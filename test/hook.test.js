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

test('files a shell command changes are found past `source … &&` and `cd` in front of it', () => {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => cp.execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'start');
  fs.writeFileSync(path.join(repo, 'app.js'), 'old\n');
  const command = `source ~/.nvm/nvm.sh > /dev/null 2>&1 && cd "${repo.replace(/\\/g, '/')}" && sed -i s/old/new/ app.js`;
  // The session started in tmp, which isn't a git repository: only the cd says where the command runs.
  const call = { session_id: 's2', tool_name: 'Bash', tool_use_id: 'shell1', cwd: tmp, tool_input: { command } };
  runHook({ ...call, hook_event_name: 'PreToolUse' });
  fs.writeFileSync(path.join(repo, 'app.js'), 'new\n'); // what the command did
  runHook({ ...call, hook_event_name: 'PostToolUse', tool_response: { stdout: '', stderr: '', exitCode: 0 } });
  const changed = events().filter((e) => e.type === 'fileEnd' && e.toolId === 'shell1');
  assert.deepEqual(
    changed.map((e) => path.basename(e.file)),
    ['app.js']
  );
});

test('commands that cannot change files are recognised, and anything unclear is not', () => {
  const { readOnly } = require(HOOK);
  const yes = [
    'ls -la',
    'git status',
    'git diff HEAD~1 -- src',
    'cd "E:/x" && git log --oneline | head -20',
    'grep -rn "a>b" src 2>/dev/null',
    'find . -name "*.js"',
    'sed -n 1,5p file.txt',
    'git -C sub --no-pager log -3',
    'echo hi > /dev/null',
    'cat a.txt 2>&1 | wc -l',
    'rg foo # look for it\nls',
    'wc -l < a.txt',
  ];
  const no = [
    'npm test',
    'grep -rn x src > out.txt',
    'cat a.txt | tee b.txt',
    'find . -name "*.js" -delete',
    'echo $(rm x)',
    'echo "`rm x`"',
    'sed -i s/a/b/ file.txt',
    'git checkout main',
    'git stash',
    'git diff --output=x',
    'ls; rm x',
    'ls &',
    'cat <<EOF\nx\nEOF',
    'FOO=1 ls',
    'echo "unterminated',
    '',
  ];
  for (const c of yes) assert.equal(readOnly(c, 'Bash'), true, c);
  for (const c of no) assert.equal(readOnly(c, 'Bash'), false, c);

  for (const c of ['Get-ChildItem -Recurse | Select-String foo', 'Get-Content C:\\a\\b.txt', 'git status; Get-Location', 'Get-ChildItem | Where-Object { $_.Length -gt 5 } | Sort-Object Name']) {
    assert.equal(readOnly(c, 'PowerShell'), true, c);
  }
  for (const c of ['Get-Content a.txt | Set-Content b.txt', 'Get-ChildItem | Where-Object { Remove-Item $_ }', 'Get-Content a > b.txt', 'Get-ChildItem | ForEach-Object { $_.Delete() }']) {
    assert.equal(readOnly(c, 'PowerShell'), false, c);
  }
});

test('a command that cannot change files is not compared before and after', () => {
  const repo = path.join(tmp, 'repo-readonly');
  fs.mkdirSync(repo, { recursive: true });
  cp.execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const shellState = path.join(logDir, 'shell');
  const call = (id, command) => ({ session_id: 's3', tool_name: 'Bash', tool_use_id: id, cwd: repo, hook_event_name: 'PreToolUse', tool_input: { command } });
  runHook(call('ro1', 'git status && ls -la'));
  assert.equal(fs.existsSync(path.join(shellState, 'ro1.json')), false);
  runHook(call('rw1', 'npm run build'));
  assert.equal(fs.existsSync(path.join(shellState, 'rw1.json')), true, 'one that may change files still is');
});

