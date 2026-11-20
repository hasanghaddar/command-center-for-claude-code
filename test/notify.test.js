// Turn-end notifications, the failed-commands status bar item, and how the
// start of a turn is read from a transcript.

const test = require('node:test');
const assert = require('node:assert');
const { state, wait, fakeStore, runningCommand, setFocused } = require('./stub-vscode');
const { Notifier, FailureIndicator, TerminalManager } = require('../extension.js')._internals;
const { applyLine, newEntry } = require('../sessions.js');

test('a prompt in the transcript starts a turn; tool results do not', () => {
  const e = newEntry('session.jsonl');
  const line = (o) => applyLine(e, JSON.stringify(o), 0);
  line({ type: 'user', timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: 'fix the bug' } });
  assert.equal(e.lastPromptTs, Date.parse('2026-01-01T10:00:00Z'));
  line({ type: 'user', timestamp: '2026-01-01T10:00:20Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
  line({ type: 'user', timestamp: '2026-01-01T10:00:30Z', isMeta: true, message: { role: 'user', content: 'caveat' } });
  line({ type: 'assistant', timestamp: '2026-01-01T10:00:40Z', message: { role: 'assistant', content: [] } });
  assert.equal(e.lastPromptTs, Date.parse('2026-01-01T10:00:00Z'));
  line({ type: 'user', timestamp: '2026-01-01T10:05:00Z', message: { role: 'user', content: [{ type: 'text', text: 'now the tests' }] } });
  assert.equal(e.lastPromptTs, Date.parse('2026-01-01T10:05:00Z'));
});

function notifier(config, lastPromptTs) {
  state.config = { notifyTurnEnd: 'always', notifyTurnMinSeconds: 30, ...config };
  state.messages.length = 0;
  const store = fakeStore();
  let refreshed = 0;
  const index = { refresh: async () => void refreshed++, get: (id) => ({ id, title: `Session ${id}`, lastPromptTs, live: 'idle' }) };
  const n = new Notifier(store, index);
  const send = async (ev) => {
    store.fireSession({ session: 's1', cwd: 'E:/Work/app', ts: Date.now(), ...ev });
    await wait();
  };
  const turnEnd = (ts, session = 's1') => send({ type: 'turnEnd', session, ts, message: 'Done.' });
  return { turnEnd, send, store, refreshed: () => refreshed, statusItem: n.item, dispose: () => n.dispose() };
}

// The window gets focus back; held notifications show a moment later.
async function comeBack() {
  setFocused(true);
  await wait(350);
}

test('no notification for a turn shorter than notifyTurnMinSeconds', async () => {
  const now = Date.now();
  const n = notifier({}, now - 10 * 1000);
  await n.turnEnd(now);
  assert.deepEqual(state.messages, []);
  assert.equal(n.refreshed(), 1, 'the transcript is re-read first');
});

test('a longer turn is notified', async () => {
  const now = Date.now();
  await notifier({}, now - 45 * 1000).turnEnd(now);
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0], /^Claude finished: Session s1 — Done\./);
});

test('notifyTurnMinSeconds 0 notifies for every turn', async () => {
  const now = Date.now();
  await notifier({ notifyTurnMinSeconds: 0 }, now - 2000).turnEnd(now);
  assert.equal(state.messages.length, 1);
});

test('a turn whose start is unknown is notified', async () => {
  await notifier({}, 0).turnEnd(Date.now());
  assert.equal(state.messages.length, 1);
});

test('notifyTurnEnd "unfocused" stays quiet while the window is focused', async () => {
  const now = Date.now();
  state.focused = true;
  await notifier({ notifyTurnEnd: 'unfocused' }, now - 60 * 1000).turnEnd(now);
  assert.deepEqual(state.messages, []);
});

test('a notification raised while the window has no focus is shown when it gets focus back', async () => {
  const now = Date.now();
  const n = notifier({ notifyTurnEnd: 'unfocused' }, now - 60 * 1000);
  setFocused(false);
  await n.turnEnd(now);
  await n.turnEnd(now + 30 * 1000); // a second turn of the same session ends meanwhile
  assert.deepEqual(state.messages, [], 'nobody is looking yet');
  await comeBack();
  assert.equal(state.messages.length, 1, 'one per session, not one per turn');
  n.dispose();
});

test('a held notification is dropped when Claude has carried on meanwhile', async () => {
  const now = Date.now();
  const n = notifier({ notifyTurnEnd: 'unfocused' }, now - 60 * 1000);
  setFocused(false);
  await n.turnEnd(now);
  n.store.fireRecord(runningCommand('npm test', { session: 's1', startTs: now + 5000 }), 'start'); // prompted again from elsewhere
  await comeBack();
  assert.deepEqual(state.messages, []);
  n.dispose();
});

