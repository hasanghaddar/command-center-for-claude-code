#!/usr/bin/env node
// Claude Code hook: records every Bash/PowerShell tool call, every file edit
// (with before/after snapshots, including files a shell command changed in a
// git repo), and turn ends, subagents and permission
// prompts, to ~/.claude/command-center/log/events.jsonl so the VS Code
// extension can show it.
// It never blocks the tool call: it always exits 0, and prints nothing except
// a permission decision made in VS Code (see askVsCode).

const cp = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR =
  process.env.CLAUDE_COMMAND_CENTER_LOG_DIR ||
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'command-center', 'log');
const EVENTS_FILE = path.join(LOG_DIR, 'events.jsonl');
const MAX_OUTPUT = 256 * 1024;
const MAX_EVENTS_BYTES = 20 * 1024 * 1024;

function clip(value) {
  if (typeof value !== 'string') return value;
  if (value.length <= MAX_OUTPUT) return value;
  return value.slice(0, MAX_OUTPUT / 2) + '\n\n… [output truncated by process monitor] …\n\n' + value.slice(-MAX_OUTPUT / 2);
}

function rotateIfLarge() {
  try {
    if (fs.statSync(EVENTS_FILE).size > MAX_EVENTS_BYTES) {
      fs.renameSync(EVENTS_FILE, EVENTS_FILE + '.1');
    }
  } catch {}
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SNAPSHOT_DIR = path.join(LOG_DIR, 'snapshots');
const MAX_SNAPSHOT = 5 * 1024 * 1024;
const MAX_SNIPPET = 64 * 1024;

// Copy the file as it is right now to snapshots/<id>.<when><ext>, keeping the
// extension so the diff editor picks the right language.
function snapshot(id, file, when) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SNAPSHOT) return { exists: true, tooLarge: st.size > MAX_SNAPSHOT };
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const dest = path.join(SNAPSHOT_DIR, `${id.replace(/[^\w.-]/g, '_')}.${when}${path.extname(file)}`);
    fs.copyFileSync(file, dest);
    return { exists: true, path: dest };
  } catch {
    return { exists: false };
  }
}

function snippet(s) {
  return typeof s === 'string' && s.length > MAX_SNIPPET ? s.slice(0, MAX_SNIPPET) + '\n…' : s;
}

function buildFileEvent(input, base) {
  const ti = input.tool_input || {};
  const file = ti.file_path || ti.notebook_path;
  if (!file || !base.id) return null;
  if (input.hook_event_name === 'PreToolUse') {
    const before = snapshot(base.id, file, 'before');
    const ev = { ...base, type: 'fileStart', file, cwd: input.cwd, existed: before.exists, before: before.path, tooLarge: before.tooLarge };
    if (input.tool_name === 'Edit') {
      ev.oldString = snippet(ti.old_string);
      ev.newString = snippet(ti.new_string);
      ev.replaceAll = !!ti.replace_all;
    } else if (input.tool_name === 'MultiEdit' && Array.isArray(ti.edits)) {
      ev.edits = ti.edits.length;
    }
    return ev;
  }
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const after = failed ? {} : snapshot(base.id, file, 'after');
  const ev = { ...base, type: 'fileEnd', file, failed, after: after.path, tooLarge: after.tooLarge };
  if (failed && input.error) ev.error = clip(typeof input.error === 'string' ? input.error : JSON.stringify(input.error));
  return ev;
}

// ---------------------------------------------------------------------------
// Files changed by shell commands. Before a foreground Bash/PowerShell call in
// a git repo, note HEAD and copy the files that already differ from it. After
// it, every file that differs from that state was changed by the command; its
// "before" is the copy, or the file at that HEAD.
// ---------------------------------------------------------------------------

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const SHELL_STATE_DIR = path.join(LOG_DIR, 'shell');
const MAX_DIRTY = 500; // more files than this already changed: don't track
const MAX_DIRTY_BYTES = 50 * 1024 * 1024;
const MAX_SHELL_CHANGES = 200;
const STALE_STATE_MS = 24 * 60 * 60 * 1000;