test('copies of changed files are reused from one command to the next while the files stay the same', () => {
  const repo = path.join(tmp, 'repo-copies');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => cp.execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'files');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'edited by hand\n'); // both differ from the last commit
  fs.writeFileSync(path.join(repo, 'b.txt'), 'also edited\n');
  // A time that can be set again exactly (whole seconds).
  const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 60000);
  fs.utimesSync(path.join(repo, 'a.txt'), when, when);

  const shellState = path.join(logDir, 'shell');
  const before = (id) => {
    runHook({ session_id: 's7', tool_name: 'Bash', tool_use_id: id, cwd: repo, hook_event_name: 'PreToolUse', tool_input: { command: 'npm run build' } });
    return JSON.parse(fs.readFileSync(path.join(shellState, `${id}.json`), 'utf8')).dirty;
  };
  const first = before('cp1');
  const blobA = first['a.txt'].blob;
  assert.equal(fs.readFileSync(blobA, 'utf8'), 'edited by hand\n');

  // Had the hook read a.txt again, it would make a new copy of what is there now.
  // The file's size and time are unchanged, so it must not.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'EDITED BY HAND\n');
  fs.utimesSync(path.join(repo, 'a.txt'), when, when);
  const second = before('cp2');
  assert.equal(second['a.txt'].blob, blobA, 'the remembered copy is used');

  fs.writeFileSync(path.join(repo, 'b.txt'), 'edited once more, and longer\n'); // a real change
  const third = before('cp3');
  assert.notEqual(third['b.txt'].blob, first['b.txt'].blob);
  assert.equal(fs.readFileSync(third['b.txt'].blob, 'utf8'), 'edited once more, and longer\n');

  fs.unlinkSync(blobA); // cleaned up (Clear History): copied again rather than pointing at nothing
  const fourth = before('cp4');
  assert.ok(fs.existsSync(fourth['a.txt'].blob));
});

test('git state is read with one call: HEAD, changed, renamed and untracked files', () => {
  const { gitState, repoRoot } = require(HOOK);
  const repo = path.join(tmp, 'repo-state');
  fs.mkdirSync(path.join(repo, 'sub dir'), { recursive: true });
  const git = (...args) => cp.execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  assert.equal(repoRoot(path.join(repo, 'sub dir')), repo);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'x\n');
  assert.deepEqual(gitState(repo), { head: null, paths: ['new.txt'] }, 'before the first commit');

  fs.writeFileSync(path.join(repo, 'tracked one.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'files');
  fs.appendFileSync(path.join(repo, 'b.txt'), 'changed\n');
  git('mv', 'tracked one.txt', 'renamed file.txt');
  fs.writeFileSync(path.join(repo, 'sub dir', 'deep file.txt'), 'x\n');
  const s = gitState(repo);
  assert.equal(s.head, git('rev-parse', 'HEAD').toString().trim());
  assert.deepEqual([...s.paths].sort(), ['b.txt', 'renamed file.txt', 'sub dir/deep file.txt', 'tracked one.txt']);
});

test("a watcher started with Claude's Monitor tool is recorded as one", () => {
  // It reaches the hook as a Bash call, with timeout_ms where Bash has timeout.
  runHook({ session_id: 's4', tool_name: 'Bash', tool_use_id: 'mon1', cwd: tmp, hook_event_name: 'PreToolUse', tool_input: { command: 'tail -f build.log', description: 'build finish', timeout_ms: 1800000 } });
  const ev = events().at(-1);
  assert.deepEqual({ id: ev.id, monitor: ev.monitor, timeout: ev.timeout }, { id: 'mon1', monitor: true, timeout: 1800000 });
  runHook({ session_id: 's4', tool_name: 'Bash', tool_use_id: 'bash1', cwd: tmp, hook_event_name: 'PreToolUse', tool_input: { command: 'npm test', timeout: 60000 } });
  assert.equal(events().at(-1).monitor, undefined);
});

test('secrets are masked in what the hook records, unless that is turned off', () => {
  const command = 'PGPASSWORD=correcthorse psql -c "select 1"';
  const run = (id) => {
    const call = { session_id: 's5', tool_name: 'Bash', tool_use_id: id, cwd: tmp, tool_input: { command } };
    runHook({ ...call, hook_event_name: 'PreToolUse' });
    runHook({ ...call, hook_event_name: 'PostToolUse', tool_response: { stdout: 'API_KEY=sk_live_9f8e7d6c5b4a3210\nrows: 1\n', stderr: '' } });
    return events().slice(-2);
  };
  const [start, end] = run('sec1');
  assert.equal(start.command, 'PGPASSWORD=*** psql -c "select 1"');
  assert.equal(end.command, start.command);
  assert.equal(end.stdout, 'API_KEY=***\nrows: 1\n');

  // The extension writes its maskSecrets setting here for the hook.
  const config = path.join(tmp, 'command-center', 'config.json');
  fs.writeFileSync(config, JSON.stringify({ maskSecrets: false }));
  const [raw] = run('sec2');
  assert.equal(raw.command, command);
  fs.unlinkSync(config);
});

test('the hook records prompts (not their text), failed turns, and the tasks still running', () => {
  const base = { session_id: 's6', cwd: tmp };
  runHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'my private question' });
  const prompt = events().at(-1);
  assert.deepEqual(Object.keys(prompt).sort(), ['cwd', 'session', 'ts', 'type']);
  assert.equal(prompt.type, 'prompt');

  runHook({
    ...base,
    hook_event_name: 'Stop',
    last_assistant_message: 'Done.',
    background_tasks: [
      { id: 'b1', type: 'shell', status: 'running', command: 'npm run dev', description: 'dev server' },
      { id: 'm1', type: 'monitor', status: 'running', command: 'curl -u admin:hunter2 https://x' },
      { id: 'a1', type: 'subagent', status: 'running', agent_type: 'Explore' },
    ],
  });
  assert.deepEqual(events().at(-1).tasks, [
    { id: 'b1', type: 'shell', command: 'npm run dev' },
    { id: 'm1', type: 'monitor', command: 'curl -u admin:*** https://x' },
    { id: 'a1', type: 'subagent' },
  ]);

  runHook({ ...base, hook_event_name: 'Stop', last_assistant_message: 'Done.' }); // an older Claude Code: no list
  assert.equal('tasks' in events().at(-1), false);

  runHook({ ...base, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: 'Try again later' });
  const failed = events().at(-1);
  assert.deepEqual({ type: failed.type, failed: failed.failed, error: failed.error }, { type: 'turnEnd', failed: true, error: 'rate_limit' });
});

