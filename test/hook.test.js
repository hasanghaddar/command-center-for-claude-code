// The hook script, and its registration in Claude Code's settings.json.
// Everything runs against a throwaway Claude folder, not the real ~/.claude.

const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'command-center-test-'));
process.env.CLAUDE_CONFIG_DIR = tmp;
const hookSetup = require('../hook-setup.js');
const setupCheck = require('../setup-check.js');

const HOOK = path.join(__dirname, '..', 'hook', 'log-hook.js');
const logDir = path.join(tmp, 'command-center', 'log');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Run the hook with one payload, as Claude Code does; returns what it printed.
function runHook(payload) {
  return cp.execFileSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', cwd: tmp });
}

const events = () =>
  fs
    .readFileSync(path.join(logDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test('the hook records a command start and end', () => {
  const call = { session_id: 's1', tool_name: 'Bash', tool_use_id: 'tool1', cwd: tmp, tool_input: { command: 'npm test', description: 'Run tests' } };
  assert.equal(runHook({ ...call, hook_event_name: 'PreToolUse' }), '', 'prints nothing');
  runHook({ ...call, hook_event_name: 'PostToolUse', tool_response: { stdout: 'ok\n', stderr: '', exitCode: 0 } });
  const [start, end] = events();
  assert.deepEqual(
    { type: start.type, id: start.id, session: start.session, command: start.command, description: start.description, background: start.background },
    { type: 'start', id: 'tool1', session: 's1', command: 'npm test', description: 'Run tests', background: false }
  );
  assert.deepEqual({ type: end.type, id: end.id, failed: end.failed, stdout: end.stdout, exitCode: end.exitCode }, { type: 'end', id: 'tool1', failed: false, stdout: 'ok\n', exitCode: 0 });
});

test('the hook records a failed command with its exit code', () => {
  runHook({ session_id: 's1', tool_name: 'Bash', tool_use_id: 'tool2', hook_event_name: 'PostToolUseFailure', tool_input: { command: 'false' }, error: 'Exit code 3\nboom' });
  const end = events().at(-1);
  assert.equal(end.failed, true);
  assert.equal(end.exitCode, 3);
});

test('the hook records a turn ending', () => {
  runHook({ session_id: 's1', hook_event_name: 'Stop', cwd: tmp, last_assistant_message: 'All done.' });
  const ev = events().at(-1);
  assert.deepEqual({ type: ev.type, session: ev.session, message: ev.message }, { type: 'turnEnd', session: 's1', message: 'All done.' });
});

test('the hook answers the setup check and records nothing for it', () => {
  const before = events().length;
  const answer = JSON.parse(runHook({ hook_event_name: 'CommandCenterCheck' }));
  assert.equal(answer.commandCenterCheck, true);
  assert.equal(answer.writable, true);
  assert.equal(path.resolve(answer.logDir), path.resolve(logDir));
  assert.equal(events().length, before);
});

test('the hook exits 0 and prints nothing on input it cannot read', () => {
  assert.equal(cp.execFileSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', cwd: tmp }), '');
});

test('registering keeps other hooks and settings, and unregistering removes only ours', () => {
  const other = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] };
  fs.writeFileSync(hookSetup.settingsPath(), JSON.stringify({ model: 'opus', hooks: { PreToolUse: [other] } }));
  assert.equal(hookSetup.hookStatus(), 'missing');

  hookSetup.registerHooks();
  assert.equal(hookSetup.hookStatus(), 'ok');
  let settings = hookSetup.readSettings();
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.hooks.PreToolUse[0], other);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  for (const ev of hookSetup.EVENTS) assert.ok(settings.hooks[ev].some((m) => m.hooks.some(hookSetup.isOurHook)), ev);

  hookSetup.registerHooks(); // again: no duplicates
  assert.equal(hookSetup.readSettings().hooks.PreToolUse.length, 2);

  hookSetup.unregisterHooks();
  settings = hookSetup.readSettings();
  assert.deepEqual(settings.hooks, { PreToolUse: [other] });
  assert.equal(hookSetup.hookStatus(), 'missing');
});

test('hook status for each way the hook can be registered', () => {
  hookSetup.registerHooks();
  assert.equal(hookSetup.hookStatus(), 'ok', 'with node');

  hookSetup.registerHooks(hookSetup.runtimeHookCommand(process.execPath));
  assert.equal(hookSetup.hookStatus(), 'ok', "with an editor's runtime that exists");

  hookSetup.registerHooks(hookSetup.runtimeHookCommand(path.join(tmp, 'removed', 'Code.exe')));
  assert.equal(hookSetup.hookStatus(), 'stale', "with an editor's runtime that is gone");

  hookSetup.registerHooks(`node "${tmp.replace(/\\/g, '/')}/process-monitor/log-hook.js"`);
  assert.equal(hookSetup.hookStatus(), 'outdated', 'an old path');

  const settings = hookSetup.readSettings();
  delete settings.hooks.Stop;
  fs.writeFileSync(hookSetup.settingsPath(), JSON.stringify(settings));
  assert.equal(hookSetup.hookStatus(), 'outdated', 'an event missing');
  hookSetup.unregisterHooks();
});

test("the hook runs on an editor's runtime the way Claude Code would run it", async () => {
  hookSetup.installHookFile(HOOK);
  // Node itself stands in for the editor: ELECTRON_RUN_AS_NODE means nothing to it.
  const run = await setupCheck.runHook(hookSetup.runtimeHookCommand(process.execPath));
  assert.ok(run.report, `no answer: ${run.stderr || run.error}`);
  assert.equal(run.report.commandCenterCheck, true);

  const missing = await setupCheck.runHook(`no-such-node-binary "${hookSetup.installedHookPath().replace(/\\/g, '/')}"`);
  assert.equal(missing.report, null);
});

test('sessions the hook recorded nothing for are found', () => {
  const now = Date.now();
  const store = { records: new Map([['a', { session: 'recorded' }]]), changes: new Map(), turnEnds: new Map([['turn-only', [now]]]) };
  const sessions = [
    { id: 'recorded', firstTs: now - 3600e3, lastTs: now },
    { id: 'turn-only', firstTs: now - 3600e3, lastTs: now },
    { id: 'silent', firstTs: now - 3600e3, lastTs: now },
    { id: 'too-new', firstTs: now - 1000, lastTs: now },
    { id: 'old', firstTs: now - 3 * 86400e3, lastTs: now - 2 * 86400e3 },
    { id: 'sdk', firstTs: now - 3600e3, lastTs: now, entrypoint: 'sdk-ts' },
  ];
  const missing = setupCheck.unrecordedSessions({ store, sessions, since: now - 86400e3, settled: 120e3 });
  assert.deepEqual(missing.map((s) => s.id), ['silent']);
});
