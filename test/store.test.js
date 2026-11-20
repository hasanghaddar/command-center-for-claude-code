// The Store: reading the hook's event log across a rotation and a clear, and
// noticing background commands that ended without saying so.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { state } = require('./stub-vscode');
const { Store } = require('../extension.js')._internals;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'command-center-store-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
// A fresh log folder; returns helpers to write events as the hook does.
function logFolder() {
  const dir = path.join(tmp, `log${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  state.config = { logDir: dir, maxItems: 200 };
  const file = path.join(dir, 'events.jsonl');
  const append = (...events) => fs.appendFileSync(file, events.map((e) => JSON.stringify(e) + '\n').join(''));
  const start = (id, extra = {}) => ({ type: 'start', id, session: 's1', tool: 'Bash', command: id, ts: Date.now(), ...extra });
  const end = (id, extra = {}) => ({ type: 'end', id, session: 's1', tool: 'Bash', command: id, ts: Date.now(), stdout: `output of ${id}`, ...extra });
  return { dir, file, append, start, end };
}

// A loaded store, and the records it announced as new since.
function openStore(deps) {
  const store = new Store(deps);
  store.scope = 'all';
  store.load();
  const announced = [];
  store.onRecord(({ rec, type }) => announced.push(`${type}:${rec.id}`));
  return { store, announced };
}

const statuses = (store) => Object.fromEntries([...store.records.values()].map((r) => [r.id, r.status]));

test('history is kept when the hook moves the log aside and starts a new one', () => {
  const log = logFolder();
  log.append(log.start('a'), log.end('a'), log.start('b'));
  const { store, announced } = openStore();
  assert.deepEqual(statuses(store), { a: 'ok', b: 'running' });

  // What the hook does at 20 MB: one last event, rename, then a new file.
  log.append(log.end('b'));
  fs.renameSync(log.file, log.file + '.1');
  log.append(log.start('c'));
  store.read();
  assert.deepEqual(statuses(store), { a: 'ok', b: 'ok', c: 'running' }, 'nothing is lost, and b got the end written just before');
  assert.deepEqual(announced, ['end:b', 'start:c'], 'only what is new is announced');

  log.append(log.end('c'));
  store.read();
  assert.equal(store.records.get('c').status, 'ok', 'the new file is followed');

  const later = openStore().store; // a window opened after the rotation
  assert.deepEqual(statuses(later), { a: 'ok', b: 'ok', c: 'ok' });
  assert.equal(later.records.get('a').stdout, 'output of a');
});

test('clearing the history empties it in every window, the moved-aside file included', () => {
  const log = logFolder();
  log.append(log.start('a'), log.end('a'));
  fs.renameSync(log.file, log.file + '.1');
  log.append(log.start('b'), log.end('b'));
  const one = openStore().store;
  const two = openStore();
  assert.equal(two.store.records.size, 2);

  one.clear();
  assert.equal(fs.existsSync(log.file + '.1'), false);
  two.store.read();
  assert.equal(two.store.records.size, 0);
  assert.deepEqual(two.announced, []);

  log.append(log.start('c'));
  two.store.read();
  assert.deepEqual(statuses(two.store), { c: 'running' });
});

test('Refresh reads everything again without announcing old commands as new', () => {
  const log = logFolder();
  log.append(log.start('a'), log.end('a'), log.start('b'));
  const { store, announced } = openStore();
  store.reload();
  assert.deepEqual(statuses(store), { a: 'ok', b: 'running' });
  assert.deepEqual(announced, []);
});

test('a background command whose Claude Code session and process are gone is marked ended', async () => {
  const hourAgo = Date.now() - 3600e3;
  const setup = (deps) => {
    const log = logFolder();
    const output = path.join(log.dir, 'task1.output');
    fs.writeFileSync(output, 'listening on 3000\n'); // no "[exited with code N]"
    fs.utimesSync(output, new Date(hourAgo + 60e3), new Date(hourAgo + 60e3));
    log.append(log.start('server', { ts: hourAgo, background: true }), log.end('server', { ts: hourAgo + 1000, backgroundTaskId: 'task1', outputFile: output }));
    return { log, ...openStore(deps) };
  };
  const otherProcesses = async () => [{ pid: 10, ppid: 1, cmd: 'node unrelated.js' }];

  const gone = setup({ liveSessions: () => new Map(), listProcesses: otherProcesses });
  assert.equal(gone.store.records.get('server').status, 'background');
  await gone.store.sweepOrphans();
  const rec = gone.store.records.get('server');
  assert.equal(rec.status, 'stopped');
  assert.equal(rec.endReason, 'sessionEnded');
  assert.equal(rec.endTs, hourAgo + 60e3, 'it ended when its output went quiet');
  assert.match(fs.readFileSync(gone.log.file, 'utf8'), /"type":"stopped".*"reason":"sessionEnded"/, 'recorded, so other windows see it too');

  // Its Claude Code process is still running: left alone, without even listing processes.
  let listed = 0;
  const open = setup({ liveSessions: () => new Map([['s1', { pid: 1, startedAt: hourAgo - 1000 }]]), listProcesses: async () => (listed++, []) });
  await open.store.sweepOrphans();
  assert.equal(open.store.records.get('server').status, 'background');
  assert.equal(listed, 0);

  // The session was closed and resumed since (a new process): the old one's tasks went with it.
  const resumed = setup({ liveSessions: () => new Map([['s1', { pid: 2, startedAt: Date.now() - 1000 }]]), listProcesses: otherProcesses });
  await resumed.store.sweepOrphans();
  assert.equal(resumed.store.records.get('server').status, 'stopped');

  // The session is gone but the task's own process is still there (it outlived Claude Code).
  const stillRunning = async () => [{ pid: 20, ppid: 1, cmd: 'cmd.exe /c "node server.js > "C:\\Temp\\claude\\p\\s1\\tasks\\task1.output" 2>&1"' }];
  const orphan = setup({ liveSessions: () => new Map(), listProcesses: stillRunning });
  await orphan.store.sweepOrphans();
  assert.equal(orphan.store.records.get('server').status, 'background');

  // The process list can't be read: nothing is concluded.
  const unknown = setup({ liveSessions: () => new Map(), listProcesses: async () => [] });
  await unknown.store.sweepOrphans();
  assert.equal(unknown.store.records.get('server').status, 'background');
});

test("a background command's exit is written to the log, so it is known after its output file is gone", () => {
  const log = logFolder();
  const output = path.join(log.dir, 'task2.output');
  fs.writeFileSync(output, 'building…\n[exited with code 2]\n');
  log.append(log.start('build', { background: true }), log.end('build', { backgroundTaskId: 'task2', outputFile: output }));
  const first = openStore().store;
  assert.equal(first.records.get('build').status, 'failed');
  assert.equal(first.records.get('build').exitCode, 2);

  fs.unlinkSync(output); // Claude Code cleans its temporary files up
  const later = openStore();
  assert.equal(later.store.records.get('build').status, 'failed', 'read from the log, not looked up again');
  assert.equal(later.store.records.get('build').exitCode, 2);

  // Another window that was already open reads the exit from the log and announces it once.
  const log2 = logFolder();
  log2.append(log2.start('serve', { background: true }), log2.end('serve', { backgroundTaskId: 'task3', outputFile: path.join(log2.dir, 'missing.output') }));
  const other = openStore();
  log2.append({ id: 'serve', type: 'exited', ts: Date.now(), exitCode: 0 });
  other.store.read();
  other.store.read();
  assert.equal(other.store.records.get('serve').status, 'ok');
  assert.deepEqual(other.announced, ['end:serve']);
});

test('a background command Claude Code no longer lists at the end of a turn has ended', () => {
  const log = logFolder();
  const t = Date.now() - 60e3;
  const missing = path.join(log.dir, 'gone.output'); // no output file to read an exit code from
  const background = (id, taskId, ts) => [log.start(id, { ts, background: true }), log.end(id, { ts: ts + 100, backgroundTaskId: taskId, outputFile: missing })];
  const turnEnd = (ts, tasks) => ({ type: 'turnEnd', session: 's1', ts, tasks });
  log.append(...background('server', 'b1', t), ...background('build', 'b2', t + 1000));
  const { store, announced } = openStore();

  // Nothing is concluded from a missing id until an id has been seen to match.
  log.append(turnEnd(t + 5000, [{ id: 'other-kind-of-id', type: 'shell', command: 'something else' }]));
  store.read();
  store.checkFinished();
  assert.deepEqual(statuses(store), { server: 'background', build: 'background' });

  log.append(turnEnd(t + 10e3, [{ id: 'b1', type: 'shell', command: 'server' }, { id: 'b2', type: 'shell', command: 'build' }]));
  store.read();
  store.checkFinished();
  assert.deepEqual(statuses(store), { server: 'background', build: 'background' }, 'both still listed');

  log.append(turnEnd(t + 20e3, [{ id: 'b1', type: 'shell', command: 'server' }])); // the build is no longer there
  store.read();
  store.checkFinished();
  assert.deepEqual(statuses(store), { server: 'background', build: 'stopped' });
  assert.equal(store.records.get('build').endReason, 'taskEnded');
  assert.equal(store.records.get('build').endTs, t + 20e3);
  assert.deepEqual(announced, ['end:build']);

  // An older Claude Code sends no list: nothing changes.
  log.append({ type: 'turnEnd', session: 's1', ts: t + 30e3 });
  store.read();
  store.checkFinished();
  assert.equal(store.records.get('server').status, 'background');

  assert.deepEqual(statuses(openStore().store), { server: 'background', build: 'stopped' }, 'the same after a restart');
});

test('a watcher ends when Claude Code no longer lists it', () => {
  const log = logFolder();
  const t = Date.now() - 60e3;
  log.append(log.start('watch', { ts: t, monitor: true, timeout: 30 * 60e3, command: 'tail -f build.log | grep -m1 done' }));
  const { store } = openStore();
  const subagentEnd = (ts, tasks) => ({ type: 'subagentEnd', session: 's1', ts, agentType: 'Explore', tasks });

  log.append(subagentEnd(t + 5000, [{ id: 'm1', type: 'monitor', command: 'tail -f build.log | grep -m1 done' }]));
  store.read();
  store.checkFinished();
  assert.equal(store.records.get('watch').status, 'background', 'still listed');

  log.append(subagentEnd(t + 8000, [{ id: 'm9', type: 'monitor', command: 'some other script' }]));
  store.read();
  store.checkFinished();
  assert.equal(store.records.get('watch').status, 'background', 'a command that cannot be placed: no conclusion');

  log.append(subagentEnd(t + 10e3, []));
  store.read();
  store.checkFinished();
  assert.equal(store.records.get('watch').status, 'stopped');
  assert.equal(store.records.get('watch').endTs, t + 10e3);
});

test('the time of the latest prompt of each session is kept', () => {
  const log = logFolder();
  const now = Date.now();
  log.append({ type: 'prompt', session: 's1', ts: now - 5000 }, { type: 'prompt', session: 's2', ts: now - 3000 }, { type: 'prompt', session: 's1', ts: now - 1000 });
  const { store } = openStore();
  assert.equal(store.turnStarts.get('s1'), now - 1000);
  assert.equal(store.turnStarts.get('s2'), now - 3000);
});

test("a watcher started with Claude's Monitor tool is a background command that ends with its timeout", () => {
  const log = logFolder();
  const now = Date.now();
  log.append(
    log.start('watching', { ts: now - 60e3, monitor: true, timeout: 30 * 60e3 }),
    log.start('expired', { ts: now - 3600e3, monitor: true, timeout: 30 * 60e3 }),
    log.start('regular', { ts: now - 1000 })
  );
  const { store } = openStore();
  assert.deepEqual(statuses(store), { watching: 'background', expired: 'stopped', regular: 'running' });
  assert.equal(store.records.get('expired').endReason, 'monitorEnded');
  assert.deepEqual(store.runningForeground().map((r) => r.id), ['regular'], 'a watcher is not shown as the running command');
});
