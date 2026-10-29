// Command Center for Claude Code: shows the shell commands Claude Code runs
// (recorded by hook/log-hook.js) and streams background process logs.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { Dashboard } = require('./dashboard');
const hookSetup = require('./hook-setup');

const ESC = '\x1b[';
const c = {
  dim: (s) => `${ESC}2m${s}${ESC}0m`,
  bold: (s) => `${ESC}1m${s}${ESC}0m`,
  cyan: (s) => `${ESC}36m${s}${ESC}0m`,
  green: (s) => `${ESC}32m${s}${ESC}0m`,
  red: (s) => `${ESC}31m${s}${ESC}0m`,
  yellow: (s) => `${ESC}33m${s}${ESC}0m`,
};

const crlf = (s) => String(s).replace(/\r?\n/g, '\r\n');

function logDir() {
  const configured = vscode.workspace.getConfiguration('claudeCommandCenter').get('logDir');
  return configured || hookSetup.defaultLogDir();
}

// Comparable path: forward slashes, no trailing slash, case-insensitive on Windows.
function normPath(p) {
  if (!p) return '';
  let s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------
// Store: tails events.jsonl and keeps one record per tool call.
// ---------------------------------------------------------------------------

class Store {
  constructor() {
    this.records = new Map();
    this.changes = new Map(); // file edits, keyed by tool_use_id
    this.offset = 0;
    this.partial = '';
    this._onChange = new vscode.EventEmitter();
    this.onChange = this._onChange.event;
    this._onRecord = new vscode.EventEmitter();
    this.onRecord = this._onRecord.event; // (record, eventType)
    this.initialLoad = true;
  }

  get file() {
    return path.join(logDir(), 'events.jsonl');
  }

  start() {
    this.read();
    this.initialLoad = false;
    this.checkFinished();
    this.timer = setInterval(() => this.read(), 700);
    this.finishTimer = setInterval(() => this.checkFinished(), 2000);
  }

  dispose() {
    clearInterval(this.timer);
    clearInterval(this.finishTimer);
  }

  // No hook fires when a background task ends, but Claude Code appends
  // "[exited with code N]" to the task's output file.
  checkFinished() {
    let changed = false;
    for (const rec of this.records.values()) {
      if (rec.status !== 'background') continue;
      if (!rec.outputFile) rec.outputFile = findTaskOutput(rec.session, rec.backgroundTaskId);
      if (!rec.outputFile) continue;
      const exit = readExitMarker(rec.outputFile);
      if (!exit) continue;
      rec.exitCode = exit.code;
      rec.endTs = exit.mtime;
      rec.status = exit.code === 0 ? 'ok' : exit.code == null ? 'stopped' : 'failed';
      changed = true;
      this._onRecord.fire({ rec, type: 'end' });
    }
    if (changed) this._onChange.fire();
  }

  reset() {
    this.records.clear();
    this.changes.clear();
    this.offset = 0;
    this.partial = '';
    this._onChange.fire();
  }

  read() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      if (this.records.size) this.reset();
      return;
    }
    if (size < this.offset) this.reset(); // rotated or cleared
    if (size === this.offset) return;

    const fd = fs.openSync(this.file, 'r');
    const buf = Buffer.alloc(size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;

    const lines = (this.partial + buf.toString('utf8')).split('\n');
    this.partial = lines.pop();
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.apply(JSON.parse(line));
        changed = true;
      } catch {}
    }
    if (changed) this._onChange.fire();
  }

  applyFile(ev) {
    let ch = this.changes.get(ev.id);
    if (ev.type === 'fileStart') {
      ch = {
        id: ev.id,
        kind: 'change',
        session: ev.session,
        tool: ev.tool,
        file: ev.file,
        cwd: ev.cwd,
        ts: ev.ts,
        status: 'pending',
        created: ev.existed === false,
        before: ev.before,
        tooLarge: ev.tooLarge,
        oldString: ev.oldString,
        newString: ev.newString,
        replaceAll: ev.replaceAll,
        edits: ev.edits,
      };
      this.changes.set(ev.id, ch);
    } else {
      if (!ch) return;
      ch.endTs = ev.ts;
      ch.after = ev.after;
      ch.tooLarge = ch.tooLarge || ev.tooLarge;
      ch.status = ev.failed ? 'failed' : 'done';
      ch.error = ev.error;
    }
    if (!this.initialLoad) this._onRecord.fire({ rec: ch, type: ev.type });
  }

  apply(ev) {
    if (ev.type === 'fileStart' || ev.type === 'fileEnd') return this.applyFile(ev);
    let id = ev.id;
    if (!id && ev.type === 'end') {
      // no tool_use_id: pair with the oldest running call of the same command
      const match = [...this.records.values()]
        .filter((r) => r.status === 'running' && r.session === ev.session && r.command === ev.command)
        .sort((a, b) => a.startTs - b.startTs)[0];
      id = match && match.id;
    }
    id = id || `${ev.session}:${ev.ts}`;
    let rec = this.records.get(id);
    if (ev.type === 'start') {
      rec = {
        id,
        session: ev.session,
        tool: ev.tool,
        command: ev.command || '',
        description: ev.description || '',
        cwd: ev.cwd,
        background: ev.background,
        startTs: ev.ts,
        status: 'running',
        output: '',
      };
      this.records.set(id, rec);
    } else if (ev.type === 'end') {
      if (!rec) return; // end without start (e.g. history cleared mid-run)
      rec.endTs = ev.durationMs != null ? rec.startTs + ev.durationMs : ev.ts;
      rec.stdout = ev.stdout || '';
      rec.stderr = ev.stderr || ev.error || '';
      rec.exitCode = ev.exitCode;
      if (ev.backgroundTaskId) {
        rec.backgroundTaskId = ev.backgroundTaskId;
        rec.outputFile = ev.outputFile || findTaskOutput(rec.session, ev.backgroundTaskId);
        rec.status = 'background';
      } else if (ev.failed || ev.interrupted || (ev.exitCode != null && ev.exitCode !== 0)) {
        rec.status = ev.interrupted ? 'interrupted' : 'failed';
      } else {
        rec.status = 'ok';
      }
    } else if (ev.type === 'stopped') {
      if (rec && (rec.status === 'background' || rec.status === 'stopped')) {
        rec.status = 'stopped';
        rec.endTs = ev.ts;
      }
    } else {
      return;
    }
    if (!this.initialLoad) this._onRecord.fire({ rec, type: ev.type });
  }

  setScope(scope) {
    this.scope = scope;
    this._onChange.fire();
  }

  // 'workspace' shows only commands whose folder (or edited file) is inside
  // one of this window's workspace folders; a window with no folder open
  // shows everything.
  inScope(rec) {
    if (this.scope === 'all') return true;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) return true;
    const cwd = normPath(rec.file || rec.cwd);
    if (!cwd) return false;
    return folders.some((f) => {
      const root = normPath(f.uri.fsPath);
      return cwd === root || cwd.startsWith(root + '/');
    });
  }

  list() {
    const max = vscode.workspace.getConfiguration('claudeCommandCenter').get('maxItems') || 200;
    return [...this.records.values()]
      .filter((r) => this.inScope(r))
      .sort((a, b) => b.startTs - a.startTs)
      .slice(0, max);
  }

  listChanges() {
    const max = vscode.workspace.getConfiguration('claudeCommandCenter').get('maxItems') || 200;
    return [...this.changes.values()]
      .filter((c) => this.inScope(c))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, max);
  }

  runningCount() {
    let n = 0;
    for (const r of this.records.values()) {
      if ((r.status === 'running' || r.status === 'background') && this.inScope(r)) n++;
    }
    return n;
  }

  clear() {
    try {
      fs.writeFileSync(this.file, '');
    } catch {}
    for (const sub of ['snapshots', 'context']) {
      try {
        fs.rmSync(path.join(logDir(), sub), { recursive: true, force: true });
      } catch {}
    }
    this.reset();
  }
}

