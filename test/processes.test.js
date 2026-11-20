// Listing processes. The Windows part runs PowerShell for real.

const test = require('node:test');
const assert = require('node:assert');
const { listProcesses, closeSession, processTree } = require('../processes.js');

test('the processes a command started are found from the list', () => {
  const procs = [
    { pid: 1, ppid: 0 },
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 20, ppid: 1 },
  ];
  assert.deepEqual(processTree(procs, [10]).sort(), [10, 11, 12]);
});

test('the process list includes this process, with its memory', async () => {
  const procs = await listProcesses();
  const me = procs.find((p) => p.pid === process.pid);
  assert.ok(me, `this process (${process.pid}) among ${procs.length}`);
  assert.ok(me.mem > 1024 * 1024);
  assert.match(me.cmd, /node/i);
});

test('on Windows, readings after the first reuse one PowerShell', { skip: process.platform !== 'win32' }, async () => {
  await listProcesses(); // starts it if the test above did not
  const started = Date.now();
  const [a, b] = await Promise.all([listProcesses(), listProcesses()]); // one at a time, in turn
  assert.ok(a.some((p) => p.pid === process.pid) && b.some((p) => p.pid === process.pid));
  const took = Date.now() - started;
  closeSession();
  const again = await listProcesses(); // closing it is no obstacle to the next reading
  assert.ok(again.length > 5);
  closeSession();
  assert.ok(took < 15000, `two readings took ${took} ms`);
});
