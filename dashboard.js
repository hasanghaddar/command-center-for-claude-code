// Dashboard: a webview tab with stats, filters, a command list and a
// detail pane that streams output.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_INITIAL_OUTPUT = 512 * 1024;

function summarize(rec) {
  return {
    id: rec.id,
    tool: rec.tool,
    command: rec.command,
    description: rec.description,
    cwd: rec.cwd,
    project: rec.cwd ? path.basename(rec.cwd) : '',
    status: rec.status,
    background: !!rec.background,
    startTs: rec.startTs,
    endTs: rec.endTs,
    exitCode: rec.exitCode,
    backgroundTaskId: rec.backgroundTaskId,
    outputFile: rec.outputFile,
  };
}

const PREVIEW_MAX = 16 * 1024;
const clipPreview = (s) => (typeof s === 'string' && s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX) + '\n…' : s);

// Short folder label for a changed file: "src/lib" inside a workspace, the
// project's name for files at a workspace root (asRelativePath returns a root
// folder's full path unchanged), the full folder otherwise.
function folderLabel(file) {
  const dir = path.dirname(file);
  const rel = vscode.workspace.asRelativePath(dir, false);
  if (rel !== dir) return rel;
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  return folder ? folder.name : dir;
}

function summarizeChange(ch) {
  return {
    id: ch.id,
    tool: ch.tool,
    file: ch.file,
    name: path.basename(ch.file),
    dir: folderLabel(ch.file),
    status: ch.status,
    created: !!ch.created,
    ts: ch.ts,
    oldString: clipPreview(ch.oldString),
    newString: clipPreview(ch.newString),
    replaceAll: ch.replaceAll,
    edits: ch.edits,
    error: ch.error,
    hasSnapshots: !!(ch.before || ch.after),
  };
}