test('several sessions that finished while away share one notification', async () => {
  const now = Date.now();
  const n = notifier({ notifyTurnEnd: 'unfocused' }, now - 60 * 1000);
  setFocused(false);
  for (const session of ['a', 'b', 'c']) await n.turnEnd(now, session);
  await comeBack();
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0], /^Claude is waiting in 3 sessions: Session a, Session b, Session c/);
  n.dispose();
});

test('the status bar says Claude needs you until the session carries on', async () => {
  const n = notifier({ notifyAttention: 'unfocused' }, 0);
  setFocused(true);
  const asking = runningCommand('rm -rf build', { session: 's1' }); // the call Claude wants permission for
  n.store.records.set(asking.id, asking);
  await n.send({ type: 'attention', kind: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.equal(n.statusItem.visible, true);
  assert.match(n.statusItem.text, /Claude needs you/);
  assert.deepEqual(state.messages, [], 'no notification while the window has focus and the setting is "unfocused"');

  n.store.fireRecord({ ...runningCommand('ls', { session: 's1' }), status: 'ok' }, 'end'); // some other call ends: still waiting
  assert.equal(n.statusItem.visible, true);
  n.store.fireRecord(asking, 'end'); // allowed, and it ran
  assert.equal(n.statusItem.visible, false);

  await n.send({ type: 'attention', kind: 'permission_prompt', message: 'again' });
  assert.equal(n.statusItem.visible, true);
  await n.turnEnd(Date.now()); // denied: the turn ends
  assert.equal(n.statusItem.visible, false);

  await n.send({ type: 'attention', kind: 'auth_success', message: 'not a request' });
  assert.equal(n.statusItem.visible, false, 'only requests for the user count');
  n.dispose();
});

test('helpers Claude Code runs on its own are not reported as subagents', async () => {
  const n = notifier({ notifySubagentEnd: 'always', notifySubagentMinSeconds: 0 }, 0);
  setFocused(true);
  await n.send({ type: 'subagentEnd', agentId: 'x1' }); // prompt suggestions, /btw: no type
  assert.deepEqual(state.messages, []);
  await n.send({ type: 'subagentStart', agentId: 'x2', agentType: 'Explore' });
  await n.send({ type: 'subagentEnd', agentId: 'x2', agentType: 'Explore' });
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0], /^Subagent Explore finished/);
  n.dispose();
});

test('the status bar counts recent failures until their output is opened', async () => {
  state.config = { showFailures: true, autoOpenForeground: false };
  state.shown.length = 0;
  const store = fakeStore();
  const terminals = new TerminalManager(store);
  const failures = new FailureIndicator(store, terminals);
  const item = state.statusItems.at(-1);
  const end = (label, fields) => {
    const rec = { ...runningCommand(label), status: 'failed', exitCode: 1, endTs: Date.now(), stdout: '', stderr: 'boom', ...fields };
    store.records.set(rec.id, rec);
    store.fireRecord(rec, 'end');
    return rec;
  };

  end('passes', { status: 'ok', exitCode: 0 });
  assert.equal(item.visible, false, 'nothing failed');

  end('npm test');
  assert.equal(item.visible, true);
  assert.equal(item.text, '$(error) 1 failed');

  end('old failure', { endTs: Date.now() - 11 * 60 * 1000 });
  end('interrupted', { status: 'interrupted' });
  assert.equal(item.text, '$(error) 1 failed', 'old and interrupted ones are not counted');

  const lint = end('npm run lint');
  assert.equal(item.text, '$(error) 2 failed');

  state.pick = (items) => items.find((i) => i.rec === lint);
  await failures.open();
  await wait();
  assert.deepEqual(state.shown, ['Claude: npm run lint'], 'the picked one opens');
  assert.equal(item.visible, false, 'all of them have been looked at');

  end('fails again');
  assert.equal(item.text, '$(error) 1 failed');
  state.config.showFailures = false;
  failures.update();
  assert.equal(item.visible, false, 'turned off');

  for (const t of terminals.terminals.values()) t.dispose();
  terminals.dispose();
  failures.dispose();
});

test('a new prompt clears what was waiting for the user', async () => {
  const n = notifier({ notifyAttention: 'unfocused', notifyTurnEnd: 'unfocused' }, 0);
  setFocused(true);
  await n.send({ type: 'attention', kind: 'agent_needs_input', message: 'Which database?' });
  assert.equal(n.statusItem.visible, true);
  await n.send({ type: 'prompt' }); // answered
  assert.equal(n.statusItem.visible, false);

  setFocused(false);
  await n.turnEnd(Date.now());
  await n.send({ type: 'prompt' }); // prompted again from another window or a terminal
  await comeBack();
  assert.deepEqual(state.messages, [], 'the finished turn is old news');
  n.dispose();
});