// Edit snapshots are removed after retentionDays; the files made for "Add to
// Claude Chat" (terminal selections, command output) after
// chatFileRetentionHours. Those must outlive the mention itself: Claude
// reads the file when the message is sent, not when the @-mention is inserted.
function pruneOldFiles() {
  const cfg = vscode.workspace.getConfiguration('claudeCommandCenter');
  const HOUR = 60 * 60 * 1000;
  const maxAge = { snapshots: cfg.get('retentionDays') * 24 * HOUR, context: cfg.get('chatFileRetentionHours') * HOUR };
  for (const sub of Object.keys(maxAge)) {
    if (!(maxAge[sub] > 0)) continue;
    const cutoff = Date.now() - maxAge[sub];
    const dir = path.join(logDir(), sub);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {}
    }
  }
}

// Empty stand-in for "before" of a newly created file (or a missing snapshot).
function emptyFile(ext) {
  const dir = path.join(logDir(), 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `empty${ext || ''}`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  return p;
}

function changeTitle(ch) {
  const name = path.basename(ch.file);
  return `${name} (Claude ${ch.tool} · ${formatTime(ch.ts)})`;
}

// Open the before/after diff of one edit. compareCurrent diffs the "before"
// snapshot against the file as it is now.
async function openChangeDiff(ch, compareCurrent) {
  if (!ch) return;
  const ext = path.extname(ch.file);
  if (ch.tooLarge) {
    vscode.window.showWarningMessage(`${path.basename(ch.file)} is over 5 MB, so no snapshot was kept. Opening the file instead.`);
    return openChangedFile(ch);
  }
  const left = ch.before && fs.existsSync(ch.before) ? ch.before : emptyFile(ext);
  let right;
  let title;
  if (compareCurrent || !ch.after || !fs.existsSync(ch.after)) {
    if (!fs.existsSync(ch.file)) {
      vscode.window.showWarningMessage(`${ch.file} no longer exists.`);
      return;
    }
    right = ch.file;
    title = `${path.basename(ch.file)} (before Claude ${ch.tool} ↔ current)`;
  } else {
    right = ch.after;
    title = changeTitle(ch);
  }
  await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(left), vscode.Uri.file(right), title, {
    preview: true,
    viewColumn: vscode.window.activeTextEditor ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside,
  });
}

async function openChangedFile(ch) {
  if (!ch || !fs.existsSync(ch.file)) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ch.file));
  vscode.window.showTextDocument(doc, { preview: true });
}