function git(cwd, args) {
  return cp.execFileSync('git', args, { cwd, windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

// Where the command runs: the session's folder, or the one a leading
// `cd <dir> &&` / `cd <dir>;` moves to.
function shellDir(input) {
  const cwd = input.cwd || process.cwd();
  const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;|\n)/.exec((input.tool_input || {}).command || '');
  if (!m) return cwd;
  const dir = (m[1] || m[2] || m[3]).replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(cwd, dir);
}

// Paths (relative to the repo root) that differ from HEAD or the index,
// untracked ones included.
function gitDirtyPaths(root) {
  const out = git(root, ['status', '--porcelain=v1', '-z', '-uall']).toString('utf8').split('\0');
  const paths = [];
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') paths.push(out[++i]); // the rename's source
  }
  return paths;
}

// Store contents once per hash, keeping the extension so diffs get the right
// language. Reusing a copy refreshes its age so it isn't pruned while in use.
function storeBlob(buf, file) {
  const dest = path.join(SNAPSHOT_DIR, `blob-${crypto.createHash('sha1').update(buf).digest('hex')}${path.extname(file)}`);
  try {
    const now = new Date();
    fs.utimesSync(dest, now, now);
  } catch {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  return dest;
}

const shellStateFile = (id) => path.join(SHELL_STATE_DIR, `${id.replace(/[^\w.-]/g, '_')}.json`);

function shellBefore(input) {
  const ti = input.tool_input || {};
  if (!input.tool_use_id || ti.run_in_background) return; // a background task changes files after its hook has run
  let root;
  try {
    root = git(shellDir(input), ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  } catch {
    return; // not in a git repo, or no git
  }
  let head = null;
  try {
    head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']).toString('utf8').trim();
  } catch {}
  const paths = gitDirtyPaths(root);
  if (paths.length > MAX_DIRTY) return;
  const dirty = {};
  let bytes = 0;
  for (const rel of paths) {
    const file = path.join(root, rel);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      const entry = { size: st.size, mtime: st.mtimeMs };
      if (st.size > MAX_SNAPSHOT || bytes + st.size > MAX_DIRTY_BYTES) entry.tooLarge = true;
      else {
        entry.blob = storeBlob(fs.readFileSync(file), file);
        bytes += st.size;
      }
      dirty[rel] = entry;
    } catch {
      dirty[rel] = { missing: true };
    }
  }
  fs.mkdirSync(SHELL_STATE_DIR, { recursive: true });
  fs.writeFileSync(shellStateFile(input.tool_use_id), JSON.stringify({ root, head, ts: Date.now(), dirty }));
  // State left by calls that never finished (denied, or Claude Code quit).
  try {
    for (const n of fs.readdirSync(SHELL_STATE_DIR)) {
      const p = path.join(SHELL_STATE_DIR, n);
      if (Date.now() - fs.statSync(p).mtimeMs > STALE_STATE_MS) fs.unlinkSync(p);
    }
  } catch {}
}

// fileStart/fileEnd pairs, one per file the command changed.
function shellAfter(input, base) {
  if (!input.tool_use_id) return [];
  const stateFile = shellStateFile(input.tool_use_id);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.unlinkSync(stateFile);
  } catch {
    return [];
  }
  const { root, head, dirty } = state;
  const candidates = new Set([...Object.keys(dirty), ...gitDirtyPaths(root)]);
  // A commit or checkout during the command: files may now match the new HEAD
  // but still differ from the one before.
  let headNow = null;
  try {
    headNow = git(root, ['rev-parse', '--verify', '-q', 'HEAD']).toString('utf8').trim();
  } catch {}
  if (head && headNow !== head) {
    for (const rel of git(root, ['diff', '--name-only', '-z', head]).toString('utf8').split('\0')) if (rel) candidates.add(rel);
  }

  const ti = input.tool_input || {};
  const via = ti.description || String(ti.command || '').split('\n')[0];
  const events = [];
  for (const rel of candidates) {
    if (events.length >= MAX_SHELL_CHANGES * 2) break;
    const file = path.join(root, rel);
    let st = null;
    try {
      st = fs.statSync(file);
      if (!st.isFile()) continue;
    } catch {}
    const was = dirty[rel];
    if (was && !was.missing && st && st.size === was.size && st.mtimeMs === was.mtime) continue; // untouched

    // The file as it was: the copy if it already differed from HEAD, else HEAD's.
    let before = null;
    let tooLarge = false;
    if (was) {
      if (was.tooLarge) tooLarge = true;
      else if (was.blob) before = readOrNull(was.blob);
    } else if (head) {
      try {
        before = git(root, ['cat-file', 'blob', `${head}:${rel}`]);
      } catch {} // not in HEAD
    }
    const after = st ? (st.size > MAX_SNAPSHOT ? null : readOrNull(file)) : null;
    if (st && st.size > MAX_SNAPSHOT) tooLarge = true;
    if (!tooLarge && before == null && after == null) continue;
    if (!tooLarge && before && after && Buffer.compare(before, after) === 0) continue;

    const ev = { ...base, id: `${base.id}:${rel}`, toolId: base.id, file, via };
    events.push({
      ...ev,
      type: 'fileStart',
      ts: state.ts,
      cwd: input.cwd,
      existed: was ? !was.missing : before != null,
      before: before && storeBlob(before, file),
      tooLarge: tooLarge || undefined,
    });
    events.push({ ...ev, type: 'fileEnd', failed: false, after: after && storeBlob(after, file), deleted: !st || undefined, tooLarge: tooLarge || undefined });
  }
  return events;
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// Session-level events: a turn ending, subagents starting and stopping, and
// Claude asking for permission or input. They drive the extension's notifications.
const SESSION_EVENTS = {
  Stop: 'turnEnd',
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentEnd',
  Notification: 'attention',
};
const MAX_MESSAGE = 300;

function buildSessionEvent(input) {
  const ev = {
    type: SESSION_EVENTS[input.hook_event_name],
    session: input.session_id || null,
    cwd: input.cwd,
    ts: Date.now(),
  };
  const text = input.last_assistant_message || input.message;
  if (typeof text === 'string' && text.trim()) {
    ev.message = text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE) + '…' : text;
  }
  if (input.agent_id) ev.agentId = input.agent_id;
  if (input.agent_type) ev.agentType = input.agent_type;
  if (input.notification_type) ev.kind = input.notification_type;
  return ev;
}

function buildEvent(input) {
  if (SESSION_EVENTS[input.hook_event_name]) return buildSessionEvent(input);

  const ti = input.tool_input || {};
  const base = {
    id: input.tool_use_id || null,
    session: input.session_id || null,
    tool: input.tool_name || null,
    ts: Date.now(),
  };

  if (FILE_TOOLS.has(input.tool_name)) return buildFileEvent(input, base);

  switch (input.hook_event_name) {
    case 'PreToolUse':
      return {
        ...base,
        type: 'start',
        command: ti.command,
        description: ti.description,
        background: !!ti.run_in_background,
        timeout: ti.timeout,
        cwd: input.cwd,
        transcript: input.transcript_path,
      };
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const r = input.tool_response;
      const ev = {
        ...base,
        type: 'end',
        failed: input.hook_event_name === 'PostToolUseFailure',
        command: ti.command, // lets the extension pair start/end if tool_use_id is missing
        durationMs: input.duration_ms,
      };
      if (input.is_interrupt) ev.interrupted = true;
      if (r && typeof r === 'object') {
        ev.stdout = clip(r.stdout);
        ev.stderr = clip(r.stderr);
        ev.interrupted = r.interrupted;
        ev.exitCode = r.exitCode ?? r.exit_code ?? r.code;
        ev.backgroundTaskId = r.backgroundTaskId;
        ev.outputFile = r.outputFile || r.output_file || r.outputPath;
        ev.responseKeys = Object.keys(r);
      } else if (r !== undefined) {
        ev.stdout = clip(String(r));
      }
      if (input.error) {
        const err = typeof input.error === 'string' ? input.error : JSON.stringify(input.error);
        ev.error = clip(err);
        // Bash failures arrive as "Exit code N\n<output>"
        const m = /^Exit code (\d+)/.exec(err);
        if (m && ev.exitCode == null) ev.exitCode = Number(m[1]);
      }
      return ev;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Permission requests: for sessions running in a terminal, ask the VS Code
// window that has the project open, if one has this turned on. It answers by
// writing permissions/<id>.response.json. If no window is listening, or none
// answers in time, nothing is printed and Claude Code asks in the terminal.
// ---------------------------------------------------------------------------

const PERMISSION_DIR = path.join(LOG_DIR, 'permissions');
const LISTENER_FRESH_MS = 15 * 1000;
const MAX_TOOL_INPUT = 4 * 1024;

const normPath = (p) => {
  const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

// Claude Code sessions in its VS Code panel ask there already.
function inVsCodePanel(sessionId) {
  if (process.env.CLAUDE_CODE_ENTRYPOINT) return process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode';
  try {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
    for (const n of fs.readdirSync(dir)) {
      const s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (s.sessionId === sessionId) return s.entrypoint === 'claude-vscode';
    }
  } catch {}
  return false;
}

// The longest wait among VS Code windows listening for this folder, or 0.
function listenerTimeout(cwd) {
  let best = 0;
  let names = [];
  try {
    names = fs.readdirSync(PERMISSION_DIR).filter((n) => /^listener-.*\.json$/.test(n));
  } catch {}
  const target = cwd ? normPath(cwd) : '';
  for (const n of names) {
    try {
      const l = JSON.parse(fs.readFileSync(path.join(PERMISSION_DIR, n), 'utf8'));
      if (Date.now() - l.ts > LISTENER_FRESH_MS) continue;
      const covers = (l.folders || []).some((f) => target === normPath(f) || target.startsWith(normPath(f) + '/'));
      if (covers) best = Math.max(best, (l.timeoutSeconds || 60) * 1000);
    } catch {}
  }
  return best;
}

function clipInput(ti) {
  const json = JSON.stringify(ti || {});
  if (json.length <= MAX_TOOL_INPUT) return ti;
  const out = {};
  for (const [k, v] of Object.entries(ti)) out[k] = typeof v === 'string' && v.length > 1000 ? v.slice(0, 1000) + '…' : v;
  return out;
}

async function askVsCode(input) {
  if (inVsCodePanel(input.session_id)) return;
  const timeout = listenerTimeout(input.cwd);
  if (!timeout) return;
  const id = `${Date.now()}-${process.pid}`;
  const request = path.join(PERMISSION_DIR, `${id}.request.json`);
  const response = path.join(PERMISSION_DIR, `${id}.response.json`);
  fs.writeFileSync(
    request,
    JSON.stringify({ id, session: input.session_id, cwd: input.cwd, tool: input.tool_name, input: clipInput(input.tool_input), ts: Date.now() })
  );
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      let answer;
      try {
        answer = JSON.parse(fs.readFileSync(response, 'utf8'));
      } catch {
        continue; // not answered yet
      }
      const decision =
        answer.behavior === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: answer.message || 'Denied from VS Code.' };
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
      return;
    }
  } finally {
    for (const f of [request, response]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw);
    if (input.hook_event_name === 'PermissionRequest') {
      await askVsCode(input);
      process.exit(0);
    }
    const ev = buildEvent(input);
    const events = ev ? [ev] : [];
    if (SHELL_TOOLS.has(input.tool_name)) {
      try {
        if (input.hook_event_name === 'PreToolUse') shellBefore(input);
        else events.push(...shellAfter(input, { session: ev.session, tool: ev.tool, id: ev.id, ts: ev.ts }));
      } catch {}
    }
    if (events.length) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      rotateIfLarge();
      fs.appendFileSync(EVENTS_FILE, events.map((e) => JSON.stringify(e) + '\n').join(''));
    }
    // Create ~/.claude/command-center/log/debug to also record the raw hook payloads.
    if (process.env.CLAUDE_COMMAND_CENTER_DEBUG || fs.existsSync(path.join(LOG_DIR, 'debug'))) {
      fs.appendFileSync(path.join(LOG_DIR, 'raw.jsonl'), raw.trim() + '\n');
    }
  } catch {}
  process.exit(0);
});