test('the length of a turn is taken from its recorded prompt', async () => {
  const now = Date.now();
  const n = notifier({}, now - 300 * 1000); // the transcript's last prompt is older
  setFocused(true);
  n.store.turnStarts.set('s1', now - 10 * 1000);
  await n.turnEnd(now);
  assert.deepEqual(state.messages, [], '10 seconds: too short to notify');
  assert.equal(n.refreshed(), 0, 'no need to read the transcript');
  n.store.turnStarts.set('s1', now - 60 * 1000);
  await n.turnEnd(now + 30 * 1000);
  assert.equal(state.messages.length, 1);
  n.dispose();
});

test('a turn that ends in an error is notified, however short', async () => {
  const now = Date.now();
  const n = notifier({}, now - 5000);
  setFocused(true);
  await n.send({ type: 'turnEnd', failed: true, error: 'rate_limit', ts: now });
  assert.deepEqual(state.messages, ['Claude stopped: rate limit (Session s1)']);
  n.dispose();
});

test('with systemNotifications on, the operating system notifies while the window is not in front', async () => {
  const shown = [];
  const setup = (config) => {
    state.config = { notifyTurnEnd: 'unfocused', notifyAttention: 'unfocused', notifyTurnMinSeconds: 0, ...config };
    state.messages.length = 0;
    shown.length = 0;
    const store = fakeStore();
    const index = { refresh: async () => {}, get: (id) => ({ id, title: 'Fix the login bug', cwd: 'E:\\Work\\my app', live: 'idle' }) };
    const n = new Notifier(store, index, { systemNotify: (x) => shown.push(x) });
    const send = async (ev) => {
      store.fireSession({ session: 's1', cwd: 'E:\\Work\\my app', ts: Date.now(), ...ev });
      await wait();
    };
    return { n, send };
  };

  let t = setup({ systemNotifications: true });
  setFocused(false);
  await t.send({ type: 'turnEnd', message: 'All tests pass.' });
  await t.send({ type: 'attention', kind: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.deepEqual(shown.map((x) => [x.title, x.body]), [
    ['Claude finished', 'Fix the login bug: All tests pass.'],
    ['Claude needs you', 'Fix the login bug: Claude needs your permission to use Bash'],
  ]);
  assert.equal(shown[0].uri, 'vscode://file/E:/Work/my%20app', 'clicking it opens the project, which brings its window forward');
  assert.deepEqual(state.messages, [], 'the notification inside the window still waits for it to have focus');
  t.n.dispose();

  t = setup({ systemNotifications: true });
  setFocused(true);
  await t.send({ type: 'turnEnd', message: 'Done.' });
  assert.deepEqual(shown, [], 'not while the window is in front');
  t.n.dispose();

  t = setup({ systemNotifications: false });
  setFocused(false);
  await t.send({ type: 'turnEnd', message: 'Done.' });
  assert.deepEqual(shown, [], 'not unless it is turned on');
  t.n.dispose();
  setFocused(true);
});

test('a system notification is built without putting its text into a script', () => {
  const { command } = require('../notify-os.js');
  const n = { title: 'Claude needs you', body: 'app: run "rm -rf $HOME"; `whoami` <b>&', uri: 'vscode://file/E:/Work/app', app: 'Microsoft.VisualStudioCode' };

  const win = command(n, 'win32');
  assert.equal(win.file, 'powershell.exe');
  assert.ok(!win.args.join(' ').includes('whoami'), 'the text is not part of the command');
  assert.match(win.env.CC_NOTIFY_XML, /^<toast activationType="protocol" launch="vscode:\/\/file\/E:\/Work\/app">/);
  assert.ok(win.env.CC_NOTIFY_XML.includes('run &quot;rm -rf $HOME&quot;; `whoami` &lt;b&gt;&amp;'), 'and is escaped where it goes');
  assert.equal(win.env.CC_NOTIFY_APP, 'Microsoft.VisualStudioCode');

  const mac = command(n, 'darwin');
  assert.equal(mac.file, 'osascript');
  assert.ok(!mac.args.join(' ').includes('whoami'));
  assert.equal(mac.env.CC_NOTIFY_BODY, n.body);

  const linux = command(n, 'linux');
  assert.deepEqual(linux.args.slice(-3), ['--', n.title, n.body]);
  assert.equal(command(n, 'aix'), null);
});