// ---------------------------------------------------------------------------
// Add to Claude chat. The Claude Code extension only exposes "insert
// @-mention" for the active editor and its selection, so files are opened,
// selected and mentioned through that command. Folders can't go through it;
// their mention is copied to the clipboard instead.
// ---------------------------------------------------------------------------

function claudeMentionCommand() {
  if (!vscode.extensions.getExtension('anthropic.claude-code')) return null;
  return vscode.workspace.getConfiguration('claudeCode').get('useTerminal')
    ? 'claude-code.insertAtMentioned'
    : 'claude-vscode.insertAtMention';
}

function mentionText(fsPath, lines) {
  const rel = vscode.workspace.asRelativePath(fsPath, false).replace(/\\/g, '/');
  if (!lines) return `@${rel}`;
  return lines.start === lines.end ? `@${rel}#${lines.start}` : `@${rel}#${lines.start}-${lines.end}`;
}

// lines are 1-based and inclusive; omit them to mention the whole file.
async function mentionFile(uri, cmd, lines) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
  if (lines) {
    const end = Math.min(lines.end, doc.lineCount) - 1;
    editor.selection = new vscode.Selection(lines.start - 1, 0, end, doc.lineAt(end).text.length);
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } else {
    editor.selection = new vscode.Selection(0, 0, 0, 0);
  }
  await vscode.commands.executeCommand(cmd);
}

async function copyMentionsFallback(mentions, why) {
  if (!mentions.length) return;
  await vscode.env.clipboard.writeText(mentions.join(' ') + ' ');
  try {
    await vscode.commands.executeCommand('claude-vscode.editor.openLast');
  } catch {}
  vscode.window.showInformationMessage(`${why} Copied ${mentions.join(' ')}. Paste it into the Claude input (Ctrl+V).`);
}

// targets: [{ uri, lines? }]
async function addToClaudeChat(targets) {
  if (!targets.length) return;
  const cmd = claudeMentionCommand();
  const original = vscode.window.activeTextEditor;
  const leftovers = [];
  let mentioned = 0;
  for (const t of targets) {
    let isDir = false;
    try {
      isDir = fs.statSync(t.uri.fsPath).isDirectory();
    } catch {}
    if (isDir || !cmd) {
      leftovers.push(mentionText(t.uri.fsPath).replace(/\/?$/, isDir ? '/' : ''));
      continue;
    }
    try {
      await mentionFile(t.uri, cmd, t.lines);
      mentioned++;
    } catch {
      leftovers.push(mentionText(t.uri.fsPath, t.lines)); // e.g. a binary file
    }
  }
  // put back the editor the user was on, without pulling focus from the chat
  if (mentioned && original && original.document.uri.toString() !== targets[targets.length - 1].uri.toString()) {
    vscode.window.showTextDocument(original.document, { viewColumn: original.viewColumn, preserveFocus: true });
  }
  const why = !cmd
    ? 'The Claude Code extension isn’t installed or active.'
    : leftovers.length === 1 && targets.length === 1
      ? 'Claude Code can’t receive this directly.'
      : 'Some items can’t be sent directly.';
  await copyMentionsFallback(leftovers, why);
}

// The lines an Edit touched, found by locating its new text in the file now.
function changedLines(ch) {
  if (ch.tool !== 'Edit' || !ch.newString || !fs.existsSync(ch.file)) return undefined;
  try {
    const text = fs.readFileSync(ch.file, 'utf8');
    const at = text.indexOf(ch.newString);
    if (at < 0) return undefined;
    const start = text.slice(0, at).split('\n').length;
    const end = start + ch.newString.replace(/\n$/, '').split('\n').length - 1;
    return { start, end };
  } catch {
    return undefined;
  }
}

// The terminal API doesn't expose its text, so run one of VS Code's terminal
// copy commands and read the clipboard, then put the user's clipboard back.
async function copyFromTerminal(copyCommand) {
  const previous = await vscode.env.clipboard.readText();
  const marker = `claude-command-center-empty-${Date.now()}`;
  await vscode.env.clipboard.writeText(marker);
  let text = '';
  try {
    await vscode.commands.executeCommand(copyCommand);
    text = await vscode.env.clipboard.readText();
  } finally {
    await vscode.env.clipboard.writeText(previous);
  }
  return text === marker ? '' : text;
}

async function addTerminalTextToChat(copyCommand, what) {
  const term = vscode.window.activeTerminal;
  const text = (await copyFromTerminal(copyCommand)).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  if (!text.trim()) {
    vscode.window.showInformationMessage(
      what === 'selection'
        ? 'Select some text in the terminal first.'
        : 'No output from the last command was found. This needs terminal shell integration (on by default) and a command that has finished.'
    );
    return;
  }
  const dir = path.join(logDir(), 'context');
  fs.mkdirSync(dir, { recursive: true });
  const name = (term && term.name) || 'terminal';
  const safe = name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'terminal';
  const file = path.join(dir, `terminal-${safe}-${Date.now()}.log`);
  let cwd = '';
  try {
    cwd = term && term.shellIntegration && term.shellIntegration.cwd ? term.shellIntegration.cwd.fsPath : '';
  } catch {}
  const header = [
    `# ${what === 'selection' ? 'Selected text' : 'Last command output'} from VS Code terminal "${name}"`,
    `# copied: ${new Date().toLocaleString()}`,
    cwd ? `# cwd: ${cwd}` : null,
    '',
  ].filter((l) => l !== null);
  fs.writeFileSync(file, header.join('\n') + '\n' + text + (text.endsWith('\n') ? '' : '\n'));
  await addToClaudeChat([{ uri: vscode.Uri.file(file) }]);
}

