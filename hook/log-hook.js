#!/usr/bin/env node
// Claude Code hook: records every Bash/PowerShell tool call, every file edit
// (with before/after snapshots), and turn ends, subagents and permission
// prompts, to ~/.claude/command-center/log/events.jsonl so the VS Code
// extension can show it.
// It never blocks the tool call: it always exits 0, and prints nothing except
// a permission decision made in VS Code (see askVsCode).

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
    if (ev) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      rotateIfLarge();
      fs.appendFileSync(EVENTS_FILE, JSON.stringify(ev) + '\n');
    }
    // Create ~/.claude/command-center/log/debug to also record the raw hook payloads.
    if (process.env.CLAUDE_COMMAND_CENTER_DEBUG || fs.existsSync(path.join(LOG_DIR, 'debug'))) {
      fs.appendFileSync(path.join(LOG_DIR, 'raw.jsonl'), raw.trim() + '\n');
    }
  } catch {}
  process.exit(0);
});
