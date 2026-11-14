// When and where the tabs for Claude's commands open.

const test = require('node:test');
const assert = require('node:assert');
const { state, setActiveTerminal, userTerminal, wait, fakeStore, runningCommand } = require('./stub-vscode');
const { TerminalManager, commandLabel } = require('../extension.js')._internals;

function setup(config) {
  state.config = { autoOpenForeground: true, autoOpenBackground: true, autoOpenDelay: 0, commandTabs: 'perCommand', ...config };
  state.terminals.length = 0;
  state.shown.length = 0;
  state.activeTerminal = undefined;
  const store = fakeStore();
  const manager = new TerminalManager(store);
  const start = (label, extra) => {
    const rec = runningCommand(label, extra);
    store.records.set(rec.id, rec);
    store.fireRecord(rec, 'start');
    return rec;
  };
  const finish = (rec, fields = {}) => {
    Object.assign(rec, { status: 'ok', endTs: Date.now(), stdout: '', stderr: '' }, fields);
    store.fireRecord(rec, 'end');
  };
  return { manager, start, finish };
}

test('commandLabel uses the description, or the command without its leading cd', () => {
  assert.equal(commandLabel({ command: 'cd x; ls', description: 'List files' }), 'List files');
  assert.equal(commandLabel({ command: 'cd "E:/Work/app"; node -e "x"' }), 'node -e "x"');
  assert.equal(commandLabel({ command: 'cd "E:/Work/app" && npx tsc --noEmit' }), 'npx tsc --noEmit');
  assert.equal(commandLabel({ command: 'Set-Location -Path "E:/a b"; git status' }), 'git status');
  assert.equal(commandLabel({ command: 'cd /d E:/y && cd sub && npm test' }), 'npm test');
  assert.equal(commandLabel({ command: 'cd "E:/Work/app"' }), 'cd "E:/Work/app"');
  assert.equal(commandLabel({ command: 'npm test\necho done' }), 'npm test');
});

test('commandLabel skips the setup steps Claude puts in front on macOS and Linux', () => {
  const cases = {
    'source ~/.nvm/nvm.sh > /dev/null 2>&1 && cd /Users/me/app && npm test': 'npm test',
    'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 20 >/dev/null; npx tsc --noEmit': 'npx tsc --noEmit',
    '. "$HOME/.nvm/nvm.sh" && nvm use && npm run build': 'npm run build',
    'export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && node -v': 'node -v',
    'eval "$(fnm env)" && fnm use 20 && pnpm test': 'pnpm test',
    'export PATH="/opt/homebrew/bin:$PATH"; export CI=1 FOO=bar; make': 'make',
    'source .venv/bin/activate && pytest -q': 'pytest -q',
    'cd /Users/me/app && source ~/.nvm/nvm.sh &>/dev/null && npm start': 'npm start',
    'source ~/.nvm/nvm.sh': 'source ~/.nvm/nvm.sh', // nothing after it: keep it
    'export FOO=1': 'export FOO=1',
    'sourcetree --version': 'sourcetree --version',
    'nvm ls': 'nvm ls',
    'echo hi && npm test': 'echo hi && npm test', // not a setup step
  };
  for (const [command, label] of Object.entries(cases)) assert.equal(commandLabel({ command }), label, command);
});

test('a tab opens for each command and the finished one closes when the next opens', async () => {
  const { manager, start, finish } = setup();
  const a = start('cmd A');
  await wait();
  assert.deepEqual(state.shown, ['Claude: cmd A']);
  finish(a);
  start('cmd B');
  await wait();
  assert.deepEqual(state.shown, ['Claude: cmd A', 'Claude: cmd B']);
  assert.equal(state.terminals.find((t) => t.name === 'Claude: cmd A').disposed, true);
  manager.dispose();
});