// Commands have no file of their own, so save one with the command and its
// output and mention that.
function writeCommandContext(rec) {
  const dir = path.join(logDir(), 'context');
  fs.mkdirSync(dir, { recursive: true });
  const safe = (rec.description || rec.command.split(/\r?\n/)[0]).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'command';
  const file = path.join(dir, `${safe}-${rec.startTs}.log`);
  let output = rec.stdout || '';
  if (rec.background && rec.outputFile) {
    try {
      output = fs.readFileSync(rec.outputFile, 'utf8');
    } catch {}
  }
  if (output.length > 200 * 1024) output = '… [earlier output omitted] …\n' + output.slice(-200 * 1024);
  const strip = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const lines = [
    `# ${rec.description || 'Command run by Claude'}`,
    `# tool: ${rec.tool} · status: ${rec.status}${rec.exitCode != null ? ` · exit code ${rec.exitCode}` : ''}`,
    `# started: ${new Date(rec.startTs).toLocaleString()}${rec.endTs ? ` · took ${formatDuration(rec.endTs - rec.startTs)}` : ''}`,
    rec.cwd ? `# cwd: ${rec.cwd}` : null,
    '',
    `$ ${rec.command}`,
    '',
    strip(output),
    rec.stderr ? '\n--- stderr ---\n' + strip(rec.stderr) : '',
  ].filter((l) => l !== null);
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

// Claude Code writes background task output to
// <tmp>/claude/<project>/<session>/tasks/<taskId>.output
function findTaskOutput(session, taskId) {
  if (!session || !taskId) return undefined;
  const roots = [path.join(os.tmpdir(), 'claude')];
  for (const root of roots) {
    let projects;
    try {
      projects = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const p of projects) {
      const candidate = path.join(root, p, session, 'tasks', `${taskId}.output`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function readExitMarker(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 300);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const m = /\[exited with code (-?\d+)\]\s*$/.exec(tail);
    if (m) return { code: Number(m[1]), mtime: st.mtimeMs };
    if (/\[(killed|stopped|terminated|interrupted)[^\]\n]*\]\s*$/i.test(tail)) return { code: null, mtime: st.mtimeMs };
  } catch {}
  return null;
}

// Letters and digits only, so shell quoting/escaping differences don't matter.
const normalize = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

// The command Claude Code wrapped in `bash -c "... && eval '<command>' < /dev/null && pwd -P >| ..."`.
function wrappedCommand(cmdline) {
  const start = cmdline.indexOf("&& eval '");
  const end = cmdline.lastIndexOf("' < /dev/null");
  return start >= 0 && end > start ? cmdline.slice(start + 9, end) : null;
}

// Find the OS processes running a background task: Claude Code shells whose
// wrapped command is exactly this one, keeping only the top of each tree.
// Matching other command lines that merely mention the text (a grep, an
// editor) would risk killing the wrong thing.
function findTaskPids(rec) {
  return new Promise((resolve) => {
    const needle = normalize(rec.command);
    if (needle.length < 4) return resolve([]);
    const pick = (procs) => {
      const matching = procs.filter((p) => {
        if (p.pid === process.pid || !p.cmd) return false;
        const wrapped = wrappedCommand(p.cmd);
        return wrapped != null && normalize(wrapped) === needle;
      });
      const ids = new Set(matching.map((p) => p.pid));
      resolve(matching.filter((p) => !ids.has(p.ppid)).map((p) => p.pid));
    };
    if (process.platform !== 'win32') {
      cp.execFile('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve([]);
        pick(
          out.split('\n').map((l) => {
            const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
            return m ? { pid: +m[1], ppid: +m[2], cmd: m[3] } : null;
          }).filter(Boolean)
        );
      });
      return;
    }
    const ps =
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne $PID } | ' +
      'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
    cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      try {
        const list = [].concat(JSON.parse(out));
        pick(list.map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, cmd: p.CommandLine })));
      } catch {
        resolve([]);
      }
    });
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      cp.execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Tree view
// ---------------------------------------------------------------------------

const STATUS_ICON = {
  running: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow')),
  background: new vscode.ThemeIcon('radio-tower', new vscode.ThemeColor('charts.blue')),
  ok: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
  failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
  interrupted: new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.orange')),
  stopped: new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('disabledForeground')),
};

class Provider {
  constructor(store) {
    this.store = store;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    store.onChange(() => this._onDidChangeTreeData.fire());
    // keep "running for Xs" labels fresh
    this.ticker = setInterval(() => {
      if (store.runningCount()) this._onDidChangeTreeData.fire();
    }, 5000);
  }

  dispose() {
    clearInterval(this.ticker);
  }

  getChildren(el) {
    return el ? [] : this.store.list();
  }

