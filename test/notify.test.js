// Turn-end notifications, the failed-commands status bar item, and how the
// start of a turn is read from a transcript.

const test = require('node:test');
const assert = require('node:assert');
const { state, wait, fakeStore, runningCommand } = require('./stub-vscode');
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
  const index = { refresh: async () => void refreshed++, get: (id) => ({ id, title: 'My session', lastPromptTs }) };
  new Notifier(store, index);
  const turnEnd = async (ts) => {
    store.fireSession({ type: 'turnEnd', session: 's1', cwd: 'E:/Work/app', ts, message: 'Done.' });
    await wait();
  };
  return { turnEnd, refreshed: () => refreshed };
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
  assert.match(state.messages[0], /^Claude finished: My session — Done\./);
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
  state.focused = false;
  await notifier({ notifyTurnEnd: 'unfocused' }, now - 60 * 1000).turnEnd(now);
  assert.equal(state.messages.length, 1);
  state.focused = true;
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
