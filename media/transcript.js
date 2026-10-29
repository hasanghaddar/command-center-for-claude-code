// Transcript viewer page: renders the items transcript.js produces, with
// search, filters and live updates.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const $ = (id) => document.getElementById(id);
  const list = $('list');

  let items = []; // in order; item.n is its index
  let query = '';
  let matches = []; // item indexes
  let current = -1; // position in matches
  const opts = { only: false, tools: saved.tools !== false, thinking: saved.thinking !== false };

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const time = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const tokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0));

  // Wrap matches of the current query in <mark>, on already-escaped text.
  function hl(escaped) {
    if (!query) return escaped;
    const q = esc(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped.replace(new RegExp(q, 'gi'), (m) => '<mark>' + m + '</mark>');
  }

  // A little Markdown: code fences, inline code, bold, headings and lists.
  function markdown(src) {
    return String(src)
      .split(/(```[\s\S]*?(?:```|$))/g)
      .map((part) => {
        if (part.startsWith('```')) {
          const body = part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
          return '<pre class="code">' + hl(esc(body)) + '</pre>';
        }
        return hl(esc(part))
          .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text, target) =>
            /^https?:/.test(target) ? text : '<a class="file" href="#" data-file="' + target.replace(/<\/?mark>/g, '') + '">' + text + '</a>'
          )
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
          .split('\n')
          .map((line) => {
            let m;
            if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) return '<div class="h">' + m[2] + '</div>';
            if ((m = /^(\s*)[-*]\s+(.*)$/.exec(line))) return '<div class="li" style="margin-left:' + m[1].length * 6 + 'px">• ' + m[2] + '</div>';
            if ((m = /^(\s*)(\d+)\.\s+(.*)$/.exec(line))) return '<div class="li" style="margin-left:' + m[1].length * 6 + 'px">' + m[2] + '. ' + m[3] + '</div>';
            if (/^\s*\|.*\|\s*$/.test(line)) return '<div class="table-row">' + line + '</div>';
            return line.trim() ? '<p>' + line + '</p>' : '';
          })
          .join('');
      })
      .join('');
  }

  // Everything searchable in an item.
  function haystack(it) {
    if (it._hay == null) {
      it._hay = [it.text, it.name, it.summary, it.input && JSON.stringify(it.input), it.result, (it.context || []).join(' ')]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
    }
    return it._hay;
  }

  function toolStatus(it) {
    if (it.result == null) return ['running', '…'];
    return it.isError ? ['error', '✕'] : ['ok', '✓'];
  }

  function toolInput(it) {
    const i = it.input || {};
    if ((it.name === 'Bash' || it.name === 'PowerShell') && i.command) return '<pre class="code">$ ' + hl(esc(i.command)) + '</pre>';
    if (it.name === 'Edit' && (i.old_string != null || i.new_string != null)) {
      const lines = (s, cls, sign) => String(s || '').split(/\r?\n/).map((l) => '<span class="' + cls + '">' + sign + ' ' + hl(esc(l)) + '</span>').join('\n');
      return fileLink(i.file_path) + '<pre class="code diff">' + lines(i.old_string, 'del', '-') + '\n' + lines(i.new_string, 'add', '+') + '</pre>';
    }
    if (it.name === 'Write' && i.content != null) return fileLink(i.file_path) + '<pre class="code">' + hl(esc(i.content)) + '</pre>';
    const rest = Object.assign({}, i);
    const head = rest.file_path ? fileLink(rest.file_path) : '';
    delete rest.file_path;
    return head + (Object.keys(rest).length ? '<pre class="code">' + hl(esc(JSON.stringify(rest, null, 2))) + '</pre>' : '');
  }

  function fileLink(p) {
    return p ? '<a class="file" href="#" data-file="' + esc(p) + '">' + esc(p) + '</a>' : '';
  }

  function toolBody(it) {
    let html = '<div class="label">Input</div>' + toolInput(it);
    if (it.result != null) {
      html += '<div class="label">' + (it.isError ? 'Error' : 'Result') + '</div>';
      html += it.result ? '<pre class="code result' + (it.isError ? ' err' : '') + '">' + hl(esc(it.result)) + '</pre>' : '<div class="muted">(no output)</div>';
      if (it.resultTruncated) html += '<button class="btn ghost small" data-full="' + esc(it.id) + '">Open full output (' + tokens(it.resultTruncated) + ' characters)</button>';
    } else {
      html += '<div class="muted">Waiting for the result…</div>';
    }
    return html;
  }

  function render(it) {
    const el = document.createElement('section');
    el.className = 'item k-' + it.kind;
    el.dataset.n = it.n;
    el.innerHTML = inner(it);
    if (it.kind === 'tool' || it.kind === 'thinking' || it.kind === 'summary') {
      const d = el.querySelector('details');
      d.addEventListener('toggle', () => {
        if (d.open && !d.dataset.filled) fill(d, it);
      });
    }
    return el;
  }

  // Tool bodies are built when first opened: long sessions have thousands.
  function fill(details, it) {
    details.dataset.filled = '1';
    details.querySelector('.body').innerHTML = it.kind === 'tool' ? toolBody(it) : it.kind === 'summary' ? markdown(it.text) : '<div class="prose">' + markdown(it.text) + '</div>';
  }

  function inner(it) {
    const when = '<span class="when">' + esc(time(it.ts)) + '</span>';
    switch (it.kind) {
      case 'user': {
        const extra = [];
        if (it.images) extra.push(it.images + ' image' + (it.images === 1 ? '' : 's'));
        for (const c of it.context || []) extra.push(c);
        return '<div class="who">' + (it.origin === 'peer' ? 'Another session' : 'You') + when + '</div>' +
          (extra.length ? '<div class="chips">' + extra.map((x) => '<span class="chip">' + hl(esc(x)) + '</span>').join('') + '</div>' : '') +
          (it.text ? '<div class="prose user-text">' + hl(esc(it.text)) + '</div>' : '');
      }
      case 'assistant':
        return '<div class="who">Claude' + (it.model ? ' <span class="model">' + esc(it.model.replace(/^claude-/, '')) + '</span>' : '') + when + '</div>' +
          '<div class="prose">' + markdown(it.text) + '</div>';
      case 'thinking':
        return '<details><summary><span class="tag">Thinking</span> <span class="muted">' + esc(it.text.replace(/\s+/g, ' ').slice(0, 120)) + '</span></summary><div class="body"></div></details>';
      case 'tool': {
        const [cls, mark] = toolStatus(it);
        return '<details><summary><span class="st st-' + cls + '">' + mark + '</span><span class="tool-name">' + esc(it.name) + '</span>' +
          '<span class="tool-sum">' + hl(esc(it.summary || '')) + '</span>' + when + '</summary><div class="body"></div></details>';
      }
      case 'summary':
        return '<details><summary><span class="tag">Summary of the conversation so far</span>' + when + '</summary><div class="body prose"></div></details>';
      case 'divider':
        return '<div class="divider"><span>' + esc(it.text) + '</span></div>';
      default:
        return '<div class="event' + (it.level === 'error' ? ' err' : '') + '">' + hl(esc(it.text)) + when + '</div>';
    }
  }

  function element(n) {
    return list.querySelector('section[data-n="' + n + '"]');
  }

  function rerender(it) {
    const el = element(it.n);
    if (!el) return;
    const open = el.querySelector('details[open]');
    el.replaceWith(render(it));
    if (open) openItem(it);
  }

  function openItem(it) {
    const d = element(it.n) && element(it.n).querySelector('details');
    if (d && !d.open) {
      d.open = true;
      if (!d.dataset.filled) fill(d, it);
    }
  }

  function renderAll() {
    const frag = document.createDocumentFragment();
    for (const it of items) frag.appendChild(render(it));
    list.replaceChildren(frag);
    if (!items.length) list.innerHTML = '<div class="empty">This conversation has no messages yet.</div>';
    applyFilters();
  }

  function applyFilters() {
    document.body.classList.toggle('hide-tools', !opts.tools);
    document.body.classList.toggle('hide-thinking', !opts.thinking);
    const hit = new Set(matches);
    for (const el of list.children) {
      if (!el.dataset.n) continue;
      el.classList.toggle('hit', hit.has(+el.dataset.n));
      el.classList.toggle('filtered', opts.only && !!query && !hit.has(+el.dataset.n));
    }
  }

  function search(q, keepPosition) {
    query = q;
    const needle = q.toLowerCase();
    const before = matches[current];
    matches = needle ? items.filter((it) => haystack(it).includes(needle)).map((it) => it.n) : [];
    // redraw what shows the query (marks), keeping open cards open
    for (const it of items) {
      if (!it._marked && !(needle && haystack(it).includes(needle))) continue;
      it._marked = !!(needle && haystack(it).includes(needle));
      rerender(it);
    }
    current = keepPosition && matches.includes(before) ? matches.indexOf(before) : matches.length ? 0 : -1;
    applyFilters();
    updateCount();
    if (!keepPosition && current >= 0) show(current);
  }

  function updateCount() {
    $('count').textContent = query ? (matches.length ? current + 1 + ' of ' + matches.length : 'No matches') : '';
  }

  function show(i) {
    if (!matches.length) return;
    current = (i + matches.length) % matches.length;
    updateCount();
    const it = items[matches[current]];
    if (it.kind === 'tool' && !opts.tools) setOpt('tools', true);
    if (it.kind === 'thinking' && !opts.thinking) setOpt('thinking', true);
    if (it.kind === 'tool' || it.kind === 'thinking' || it.kind === 'summary') openItem(it);
    scrollToItem(it);
  }

  function scrollToItem(it) {
    const el = element(it.n);
    if (!el) return;
    list.querySelectorAll('.current').forEach((x) => x.classList.remove('current'));
    el.classList.add('current');
    el.scrollIntoView({ block: 'center' });
  }

  function focusOn(f) {
    if (!f) return;
    if (f.query) {
      $('search').value = f.query;
      search(f.query, false);
    }
    const it = items.find((x) => (f.toolId && x.id === f.toolId) || (f.uuid && x.uuid === f.uuid));
    if (!it) return;
    if (it.kind === 'tool') {
      if (!opts.tools) setOpt('tools', true);
      openItem(it);
    }
    scrollToItem(it);
  }

  function setOpt(name, value) {
    opts[name] = value;
    $(name).checked = value;
    vscode.setState({ tools: opts.tools, thinking: opts.thinking });
    applyFilters();
  }

  function setMeta(m) {
    $('title').textContent = m.title;
    const live = $('live');
    live.hidden = !m.live;
    live.textContent = m.live === 'busy' ? 'Working' : 'Open';
    live.className = 'live' + (m.live === 'busy' ? ' busy' : '');
    const facts = [
      m.cwd,
      m.firstTs ? 'Started ' + time(m.firstTs) : '',
      m.lastTs ? 'Last active ' + time(m.lastTs) : '',
      m.tokens ? tokens(m.tokens) + ' tokens in 7 days' : '',
      m.cost ? '$' + m.cost.toFixed(2) + ' (Claude Code’s estimate)' : '',
    ].filter(Boolean);
    $('facts').innerHTML = facts.map((f) => '<span>' + esc(f) + '</span>').join('');
  }

  const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'init') {
      items = msg.items;
      setMeta(msg.meta);
      renderAll();
      if (query) search(query, true);
      if (msg.focus) focusOn(msg.focus);
      else window.scrollTo(0, document.body.scrollHeight);
    } else if (msg.type === 'append') {
      const follow = nearBottom();
      if (!items.length) list.innerHTML = '';
      for (const it of msg.changed) {
        items[it.n] = it;
        rerender(it);
      }
      const frag = document.createDocumentFragment();
      for (const it of msg.items) {
        items[it.n] = it;
        frag.appendChild(render(it));
      }
      list.appendChild(frag);
      if (query) search(query, true);
      else applyFilters();
      if (follow) window.scrollTo(0, document.body.scrollHeight);
      else if (msg.items.length) $('toEnd').hidden = false;
    } else if (msg.type === 'meta') {
      setMeta(msg.meta);
    } else if (msg.type === 'focus') {
      focusOn(msg.focus);
    }
  });

  let debounce;
  $('search').addEventListener('input', (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => search(e.target.value.trim(), false), 200);
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      show(current + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      e.target.value = '';
      search('', false);
    }
  });
  $('next').addEventListener('click', () => show(current + 1));
  $('prev').addEventListener('click', () => show(current - 1));
  $('only').addEventListener('change', (e) => {
    opts.only = e.target.checked;
    applyFilters();
  });
  $('tools').addEventListener('change', (e) => setOpt('tools', e.target.checked));
  $('thinking').addEventListener('change', (e) => setOpt('thinking', e.target.checked));
  $('expand').addEventListener('click', () => {
    for (const it of items) if (it.kind === 'tool' || it.kind === 'thinking') {
      const el = element(it.n);
      if (el && !el.classList.contains('filtered')) openItem(it);
    }
  });
  $('collapse').addEventListener('click', () => list.querySelectorAll('details[open]').forEach((d) => (d.open = false)));
  $('toEnd').addEventListener('click', () => {
    window.scrollTo(0, document.body.scrollHeight);
    $('toEnd').hidden = true;
  });
  window.addEventListener('scroll', () => {
    if (nearBottom()) $('toEnd').hidden = true;
  });

  document.addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-command]');
    if (cmd) return vscode.postMessage({ type: 'command', name: cmd.dataset.command });
    const full = e.target.closest('[data-full]');
    if (full) return vscode.postMessage({ type: 'full', id: full.dataset.full });
    const file = e.target.closest('[data-file]');
    if (file) {
      e.preventDefault();
      vscode.postMessage({ type: 'openFile', path: file.dataset.file });
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      $('search').focus();
      $('search').select();
    }
  });

  $('tools').checked = opts.tools;
  $('thinking').checked = opts.thinking;
  vscode.postMessage({ type: 'ready' });
})();
