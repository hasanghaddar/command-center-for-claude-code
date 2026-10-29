#!/usr/bin/env node
// Claude Code hook: records every Bash/PowerShell tool call, and every file
// edit (with before/after snapshots), to ~/.claude/command-center/log/events.jsonl
// so the VS Code extension can show it.
// It never blocks the tool call: it prints nothing and always exits 0.

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

function buildEvent(input) {
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

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
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
