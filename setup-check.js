// "Check Setup": finds out why commands Claude Code runs might not reach
// Command Center. Runs the registered hook the way Claude Code would and
// compares the Claude Code sessions on disk with the ones the hook recorded.
// Plain Node (no vscode import); the extension passes in what it knows.

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hookSetup = require('./hook-setup');

const DAY = 24 * 60 * 60 * 1000;

const normPath = (p) => {
  const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { exists: true, data: text.trim() ? JSON.parse(text) : {} };
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, data: {} };
    return { exists: true, data: {}, error: e.message };
  }
}

// Claude Code runs hook commands with Git Bash on Windows.
function findGitBash() {
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH];
  try {
    const git = cp.execFileSync('where', ['git'], { windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .split(/\r?\n/)[0]
      .trim();
    if (git) candidates.push(path.join(path.dirname(git), '..', 'bin', 'bash.exe'));
  } catch {}
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  }
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

// Run a hook command with a check payload, as Claude Code would run it.
function runHook(command, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const bash = process.platform === 'win32' ? findGitBash() : null;
    const shell = bash || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
    let child;
    try {
      child = bash ? cp.spawn(bash, ['-c', command], { windowsHide: true }) : cp.spawn(command, { shell: true, windowsHide: true });
    } catch (e) {
      return resolve({ shell, error: e.message });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ shell, error: e.message, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let report = null;
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const o = JSON.parse(line);
          if (o && o.commandCenterCheck) report = o;
        } catch {}
      }
      resolve({ shell, code, report, stdout, stderr, timedOut });
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'CommandCenterCheck' }));
  });
}