  getTreeItem(rec) {
    const firstLine = rec.command.split(/\r?\n/)[0];
    const label = rec.description || firstLine;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = rec.id;
    item.iconPath = STATUS_ICON[rec.status] || STATUS_ICON.ok;

    const project = rec.cwd ? path.basename(rec.cwd) : '';
    const elapsed = (rec.endTs || Date.now()) - rec.startTs;
    let when;
    if (rec.status === 'running') when = `running ${formatDuration(elapsed)}`;
    else if (rec.status === 'background') when = `background · ${formatTime(rec.startTs)}`;
    else when = `${formatDuration(elapsed)} · ${formatTime(rec.startTs)}`;
    item.description = [project, when].filter(Boolean).join(' · ');

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${rec.status}** · ${rec.tool} · ${formatTime(rec.startTs)}\n\n`);
    if (rec.cwd) md.appendMarkdown(`\`${rec.cwd}\`\n\n`);
    md.appendCodeblock(rec.command.length > 2000 ? rec.command.slice(0, 2000) + '…' : rec.command, rec.tool === 'PowerShell' ? 'powershell' : 'bash');
    item.tooltip = md;

    item.contextValue = rec.status === 'background' ? 'proc.background' : 'proc';
    item.command = { command: 'claudeCommandCenter.open', title: 'Show Output', arguments: [rec] };
    return item;
  }
}

// ---------------------------------------------------------------------------
// Terminals: one read-only pseudoterminal per record, plus a live feed.
// ---------------------------------------------------------------------------

function header(rec) {
  const lines = [
    c.dim(`${rec.tool} · started ${new Date(rec.startTs).toLocaleString()}`),
    rec.cwd ? c.dim(`cwd: ${rec.cwd}`) : null,
    rec.description ? c.cyan(`# ${rec.description}`) : null,
    c.bold('$ ' + rec.command),
    '',
  ];
  return crlf(lines.filter((l) => l !== null).join('\n') + '\n');
}

function footer(rec) {
  const dur = rec.endTs ? formatDuration(rec.endTs - rec.startTs) : '';
  switch (rec.status) {
    case 'ok':
      return crlf(`\n${c.green(`✔ finished in ${dur}`)}\n`);
    case 'failed':
      return crlf(`\n${c.red(`✖ failed${rec.exitCode != null ? ` (exit ${rec.exitCode})` : ''} after ${dur}`)}\n`);
    case 'interrupted':
      return crlf(`\n${c.yellow(`⊘ interrupted after ${dur}`)}\n`);
    case 'stopped':
      return crlf(`\n${c.yellow('■ stopped')}\n`);
    default:
      return '';
  }
}

function resultText(rec) {
  let out = '';
  if (rec.stdout) out += rec.stdout;
  if (rec.stderr) out += (out && !out.endsWith('\n') ? '\n' : '') + c.red(rec.stderr);
  return out ? crlf(out.endsWith('\n') ? out : out + '\n') : '';
}

class RecordTerminal {
  constructor(manager, rec) {
    this.manager = manager;
    this.rec = rec;
    this.writeEmitter = new vscode.EventEmitter();
    this.tailOffset = 0;
    this.wroteResult = false;
    const pty = {
      onDidWrite: this.writeEmitter.event,
      open: () => this.render(),
      close: () => this.dispose(true),
      handleInput: () => {},
    };
    this.terminal = vscode.window.createTerminal({
      name: `Claude: ${(rec.description || rec.command.split(/\r?\n/)[0]).slice(0, 40)}`,
      pty,
      iconPath: new vscode.ThemeIcon(rec.background ? 'radio-tower' : 'terminal'),
      isTransient: true,
    });
  }

  write(s) {
    if (s) this.writeEmitter.fire(s);
  }

  render() {
    this.write(header(this.rec));
    this.update();
  }

  update() {
    const rec = this.rec;
    if (rec.status === 'running') {
      if (!this.wroteRunning) {
        this.write(c.dim(crlf('… running (output appears when the command finishes)\n')));
        this.wroteRunning = true;
      }
      return;
    }
    if (!this.wroteResult) {
      this.wroteResult = true;
      if (rec.background) {
        if (rec.stdout && !rec.outputFile) this.write(resultText(rec));
      } else {
        this.write(resultText(rec));
      }
    }
    if (rec.background) {
      if (!rec.outputFile) rec.outputFile = findTaskOutput(rec.session, rec.backgroundTaskId);
      if (rec.outputFile) this.startTail();
      else if (!this.wroteNoFile) {
        this.wroteNoFile = true;
        this.write(c.yellow(crlf('\nCould not locate the background output file for this task.\n')));
      }
    }
    if (rec.status !== 'background' && !this.wroteFooter) {
      if (this.tick) {
        this.tick(); // flush the last output before the footer
        clearInterval(this.tailTimer);
      }
      this.wroteFooter = true;
      this.write(footer(rec));
    }
  }

  startTail() {
    if (this.tailTimer) return;
    this.write(c.dim(crlf(`streaming ${this.rec.outputFile}\n\n`)));
    const tick = (this.tick = () => {
      let size;
      try {
        size = fs.statSync(this.rec.outputFile).size;
      } catch {
        return;
      }
      if (size < this.tailOffset) this.tailOffset = 0;
      if (size === this.tailOffset) return;
      const fd = fs.openSync(this.rec.outputFile, 'r');
      const len = Math.min(size - this.tailOffset, 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.tailOffset);
      fs.closeSync(fd);
      this.tailOffset += len;
      this.write(crlf(buf.toString('utf8')));
    });
    tick();
    this.tailTimer = setInterval(tick, 400);
  }

