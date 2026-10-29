// Registers / removes the logging hook in Claude Code's user settings.
// Plain Node (no vscode import) so the uninstall script can use it too.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MATCHER = 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit';
const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];

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
      // keep older events first so the history stays in order
      const existing = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
      fs.writeFileSync(dest, moved + existing);
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

// 'ok' | 'missing' | 'outdated' (ours, but an old path or matcher)
function hookStatus() {
  const s = readSettings();
  const want = hookCommand();
  let ok = 0;
  let ours = 0;
  for (const ev of EVENTS) {
    for (const m of (s.hooks && s.hooks[ev]) || []) {
      for (const h of m.hooks || []) {
        if (!isOurHook(h)) continue;
        ours++;
        if (h.command === want && m.matcher === MATCHER) ok++;
      }
    }
  }
  if (ok === EVENTS.length && ours === EVENTS.length) return 'ok';
  return ours ? 'outdated' : 'missing';
}

function withoutOurHooks(groups) {
  return (groups || [])
    .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurHook(h)) }))
    .filter((m) => m.hooks.length);
}

function registerHooks() {
  const s = readSettings();
  s.hooks = s.hooks || {};
  for (const ev of EVENTS) {
    s.hooks[ev] = withoutOurHooks(s.hooks[ev]);
    s.hooks[ev].push({ matcher: MATCHER, hooks: [{ type: 'command', command: hookCommand(), timeout: 10 }] });
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

module.exports = { settingsPath, defaultLogDir, installedHookPath, migrateLegacy, installHookFile, hookStatus, registerHooks, unregisterHooks };