test('hook events newer than the Claude Code in use are not registered', () => {
  assert.ok(hookSetup.EVENTS.includes('UserPromptSubmit'));
  assert.equal(hookSetup.eventsFor(undefined).includes('StopFailure'), false, 'version not known');
  assert.equal(hookSetup.eventsFor('2.1.77').includes('StopFailure'), false);
  assert.equal(hookSetup.eventsFor('2.1.78').includes('StopFailure'), true);
  assert.equal(hookSetup.eventsFor('2.2.0').includes('StopFailure'), true);

  hookSetup.registerHooks(undefined, '2.1.70');
  assert.equal('StopFailure' in hookSetup.readSettings().hooks, false);
  assert.equal(hookSetup.hookStatus('2.1.70'), 'ok');
  assert.equal(hookSetup.hookStatus('2.1.329'), 'outdated', 'Claude Code was updated since: one more event to register');

  hookSetup.registerHooks(undefined, '2.1.329');
  assert.ok(hookSetup.readSettings().hooks.StopFailure.some((m) => m.hooks.some(hookSetup.isOurHook)));
  assert.equal(hookSetup.hookStatus('2.1.329'), 'ok');
  assert.equal(hookSetup.hookStatus(undefined), 'ok', 'still fine from a window that cannot tell the version');
  hookSetup.registerHooks(undefined, undefined);
  assert.ok(hookSetup.readSettings().hooks.StopFailure, 'and registering from there keeps it');

  // The oldest Claude Code running decides.
  const sessionsDir = path.join(tmp, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, '101.json'), JSON.stringify({ pid: 101, version: '2.1.329' }));
  fs.writeFileSync(path.join(sessionsDir, '102.json'), JSON.stringify({ pid: 102, version: '2.1.60' }));
  assert.equal(hookSetup.claudeVersion('2.1.400'), '2.1.60');
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  assert.equal(hookSetup.claudeVersion(), undefined);
  hookSetup.unregisterHooks();
  assert.equal(hookSetup.readSettings().hooks, undefined);
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