function managedSettingsPath() {
  if (process.platform === 'win32') return path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json');
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

// The command our PreToolUse hook is registered with, or the one setup would register.
function registeredCommand(settings) {
  for (const m of (settings.hooks && settings.hooks.PreToolUse) || []) {
    for (const h of m.hooks || []) if (hookSetup.isOurHook(h)) return h.command;
  }
  return hookSetup.hookCommand();
}

// Session ids the hook has recorded anything for.
function recordedSessions(store) {
  const seen = new Set();
  for (const r of store.records.values()) if (r.session) seen.add(r.session);
  for (const c of store.changes.values()) if (c.session) seen.add(c.session);
  for (const id of store.turnEnds.keys()) seen.add(id);
  return seen;
}

const isSdk = (s) => /^sdk/.test(s.entrypoint || '') || /^sdk/.test(s.liveEntrypoint || '');

// Claude Code sessions active since `since` that the hook recorded nothing
// for. `settled` leaves out sessions too new to have sent anything yet.
function unrecordedSessions({ store, sessions, since, inScope = () => true, settled = 0 }) {
  const seen = recordedSessions(store);
  const now = Date.now();
  return sessions.filter(
    (s) =>
      s.lastTs > since &&
      now - (s.firstTs || s.lastTs) > settled &&
      !seen.has(s.id) &&
      !isSdk(s) &&
      inScope(s)
  );
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// Each item: { level: 'ok' | 'warn' | 'error' | 'info', title, detail?, fix? }
async function runChecks(ctx) {
  const items = [];
  const add = (level, title, detail, fix) => items.push({ level, title, detail, fix });
  const configDir = hookSetup.claudeDir();

  if (ctx.remoteName) {
    add(
      'info',
      `VS Code is connected to a remote (${ctx.remoteName})`,
      'Command Center runs on the remote side, so it only sees Claude Code sessions running there too.',
      'Run Claude Code inside the remote (for example in its terminal), not on your local machine.'
    );
  }
  add(
    'info',
    `Claude Code folder: ${configDir}`,
    (process.env.CLAUDE_CONFIG_DIR ? 'Set by CLAUDE_CONFIG_DIR. ' : '') +
      'Claude Code must use this same folder (same CLAUDE_CONFIG_DIR, same user, not inside WSL), or the hook and Command Center look in different places.'
  );

  // settings.json and hook registration
  const settingsFile = hookSetup.settingsPath();
  const settings = readJson(settingsFile);
  if (settings.error) {
    add('error', `${settingsFile} can't be read`, settings.error, 'Fix the JSON in that file. Claude Code ignores its settings, hooks included, while it is invalid.');
  } else {
    const status = hookSetup.hookStatus();
    if (status === 'ok') add('ok', 'The hook is registered in Claude Code\'s settings');
    else if (status === 'outdated') add('error', 'The hook registration is from an older version', undefined, 'Run "Command Center: Set Up Hooks".');
    else add('error', `The hook is not registered in ${settingsFile}`, undefined, 'Run "Command Center: Set Up Hooks".');
    if (settings.data.disableAllHooks) add('error', `disableAllHooks is on in ${settingsFile}`, 'Claude Code runs no hooks at all.', 'Remove "disableAllHooks" from that file.');
  }
  for (const folder of ctx.workspaceFolders || []) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = path.join(folder, '.claude', name);
      const s = readJson(file);
      if (s.data && s.data.disableAllHooks) add('error', `disableAllHooks is on in ${file}`, 'Claude Code runs no hooks in this project.', 'Remove "disableAllHooks" from that file.');
    }
  }
  const managedFile = managedSettingsPath();
  const managed = readJson(managedFile);
  if (managed.data.disableAllHooks) {
    add('error', 'Hooks are turned off by your organization', `${managedFile} sets disableAllHooks.`, 'Ask your administrator to allow hooks.');
  } else if (managed.data.allowManagedHooksOnly) {
    add('error', 'Only hooks set by your organization may run', `${managedFile} sets allowManagedHooksOnly, so Claude Code skips the Command Center hook.`, 'Ask your administrator to allow user hooks.');
  }

  // Run the hook the way Claude Code does
  const installed = hookSetup.installedHookPath();
  if (!fs.existsSync(installed)) {
    add('error', `The hook script is missing: ${installed}`, undefined, 'Run "Command Center: Set Up Hooks".');
  }
  const command = settings.error ? hookSetup.hookCommand() : registeredCommand(settings.data);
  const run = await runHook(command);
  const output = [run.error, run.stderr && run.stderr.trim(), run.stdout && !run.report && run.stdout.trim()].filter(Boolean).join('\n');
  if (run.report) {
    add('ok', `The hook runs (Node.js ${run.report.node}, via ${path.basename(run.shell)})`, `Command: ${command}`);
    if (normPath(run.report.logDir) !== normPath(ctx.logDir)) {
      add(
        'error',
        'The hook writes to a different folder than Command Center reads',
        `Hook: ${run.report.logDir}\nCommand Center: ${ctx.logDir}`,
        'Clear the "claudeCommandCenter.logDir" setting, or set CLAUDE_COMMAND_CENTER_LOG_DIR to the same folder for Claude Code.'
      );
    } else if (!run.report.writable) {
      add('error', `The hook can't write to ${run.report.logDir}`, undefined, 'Check that folder\'s permissions.');
    }
  } else if (run.code === 0 && !output) {
    add(
      'error',
      'The hook ran but did not answer the check',
      `Command: ${command}`,
      'The registered hook is probably an old or edited copy. Run "Command Center: Set Up Hooks", then run this check again.'
    );
  } else {
    const notFound = /not found|not recognized|ENOENT|No such file/i.test(output) && /node/i.test(output);
    add(
      'error',
      run.timedOut ? 'The hook did not finish within 15 seconds' : notFound ? 'Node.js was not found when running the hook' : 'The hook failed to run',
      `Command: ${command}\nShell: ${run.shell}${run.code != null ? `\nExit code: ${run.code}` : ''}${output ? `\nOutput:\n${output.slice(0, 2000)}` : ''}`,
      notFound
        ? 'Install Node.js from https://nodejs.org/ (the hook needs it, separately from VS Code), then restart VS Code and Claude Code. If Node.js comes from nvm, Volta or fnm, make sure it is on the PATH that apps (not only terminals) get.'
        : 'Run "Command Center: Set Up Hooks", then run this check again. If it still fails, the output above says why.'
    );
  }
  if (process.platform === 'win32' && !findGitBash()) {
    add('warn', 'Git Bash was not found', 'Claude Code on Windows runs hook commands with Git Bash; this check used cmd.exe instead.', 'Install Git for Windows, or set CLAUDE_CODE_GIT_BASH_PATH to bash.exe.');
  }

  // What has actually arrived
  const eventsFile = path.join(ctx.logDir, 'events.jsonl');
  let lastEvent = 0;
  try {
    lastEvent = fs.statSync(eventsFile).mtimeMs;
  } catch {}
  if (lastEvent) add('info', `Last event received ${ago(lastEvent)}`, eventsFile);
  else add('warn', 'Nothing has been recorded yet', `${eventsFile} doesn't exist.`, 'After setup, start a new Claude Code session and let it run a command.');

  const recent = unrecordedSessions({ store: ctx.store, sessions: ctx.sessions, since: Date.now() - DAY, settled: 2 * 60 * 1000 });
  if (recent.length) {
    const before = recent.filter((s) => ctx.hookOkSince && (s.firstTs || s.lastTs) < ctx.hookOkSince);
    const list = recent
      .slice(0, 8)
      .map((s) => `- ${s.title || s.id} (${s.cwd || 'unknown folder'}, active ${ago(s.lastTs)}${s.live ? ', open' : ''})`)
      .join('\n');
    add(
      before.length === recent.length ? 'warn' : 'error',
      `${recent.length} Claude Code session${recent.length === 1 ? '' : 's'} in the last 24 hours sent nothing to Command Center`,
      list,
      before.length === recent.length
        ? 'These started before the hook was set up. Claude Code reads hooks when a session starts: restart them (exit and resume).'
        : 'Claude Code ran these sessions without running the hook. Restart any that were open during setup. If new sessions are also listed, see the errors above; if there are none, Claude Code may run with a different user folder (CLAUDE_CONFIG_DIR, WSL, or another machine over Remote).'
    );
  } else if (ctx.sessions.some((s) => s.lastTs > Date.now() - DAY)) {
    add('ok', 'Every Claude Code session from the last 24 hours was recorded');
  }

  // Why a recorded command might still not open a tab here
  if (ctx.scope !== 'all') {
    const outside = [...ctx.store.records.values()].filter((r) => r.startTs > Date.now() - DAY && !ctx.inScope(r));
    if (outside.length) {
      const dirs = [...new Set(outside.map((r) => r.cwd).filter(Boolean))].slice(0, 5);
      add(
        'info',
        `${outside.length} command${outside.length === 1 ? '' : 's'} from the last 24 hours ran outside this window's folders`,
        `They open in the window that has their folder open, not here:\n${dirs.map((d) => `- ${d}`).join('\n')}`,
        'Open that folder in this window, or switch the Commands view to "All workspaces".'
      );
    }
  }
  if (!ctx.autoOpenForeground) {
    add('info', 'Tabs for regular commands are turned off', 'claudeCommandCenter.autoOpenForeground is false.', 'Turn the setting on to get a tab for each command Claude runs.');
  }
  return items;
}

const ICON = { ok: '✅', warn: '⚠️', error: '❌', info: 'ℹ️' };

function formatReport(items, meta) {
  const problems = items.filter((i) => i.level === 'error').length;
  const warnings = items.filter((i) => i.level === 'warn').length;
  const lines = [
    '# Command Center: setup check',
    '',
    problems || warnings
      ? `${problems} problem${problems === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`
      : 'No problems found.',
    '',
    `Checked ${new Date().toLocaleString()} · Command Center ${meta.version} · VS Code ${meta.vscodeVersion} · ${os.platform()} ${os.release()}`,
    '',
  ];
  const order = { error: 0, warn: 1, ok: 2, info: 3 };
  for (const i of [...items].sort((a, b) => order[a.level] - order[b.level])) {
    lines.push(`## ${ICON[i.level]} ${i.title}`, '');
    if (i.detail) lines.push('```', i.detail, '```', '');
    if (i.fix) lines.push(`**Fix:** ${i.fix}`, '');
  }
  return lines.join('\n');
}

module.exports = { runChecks, formatReport, unrecordedSessions, findGitBash };