test('tabs stay in the background while the user is on a terminal of their own', async () => {
  const { manager, start } = setup();
  const mine = userTerminal();
  start('cmd A');
  await wait();
  assert.deepEqual(state.shown, ['Claude: cmd A'], 'shown: the user had not chosen their terminal');

  setActiveTerminal(mine); // the user clicks their own terminal
  const b = start('cmd B');
  await wait();
  assert.deepEqual(state.shown, ['Claude: cmd A'], 'not brought to the front');
  assert.ok(manager.terminals.has(b.id), 'but its tab exists');
  assert.equal(state.activeTerminal, mine);

  manager.terminals.get(b.id).terminal.show(); // the user clicks Claude's tab
  start('cmd C');
  await wait();
  assert.equal(state.shown.at(-1), 'Claude: cmd C', 'following again');
  manager.dispose();
});

test('closing our own finished tab does not count as the user choosing their terminal', async () => {
  const { manager, start, finish } = setup();
  userTerminal();
  const a = start('cmd A');
  await wait();
  finish(a);
  start('cmd B'); // closes A's tab: VS Code falls back to the user's terminal for a moment
  await wait();
  start('cmd C');
  await wait();
  assert.equal(state.shown.at(-1), 'Claude: cmd C');
  manager.dispose();
});

test('with a delay, only commands still running after it get a tab', async () => {
  const { manager, start, finish } = setup({ autoOpenDelay: 0.05 });
  const quick = start('quick');
  finish(quick);
  start('slow');
  await wait(120);
  assert.deepEqual(state.shown, ['Claude: slow']);
  manager.dispose();
});

test('autoOpenForeground off: no tabs', async () => {
  const { manager, start } = setup({ autoOpenForeground: false });
  start('cmd A');
  await wait();
  assert.deepEqual(state.shown, []);
  manager.dispose();
});

test('shared tab: every command prints into one tab', async () => {
  const { manager, start, finish } = setup({ commandTabs: 'shared' });
  const a = start('cmd A');
  await wait();
  finish(a, { stdout: 'output of A\n' });
  const b = start('cmd B');
  await wait();
  const ours = state.terminals.filter((t) => !t.disposed);
  assert.equal(ours.length, 1, 'one tab for both');
  const tab = ours[0];
  assert.match(tab.output, /\$ cmd A[\s\S]*output of A[\s\S]*finished[\s\S]*\$ cmd B/);
  assert.equal(tab.name, 'Claude: cmd B', 'the title follows the current command');

  // A third command starts while B is still running: B's result is printed when it ends.
  start('cmd C');
  await wait();
  finish(b, { status: 'failed', exitCode: 2, stdout: 'output of B\n' });
  assert.match(tab.output, /\$ cmd C[\s\S]*← cmd B[\s\S]*output of B[\s\S]*failed \(exit 2\)/);
  assert.equal(state.terminals.length, 1);
  assert.ok(!manager.terminals.has(a.id) && !manager.terminals.has(b.id), 'earlier commands are released');
  manager.dispose();
});

test('shared tab: closing it starts a new one for the next command', async () => {
  const { manager, start } = setup({ commandTabs: 'shared' });
  const a = start('cmd A');
  await wait();
  const closed = manager.shared;
  closed.terminal.close();
  assert.equal(manager.shared, null);
  assert.ok(!manager.terminals.has(a.id));
  start('cmd B');
  await wait();
  assert.notEqual(manager.shared, closed);
  assert.equal(state.terminals.length, 2);
  manager.dispose();
});

test('background processes keep their own tab in shared mode', async () => {
  const { manager, start } = setup({ commandTabs: 'shared' });
  const server = start('npm run dev', { background: true });
  Object.assign(server, { status: 'background', backgroundTaskId: 'task1', endTs: Date.now() });
  manager.store.fireRecord(server, 'end');
  await wait();
  assert.equal(manager.shared, null);
  assert.deepEqual(state.shown, ['Claude: npm run dev']);
  for (const t of manager.terminals.values()) t.dispose();
  manager.dispose();
});