class Dashboard {
  constructor(context, store, findTaskOutput) {
    this.context = context;
    this.store = store;
    this.findTaskOutput = findTaskOutput;
    this.panel = null;
    this.selected = null;
    this.tailOffset = 0;
    store.onChange(() => this.pushState());
    store.onRecord(({ rec }) => {
      if (this.panel && rec.id === this.selected) this.sendOutput(true);
    });
  }

  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel('claudeCommandCenter.dashboard', 'Command Center', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    });
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon-dark.svg'),
    };
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => {
      clearInterval(this.tailTimer);
      this.panel = null;
    });
    this.tailTimer = setInterval(() => this.tail(), 500);
  }

  onMessage(msg) {
    const rec = msg.id ? this.store.records.get(msg.id) : null;
    switch (msg.type) {
      case 'ready':
        this.pushState();
        if (this.selected) this.sendOutput(true);
        break;
      case 'select':
        this.selected = msg.id;
        this.sendOutput(true);
        break;
      case 'action':
        this.action(msg.action, rec);
        break;
      case 'change': {
        const ch = this.store.changes.get(msg.id);
        const cmd = {
          diff: 'claudeCommandCenter.openChangeDiff',
          current: 'claudeCommandCenter.compareWithCurrent',
          file: 'claudeCommandCenter.openChangedFile',
          chat: 'claudeCommandCenter.addChangeToChat',
        }[msg.action];
        if (ch && cmd) vscode.commands.executeCommand(cmd, ch);
        break;
      }
      case 'scope':
        vscode.commands.executeCommand('claudeCommandCenter.toggleScope', msg.scope);
        break;
    }
  }

  action(name, rec) {
    const cmd = {
      stop: 'claudeCommandCenter.stop',
      copy: 'claudeCommandCenter.copyCommand',
      rerun: 'claudeCommandCenter.runInTerminal',
      terminal: 'claudeCommandCenter.open',
      feed: 'claudeCommandCenter.openFeed',
      chat: 'claudeCommandCenter.addCommandToChat',
      clear: 'claudeCommandCenter.clear',
    }[name];
    if (!cmd) return;
    if (rec) vscode.commands.executeCommand(cmd, rec);
    else vscode.commands.executeCommand(cmd);
  }

  pushState() {
    if (!this.panel) return;
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.name);
    this.panel.webview.postMessage({
      type: 'state',
      records: this.store.list().map(summarize),
      changes: this.store.listChanges().map(summarizeChange),
      scope: this.store.scope,
      workspace: folders.join(', '),
    });
  }

  // Full output for the selected record, then tail() appends to it.
  sendOutput() {
    if (!this.panel) return;
    const rec = this.selected && this.store.records.get(this.selected);
    if (!rec) {
      this.panel.webview.postMessage({ type: 'output', id: this.selected, stdout: '', stderr: '' });
      return;
    }
    let stdout = rec.stdout || '';
    this.tailOffset = 0;
    if (rec.status === 'background' || (rec.background && rec.outputFile)) {
      if (!rec.outputFile) rec.outputFile = this.findTaskOutput(rec.session, rec.backgroundTaskId);
      if (rec.outputFile) {
        const { text, size } = readFrom(rec.outputFile, 0, MAX_INITIAL_OUTPUT);
        stdout = text;
        this.tailOffset = size;
      }
    }
    this.panel.webview.postMessage({ type: 'output', id: rec.id, stdout, stderr: rec.stderr || '' });
  }

  tail() {
    if (!this.panel || !this.panel.visible) return;
    const rec = this.selected && this.store.records.get(this.selected);
    if (!rec || rec.status !== 'background' || !rec.outputFile) return;
    let size;
    try {
      size = fs.statSync(rec.outputFile).size;
    } catch {
      return;
    }
    if (size < this.tailOffset) return this.sendOutput();
    if (size === this.tailOffset) return;
    const { text } = readFrom(rec.outputFile, this.tailOffset, 1024 * 1024);
    this.tailOffset = size;
    this.panel.webview.postMessage({ type: 'append', id: rec.id, text });
  }

  html(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};`;
    return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Command Center</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header class="top">
  <div class="title">
    <h1>Command Center</h1>
    <div class="tabs" id="tabs" role="tablist">
      <button data-tab="commands" role="tab">Commands <b id="n-commands">0</b></button>
      <button data-tab="changes" role="tab">File changes <b id="n-changes">0</b></button>
    </div>
    <div class="stats" id="stats"></div>
  </div>
  <div class="toolbar">
    <input id="search" type="search" placeholder="Search commands, descriptions, folders…" aria-label="Search">
    <div class="seg" id="scope" title="Which commands to show">
      <button data-s="workspace" class="on" id="scope-ws">This workspace</button>
      <button data-s="all">All</button>
    </div>
    <div class="seg" id="filter" role="tablist">
      <button data-f="all" class="on">All</button>
      <button data-f="active">Active</button>
      <button data-f="failed">Failed</button>
    </div>
    <select id="project" aria-label="Project"><option value="">All projects</option></select>
    <button class="btn ghost" data-action="feed" title="Open the live feed terminal">Live feed</button>
    <button class="btn ghost" data-action="clear" title="Clear history">Clear</button>
  </div>
</header>
<main>
  <section class="list" id="list" aria-label="Commands"></section>
  <section class="detail" id="detail" aria-label="Details"></section>
</main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
  }
}

function readFrom(file, offset, max) {
  try {
    const size = fs.statSync(file).size;
    let start = offset;
    let prefix = '';
    if (size - start > max) {
      start = size - max;
      prefix = '… [earlier output omitted] …\n';
    }
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return { text: prefix + buf.toString('utf8'), size };
  } catch {
    return { text: '', size: offset };
  }
}

const CSS = `
:root {
  --bg: var(--vscode-editor-background);
  --fg: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground);
  --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,.25)));
  --hover: var(--vscode-list-hoverBackground);
  --sel: var(--vscode-list-activeSelectionBackground);
  --sel-fg: var(--vscode-list-activeSelectionForeground);
  --card: var(--vscode-sideBar-background, var(--bg));
  --code-bg: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
  --term-bg: var(--vscode-terminal-background, var(--vscode-panel-background, var(--bg)));
  --term-fg: var(--vscode-terminal-foreground, var(--fg));
  --ok: var(--vscode-testing-iconPassed, #3fb950);
  --bad: var(--vscode-testing-iconFailed, #f85149);
  --run: var(--vscode-charts-yellow, #d29922);
  --bgtask: var(--vscode-charts-blue, #58a6ff);
  --warn: var(--vscode-charts-orange, #db6d28);
  --accent: var(--vscode-focusBorder, #007fd4);
  --mono: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace);
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; padding: 0; background: var(--bg); color: var(--fg);
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
  display: flex; flex-direction: column; overflow: hidden;
}
button { font: inherit; color: inherit; }
.top { padding: 14px 16px 10px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
.title { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 15px; font-weight: 600; margin: 0; letter-spacing: .2px; }
.stats { display: flex; gap: 8px; flex-wrap: wrap; }
.stat { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border: 1px solid var(--border); border-radius: 999px; font-size: 12px; color: var(--muted); }
.stat b { color: var(--fg); font-variant-numeric: tabular-nums; }
.stat .dot { margin: 0; width: 7px; height: 7px; }
button.stat { background: transparent; cursor: pointer; font: inherit; font-size: 12px; }
button.stat:hover { background: var(--hover); color: var(--fg); }
button.stat.on { border-color: var(--accent); background: var(--vscode-button-secondaryBackground, var(--hover)); color: var(--vscode-button-secondaryForeground, var(--fg)); }
.tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 6px; background: var(--code-bg); }
.tabs button { border: 0; background: transparent; padding: 4px 12px; border-radius: 4px; cursor: pointer; color: var(--muted); }
.tabs button b { font-weight: 600; margin-left: 4px; font-variant-numeric: tabular-nums; }
.tabs button.on { background: var(--bg); color: var(--fg); box-shadow: 0 0 0 1px var(--border); }
.tabs button:hover:not(.on) { color: var(--fg); }
.hidden { display: none !important; }
.diff { flex: 1; overflow: auto; margin: 0; padding: 10px 0; background: var(--term-bg); font-family: var(--mono); font-size: 12px; line-height: 1.45; }
.diff .ln { display: block; padding: 0 18px; white-space: pre-wrap; word-break: break-word; }
.diff .del { background: var(--vscode-diffEditor-removedLineBackground, rgba(248,81,73,.15)); }
.diff .add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(63,185,80,.15)); }
.diff .sep { color: var(--muted); padding: 6px 18px; display: block; }
.note { padding: 16px 18px; color: var(--muted); line-height: 1.6; }
.path { font-family: var(--mono); font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
#search { flex: 1 1 180px; min-width: 140px; padding: 5px 9px; border-radius: 4px; border: 1px solid var(--vscode-input-border, var(--border)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font: inherit; }
#search:focus, select:focus, button:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
select { max-width: 170px; padding: 4px 6px; border-radius: 4px; border: 1px solid var(--vscode-dropdown-border, var(--border)); background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); font: inherit; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.seg button { background: transparent; border: 0; padding: 4px 11px; cursor: pointer; color: var(--muted); }
.seg button + button { border-left: 1px solid var(--border); }
.seg button.on { background: var(--vscode-button-secondaryBackground, var(--hover)); color: var(--vscode-button-secondaryForeground, var(--fg)); }
.btn { border-radius: 4px; padding: 4px 11px; cursor: pointer; border: 1px solid transparent; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn:hover { background: var(--vscode-button-hoverBackground); }
.btn.ghost { background: transparent; color: var(--fg); border-color: var(--border); }
.btn.ghost:hover { background: var(--hover); }
.btn.danger { background: var(--bad); color: #fff; }
.btn.danger:hover { filter: brightness(1.1); }

main { flex: 1; display: grid; grid-template-columns: minmax(280px, 38%) 1fr; min-height: 0; }
.list { overflow-y: auto; border-right: 1px solid var(--border); }
.group { position: sticky; top: 0; z-index: 1; background: var(--bg); padding: 8px 14px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: var(--muted); }
.row { display: grid; grid-template-columns: 14px 1fr auto; gap: 4px 10px; align-items: start; padding: 8px 14px; cursor: pointer; border-left: 2px solid transparent; }
.row:hover { background: var(--hover); }
.row.sel { background: var(--sel); color: var(--sel-fg); border-left-color: var(--accent); }
.row.sel .cmd, .row.sel .meta { color: inherit; opacity: .85; }
.dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 4px; background: var(--muted); }
.s-ok .dot { background: var(--ok); }
.s-failed .dot { background: var(--bad); }
.s-interrupted .dot { background: var(--warn); }
.s-noresult .dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--muted); }
.s-stopped .dot { background: var(--muted); opacity: .6; }
.s-running .dot { background: var(--run); animation: pulse 1.2s ease-in-out infinite; }
.s-background .dot { background: var(--bgtask); box-shadow: 0 0 0 3px color-mix(in srgb, var(--bgtask) 25%, transparent); }
@keyframes pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .s-running .dot { animation: none; } }
.name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmd { grid-column: 2 / 4; font-family: var(--mono); font-size: 12px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { font-size: 11px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.empty { padding: 40px 20px; text-align: center; color: var(--muted); line-height: 1.6; }
.empty code { font-family: var(--mono); background: var(--code-bg); padding: 1px 5px; border-radius: 3px; }

.detail { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.d-head { padding: 14px 18px 12px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px; }
.d-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.d-title h2 { margin: 0; font-size: 14px; font-weight: 600; flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; border: 1px solid currentColor; }
.b-ok { color: var(--ok); } .b-failed { color: var(--bad); } .b-running { color: var(--run); }
.b-background { color: var(--bgtask); } .b-interrupted { color: var(--warn); } .b-stopped { color: var(--muted); } .b-noresult { color: var(--muted); }
.actions { display: flex; gap: 6px; flex-wrap: wrap; }
.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 16px; font-size: 12px; }
.facts div span { display: block; color: var(--muted); font-size: 11px; margin-bottom: 1px; }
.facts div b { font-weight: 500; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.command { margin: 0; font-family: var(--mono); font-size: 12px; background: var(--code-bg); padding: 8px 10px; border-radius: 4px; white-space: pre-wrap; word-break: break-all; max-height: 140px; overflow: auto; }
.out-bar { display: flex; align-items: center; gap: 10px; padding: 6px 18px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.out-bar .grow { flex: 1; }
.out-bar label { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
.live { color: var(--bgtask); font-weight: 600; }
.live::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: currentColor; margin-right: 6px; animation: pulse 1.2s infinite; }
pre.output { flex: 1; margin: 0; padding: 12px 18px; overflow: auto; background: var(--term-bg); color: var(--term-fg); font-family: var(--vscode-terminal-font-family, var(--mono)); font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
pre.output .stderr { color: var(--bad); }
pre.output .placeholder { color: var(--muted); font-style: italic; }
.a-b { font-weight: bold; } .a-d { opacity: .7; } .a-i { font-style: italic; } .a-u { text-decoration: underline; }
.a-30,.a-90 { color: var(--vscode-terminal-ansiBrightBlack, #888); }
.a-31 { color: var(--vscode-terminal-ansiRed); } .a-91 { color: var(--vscode-terminal-ansiBrightRed); }
.a-32 { color: var(--vscode-terminal-ansiGreen); } .a-92 { color: var(--vscode-terminal-ansiBrightGreen); }
.a-33 { color: var(--vscode-terminal-ansiYellow); } .a-93 { color: var(--vscode-terminal-ansiBrightYellow); }
.a-34 { color: var(--vscode-terminal-ansiBlue); } .a-94 { color: var(--vscode-terminal-ansiBrightBlue); }
.a-35 { color: var(--vscode-terminal-ansiMagenta); } .a-95 { color: var(--vscode-terminal-ansiBrightMagenta); }
.a-36 { color: var(--vscode-terminal-ansiCyan); } .a-96 { color: var(--vscode-terminal-ansiBrightCyan); }
.a-37,.a-97 { color: var(--vscode-terminal-ansiWhite); }
.no-sel { margin: auto; color: var(--muted); text-align: center; padding: 20px; }

@media (max-width: 720px) {
  main { grid-template-columns: 1fr; grid-template-rows: minmax(160px, 40%) 1fr; }
  .list { border-right: 0; border-bottom: 1px solid var(--border); }
}
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
let records = [];
let selected = saved.selected || null;
let filter = saved.filter || 'all';
let project = saved.project || '';
let query = '';
let follow = saved.follow !== false;
let output = { id: null, stdout: '', stderr: '' };
let tab = saved.tab || 'commands';
let changes = [];
let selectedChange = saved.selectedChange || null;
let changeFilter = saved.changeFilter || 'all';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const save = () => vscode.setState({ selected, filter, project, follow, tab, selectedChange, changeFilter });
const changeKind = (c) => (c.status === 'failed' ? 'failed' : c.created ? 'created' : 'edited');
const CHANGE_LABEL = { edited: 'Edited', created: 'Created', failed: 'Failed', pending: 'Saving…' };

const STATUS_LABEL = { running: 'Running', background: 'Background', ok: 'Done', failed: 'Failed', interrupted: 'Interrupted', stopped: 'Stopped', noresult: 'No result' };
const isActive = (r) => r.status === 'running' || r.status === 'background';

function dur(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + Math.round(s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function dayLabel(ts) {
  const d = new Date(ts), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
const elapsed = (r) => (r.endTs || Date.now()) - r.startTs;
const firstLine = (s) => String(s || '').split(/\\r?\\n/)[0];

// Minimal ANSI SGR -> spans (colors, bold, dim, italic, underline); other escapes are dropped.
function ansi(text) {
  let html = '', open = 0, cls = new Set();
  const re = /\\x1b\\[([0-9;]*)m|\\x1b\\[[0-9;?]*[A-Za-z]|\\x1b\\][^\\x07]*\\x07|\\r(?!\\n)/g;
  let last = 0, m;
  const flush = (chunk) => { if (chunk) html += esc(chunk); };
  while ((m = re.exec(text))) {
    flush(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === undefined) continue;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (const code of codes) {
      if (code === 0) cls.clear();
      else if (code === 1) cls.add('a-b');
      else if (code === 2) cls.add('a-d');
      else if (code === 3) cls.add('a-i');
      else if (code === 4) cls.add('a-u');
      else if (code === 22) { cls.delete('a-b'); cls.delete('a-d'); }
      else if (code === 39) { for (const c of [...cls]) if (/^a-[39]\\d$/.test(c)) cls.delete(c); }
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        for (const c of [...cls]) if (/^a-[39]\\d$/.test(c)) cls.delete(c);
        cls.add('a-' + code);
      }
    }
    while (open) { html += '</span>'; open--; }
    if (cls.size) { html += '<span class="' + [...cls].join(' ') + '">'; open++; }
  }
  flush(text.slice(last));
  while (open) { html += '</span>'; open--; }
  return html;
}

function visible() {
  const q = query.toLowerCase();
  return records.filter((r) => {
    if (filter === 'active' && !isActive(r)) return false;
    if (filter === 'running' && r.status !== 'running') return false;
    if (filter === 'background' && r.status !== 'background') return false;
    if (filter === 'failed' && !(r.status === 'failed' || r.status === 'interrupted')) return false;
    if (project && r.project !== project) return false;
    if (q && !((r.command || '') + ' ' + (r.description || '') + ' ' + (r.cwd || '')).toLowerCase().includes(q)) return false;
    return true;
  });
}

function visibleChanges() {
  const q = query.toLowerCase();
  return changes.filter((c) => {
    if (changeFilter !== 'all' && changeKind(c) !== changeFilter) return false;
    if (q && !(c.file + ' ' + c.tool).toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderChangeStats() {
  const n = (k) => changes.filter((c) => changeKind(c) === k).length;
  const chips = [
    ['Edited', n('edited'), 's-background', 'edited'],
    ['Created', n('created'), 's-ok', 'created'],
    ['Failed', n('failed'), 's-failed', 'failed'],
    ['Total', changes.length, '', 'all'],
  ];
  $('stats').innerHTML = chips.map(([label, v, cls, f]) =>
    '<button class="stat ' + cls + (changeFilter === f ? ' on' : '') + '" data-stat="' + f + '" aria-pressed="' + (changeFilter === f) + '"' +
    ' title="' + (f === 'all' ? 'Show all file changes' : 'Show only ' + label.toLowerCase() + ' files') + '">' +
    '<span class="dot"></span>' + label + ' <b>' + v + '</b></button>').join('');
}

function renderChangeList() {
  const list = $('list');
  const rows = visibleChanges();
  if (!changes.length) {
    list.innerHTML = '<div class="empty">No file changes recorded yet.<br>The hook needs <code>Edit|Write|MultiEdit|NotebookEdit</code> in its matcher (see README).</div>';
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nothing matches these filters.</div>';
    return;
  }
  let html = '', lastDay = '';
  for (const c of rows) {
    const day = dayLabel(c.ts);
    if (day !== lastDay) { html += '<div class="group">' + esc(day) + '</div>'; lastDay = day; }
    const kind = c.status === 'pending' ? 'pending' : changeKind(c);
    const cls = { edited: 's-background', created: 's-ok', failed: 's-failed', pending: 's-running' }[kind];
    html += '<div class="row ' + cls + (c.id === selectedChange ? ' sel' : '') + '" data-id="' + esc(c.id) + '" tabindex="0" role="button" title="Click to open the diff">' +
      '<span class="dot" title="' + esc(CHANGE_LABEL[kind]) + '"></span>' +
      '<span class="name">' + esc(c.name) + '</span>' +
      '<span class="meta">' + esc(CHANGE_LABEL[kind]) + ' · ' + esc(time(c.ts)) + '</span>' +
      '<span class="cmd">' + esc(c.dir && c.dir !== '.' ? c.dir : c.file) + '</span>' +
      '</div>';
  }
  list.innerHTML = html;
}

function diffPreview(c) {
  if (c.tool === 'Edit' && (c.oldString != null || c.newString != null)) {
    const lines = (s, cls, sign) => String(s || '').split(/\\r?\\n/).map((l) => '<span class="ln ' + cls + '">' + sign + ' ' + esc(l) + '</span>').join('');
    return '<pre class="diff">' + lines(c.oldString, 'del', '-') + lines(c.newString, 'add', '+') +
      (c.replaceAll ? '<span class="sep">(replaced every occurrence)</span>' : '') + '</pre>';
  }
  if (c.status === 'failed') return '<div class="note">The edit failed, so the file was not changed.</div>';
  const what = c.tool === 'MultiEdit' && c.edits ? c.edits + ' edits in one go.' : c.created ? 'New file.' : 'File rewritten.';
  return '<div class="note">' + esc(what) + ' Open the diff to see the full change.</div>';
}

function renderChangeDetail() {
  const d = $('detail');
  const c = changes.find((x) => x.id === selectedChange);
  if (!c) {
    d.innerHTML = '<div class="no-sel">Select a file change to see it. Clicking one opens its diff.</div>';
    return;
  }
  const kind = c.status === 'pending' ? 'pending' : changeKind(c);
  const badge = { edited: 'b-background', created: 'b-ok', failed: 'b-failed', pending: 'b-running' }[kind];
  const facts = [['Tool', c.tool], ['When', new Date(c.ts).toLocaleString()], ['Folder', c.dir || '—']];
  d.innerHTML =
    '<div class="d-head">' +
      '<div class="d-title"><span class="badge ' + badge + '">' + esc(CHANGE_LABEL[kind]) + '</span>' +
      '<h2>' + esc(c.name) + '</h2>' +
      '<div class="actions">' +
        (c.status !== 'failed' ? '<button class="btn" data-change="diff">Open diff</button>' : '') +
        '<button class="btn ghost" data-change="current" title="Compare the file before this edit with the file as it is now">Compare with current</button>' +
        '<button class="btn ghost" data-change="chat" title="@-mention this file (and the edited lines) in the Claude chat">Add to chat</button>' +
        '<button class="btn ghost" data-change="file">Open file</button>' +
      '</div></div>' +
      '<div class="path">' + esc(c.file) + '</div>' +
      '<div class="facts">' + facts.map(([k, v]) => '<div><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('') + '</div>' +
      (c.error ? '<pre class="command">' + esc(c.error) + '</pre>' : '') +
    '</div>' +
    '<div class="out-bar"><span>' + (c.tool === 'Edit' ? 'Change' : 'Summary') + '</span></div>' +
    diffPreview(c);
}

function selectChange(id, openDiff) {
  if (id !== selectedChange) {
    selectedChange = id;
    save();
    renderChangeList();
    renderChangeDetail();
  }
  const c = changes.find((x) => x.id === id);
  if (openDiff && c && c.status !== 'failed') vscode.postMessage({ type: 'change', action: 'diff', id });
}

function setTab(t) {
  tab = t;
  save();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $('filter').classList.toggle('hidden', t === 'changes');
  $('project').classList.toggle('hidden', t === 'changes');
  $('search').placeholder = t === 'changes' ? 'Search file paths…' : 'Search commands, descriptions, folders…';
  renderStats();
  renderList();
  renderDetail();
}

function renderStats() {
  if (tab === 'changes') return renderChangeStats();
  const n = (f) => records.filter(f).length;
  const chips = [
    ['Running', n((r) => r.status === 'running'), 's-running', 'running'],
    ['Background', n((r) => r.status === 'background'), 's-background', 'background'],
    ['Failed', n((r) => r.status === 'failed' || r.status === 'interrupted'), 's-failed', 'failed'],
    ['Total', records.length, '', 'all'],
  ];
  $('stats').innerHTML = chips.map(([label, v, cls, f]) =>
    '<button class="stat ' + cls + (filter === f ? ' on' : '') + '" data-stat="' + f + '" aria-pressed="' + (filter === f) + '"' +
    ' title="' + (f === 'all' ? 'Show all commands' : 'Show only ' + label.toLowerCase() + ' commands') + '">' +
    '<span class="dot"></span>' + label + ' <b>' + v + '</b></button>').join('');
}

function renderProjects() {
  const sel = $('project');
  const projects = [...new Set(records.map((r) => r.project).filter(Boolean))].sort();
  const want = ['', ...projects].join('|');
  if (sel.dataset.list !== want) {
    sel.innerHTML = '<option value="">All projects</option>' + projects.map((p) => '<option>' + esc(p) + '</option>').join('');
    sel.dataset.list = want;
  }
  sel.value = projects.includes(project) ? project : '';
}

function renderList() {
  if (tab === 'changes') return renderChangeList();
  const list = $('list');
  const rows = visible();
  if (!records.length) {
    list.innerHTML = '<div class="empty">No commands recorded yet.<br>Once the hook is set up, every command Claude runs shows up here.<br><br>Events file: <code>~/.claude/command-center/log/events.jsonl</code></div>';
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nothing matches these filters.</div>';
    return;
  }
  let html = '', lastDay = '';
  for (const r of rows) {
    const day = dayLabel(r.startTs);
    if (day !== lastDay) { html += '<div class="group">' + esc(day) + '</div>'; lastDay = day; }
    const meta = r.status === 'running' ? 'running ' + dur(elapsed(r))
      : r.status === 'background' ? 'background'
      : dur(elapsed(r));
    html += '<div class="row s-' + r.status + (r.id === selected ? ' sel' : '') + '" data-id="' + esc(r.id) + '" tabindex="0" role="button">' +
      '<span class="dot" title="' + esc(STATUS_LABEL[r.status] || r.status) + '"></span>' +
      '<span class="name">' + esc(r.description || firstLine(r.command)) + '</span>' +
      '<span class="meta">' + esc(meta) + ' · ' + esc(time(r.startTs)) + '</span>' +
      '<span class="cmd">' + (r.project ? esc(r.project) + ' › ' : '') + esc(firstLine(r.command)) + '</span>' +
      '</div>';
  }
  list.innerHTML = html;
}

function renderDetail() {
  if (tab === 'changes') return renderChangeDetail();
  const d = $('detail');
  const r = records.find((x) => x.id === selected);
  if (!r) {
    d.innerHTML = '<div class="no-sel">Select a command to see its details and output.</div>';
    return;
  }
  const facts = [
    ['Tool', r.tool],
    ['Started', new Date(r.startTs).toLocaleString()],
    ['Duration', r.status === 'background' ? 'still running' : dur(elapsed(r))],
    r.exitCode != null ? ['Exit code', r.exitCode] : null,
    r.backgroundTaskId ? ['Task', r.backgroundTaskId] : null,
    ['Folder', r.cwd || '—'],
  ].filter(Boolean);
  d.innerHTML =
    '<div class="d-head">' +
      '<div class="d-title"><span class="badge b-' + r.status + '">' + esc(STATUS_LABEL[r.status] || r.status) + '</span>' +
      '<h2>' + esc(r.description || firstLine(r.command)) + '</h2>' +
      '<div class="actions">' +
        (r.status === 'background' ? '<button class="btn danger" data-action="stop">Stop</button>' : '') +
        '<button class="btn ghost" data-action="chat" title="Save the command and its output to a file and @-mention it in the Claude chat">Add to chat</button>' +
        '<button class="btn ghost" data-action="terminal">Open in terminal</button>' +
        '<button class="btn ghost" data-action="rerun">Run again</button>' +
        '<button class="btn ghost" data-action="copy">Copy</button>' +
      '</div></div>' +
      '<div class="facts">' + facts.map(([k, v]) => '<div><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('') + '</div>' +
      '<pre class="command">$ ' + esc(r.command) + '</pre>' +
    '</div>' +
    '<div class="out-bar">' +
      (r.status === 'background' ? '<span class="live">Live</span>' : '<span>Output</span>') +
      '<span class="grow"></span>' +
      '<label><input type="checkbox" id="follow"' + (follow ? ' checked' : '') + '> Follow</label>' +
    '</div>' +
    '<pre class="output" id="output"></pre>';
  $('follow').addEventListener('change', (e) => { follow = e.target.checked; save(); if (follow) scrollOut(); });
  renderOutput();
}

function renderOutput() {
  const el = $('output');
  const r = records.find((x) => x.id === selected);
  if (!el || !r) return;
  if (output.id !== r.id) { el.innerHTML = '<span class="placeholder">Loading…</span>'; return; }
  let html = ansi(output.stdout || '');
  if (output.stderr) html += (html ? '\\n' : '') + '<span class="stderr">' + ansi(output.stderr) + '</span>';
  if (!html) {
    html = '<span class="placeholder">' + (r.status === 'running'
      ? 'Running… output appears when the command finishes.'
      : r.status === 'background' ? 'Waiting for output…'
      : r.status === 'noresult' ? 'No result: the command was denied, cancelled or interrupted before it finished.' : 'No output.') + '</span>';
  }
  el.innerHTML = html;
  scrollOut();
}

function scrollOut() {
  const el = $('output');
  if (el && follow) el.scrollTop = el.scrollHeight;
}

function select(id) {
  if (id === selected) return;
  selected = id;
  save();
  output = { id: null, stdout: '', stderr: '' };
  renderList();
  renderDetail();
  vscode.postMessage({ type: 'select', id });
}

function renderAll() {
  renderStats();
  renderProjects();
  renderList();
  $('n-commands').textContent = records.length;
  $('n-changes').textContent = changes.length;
  let key;
  if (tab === 'changes') {
    const c = changes.find((x) => x.id === selectedChange);
    key = c ? 'c' + c.id + c.status : '';
  } else {
    const r = records.find((x) => x.id === selected);
    key = r ? r.id + r.status + r.endTs + r.exitCode : '';
  }
  if (key !== renderAll.lastKey) { renderAll.lastKey = key; renderDetail(); }
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'state') {
    records = msg.records;
    changes = msg.changes || [];
    document.querySelectorAll('#scope button').forEach((b) => b.classList.toggle('on', b.dataset.s === msg.scope));
    $('scope-ws').title = msg.workspace ? 'Commands run inside: ' + msg.workspace : 'No folder open: showing everything';
    if (!selected && records.length) select(records[0].id);
    renderAll();
  } else if (msg.type === 'output' && msg.id === selected) {
    output = msg;
    renderOutput();
  } else if (msg.type === 'append' && msg.id === selected && output.id === selected) {
    output.stdout += msg.text;
    const el = $('output');
    if (el) {
      if (el.querySelector('.placeholder')) el.innerHTML = '';
      el.insertAdjacentHTML('beforeend', ansi(msg.text));
      scrollOut();
    }
  }
});

document.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (row) return tab === 'changes' ? selectChange(row.dataset.id, true) : select(row.dataset.id);
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) return setTab(tabBtn.dataset.tab);
  const changeBtn = e.target.closest('[data-change]');
  if (changeBtn) return vscode.postMessage({ type: 'change', action: changeBtn.dataset.change, id: selectedChange });
  const btn = e.target.closest('[data-action]');
  if (btn) vscode.postMessage({ type: 'action', action: btn.dataset.action, id: btn.closest('.detail') ? selected : undefined });
  const scopeBtn = e.target.closest('#scope button');
  if (scopeBtn) return vscode.postMessage({ type: 'scope', scope: scopeBtn.dataset.s });
  const stat = e.target.closest('[data-stat]');
  if (stat) {
    const current = tab === 'changes' ? changeFilter : filter;
    return setFilter(stat.dataset.stat === current ? 'all' : stat.dataset.stat);
  }
  const seg = e.target.closest('#filter button');
  if (seg) setFilter(seg.dataset.f);
});

function setFilter(f) {
  if (tab === 'changes') {
    changeFilter = f;
    save();
    renderStats();
    renderList();
    return;
  }
  filter = f;
  document.querySelectorAll('#filter button').forEach((b) => b.classList.toggle('on', b.dataset.f === f));
  save();
  renderStats();
  renderList();
}

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'search') return;
  const rows = [...document.querySelectorAll('.row')];
  const cur = tab === 'changes' ? selectedChange : selected;
  const pick = (id) => (tab === 'changes' ? selectChange(id, false) : select(id));
  const i = rows.findIndex((r) => r.dataset.id === cur);
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); const n = rows[Math.min(i + 1, rows.length - 1)]; if (n) { pick(n.dataset.id); n.scrollIntoView({ block: 'nearest' }); } }
  else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); const n = rows[Math.max(i - 1, 0)]; if (n) { pick(n.dataset.id); n.scrollIntoView({ block: 'nearest' }); } }
  else if (e.key === 'Enter' && e.target.classList.contains('row')) {
    if (tab === 'changes') selectChange(e.target.dataset.id, true);
    else select(e.target.dataset.id);
  }
  else if (e.key === '/') { e.preventDefault(); $('search').focus(); }
});

$('search').addEventListener('input', (e) => { query = e.target.value; renderList(); });
$('project').addEventListener('change', (e) => { project = e.target.value; save(); renderList(); });
document.querySelectorAll('#filter button').forEach((b) => b.classList.toggle('on', b.dataset.f === filter));

// keep running timers fresh
setInterval(() => {
  if (records.some(isActive)) {
    renderList();
    const r = records.find((x) => x.id === selected);
    if (r && r.status === 'running') {
      const facts = document.querySelectorAll('.facts b');
      if (facts[2]) facts[2].textContent = dur(elapsed(r));
    }
  }
}, 1000);

setTab(tab);
vscode.postMessage({ type: 'ready' });
if (selected) vscode.postMessage({ type: 'select', id: selected });
`;

module.exports = { Dashboard, folderLabel };
