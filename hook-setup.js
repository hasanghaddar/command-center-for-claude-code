// Registers / removes the logging hook in Claude Code's user settings.
// Plain Node (no vscode import) so the uninstall script can use it too.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MATCHER = 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit';
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
// Registered without a matcher: every prompt, turn end, subagent, notification
// and permission request.
const SESSION_EVENTS = ['UserPromptSubmit', 'Stop', 'SubagentStart', 'SubagentStop', 'Notification', 'PermissionRequest'];
// Events newer Claude Code versions added, with the version that added them.
// It isn't documented what an older Claude Code does with a hook event it
// doesn't know, so these are registered only when every Claude Code seen on
// this machine is new enough (see claudeVersion).
const SINCE = { StopFailure: '2.1.78' }; // a turn that ends in an API error
// Seconds Claude Code lets the hook run. A permission request can wait for an
// answer from VS Code (up to the permissionTimeoutSeconds setting, max 300).
const timeoutFor = (ev) => (ev === 'PermissionRequest' ? 310 : 10);
const EVENTS = [...TOOL_EVENTS, ...SESSION_EVENTS]; // always registered
const ALL_EVENTS = [...EVENTS, ...Object.keys(SINCE)];
const matcherFor = (ev) => (TOOL_EVENTS.includes(ev) ? MATCHER : undefined);

// Whether dotted version a is at least b.
function atLeast(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return true;
}

// The events to register for a Claude Code of this version (undefined: not known).
function eventsFor(version) {
  return ALL_EVENTS.filter((ev) => !SINCE[ev] || (!!version && atLeast(version, SINCE[ev])));
}

// The oldest Claude Code in use here: the ones running now (each writes its
// version to ~/.claude/sessions/<pid>.json) and any passed in, such as the
// editor's Claude Code extension. undefined when none is known.
function claudeVersion(...known) {
  const versions = known.filter(Boolean);
  try {
    const dir = path.join(claudeDir(), 'sessions');
    for (const n of fs.readdirSync(dir)) {
      if (!/^\d+\.json$/.test(n)) continue;
      try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')).version;
        if (typeof v === 'string') versions.push(v);
      } catch {}
    }
  } catch {}
  return versions.reduce((oldest, v) => (oldest === undefined || !atLeast(v, oldest) ? v : oldest), undefined);
}

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function settingsPath() {
  return path.join(claudeDir(), 'settings.json');
}

// ~/.claude/command-center/{hook,log}. The hook lives apart from the log so
// uninstalling can remove it without touching the recorded history.
function homeDir() {
  return path.join(claudeDir(), 'command-center');
}

function defaultLogDir() {
  return path.join(homeDir(), 'log');
}

// Stable location, so the registered command doesn't change between versions.
function installedHookPath() {
  return path.join(homeDir(), 'hook', 'log-hook.js');
}

// Where versions before the rename to Command Center kept things.
const LEGACY = {
  hookDir: () => path.join(claudeDir(), 'process-monitor'),
  logDir: () => path.join(claudeDir(), 'process-log'),
};

function hookCommand() {
  return `node "${installedHookPath().replace(/\\/g, '/')}"`;
}

// For machines without Node.js: run the hook on the editor's own runtime
// (VS Code, Cursor, … are Electron apps, which act as Node.js with this
// variable set). `execPath` is the extension host's process.execPath.
function runtimeHookCommand(execPath) {
  return `ELECTRON_RUN_AS_NODE=1 "${execPath.replace(/\\/g, '/')}" "${installedHookPath().replace(/\\/g, '/')}"`;
}

