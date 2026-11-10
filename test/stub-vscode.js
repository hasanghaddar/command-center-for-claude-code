// A stand-in for the 'vscode' module, enough to load extension.js in tests.
// require() this before extension.js. `state` is what the tests set and read.

const Module = require('module');

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (fn) => {
      this.listeners.add(fn);
      return { dispose: () => this.listeners.delete(fn) };
    };
  }
  fire(value) {
    for (const fn of [...this.listeners]) fn(value);
  }
}

const state = {
  config: {}, // claudeCommandCenter.* settings by name
  focused: true,
  activeTerminal: undefined,
  terminals: [], // every terminal created
  shown: [], // names, in the order terminals were brought to the front
  messages: [], // notification texts
  statusItems: [],
  pick: (items) => items[0], // what showQuickPick answers
};

const activeTerminalChanged = new EventEmitter();

// Make a terminal the active one, as when the user clicks its tab.
function setActiveTerminal(t) {
  state.activeTerminal = t;
  activeTerminalChanged.fire(t);
}

// A terminal the user opened themselves.
function userTerminal(name = 'powershell') {
  const t = { name };
  state.terminals.push(t);
  return t;
}

function createTerminal(opts) {
  const t = {
    name: opts.name,
    output: '',
    disposed: false,
    show() {
      state.shown.push(t.name);
      setActiveTerminal(t);
    },
    dispose() {
      t.disposed = true;
      if (state.activeTerminal === t) setActiveTerminal(state.terminals.find((o) => o !== t && !o.disposed));
    },
    // The user closes the tab.
    close() {
      if (opts.pty && opts.pty.close) opts.pty.close();
      t.dispose();
    },
  };
  if (opts.pty) {
    opts.pty.onDidWrite((s) => (t.output += s));
    if (opts.pty.onDidChangeName) opts.pty.onDidChangeName((n) => (t.name = n));
    queueMicrotask(() => opts.pty.open()); // VS Code opens the pty after createTerminal returns
  }
  state.terminals.push(t);
  return t;
}

// Anything not defined below: callable, constructible, chainable, does nothing.
const any = () =>
  new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : any()),
    apply: () => any(),
    construct: () => any(),
  });

const message = (text) => {
  state.messages.push(text);
  return Promise.resolve(undefined);
};

const windowApi = {
  get activeTerminal() {
    return state.activeTerminal;
  },
  get state() {
    return { focused: state.focused };
  },
  onDidChangeActiveTerminal: activeTerminalChanged.event,
  createTerminal,
  createStatusBarItem() {
    const item = { text: '', tooltip: undefined, visible: false, show: () => (item.visible = true), hide: () => (item.visible = false), dispose() {} };
    state.statusItems.push(item);
    return item;
  },
  showInformationMessage: message,
  showWarningMessage: message,
  showErrorMessage: message,
  showQuickPick: async (items) => state.pick(items),
};

const workspaceApi = {
  workspaceFolders: undefined, // no folder open: every command is in scope
  getConfiguration: () => ({ get: (name) => state.config[name], inspect: () => undefined, update: async () => {} }),
};

const withFallback = (api) => new Proxy(api, { get: (t, k) => (k in t ? t[k] : any()) });

const vscode = withFallback({
  EventEmitter,
  window: withFallback(windowApi),
  workspace: withFallback(workspaceApi),
  StatusBarAlignment: { Left: 1, Right: 2 },
  env: { remoteName: undefined },
  version: 'test',
});

const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};

// Let queued microtasks and timers shorter than `ms` run.
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// A store with only what TerminalManager, Notifier and FailureIndicator use.
function fakeStore() {
  const record = new EventEmitter();
  const session = new EventEmitter();
  return {
    records: new Map(),
    changes: new Map(),
    turnEnds: new Map(),
    onRecord: record.event,
    onSessionEvent: session.event,
    inScope: () => true,
    fireRecord: (rec, type) => record.fire({ rec, type }),
    fireSession: (ev) => session.fire(ev),
  };
}

let nextId = 0;
// A command Claude just started.
function runningCommand(label, extra = {}) {
  return { id: `rec${++nextId}`, tool: 'Bash', command: label, description: '', status: 'running', startTs: Date.now(), session: 'session-1', ...extra };
}

module.exports = { vscode, state, EventEmitter, setActiveTerminal, userTerminal, wait, fakeStore, runningCommand };
