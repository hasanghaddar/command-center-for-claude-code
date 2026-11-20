// The dashboard's page script, run against a stand-in for the browser: what
// the command list shows when grouped, flat, filtered and folded.

const test = require('node:test');
const assert = require('node:assert');
require('./stub-vscode');
const { SCRIPT } = require('../dashboard.js');

// Just enough of a page for the script: elements by id that remember their HTML.
function page() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        innerHTML: '',
        textContent: '',
        value: '',
        placeholder: '',
        title: '',
        dataset: {},
        classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
        addEventListener() {},
        querySelector: () => null,
        insertAdjacentHTML() {},
      });
    }
    return elements.get(id);
  };
  const listeners = {};
  const posted = [];
  const document = {
    getElementById: element,
    querySelectorAll: () => [],
    addEventListener: (type, fn) => (listeners[type] = fn),
  };
  const window = { addEventListener: (type, fn) => (listeners['window:' + type] = fn) };
  let state;
  const acquireVsCodeApi = () => ({ getState: () => state, setState: (s) => (state = s), postMessage: (m) => posted.push(m) });
  new Function('acquireVsCodeApi', 'document', 'window', 'setInterval', SCRIPT)(acquireVsCodeApi, document, window, () => 0);
  return {
    list: () => element('list').innerHTML,
    send: (msg) => listeners['window:message']({ data: msg }),
    // A click on an element found by one of these selectors.
    click: (hit) => listeners.click({ target: { closest: (sel) => hit[sel] || null } }),
    posted,
  };
}

const now = Date.now();
let n = 0;
const rec = (session, ms, extra = {}) => {
  n++;
  return { id: `r${n}`, session, tool: 'Bash', command: `cmd ${n}`, label: `cmd ${n}`, project: 'app', status: 'ok', background: false, startTs: now - n * 1000, endTs: now - n * 1000 + ms, ...extra };
};
const records = [rec('s1', 5000), rec('s1', 100), rec('s1', 200), rec('s1', 300), rec('s2', 100), rec('s1', 900, { status: 'failed' })];
const state = (extra) => ({ type: 'state', records, changes: [], sessions: { s1: { title: 'Fix the login bug' }, s2: { title: 'Update the docs' } }, scope: 'workspace', workspace: 'app', ...extra });

const names = (html) => [...html.matchAll(/class="(?:name|sess-name)">([^<]*)</g)].map((m) => m[1]);

test('the dashboard lists commands under their session, with quick ones folded', () => {
  const p = page();
  p.send(state({ commandList: 'grouped' }));
  assert.deepEqual(names(p.list()), ['Fix the login bug', 'cmd 1', '3 quick commands', 'cmd 6', 'Update the docs', 'cmd 5']);
  assert.match(p.list(), /1 failed · 5 commands/);
  assert.match(p.list(), /cmd 2, cmd 3, cmd 4/, 'the folded row says what is inside');

  p.click({ '.row': { dataset: { quick: 'r4' } } }); // unfold the quick commands
  assert.deepEqual(names(p.list()).slice(0, 6), ['Fix the login bug', 'cmd 1', '3 quick commands', 'cmd 2', 'cmd 3', 'cmd 4']);

  p.click({ '.group.sess': { dataset: { sess: 's1' } } }); // fold the whole session
  assert.deepEqual(names(p.list()), ['Fix the login bug', 'Update the docs', 'cmd 5']);
  p.click({ '.group.sess': { dataset: { sess: 's1' } } });
  assert.equal(names(p.list()).length, 9);
});

test('a filter shows every match, not a folded row that hides them', () => {
  const p = page();
  p.send(state({ commandList: 'grouped' }));
  p.click({ '[data-stat]': { dataset: { stat: 'failed' } } });
  assert.deepEqual(names(p.list()), ['Fix the login bug', 'cmd 6']);
});

test('commandList "flat" keeps one list by day', () => {
  const p = page();
  p.send(state({ commandList: 'flat' }));
  assert.deepEqual(names(p.list()), ['cmd 1', 'cmd 2', 'cmd 3', 'cmd 4', 'cmd 5', 'cmd 6']);
  assert.match(p.list(), /class="group">Today</);
});

test('an empty dashboard offers setup instead of file paths', () => {
  const p = page();
  p.send({ ...state({}), records: [] });
  assert.match(p.list(), /data-action="setup"/);
  assert.match(p.list(), /data-action="checkSetup"/);
});
