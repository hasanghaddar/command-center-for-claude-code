// Transcript viewer: one webview tab per session, following it live. The page
// itself is media/transcript.js and media/transcript.css.

const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const { TranscriptReader } = require('./transcript');

const MAX_INPUT_FIELD = 8000;

// Tool inputs can hold whole files (Write); the page gets a shortened copy.
function slim(item) {
  if (item.kind !== 'tool' || !item.input || typeof item.input !== 'object') return item;
  const input = {};
  for (const [k, v] of Object.entries(item.input)) {
    input[k] = typeof v === 'string' && v.length > MAX_INPUT_FIELD ? v.slice(0, MAX_INPUT_FIELD) + `\n… [${v.length - MAX_INPUT_FIELD} more characters]` : v;
  }
  return { ...item, input };
}

function sessionMeta(s, label) {
  return {
    id: s.id,
    title: label(s),
    cwd: s.cwd,
    firstTs: s.firstTs,
    lastTs: s.lastTs,
    cost: s.cost,
    tokens: s.tokens,
    live: s.live,
  };
}

class TranscriptViews {
  // label: session -> display title
  constructor(context, index, label) {
    this.context = context;
    this.index = index;
    this.label = label;
    this.views = new Map(); // session ID -> TranscriptView
  }

  // focus: { uuid?, toolId?, query? } to scroll to a message or tool call
  open(sessionId, focus) {
    const s = this.index.get(sessionId);
    if (!s || !s.file) {
      vscode.window.showWarningMessage('That session’s transcript wasn’t found. It may be older than the "sessionDays" setting, or deleted.');
      return;
    }
    const existing = this.views.get(sessionId);
    if (existing) {
      existing.panel.reveal();
      if (focus) existing.post({ type: 'focus', focus });
      return;
    }
    this.views.set(sessionId, new TranscriptView(this, s, focus));
  }
}

class TranscriptView {
  constructor(owner, session, focus) {
    this.owner = owner;
    this.session = session;
    this.focus = focus;
    this.reader = new TranscriptReader(session.file);
    const media = vscode.Uri.joinPath(owner.context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('claudeCommandCenter.transcript', `Transcript: ${owner.label(session).slice(0, 40)}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(media, 'icon-light.svg'),
      dark: vscode.Uri.joinPath(media, 'icon-dark.svg'),
    };
    this.panel.webview.html = this.html(media);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => {
      clearInterval(this.timer);
      owner.views.delete(session.id);
    });
  }

  post(msg) {
    this.panel.webview.postMessage(msg);
  }

  meta() {
    const s = this.owner.index.get(this.session.id) || this.session;
    return sessionMeta(s, this.owner.label);
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'ready': {
        this.reader = new TranscriptReader(this.session.file); // a reloaded page starts over
        const { added } = this.reader.read();
        this.post({ type: 'init', meta: this.meta(), items: added.map(slim), focus: this.focus });
        this.focus = null;
        clearInterval(this.timer);
        this.timer = setInterval(() => this.tick(), 1000);
        break;
      }
      case 'full': {
        const full = this.reader.fullResults.get(msg.id);
        if (full) vscode.workspace.openTextDocument({ content: full, language: 'log' }).then((d) => vscode.window.showTextDocument(d, { preview: true }));
        break;
      }
      case 'command':
        if (['openSession', 'resumeSession', 'sessionDiff'].includes(msg.name)) {
          vscode.commands.executeCommand(`claudeCommandCenter.${msg.name}`, this.session.id);
        }
        break;
      case 'openFile': {
        if (typeof msg.path !== 'string') break;
        // Links in replies are relative to the session's folder, and may end in #L12 or :12
        const m = /^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+))?$/.exec(decodeURIComponent(msg.path));
        const file = path.isAbsolute(m[1]) || !this.session.cwd ? m[1] : path.join(this.session.cwd, m[1]);
        const line = Number(m[2] || m[3]) || 0;
        vscode.workspace.openTextDocument(vscode.Uri.file(file)).then(
          (d) => {
            const at = new vscode.Position(Math.max(0, Math.min(line - 1, d.lineCount - 1)), 0);
            vscode.window.showTextDocument(d, { preview: true, selection: line ? new vscode.Range(at, at) : undefined });
          },
          () => vscode.window.showWarningMessage(`${file} doesn’t exist any more.`)
        );
        break;
      }
    }
  }

  // Follow the session: new messages, tool results, and its open/working state.
  tick() {
    if (!this.panel.visible) return;
    const r = this.reader.read();
    if (r.reset) {
      this.post({ type: 'init', meta: this.meta(), items: this.reader.items.map(slim) });
      return;
    }
    if (r.added.length || r.changed.length) this.post({ type: 'append', items: r.added.map(slim), changed: r.changed.map(slim) });
    const meta = JSON.stringify(this.meta());
    if (meta !== this.lastMeta) {
      this.lastMeta = meta;
      this.post({ type: 'meta', meta: JSON.parse(meta) });
    }
  }

  html(media) {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};`;
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'transcript.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'transcript.js'));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcript</title>
<link rel="stylesheet" href="${css}">
</head>
<body>
<header class="top">
  <div class="title-row">
    <h1 id="title">Transcript</h1>
    <span class="live" id="live" hidden></span>
    <div class="actions">
      <button class="btn" data-command="openSession" title="Open in the Claude Code panel, or resume it in a terminal">Open session</button>
      <button class="btn ghost" data-command="resumeSession">Resume in terminal</button>
      <button class="btn ghost" data-command="sessionDiff" title="Every file this session changed">Session diff</button>
    </div>
  </div>
  <div class="facts" id="facts"></div>
  <div class="toolbar">
    <div class="search">
      <input id="search" type="search" placeholder="Search this conversation…" aria-label="Search this conversation">
      <span id="count" class="count"></span>
      <button class="icon" id="prev" title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
      <button class="icon" id="next" title="Next match (Enter)" aria-label="Next match">↓</button>
    </div>
    <label><input type="checkbox" id="only"> Only matches</label>
    <label><input type="checkbox" id="tools" checked> Tool calls</label>
    <label><input type="checkbox" id="thinking" checked> Thinking</label>
    <button class="btn ghost" id="expand">Expand all</button>
    <button class="btn ghost" id="collapse">Collapse all</button>
  </div>
</header>
<main id="list" aria-live="polite"></main>
<button class="btn to-end" id="toEnd" hidden>↓ Latest</button>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

module.exports = { TranscriptViews };