// 'ok' | 'stale' (runs on an editor that is gone or has moved) | 'other'
function commandState(command) {
  if (command === hookCommand()) return 'ok';
  const m = /^ELECTRON_RUN_AS_NODE=1 "([^"]+)" "([^"]+)"$/.exec(command);
  if (!m || m[2] !== installedHookPath().replace(/\\/g, '/')) return 'other';
  return fs.existsSync(m[1]) ? 'ok' : 'stale';
}

// Ours, including older installs and copies registered by hand from a
// checkout of this repo.
function isOurHook(h) {
  return (
    h &&
    typeof h.command === 'string' &&
    /log-hook\.js/.test(h.command) &&
    /(command-center|process-monitor)/.test(h.command)
  );
}

// Events store snapshot paths, so point those at the new folder too.
function rewriteEvents(text, fromRoot, toRoot) {
  const json = (p) => JSON.stringify(p).slice(1, -1);
  return text.split(json(fromRoot)).join(json(toRoot));
}

// Event lines from several files, sorted by their timestamp (stable, so lines
// with equal or missing times keep their order).
function mergeByTime(...texts) {
  const lines = texts.flatMap((t) => t.split('\n').filter((l) => l.trim()));
  const ts = (l) => {
    try {
      return JSON.parse(l).ts || 0;
    } catch {
      return 0;
    }
  };
  return lines
    .map((l, i) => ({ l, i, t: ts(l) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.l + '\n')
    .join('');
}

function moveContents(from, to, fromRoot = from, toRoot = to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (fs.statSync(src).isDirectory()) {
      moveContents(src, dest, fromRoot, toRoot);
      fs.rmSync(src, { recursive: true, force: true });
    } else if (/^events\.jsonl(\.1)?$/.test(name)) {
      const moved = rewriteEvents(fs.readFileSync(src, 'utf8'), fromRoot, toRoot);
      // The old hook can keep writing here until setup re-registers it, so
      // the two files overlap in time: merge them in time order.
      const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
      fs.writeFileSync(dest, mergeByTime(moved, existing));
      fs.unlinkSync(src);
    } else if (!fs.existsSync(dest)) {
      fs.renameSync(src, dest);
    } else {
      fs.unlinkSync(src);
    }
  }
}

// Move history from the pre-rename folder, and drop the old hook copy once
// it is no longer registered. Safe to call repeatedly.
function migrateLegacy() {
  const oldLog = LEGACY.logDir();
  if (fs.existsSync(oldLog)) {
    moveContents(oldLog, defaultLogDir());
    fs.rmSync(oldLog, { recursive: true, force: true });
  }
  const oldHookDir = LEGACY.hookDir();
  if (fs.existsSync(oldHookDir)) {
    const stillUsed = JSON.stringify(readSettings().hooks || {}).includes('process-monitor');
    if (!stillUsed) fs.rmSync(oldHookDir, { recursive: true, force: true });
  }
}

function readSettings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text); // throws on invalid JSON; callers report it
}

function writeSettings(settings) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-command-center');
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

// Copy the bundled hook over the installed one when they differ.
function installHookFile(bundledHook) {
  const dest = installedHookPath();
  const src = fs.readFileSync(bundledHook);
  try {
    if (Buffer.compare(fs.readFileSync(dest), src) === 0) return false;
  } catch {}
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, src);
  return true;
}

// 'ok' | 'missing' | 'outdated' (ours, but an old path or matcher, or an
// event not registered yet) | 'stale' (ours and current, but the editor
// runtime it runs on is gone).
// version: the Claude Code in use (claudeVersion), which decides whether the
// newer events are expected. One of those already registered is fine either way.
function hookStatus(version) {
  const s = readSettings();
  const state = {}; // event -> 'ok' | 'stale'
  let ours = 0;
  let wrong = 0;
  for (const ev of ALL_EVENTS) {
    for (const m of (s.hooks && s.hooks[ev]) || []) {
      for (const h of m.hooks || []) {
        if (!isOurHook(h)) continue;
        ours++;
        const st = (m.matcher || undefined) === matcherFor(ev) ? commandState(h.command) : 'other';
        if (st === 'other' || state[ev]) wrong++; // an old path or matcher, or registered twice
        else state[ev] = st;
      }
    }
  }
  const complete = !wrong && eventsFor(version).every((ev) => state[ev]);
  if (complete) return Object.values(state).includes('stale') ? 'stale' : 'ok';
  return ours ? 'outdated' : 'missing';
}

function withoutOurHooks(groups) {
  return (groups || [])
    .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurHook(h)) }))
    .filter((m) => m.hooks.length);
}

// version: the Claude Code in use (claudeVersion). A newer event that is
// registered already stays registered when the version isn't known this time.
function registerHooks(command = hookCommand(), version) {
  const s = readSettings();
  s.hooks = s.hooks || {};
  const wanted = eventsFor(version);
  for (const ev of ALL_EVENTS) {
    const had = (s.hooks[ev] || []).some((m) => (m.hooks || []).some(isOurHook));
    s.hooks[ev] = withoutOurHooks(s.hooks[ev]);
    if (wanted.includes(ev) || (SINCE[ev] && had)) {
      const group = { hooks: [{ type: 'command', command, timeout: timeoutFor(ev) }] };
      if (matcherFor(ev)) group.matcher = matcherFor(ev);
      s.hooks[ev].push(group);
    }
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  writeSettings(s);
}

function unregisterHooks() {
  const s = readSettings();
  if (!s.hooks) return false;
  let changed = false;
  for (const ev of Object.keys(s.hooks)) {
    const before = JSON.stringify(s.hooks[ev]);
    s.hooks[ev] = withoutOurHooks(s.hooks[ev]);
    if (JSON.stringify(s.hooks[ev]) !== before) changed = true;
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  if (changed) writeSettings(s);
  return changed;
}

module.exports = {
  EVENTS,
  ALL_EVENTS,
  eventsFor,
  claudeVersion,
  claudeDir,
  homeDir,
  mergeByTime,
  settingsPath,
  readSettings,
  defaultLogDir,
  installedHookPath,
  hookCommand,
  runtimeHookCommand,
  isOurHook,
  migrateLegacy,
  installHookFile,
  hookStatus,
  registerHooks,
  unregisterHooks,
};
