// Command Center for Claude Code: shows the shell commands Claude Code runs
// (recorded by hook/log-hook.js) and streams background process logs.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { Dashboard, folderLabel } = require('./dashboard');
const hookSetup = require('./hook-setup');
const sessions = require('./sessions');
const { findTaskPids, killTree } = require('./processes');
const { TranscriptViews } = require('./transcript-view');
const { searchTranscripts } = require('./transcript');

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

// Claude Code's Bash/PowerShell tool timeouts (ms): default and maximum.
const DEFAULT_TOOL_TIMEOUT = 2 * 60 * 1000;
const MAX_TOOL_TIMEOUT = 10 * 60 * 1000;
const NO_RESULT_GRACE = 60 * 1000;

const SESSION_EVENT_TYPES = new Set(['turnEnd', 'subagentStart', 'subagentEnd', 'attention']);

// Comparable path: forward slashes, no trailing slash, case-insensitive on Windows.
function normPath(p) {
  if (!p) return '';
  let s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

// Whether a path is inside one of this window's workspace folders. A window
// with no folder open counts everything as its own.
function inWorkspace(p) {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return true;
  const target = normPath(p);
  if (!target) return false;
  return folders.some((f) => {
    const root = normPath(f.uri.fsPath);
    return target === root || target.startsWith(root + '/');
  });
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
    this.earlyEnds = new Map(); // end events seen before their start
    this.turnEnds = new Map(); // session -> times its turns ended
    this.offset = 0;
    this.partial = '';
    this._onChange = new vscode.EventEmitter();
    this.onChange = this._onChange.event;
    this._onRecord = new vscode.EventEmitter();
    this.onRecord = this._onRecord.event; // (record, eventType)
    this._onSessionEvent = new vscode.EventEmitter();
    this.onSessionEvent = this._onSessionEvent.event; // turn ends, subagents, permission prompts
    this.initialLoad = true;
  }

  get file() {
    return path.join(logDir(), 'events.jsonl');
  }

  start() {
    this.startedAt = Date.now();
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
  // Nor does one fire when a call is denied or cancelled (Esc), which would
  // leave it "running" forever; a foreground call can't outlive its timeout,
  // so past that it is marked "no result".
  checkFinished() {
    let changed = false;
    const now = Date.now();
    for (const rec of this.records.values()) {
      if (rec.status === 'running' && !rec.background) {
        const limit = Math.min(rec.timeout || DEFAULT_TOOL_TIMEOUT, MAX_TOOL_TIMEOUT) + NO_RESULT_GRACE;
        if (now - rec.startTs > limit) {
          rec.status = 'noresult';
          changed = true;
          this._onRecord.fire({ rec, type: 'end' });
        }
        continue;
      }
      if (rec.status !== 'background') continue;
      if (!rec.outputFile) rec.outputFile = findTaskOutput(rec.session, rec.backgroundTaskId);
      if (!rec.outputFile) continue;
      if (!rec.url && (rec.url = scanForUrl(rec))) {
        changed = true;
        this._onRecord.fire({ rec, type: 'url' });
      }
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
    this.earlyEnds.clear();
    this.turnEnds.clear();
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
      const early = this.earlyEnds.get('file:' + ev.id);
      if (early) {
        this.earlyEnds.delete('file:' + ev.id);
        return this.applyFile(early);
      }
    } else {
      if (!ch) {
        if (ev.id) this.earlyEnds.set('file:' + ev.id, ev); // see apply()
        return;
      }
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
    if (SESSION_EVENT_TYPES.has(ev.type)) {
      if (ev.type === 'turnEnd' && ev.session) {
        if (!this.turnEnds.has(ev.session)) this.turnEnds.set(ev.session, []);
        this.turnEnds.get(ev.session).push(ev.ts);
      }
      if (!this.initialLoad) this._onSessionEvent.fire(ev);
      return;
    }
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
        timeout: ev.timeout,
        startTs: ev.ts,
        status: 'running',
        output: '',
      };
      this.records.set(id, rec);
      const early = this.earlyEnds.get(id);
      if (early) {
        this.earlyEnds.delete(id);
        return this.apply(early);
      }
    } else if (ev.type === 'end') {
      if (!rec) {
        // An end can be logged before its start (history merged out of order);
        // hold it until the start arrives. Ends whose start was cleared stay here.
        if (ev.id) this.earlyEnds.set(ev.id, ev);
        return;
      }
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
    return this.scope === 'all' || inWorkspace(rec.file || rec.cwd);
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
    for (const sub of ['snapshots', 'reverts', 'context']) {
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
  const maxAge = {
    snapshots: cfg.get('retentionDays') * 24 * HOUR,
    reverts: cfg.get('retentionDays') * 24 * HOUR, // copies saved before a revert, for undo
    context: cfg.get('chatFileRetentionHours') * HOUR,
  };
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
    viewColumn: vscode.ViewColumn.Active,
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
  // <tmp>/claude on Windows; <tmp>/claude-<uid> on macOS and Linux, where
  // <tmp> is CLAUDE_CODE_TMPDIR, else /tmp (Node's tmpdir() can differ).
  const uid = process.getuid ? process.getuid() : '';
  const tmps = [...new Set([process.env.CLAUDE_CODE_TMPDIR, os.tmpdir(), process.platform === 'win32' ? null : '/tmp'].filter(Boolean))];
  const roots = tmps.flatMap((t) => [path.join(t, 'claude'), path.join(t, `claude-${uid}`)]);
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

// A local address a dev server announces ("Local: http://localhost:5173/").
const LOCAL_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|(?:\d{1,3}\.){3}\d{1,3}|[\w-]+\.local)(?::\d{2,5})?(?:\/[^\s'"<>`)\]]*)?/i;

// Look through the output written since the last call for a local URL.
function scanForUrl(rec) {
  try {
    const size = fs.statSync(rec.outputFile).size;
    const from = rec.urlOffset || 0;
    if (size <= from) return undefined;
    const len = Math.min(size - from, 256 * 1024);
    const fd = fs.openSync(rec.outputFile, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    fs.closeSync(fd);
    rec.urlOffset = Math.max(from + len - 200, from); // overlap, so a URL split across reads is still seen
    const m = LOCAL_URL.exec(buf.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
    if (!m) return undefined;
    return m[0].replace(/[.,;:]+$/, '').replace(/\/\/(0\.0\.0\.0|\[::\])/, '//localhost');
  } catch {
    return undefined;
  }
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
  noresult: new vscode.ThemeIcon('question', new vscode.ThemeColor('disabledForeground')),
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
    else if (rec.status === 'background') when = `${rec.url ? rec.url.replace(/^https?:\/\//, '') : 'background'} · ${formatTime(rec.startTs)}`;
    else when = `${formatDuration(elapsed)} · ${formatTime(rec.startTs)}`;
    item.description = [project, when].filter(Boolean).join(' · ');

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${rec.status}** · ${rec.tool} · ${formatTime(rec.startTs)}\n\n`);
    if (rec.cwd) md.appendMarkdown(`\`${rec.cwd}\`\n\n`);
    md.appendCodeblock(rec.command.length > 2000 ? rec.command.slice(0, 2000) + '…' : rec.command, rec.tool === 'PowerShell' ? 'powershell' : 'bash');
    item.tooltip = md;

    item.contextValue = rec.status === 'background' ? (rec.url ? 'proc.background.url' : 'proc.background') : 'proc';
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
    case 'noresult':
      return crlf(`\n${c.yellow('… no result: the command was denied, cancelled or interrupted')}\n`);
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
      if (type === 'url') return announceUrl(store, rec);
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

    const rel = folderLabel(ch.file);
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
// Sessions: Claude Code's own transcripts, read by sessions.js.
// ---------------------------------------------------------------------------

const SESSION_ICON = {
  busy: new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow')),
  idle: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed')),
  closed: new vscode.ThemeIcon('comment-discussion'),
};

function sessionLabel(s) {
  if (!s) return 'Unknown session';
  const text = s.title || (s.lastPrompt && s.lastPrompt.split(/\r?\n/)[0]) || s.id.slice(0, 8);
  return text.length > 80 ? text.slice(0, 80) + '…' : text;
}

function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
  return `${(n / 1e9).toFixed(1)}B`;
}

function formatWhen(ts) {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? formatTime(ts) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

class SessionsProvider {
  constructor(store, index) {
    this.store = store;
    this.index = index;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    store.onChange(() => this._onDidChangeTreeData.fire()); // scope toggles
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  list() {
    const max = vscode.workspace.getConfiguration('claudeCommandCenter').get('maxItems') || 200;
    return this.index.sessions().filter((s) => this.store.inScope({ cwd: s.cwd })).slice(0, max);
  }

  getChildren(el) {
    return el ? [] : this.list();
  }

  getTreeItem(s) {
    const item = new vscode.TreeItem(sessionLabel(s), vscode.TreeItemCollapsibleState.None);
    item.id = 'session:' + s.id;
    item.iconPath = SESSION_ICON[s.live === 'busy' ? 'busy' : s.live ? 'idle' : 'closed'];
    const project = s.cwd ? path.basename(s.cwd) : '';
    item.description = [s.live === 'busy' ? 'working' : '', project, formatWhen(s.lastTs)].filter(Boolean).join(' · ');

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${sessionLabel(s).replace(/[*_`[\]]/g, '\\$&')}**\n\n`);
    if (s.cwd) md.appendMarkdown(`\`${s.cwd}\`\n\n`);
    const facts = [
      s.live ? (s.live === 'busy' ? 'Open, working' : 'Open, idle') : 'Closed',
      `last active ${new Date(s.lastTs).toLocaleString()}`,
      s.tokens ? `${formatTokens(s.tokens)} tokens in 7 days` : null,
      s.cost ? `$${s.cost.toFixed(2)} (Claude Code's estimate)` : null,
    ].filter(Boolean);
    md.appendMarkdown(facts.join(' · ') + '\n\n');
    if (s.lastPrompt) md.appendCodeblock(s.lastPrompt.length > 500 ? s.lastPrompt.slice(0, 500) + '…' : s.lastPrompt, 'text');
    md.appendMarkdown(`\n\nSession \`${s.id}\``);
    item.tooltip = md;

    item.contextValue = s.live ? 'session.live' : 'session';
    item.command = { command: 'claudeCommandCenter.openSession', title: 'Open Session', arguments: [s] };
    return item;
  }
}

// The Claude Code CLI: on PATH, else the copy bundled with its VS Code extension.
function findClaudeCli() {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, 'claude' + ext.toLowerCase());
      if (dir && fs.existsSync(p)) return p;
    }
  }
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const p = path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function confirmResumeLive(s) {
  if (!s.live) return true;
  const pick = await vscode.window.showWarningMessage(
    `"${sessionLabel(s)}" is still open in another Claude Code process. Resuming it a second time can interleave the two conversations. Resume anyway?`,
    { modal: true },
    'Resume'
  );
  return pick === 'Resume';
}

async function resumeInTerminal(s) {
  if (!(await confirmResumeLive(s))) return;
  const cli = findClaudeCli();
  if (!cli) {
    vscode.window.showErrorMessage('Couldn’t find the Claude Code CLI ("claude") on your PATH.');
    return;
  }
  // Run the CLI as the terminal's process, so no shell quoting is involved
  // (an npm-installed claude.cmd still needs cmd.exe to start it).
  const viaCmd = /\.(cmd|bat)$/i.test(cli);
  const term = vscode.window.createTerminal({
    name: `Claude: ${sessionLabel(s).slice(0, 40)}`,
    cwd: s.cwd && fs.existsSync(s.cwd) ? s.cwd : undefined,
    shellPath: viaCmd ? process.env.ComSpec || 'cmd.exe' : cli,
    shellArgs: viaCmd ? ['/d', '/c', cli, '--resume', s.id] : ['--resume', s.id],
    iconPath: new vscode.ThemeIcon('comment-discussion'),
  });
  term.show();
}

// The Claude Code extension opens sessions of the workspace folder it runs
// in, so a session from anywhere else is resumed in a terminal instead.
async function openSession(s) {
  if (!s) return;
  const atRoot = (vscode.workspace.workspaceFolders || []).some((f) => normPath(f.uri.fsPath) === normPath(s.cwd));
  if (vscode.extensions.getExtension('anthropic.claude-code') && s.cwd && atRoot) {
    // open in a terminal CLI: opening it in the panel too would run it twice
    if (s.live && s.liveEntrypoint !== 'claude-vscode' && !(await confirmResumeLive(s))) return;
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', s.id);
      return;
    } catch {}
  }
  return resumeInTerminal(s);
}

async function moveSessionTo(s, index) {
  if (!s) return;
  if (s.live) {
    vscode.window.showWarningMessage(`"${sessionLabel(s)}" is still open in Claude Code. Close it first, then move it.`);
    return;
  }
  const known = new Map();
  for (const f of vscode.workspace.workspaceFolders || []) known.set(normPath(f.uri.fsPath), f.uri.fsPath);
  for (const other of index.sessions()) if (other.cwd && !known.has(normPath(other.cwd))) known.set(normPath(other.cwd), other.cwd);
  known.delete(normPath(s.cwd));
  const items = [...known.values()].map((p) => ({ label: path.basename(p), description: p, target: p }));
  items.push({ label: '$(folder-opened) Choose a folder…', browse: true });
  const pick = await vscode.window.showQuickPick(items, {
    title: `Move "${sessionLabel(s)}" to another project`,
    placeHolder: `Now in ${s.cwd || 'an unknown folder'}`,
    matchOnDescription: true,
  });
  if (!pick) return;
  let target = pick.target;
  if (pick.browse) {
    const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Move session here' });
    if (!uris || !uris.length) return;
    target = uris[0].fsPath;
  }
  if (normPath(target) === normPath(s.cwd)) return;
  const ok = await vscode.window.showWarningMessage(
    `Move "${sessionLabel(s)}" to ${target}?`,
    {
      modal: true,
      detail:
        'Claude Code will list and resume it in that folder. File paths mentioned earlier in the conversation stay as they were.',
    },
    'Move'
  );
  if (ok !== 'Move') return;
  try {
    sessions.moveSession(s, target);
  } catch (e) {
    vscode.window.showErrorMessage(`Couldn’t move the session: ${e.message}`);
    return;
  }
  await index.refresh(sessionDays());
  vscode.window.showInformationMessage(`Moved "${sessionLabel(s)}" to ${path.basename(target)}.`);
}

function sessionDays() {
  return vscode.workspace.getConfiguration('claudeCommandCenter').get('sessionDays') || 30;
}

// Notifications for turn ends, permission prompts and finished subagents. Only
// the window whose folders the session runs in shows them.
const ATTENTION_KINDS = new Set([
  'permission_prompt',
  'worker_permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
  'push_notification',
]);

class Notifier {
  constructor(store, index) {
    this.index = index;
    this.subagents = new Map(); // agent ID -> start time
    this.lastTurnEnd = new Map(); // session -> when its last turn-end toast showed
    store.onSessionEvent((ev) => this.handle(ev));
  }

  wanted(setting) {
    const mode = vscode.workspace.getConfiguration('claudeCommandCenter').get(setting);
    return mode === 'always' || (mode === 'unfocused' && !vscode.window.state.focused);
  }

  handle(ev) {
    if (ev.type === 'subagentStart') {
      if (ev.agentId) this.subagents.set(ev.agentId, ev.ts);
      return;
    }
    if (!inWorkspace(ev.cwd)) return;
    const s = this.index.get(ev.session) || { id: ev.session, cwd: ev.cwd };
    const where = s.title || s.lastPrompt ? sessionLabel(s) : path.basename(ev.cwd || '') || 'Claude Code';
    const snippet = (ev.message || '').split(/\r?\n/).find((l) => l.trim()) || '';
    const clip = (t) => (t.length > 140 ? t.slice(0, 140) + '…' : t);

    if (ev.type === 'turnEnd') {
      if (!this.wanted('notifyTurnEnd')) return;
      const last = this.lastTurnEnd.get(ev.session) || 0;
      if (ev.ts - last < 20 * 1000) return;
      this.lastTurnEnd.set(ev.session, ev.ts);
      this.show('info', `Claude finished: ${where}${snippet ? ` — ${clip(snippet)}` : ''}`, s);
    } else if (ev.type === 'attention') {
      if (ev.kind && !ATTENTION_KINDS.has(ev.kind)) return;
      if (!this.wanted('notifyAttention')) return;
      this.show('warning', `Claude needs you: ${clip(snippet || 'waiting for permission')} (${where})`, s);
    } else if (ev.type === 'subagentEnd') {
      const started = this.subagents.get(ev.agentId);
      this.subagents.delete(ev.agentId);
      if (!this.wanted('notifySubagentEnd')) return;
      const min = (vscode.workspace.getConfiguration('claudeCommandCenter').get('notifySubagentMinSeconds') || 0) * 1000;
      if (started == null ? min > 0 : ev.ts - started < min) return;
      const took = started != null ? ` after ${formatDuration(ev.ts - started)}` : '';
      this.show('info', `Subagent ${ev.agentType || ''} finished${took} (${where})`.replace(/\s+/g, ' '), s);
    }
  }

  async show(level, text, s) {
    const fn = level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const pick = await fn(text, 'Open Session');
    if (pick) openSession(this.index.get(s.id) || s);
  }
}

// Status bar: tokens Claude Code used on this machine, from its transcripts.
function usageTooltip(u) {
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**Claude Code usage on this machine**\n\n');
  md.appendMarkdown('| | 5 hours | Today | 7 days |\n|---|--:|--:|--:|\n');
  const row = (label, k) => md.appendMarkdown(`| ${label} | ${formatTokens(u.fiveHours[k])} | ${formatTokens(u.today[k])} | ${formatTokens(u.week[k])} |\n`);
  row('Output', 'output');
  row('Input', 'input');
  row('Cache write', 'cacheWrite');
  row('Cache read', 'cacheRead');
  row('**Total**', 'total');
  const models = Object.entries(u.week.models).sort((a, b) => b[1] - a[1]);
  if (models.length > 1) {
    md.appendMarkdown('\n**By model, 7 days:** ' + models.map(([m, n]) => `${m.replace(/^claude-/, '')} ${formatTokens(n)}`).join(' · ') + '\n');
  }
  md.appendMarkdown('\nCounted from local session transcripts, all projects. Plan limits aren’t known locally, so this is not a percentage of your quota.');
  return md;
}

// ---------------------------------------------------------------------------
// Permission prompts of terminal sessions, answered here (opt-in). The hook
// writes permissions/<id>.request.json and waits for <id>.response.json; a
// window only receives requests while its listener file is fresh.
// ---------------------------------------------------------------------------

class PermissionBroker {
  constructor() {
    this.seen = new Set();
    this.lastBeat = 0;
    this.listener = path.join(this.dir, `listener-${process.pid}.json`);
    this.timer = setInterval(() => this.tick(), 500);
  }

  get dir() {
    return path.join(logDir(), 'permissions');
  }

  get config() {
    return vscode.workspace.getConfiguration('claudeCommandCenter');
  }

  // Only windows with a folder open listen: requests go to the window whose
  // folders contain the session's working folder.
  tick() {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    if (!this.config.get('answerPermissions') || !folders.length) return this.stopListening();
    if (Date.now() - this.lastBeat > 5000) {
      this.lastBeat = Date.now();
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const timeoutSeconds = Math.min(Math.max(this.config.get('permissionTimeoutSeconds') || 60, 10), 300);
        fs.writeFileSync(this.listener, JSON.stringify({ pid: process.pid, folders, timeoutSeconds, ts: Date.now() }));
      } catch {}
      this.cleanUp();
    }
    let names;
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.request.json'));
    } catch {
      return;
    }
    for (const n of names) {
      if (this.seen.has(n)) continue;
      this.seen.add(n);
      let req;
      try {
        req = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
      } catch {
        this.seen.delete(n); // still being written
        continue;
      }
      if (inWorkspace(req.cwd) && Date.now() - req.ts < 5 * 60 * 1000) this.ask(req);
    }
  }

  stopListening() {
    if (!this.lastBeat) return;
    this.lastBeat = 0;
    try {
      fs.unlinkSync(this.listener);
    } catch {}
  }

  // Answers nobody picked up (the hook gave up) and old requests.
  cleanUp() {
    try {
      for (const n of fs.readdirSync(this.dir)) {
        const p = path.join(this.dir, n);
        const age = Date.now() - fs.statSync(p).mtimeMs;
        if ((/\.(request|response)\.json$/.test(n) && age > 10 * 60 * 1000) || (n.startsWith('listener-') && age > 60 * 1000)) fs.unlinkSync(p);
      }
    } catch {}
  }

  async ask(req) {
    const project = req.cwd ? path.basename(req.cwd) : 'Claude Code';
    const pick = await vscode.window.showWarningMessage(
      `Claude (terminal, ${project}) wants to ${describeToolUse(req.tool, req.input || {})}`,
      'Allow',
      'Deny'
    );
    if (!pick) return;
    const request = path.join(this.dir, `${req.id}.request.json`);
    const response = path.join(this.dir, `${req.id}.response.json`);
    if (!fs.existsSync(request) || fs.existsSync(response)) {
      vscode.window.showInformationMessage('That request was already answered, or timed out and is waiting in the terminal.');
      return;
    }
    // write then rename, so the hook never reads half an answer
    const tmp = `${response}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ behavior: pick === 'Allow' ? 'allow' : 'deny', ts: Date.now() }));
      fs.renameSync(tmp, response);
    } catch (e) {
      vscode.window.showErrorMessage(`Couldn’t send the answer: ${e.message}`);
    }
  }

  dispose() {
    clearInterval(this.timer);
    this.stopListening();
  }
}

// "run: npm test", "edit app.ts", …
function describeToolUse(tool, input) {
  const clip = (s) => {
    const one = String(s || '').replace(/\s+/g, ' ').trim();
    return one.length > 200 ? one.slice(0, 200) + '…' : one;
  };
  if (tool === 'Bash' || tool === 'PowerShell') return `run: ${clip(input.command)}`;
  if (input.file_path || input.notebook_path) return `${tool === 'Read' ? 'read' : 'edit'} ${path.basename(input.file_path || input.notebook_path)}`;
  if (input.url) return `fetch ${clip(input.url)}`;
  return `use ${tool}${Object.keys(input).length ? `: ${clip(JSON.stringify(input))}` : ''}`;
}

// A background process printed a local URL: offer to open it. Servers that
// were already running when VS Code started aren't announced.
async function announceUrl(store, rec) {
  if (rec.startTs < store.startedAt) return;
  const mode = vscode.workspace.getConfiguration('claudeCommandCenter').get('notifyServerUrl');
  if (mode === 'never' || (mode === 'unfocused' && vscode.window.state.focused)) return;
  const pick = await vscode.window.showInformationMessage(
    `${rec.description || rec.command.split(/\r?\n/)[0]} is serving ${rec.url}`,
    'Open in Browser',
    'Open in VS Code'
  );
  if (pick === 'Open in Browser') openUrl(rec.url, false);
  else if (pick === 'Open in VS Code') openUrl(rec.url, true);
}

function openUrl(url, inEditor) {
  if (!url) return;
  if (inEditor) return vscode.commands.executeCommand('simpleBrowser.show', url);
  return vscode.env.openExternal(vscode.Uri.parse(url));
}

// ---------------------------------------------------------------------------
// Session file changes: one diff per file across a session, and reverting
// them from the recorded snapshots.
// ---------------------------------------------------------------------------

// The successful edits a session made since `fromTs`, per file: its first
// edit (whose "before" is the file as it was) and its last.
function sessionFileChanges(store, sessionId, fromTs = 0) {
  const byFile = new Map();
  const edits = [...store.changes.values()]
    .filter((c) => c.session === sessionId && c.status === 'done' && c.ts >= fromTs)
    .sort((a, b) => a.ts - b.ts);
  for (const c of edits) {
    const f = byFile.get(normPath(c.file));
    if (f) {
      f.last = c;
      f.count++;
    } else {
      byFile.set(normPath(c.file), { file: c.file, first: c, last: c, count: 1 });
    }
  }
  return [...byFile.values()];
}

// The left and right side of a file's diff across a session.
function sessionDiffSides(f) {
  const ext = path.extname(f.file);
  const left = !f.first.created && f.first.before && fs.existsSync(f.first.before) ? f.first.before : emptyFile(ext);
  const right = f.last.after && fs.existsSync(f.last.after) ? f.last.after : fs.existsSync(f.file) ? f.file : emptyFile(ext);
  return { left: vscode.Uri.file(left), right: vscode.Uri.file(right) };
}

async function openFileSessionDiff(store, ch) {
  if (!ch || !ch.session) return;
  const f = sessionFileChanges(store, ch.session).find((x) => normPath(x.file) === normPath(ch.file));
  if (!f) return openChangeDiff(ch, false);
  const { left, right } = sessionDiffSides(f);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(f.file)} (whole Claude session · ${f.count} edit${f.count === 1 ? '' : 's'})`, { preview: true });
}

// Every file the session changed, in one multi-file diff editor.
async function openSessionDiff(store, sessionId, title) {
  const files = sessionFileChanges(store, sessionId);
  if (!files.length) {
    vscode.window.showInformationMessage('No file edits are recorded for this session.');
    return;
  }
  const resources = files.map((f) => {
    const { left, right } = sessionDiffSides(f);
    return [vscode.Uri.file(f.file), left, right];
  });
  try {
    await vscode.commands.executeCommand('vscode.changes', `Claude: ${title}`, resources);
  } catch {
    const pick = await vscode.window.showQuickPick(
      files.map((f) => ({ label: path.basename(f.file), description: folderLabel(f.file), f })),
      { title: `Files changed by "${title}"` }
    );
    if (pick) openFileSessionDiff(store, pick.f.last);
  }
}

const sameBytes = (a, b) => a != null && b != null && Buffer.compare(a, b) === 0;
const readOrNull = (p) => {
  try {
    return p ? fs.readFileSync(p) : null;
  } catch {
    return null;
  }
};

// What reverting one file would do, and whether it would throw away changes
// made after Claude's last edit of it.
function revertPlan(f) {
  const plan = { f, action: f.first.created ? 'delete' : 'restore' };
  if (f.first.tooLarge || f.last.tooLarge) return { ...plan, blocked: 'over 5 MB, no snapshot was kept' };
  if (plan.action === 'restore' && !readOrNull(f.first.before)) return { ...plan, blocked: 'its snapshot was already cleaned up' };
  const current = readOrNull(f.file);
  const dirty = vscode.workspace.textDocuments.some((d) => d.isDirty && normPath(d.uri.fsPath) === normPath(f.file));
  if (dirty) plan.conflict = 'it has unsaved changes in an editor';
  else if (!sameBytes(current, readOrNull(f.last.after))) plan.conflict = current == null ? 'it was deleted since' : 'it changed since Claude’s last edit';
  return plan;
}

// Restore every chosen file to how it was before the session (or turn) first
// touched it, after saving the current versions so the revert can be undone.
async function revertChanges(store, sessionId, fromTs, what, live) {
  const plans = sessionFileChanges(store, sessionId, fromTs).map(revertPlan);
  if (!plans.length) {
    vscode.window.showInformationMessage(`No file edits are recorded for ${what}.`);
    return;
  }
  const blocked = plans.filter((p) => p.blocked);
  const items = plans
    .filter((p) => !p.blocked)
    .map((p) => ({
      label: path.basename(p.f.file),
      description: folderLabel(p.f.file),
      detail: p.conflict
        ? `$(warning) Overwrites your changes: ${p.conflict}`
        : p.action === 'delete'
          ? 'Delete it (Claude created it)'
          : `Restore it to before Claude’s edit${p.f.count === 1 ? '' : 's'} (${p.f.count})`,
      picked: !p.conflict,
      plan: p,
    }));
  if (!items.length) {
    vscode.window.showWarningMessage(`Nothing can be reverted: ${blocked.map((p) => `${path.basename(p.f.file)} (${p.blocked})`).join(', ')}.`);
    return;
  }
  const picks = await vscode.window.showQuickPick(items, {
    title: `Revert ${what}`,
    placeHolder: blocked.length
      ? `Choose files to revert. ${blocked.length} can’t be: ${blocked.map((p) => path.basename(p.f.file)).join(', ')}`
      : 'Choose files to revert. Files changed since Claude edited them are unticked.',
    canPickMany: true,
    matchOnDescription: true,
  });
  if (!picks || !picks.length) return;
  const ok = await vscode.window.showWarningMessage(
    `Revert ${picks.length} file${picks.length === 1 ? '' : 's'} changed by ${what}?`,
    {
      modal: true,
      detail:
        (live === 'busy' ? 'Claude is still working in this session, and won’t know its edits were undone.\n\n' : '') +
        'The current versions are saved first, so you can undo this. Changes Claude made with shell commands aren’t covered.',
    },
    'Revert'
  );
  if (ok !== 'Revert') return;

  const dir = path.join(logDir(), 'reverts');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const undo = [];
  const failed = [];
  picks.forEach(({ plan }, i) => {
    const file = plan.f.file;
    try {
      let backup = null;
      if (fs.existsSync(file)) {
        backup = path.join(dir, `${stamp}-${i}${path.extname(file)}`);
        fs.copyFileSync(file, backup);
      }
      if (plan.action === 'delete') {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(plan.f.first.before, file);
      }
      undo.push({ file, backup });
    } catch (e) {
      failed.push(`${path.basename(file)}: ${e.message}`);
    }
  });
  if (failed.length) vscode.window.showErrorMessage(`Couldn’t revert ${failed.join('; ')}`);
  if (!undo.length) return;
  const pick = await vscode.window.showInformationMessage(`Reverted ${undo.length} file${undo.length === 1 ? '' : 's'}.`, 'Undo');
  if (pick !== 'Undo') return;
  for (const u of undo) {
    try {
      if (u.backup) {
        fs.mkdirSync(path.dirname(u.file), { recursive: true });
        fs.copyFileSync(u.backup, u.file);
      } else if (fs.existsSync(u.file)) {
        fs.unlinkSync(u.file);
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Couldn’t restore ${u.file}: ${e.message}`);
    }
  }
  vscode.window.setStatusBarMessage('Revert undone', 3000);
}

// When the turn holding the session's latest edit started: the end of the
// turn before it, or 0 if that was the first. undefined when no turn ends
// were recorded (a hook from before 0.9).
function lastTurnStart(store, sessionId) {
  const ends = store.turnEnds.get(sessionId) || [];
  if (!ends.length) return undefined;
  const edits = [...store.changes.values()].filter((c) => c.session === sessionId).map((c) => c.ts);
  const lastEdit = edits.length ? Math.max(...edits) : Infinity;
  const before = ends.filter((t) => t < lastEdit);
  return before.length ? before[before.length - 1] : 0;
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

  const index = new sessions.SessionIndex();
  const sessionsProvider = new SessionsProvider(store, index);
  const sessionsView = vscode.window.createTreeView('claudeCommandCenter.sessions', { treeDataProvider: sessionsProvider });
  new Notifier(store, index);
  const permissions = new PermissionBroker();
  const dashboard = new Dashboard(context, store, findTaskOutput, index);

  const usageItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  usageItem.command = 'claudeCommandCenter.sessions.focus';
  const updateUsage = () => {
    if (!vscode.workspace.getConfiguration('claudeCommandCenter').get('showUsage')) return usageItem.hide();
    const u = index.usage();
    usageItem.text = `$(graph) 5h: ${formatTokens(u.fiveHours.output)} out`;
    usageItem.tooltip = usageTooltip(u);
    usageItem.show();
  };

  // Transcripts are re-read every few seconds while the window has focus.
  let lastRefresh = 0;
  let lastSignature = '';
  const refreshSessions = async (force) => {
    if (!force && !vscode.window.state.focused && Date.now() - lastRefresh < 30 * 1000) return;
    lastRefresh = Date.now();
    await index.refresh(sessionDays());
    updateUsage();
    const list = sessionsProvider.list();
    const signature = list.map((s) => s.id + s.lastTs + s.live + s.title).join('|');
    if (signature === lastSignature) return;
    lastSignature = signature;
    sessionsProvider.refresh();
    sessionsView.description = list.length ? `${list.filter((s) => s.live).length} open · ${list.length}` : undefined;
    dashboard.pushState();
  };
  const sessionsTimer = setInterval(() => refreshSessions(false), 5000);
  context.subscriptions.push({ dispose: () => clearInterval(sessionsTimer) });
  store.onSessionEvent(() => refreshSessions(true));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCommandCenter.showUsage')) updateUsage();
      if (e.affectsConfiguration('claudeCommandCenter.sessionDays')) refreshSessions(true);
    })
  );
  // A session object from the Sessions view, or a session ID from the dashboard
  // or a command; looked up again for its current state.
  const sessionArg = (arg) => {
    const id = typeof arg === 'string' ? arg : arg && arg.id;
    return (id && index.get(id)) || (arg && typeof arg === 'object' ? arg : undefined);
  };

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
  reg('claudeCommandCenter.openSession', (arg) => openSession(sessionArg(arg)));
  reg('claudeCommandCenter.resumeSession', (arg) => {
    const s = sessionArg(arg);
    if (s) return resumeInTerminal(s);
  });
  reg('claudeCommandCenter.moveSession', (arg) => moveSessionTo(sessionArg(arg), index).then(() => refreshSessions(true)));
  reg('claudeCommandCenter.showSessionCommands', (arg) => {
    const s = sessionArg(arg);
    if (s) dashboard.showSession(s.id);
  });
  reg('claudeCommandCenter.copySessionId', async (arg) => {
    const s = sessionArg(arg);
    if (!s) return;
    await vscode.env.clipboard.writeText(s.id);
    vscode.window.setStatusBarMessage('Session ID copied', 2000);
  });
  reg('claudeCommandCenter.revealTranscript', (arg) => {
    const s = sessionArg(arg);
    if (s && s.file) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(s.file));
  });
  reg('claudeCommandCenter.refreshSessions', () => refreshSessions(true));

  // Session diffs and reverts take a session (Sessions view), a file change
  // (File Changes view) or a session ID (dashboard).
  const sessionIdOf = (arg) => (arg && arg.kind === 'change' ? arg.session : (sessionArg(arg) || {}).id);
  const titleOf = (id) => sessionLabel(index.get(id) || { id });
  reg('claudeCommandCenter.sessionDiff', (arg) => {
    const id = sessionIdOf(arg);
    if (id) return openSessionDiff(store, id, titleOf(id));
  });
  reg('claudeCommandCenter.fileSessionDiff', (ch) => openFileSessionDiff(store, ch));
  reg('claudeCommandCenter.revertSession', (arg) => {
    const id = sessionIdOf(arg);
    if (id) return revertChanges(store, id, 0, `session "${titleOf(id)}"`, (index.get(id) || {}).live);
  });
  reg('claudeCommandCenter.revertLastTurn', (arg) => {
    const id = sessionIdOf(arg);
    if (!id) return;
    const from = lastTurnStart(store, id);
    if (from === undefined) {
      vscode.window.showInformationMessage(
        'No turn ends are recorded for this session yet. They are recorded by the hook from version 0.9, in sessions started after updating it.'
      );
      return;
    }
    return revertChanges(store, id, from, `the last turn of "${titleOf(id)}"`, (index.get(id) || {}).live);
  });
  reg('claudeCommandCenter.revertFromHere', (ch) => {
    if (!ch || !ch.session) return;
    return revertChanges(store, ch.session, ch.ts, `this and later edits of "${titleOf(ch.session)}"`, (index.get(ch.session) || {}).live);
  });
  const transcripts = new TranscriptViews(context, index, sessionLabel);
  reg('claudeCommandCenter.viewTranscript', (arg) => {
    const id = sessionIdOf(arg);
    if (id) transcripts.open(id);
  });
  // A command or file change: its tool call in the transcript.
  reg('claudeCommandCenter.showInTranscript', async (rec) => {
    if (!rec || !rec.session) return;
    if (!index.get(rec.session)) await refreshSessions(true);
    transcripts.open(rec.session, { toolId: rec.id });
  });
  reg('claudeCommandCenter.searchSessions', async () => {
    const query = await vscode.window.showInputBox({
      title: 'Search Claude Code sessions',
      prompt: `Prompts, replies and tool calls in ${store.scope === 'all' ? 'all projects' : 'this workspace’s sessions'}, last ${sessionDays()} days`,
      placeHolder: 'Text to find',
    });
    if (!query || !query.trim()) return;
    const list = sessionsProvider.list().map((s) => ({ file: s.file, session: s.id }));
    const hits = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Searching ${list.length} sessions…` },
      () => searchTranscripts(list, query.trim())
    );
    if (!hits.length) {
      vscode.window.showInformationMessage(`No matches for "${query.trim()}".`);
      return;
    }
    const icon = { user: '$(account)', assistant: '$(sparkle)', tool: '$(tools)', thinking: '$(lightbulb)' };
    const pick = await vscode.window.showQuickPick(
      hits.map((h) => ({
        label: `${icon[h.kind] || '$(comment)'} ${h.snippet}`,
        description: `${titleOf(h.session)} · ${h.ts ? formatWhen(h.ts) : ''}`,
        hit: h,
      })),
      { title: `${hits.length}${hits.length >= 200 ? '+' : ''} matches for "${query.trim()}"`, matchOnDescription: true }
    );
    if (pick) transcripts.open(pick.hit.session, { uuid: pick.hit.uuid, toolId: pick.hit.toolId, query: query.trim() });
  });
  reg('claudeCommandCenter.openUrl', (rec) => rec && openUrl(rec.url, false));
  reg('claudeCommandCenter.openUrlInEditor', (rec) => rec && openUrl(rec.url, true));
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
  refreshSessions(true);
  checkSetup(context);

  context.subscriptions.push(view, changesView, sessionsView, status, usageItem, { dispose: () => store.dispose() }, provider, terminals, permissions);
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