  show() {
    this.terminal.show(true);
  }

  dispose(fromClose) {
    clearInterval(this.tailTimer);
    this.manager.terminals.delete(this.rec.id);
    if (!fromClose) this.terminal.dispose();
  }
}

class FeedTerminal {
  constructor(manager) {
    this.manager = manager;
    this.writeEmitter = new vscode.EventEmitter();
    this.terminal = vscode.window.createTerminal({
      name: 'Claude: Live Feed',
      pty: {
        onDidWrite: this.writeEmitter.event,
        open: () => this.writeEmitter.fire(c.dim(crlf('Live feed of commands Claude runs. Background logs open in their own tabs.\n\n'))),
        close: () => (manager.feed = null),
        handleInput: () => {},
      },
      iconPath: new vscode.ThemeIcon('pulse'),
      isTransient: true,
    });
  }

  event(rec, type) {
    if (type === 'fileEnd') {
      const what = rec.status === 'failed' ? c.red('✖ edit failed') : rec.created ? c.green('+ created') : c.yellow('✎ edited');
      this.writeEmitter.fire(crlf(`${c.dim(`[${formatTime(rec.ts)}]`)} ${what} ${rec.file}\n\n`));
      return;
    }
    if (type === 'start') {
      this.writeEmitter.fire(c.dim(crlf(`[${formatTime(rec.startTs)}] `)) + header(rec).replace(/^.*?\r\n/, ''));
    } else if (type === 'end' || type === 'stopped') {
      const label = c.dim(`[${formatTime(rec.endTs || Date.now())}] ← ${rec.description || rec.command.split(/\r?\n/)[0]}`);
      this.writeEmitter.fire(crlf(label + '\n'));
      if (rec.status === 'background') {
        this.writeEmitter.fire(c.cyan(crlf(`↳ running in background (task ${rec.backgroundTaskId})\n\n`)));
      } else {
        this.writeEmitter.fire(resultText(rec) + footer(rec) + '\r\n');
      }
    }
  }
}

class TerminalManager {
  constructor(store) {
    this.store = store;
    this.terminals = new Map();
    this.feed = null;
    store.onRecord(({ rec, type }) => {
      const t = this.terminals.get(rec.id);
      if (t) t.update();
      if (!store.inScope(rec)) return;
      if (this.feed) this.feed.event(rec, type);
      if (
        type === 'end' &&
        rec.status === 'background' &&
        vscode.workspace.getConfiguration('claudeCommandCenter').get('autoOpenBackground')
      ) {
        this.open(rec);
      }
    });
  }

  open(rec) {
    let t = this.terminals.get(rec.id);
    if (!t) {
      t = new RecordTerminal(this, rec);
      this.terminals.set(rec.id, t);
    }
    t.show();
  }

  openFeed() {
    if (!this.feed) this.feed = new FeedTerminal(this);
    this.feed.terminal.show(true);
  }

  dispose() {
    for (const t of this.terminals.values()) clearInterval(t.tailTimer);
  }
}

// Sidebar list of file edits; clicking one opens its diff.
class ChangesProvider {
  constructor(store) {
    this.store = store;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    store.onChange(() => this._onDidChangeTreeData.fire());
  }

  getChildren(el) {
    return el ? [] : this.store.listChanges();
  }

  getTreeItem(ch) {
    const item = new vscode.TreeItem(path.basename(ch.file), vscode.TreeItemCollapsibleState.None);
    item.id = 'change:' + ch.id;
    item.resourceUri = vscode.Uri.file(ch.file); // file-type icon from the icon theme
    if (ch.status === 'failed') item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    else if (ch.status === 'pending') item.iconPath = new vscode.ThemeIcon('sync~spin');

    const rel = vscode.workspace.asRelativePath(path.dirname(ch.file), false);
    const what = ch.status === 'failed' ? 'failed' : ch.created ? 'new' : ch.tool;
    item.description = [what, rel && rel !== '.' ? rel : '', formatTime(ch.ts)].filter(Boolean).join(' · ');

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${ch.created ? 'Created' : ch.tool}** · ${new Date(ch.ts).toLocaleString()}\n\n\`${ch.file}\``);
    if (ch.error) md.appendCodeblock(ch.error.slice(0, 500));
    item.tooltip = md;

    item.contextValue = 'change';
    item.command = { command: 'claudeCommandCenter.openChangeDiff', title: 'Open Diff', arguments: [ch] };
    return item;
  }
}

// ---------------------------------------------------------------------------
// Setup: register the hook in Claude Code's settings and let Alt+K reach the
// extension from a terminal. Asked once; also available as commands.
// ---------------------------------------------------------------------------

const SKIP_SHELL_CMD = 'claudeCommandCenter.addTerminalSelectionToChat';

function bundledHook(context) {
  return path.join(context.extensionPath, 'hook', 'log-hook.js');
}

function nodeAvailable() {
  return new Promise((resolve) => cp.execFile('node', ['--version'], { windowsHide: true }, (err) => resolve(!err)));
}

async function addSkipShell() {
  const cfg = vscode.workspace.getConfiguration('terminal.integrated');
  const current = cfg.inspect('commandsToSkipShell')?.globalValue || [];
  if (!current.includes(SKIP_SHELL_CMD)) {
    await cfg.update('commandsToSkipShell', [...current, SKIP_SHELL_CMD], vscode.ConfigurationTarget.Global);
  }
}

async function runSetup(context) {
  if (!(await nodeAvailable())) {
    vscode.window.showWarningMessage(
      'Command Center for Claude Code needs Node.js on your PATH to run its logging hook. Install Node.js, then run "Command Center: Set Up Hooks".',
      'Get Node.js'
    ).then((pick) => pick && vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/')));
    return false;
  }
  try {
    hookSetup.installHookFile(bundledHook(context));
    hookSetup.registerHooks();
    hookSetup.migrateLegacy(); // the old hook is unregistered now, so its copy and any late events can move
  } catch (e) {
    const pick = await vscode.window.showErrorMessage(
      `Couldn't update ${hookSetup.settingsPath()}: ${e.message}`,
      'Open settings.json'
    );
    if (pick) vscode.window.showTextDocument(vscode.Uri.file(hookSetup.settingsPath()));
    return false;
  }
  try {
    await addSkipShell();
  } catch {}
  await context.globalState.update('setupDeclined', false);
  vscode.window.showInformationMessage(
    'Command Center for Claude Code is set up. Start a new Claude Code session (or restart the current one) to begin recording.'
  );
  return true;
}

async function checkSetup(context) {
  try {
    hookSetup.installHookFile(bundledHook(context)); // keep the installed hook current after updates
  } catch {}
  let status;
  try {
    status = hookSetup.hookStatus();
  } catch {
    return; // settings.json unreadable; the setup command reports details
  }
  if (status === 'ok') return;
  if (status === 'missing' && context.globalState.get('setupDeclined')) return;
  const msg =
    status === 'outdated'
      ? 'Command Center for Claude Code: your Claude Code hook is from an older setup. Update it?'
      : 'Set up Command Center for Claude Code? This adds a logging hook to Claude Code (~/.claude/settings.json, a backup is kept) and an Alt+K shortcut for terminal selections.';
  const pick = await vscode.window.showInformationMessage(msg, status === 'outdated' ? 'Update' : 'Enable', 'Not now', "Don't ask again");
  if (pick === 'Enable' || pick === 'Update') await runSetup(context);
  else if (pick === "Don't ask again") await context.globalState.update('setupDeclined', true);
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function appendEvent(ev) {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(path.join(logDir(), 'events.jsonl'), JSON.stringify(ev) + '\n');
  } catch {}
}

function activate(context) {
  try {
    hookSetup.migrateLegacy(); // history from before the rename to Command Center
  } catch {}
  const store = new Store();
  store.scope =
    context.workspaceState.get('scope') ||
    vscode.workspace.getConfiguration('claudeCommandCenter').get('scope') ||
    'workspace';
  const provider = new Provider(store);
  const terminals = new TerminalManager(store);

  const view = vscode.window.createTreeView('claudeCommandCenter.commands', { treeDataProvider: provider });
  const changesView = vscode.window.createTreeView('claudeCommandCenter.changes', { treeDataProvider: new ChangesProvider(store) });
  pruneOldFiles();
  const pruneTimer = setInterval(pruneOldFiles, 60 * 60 * 1000); // windows stay open for days
  context.subscriptions.push({ dispose: () => clearInterval(pruneTimer) });

  const dashboard = new Dashboard(context, store, findTaskOutput);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'claudeCommandCenter.dashboard';
  const updateStatus = () => {
    const n = store.runningCount();
    status.text = n ? `$(pulse) Claude: ${n} running` : '$(terminal) Claude';
    const where = store.scope === 'all' ? 'all workspaces' : 'this workspace';
    status.tooltip = `Command Center for Claude Code (${where})`;
    status.show();
    view.badge = n ? { value: n, tooltip: `${n} running` } : undefined;
    view.description = where;
    const changes = store.listChanges().length;
    changesView.description = changes ? `${changes} · ${where}` : where;
  };
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => store.setScope(store.scope)));
  store.onChange(updateStatus);

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('claudeCommandCenter.open', (rec) => rec && terminals.open(rec));
  reg('claudeCommandCenter.openFeed', () => terminals.openFeed());
  reg('claudeCommandCenter.dashboard', () => dashboard.show());
  reg('claudeCommandCenter.setup', () => runSetup(context));
  reg('claudeCommandCenter.removeHooks', async () => {
    const pick = await vscode.window.showWarningMessage(
      'Remove the Command Center logging hook from Claude Code? Commands and file changes stop being recorded.',
      { modal: true },
      'Remove'
    );
    if (pick !== 'Remove') return;
    try {
      hookSetup.unregisterHooks();
      await context.globalState.update('setupDeclined', true);
      vscode.window.showInformationMessage('Hook removed. Run "Command Center: Set Up Hooks" to add it back.');
    } catch (e) {
      vscode.window.showErrorMessage(`Couldn't update ${hookSetup.settingsPath()}: ${e.message}`);
    }
  });
  reg('claudeCommandCenter.openChangeDiff', (ch) => openChangeDiff(ch, false));
  reg('claudeCommandCenter.compareWithCurrent', (ch) => openChangeDiff(ch, true));
  reg('claudeCommandCenter.openChangedFile', (ch) => openChangedFile(ch));

  // Explorer (files/folders, multi-select) and editor tab: (clicked, allSelected)
  reg('claudeCommandCenter.addToChat', (uri, uris) => {
    let list = Array.isArray(uris) && uris.length ? uris : uri ? [uri] : [];
    if (!list.length && vscode.window.activeTextEditor) list = [vscode.window.activeTextEditor.document.uri];
    return addToClaudeChat(list.filter((u) => u && u.scheme === 'file').map((u) => ({ uri: u })));
  });
  reg('claudeCommandCenter.addSelectionToChat', () => {
    const cmd = claudeMentionCommand();
    if (cmd) return vscode.commands.executeCommand(cmd);
    const ed = vscode.window.activeTextEditor;
    if (!ed) return;
    const s = ed.selection;
    return copyMentionsFallback(
      [mentionText(ed.document.uri.fsPath, s.isEmpty ? undefined : { start: s.start.line + 1, end: s.end.line + 1 })],
      'The Claude Code extension isn’t installed or active.'
    );
  });
  reg('claudeCommandCenter.addTerminalSelectionToChat', () =>
    addTerminalTextToChat('workbench.action.terminal.copySelection', 'selection')
  );
  reg('claudeCommandCenter.addTerminalLastOutputToChat', () =>
    addTerminalTextToChat('workbench.action.terminal.copyLastCommandOutput', 'last')
  );
  // Terminal toolbar button: the selection if there is one, else the last command's output.
  reg('claudeCommandCenter.addTerminalToChat', async () => {
    const selection = await copyFromTerminal('workbench.action.terminal.copySelection');
    return addTerminalTextToChat(
      selection.trim() ? 'workbench.action.terminal.copySelection' : 'workbench.action.terminal.copyLastCommandOutput',
      selection.trim() ? 'selection' : 'last'
    );
  });
  reg('claudeCommandCenter.addChangeToChat', (ch) => {
    if (!ch) return;
    if (!fs.existsSync(ch.file)) return vscode.window.showWarningMessage(`${ch.file} no longer exists.`);
    return addToClaudeChat([{ uri: vscode.Uri.file(ch.file), lines: changedLines(ch) }]);
  });
  reg('claudeCommandCenter.addCommandToChat', (rec) => {
    if (!rec) return;
    try {
      return addToClaudeChat([{ uri: vscode.Uri.file(writeCommandContext(rec)) }]);
    } catch (e) {
      vscode.window.showErrorMessage(`Couldn't save the command output: ${e.message}`);
    }
  });
  reg('claudeCommandCenter.toggleScope', (scope) => {
    const next = typeof scope === 'string' ? scope : store.scope === 'all' ? 'workspace' : 'all';
    context.workspaceState.update('scope', next);
    store.setScope(next);
  });
  reg('claudeCommandCenter.refresh', () => {
    store.reset();
    store.read();
  });
  reg('claudeCommandCenter.clear', async () => {
    const pick = await vscode.window.showWarningMessage(
      'Clear the recorded commands and file changes for all windows? Saved file snapshots and the files made for Claude chat mentions are deleted too.',
      { modal: true },
      'Clear'
    );
    if (pick === 'Clear') store.clear();
  });
  reg('claudeCommandCenter.copyCommand', async (rec) => {
    if (!rec) return;
    await vscode.env.clipboard.writeText(rec.command);
    vscode.window.setStatusBarMessage('Command copied', 2000);
  });
  reg('claudeCommandCenter.runInTerminal', (rec) => {
    if (!rec) return;
    const opts = { name: rec.description || 'Claude command', cwd: rec.cwd && fs.existsSync(rec.cwd) ? rec.cwd : undefined };
    if (process.platform === 'win32') {
      opts.shellPath = rec.tool === 'PowerShell' ? 'powershell.exe' : findGitBash();
    }
    const term = vscode.window.createTerminal(opts);
    term.show();
    term.sendText(rec.command, false); // let the user press Enter
  });
  reg('claudeCommandCenter.stop', async (rec) => {
    if (!rec || rec.status !== 'background') return;
    store.checkFinished();
    if (rec.status !== 'background') {
      vscode.window.showInformationMessage(
        `"${rec.description || rec.command}" already finished${rec.exitCode != null ? ` (exit code ${rec.exitCode})` : ''}.`
      );
      return;
    }
    const pids = (await findTaskPids(rec)).filter((pid) => isAlive(pid));
    if (!pids.length) {
      const pick = await vscode.window.showWarningMessage(
        `Couldn't find a running process for "${rec.description || rec.command}". Mark it as stopped?`,
        'Mark stopped'
      );
      if (pick) appendEvent({ id: rec.id, type: 'stopped', ts: Date.now() });
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      `Stop "${rec.description || rec.command}"? (PID ${pids.join(', ')} and child processes)`,
      { modal: true },
      'Stop'
    );
    if (pick !== 'Stop') return;
    // mark it first, so the "[exited with code 1]" the kill produces doesn't read as a failure
    rec.status = 'stopped';
    rec.endTs = Date.now();
    appendEvent({ id: rec.id, type: 'stopped', ts: rec.endTs });
    for (const pid of pids) await killTree(pid);
  });

  store.start();
  updateStatus();
  checkSetup(context);

  context.subscriptions.push(view, changesView, status, { dispose: () => store.dispose() }, provider, terminals);
}

function findGitBash() {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function deactivate() {}

module.exports = { activate, deactivate };
