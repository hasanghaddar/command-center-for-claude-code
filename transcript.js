// Turns a Claude Code transcript (<session>.jsonl) into the items the
// transcript viewer shows: prompts, replies, thinking, tool calls merged with
// their results, and events such as compaction. Read incrementally, so a
// running session can be followed. Plain Node (no vscode import).

const fs = require('fs');

const MAX_RESULT = 20 * 1024; // tool output kept per call; the rest is fetched on request
const CHUNK = 4 * 1024 * 1024;

// Wrapper markup Claude Code adds to user messages, shown more plainly.
function cleanUserText(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>\s*(?:<command-args>([\s\S]*?)<\/command-args>)?/g, (_, n, a) => `${n.trim()} ${(a || '').trim()}`.trim())
    .trim();
}

function tag(text, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1].trim() : '';
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : b.type === 'tool_reference' ? `[tool: ${b.tool_name || b.name || '?'}]` : ''))
    .filter(Boolean)
    .join('\n');
}

// One line of the input in the tool card's header: the command, file, pattern…
function toolSummary(name, input) {
  const i = input || {};
  const first = (s) => String(s || '').split(/\r?\n/)[0];
  return first(i.description) || first(i.command) || i.file_path || i.notebook_path || i.pattern || i.url || i.query || first(i.prompt) || i.skill || '';
}

class TranscriptReader {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.partial = '';
    this.items = [];
    this.tools = new Map(); // tool_use_id -> item
    this.fullResults = new Map(); // tool_use_id -> untruncated output
    this.lastAssistant = null; // { messageId, item } to merge a message's text blocks
    this.seq = 0;
  }

  // Read what was appended since the last call. Returns the items added and
  // the existing items that changed (tool calls that got their result).
  read() {
    const added = [];
    const changed = new Set();
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return { added, changed: [] };
    }
    if (size < this.offset) {
      Object.assign(this, new TranscriptReader(this.file));
      return { reset: true, ...this.read() };
    }
    if (size === this.offset) return { added, changed: [] };
    const fd = fs.openSync(this.file, 'r');
    try {
      while (this.offset < size) {
        const len = Math.min(CHUNK, size - this.offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.offset);
        this.offset += len;
        const lines = (this.partial + buf.toString('utf8')).split('\n');
        this.partial = lines.pop();
        for (const l of lines) this.apply(l, added, changed);
      }
    } finally {
      fs.closeSync(fd);
    }
    return { added, changed: [...changed].filter((it) => !added.includes(it)) };
  }

  push(item, added) {
    item.n = this.seq++;
    this.items.push(item);
    added.push(item);
    return item;
  }

  apply(line, added, changed) {
    if (!line || line.startsWith('{"type":"api-request') || line.startsWith('{"type":"file-history')) return;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (o.isSidechain) return;
    const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
    const base = { uuid: o.uuid, ts };

    if (o.type === 'system') {
      if (o.subtype === 'compact_boundary') this.push({ ...base, kind: 'divider', text: 'Conversation compacted' }, added);
      else if (o.subtype === 'api_error') this.push({ ...base, kind: 'event', level: 'error', text: `API error: ${(o.error && (o.error.formatted || o.error.message)) || 'unknown'}` }, added);
      else if (o.content && o.subtype !== 'local_command') this.push({ ...base, kind: 'event', text: String(o.content) }, added);
      this.lastAssistant = null;
      return;
    }

    if (o.type === 'user' && o.message) {
      this.lastAssistant = null;
      const c = o.message.content;
      if (o.isCompactSummary) {
        this.push({ ...base, kind: 'summary', text: typeof c === 'string' ? c : resultText(c) }, added);
        return;
      }
      if (o.isMeta) return;
      const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
      let text = '';
      let images = 0;
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const item = this.tools.get(b.tool_use_id);
          if (!item) continue;
          const full = resultText(b.content);
          item.result = full.length > MAX_RESULT ? full.slice(0, MAX_RESULT) : full;
          item.resultTruncated = full.length > MAX_RESULT ? full.length : 0;
          if (item.resultTruncated) this.fullResults.set(b.tool_use_id, full);
          item.isError = !!b.is_error;
          if (!added.includes(item)) changed.add(item);
        } else if (b.type === 'text') {
          text += (text ? '\n\n' : '') + b.text;
        } else if (b.type === 'image') {
          images++;
        }
      }
      if (!text && !images) return;
      if (/^\s*<task-notification>/.test(text)) {
        const summary = tag(text, 'summary') || 'Background task finished';
        this.push({ ...base, kind: 'event', text: summary }, added);
        return;
      }
      if (/^\s*<local-command-(stdout|stderr)>/.test(text)) {
        const out = tag(text, 'local-command-stdout') || tag(text, 'local-command-stderr');
        if (out) this.push({ ...base, kind: 'event', text: out }, added);
        return;
      }
      const context = [];
      text = text.replace(/<(ide_selection|ide_opened_file)>([\s\S]*?)<\/\1>/g, (_, __, inner) => {
        context.push(inner.trim().split(/\r?\n/)[0]);
        return '';
      });
      text = cleanUserText(text);
      if (!text && !images && !context.length) return;
      this.push({ ...base, kind: 'user', text, images, context, origin: o.origin && o.origin.kind }, added);
      return;
    }

    if (o.type === 'assistant' && o.message) {
      const m = o.message;
      const messageId = m.id || o.uuid;
      const meta = { model: m.model, usage: m.usage };
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text && b.text.trim()) {
          const last = this.lastAssistant;
          if (last && last.messageId === messageId && last.item.kind === 'assistant') {
            last.item.text += '\n\n' + b.text;
            if (!added.includes(last.item)) changed.add(last.item);
          } else {
            const item = this.push({ ...base, kind: 'assistant', text: b.text, ...meta }, added);
            this.lastAssistant = { messageId, item };
          }
        } else if (b.type === 'thinking' && b.thinking && b.thinking.trim()) {
          this.push({ ...base, kind: 'thinking', text: b.thinking }, added);
          this.lastAssistant = { messageId, item: { kind: 'thinking' } };
        } else if (b.type === 'tool_use') {
          const item = this.push(
            { ...base, kind: 'tool', id: b.id, name: b.name, summary: toolSummary(b.name, b.input), input: b.input, result: null },
            added
          );
          this.tools.set(b.id, item);
          this.lastAssistant = { messageId, item };
        }
      }
    }
  }
}

// Look through transcripts for text (prompts, replies and tool calls),
// case-insensitively. files: [{ file, session }]. Returns up to `limit` hits.
async function searchTranscripts(files, query, limit = 200) {
  const q = query.toLowerCase();
  const hits = [];
  for (const { file, session } of files) {
    const reader = new TranscriptReader(file);
    let text;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    // Only parse lines that contain the query somewhere.
    const needle = JSON.stringify(q).slice(1, -1);
    const added = [];
    for (const line of text.split('\n')) {
      if (line.toLowerCase().includes(needle)) reader.apply(line, added, new Set());
    }
    for (const it of added) {
      const hay = [it.text, it.summary, it.input && JSON.stringify(it.input)].filter(Boolean).join('\n');
      const at = hay.toLowerCase().indexOf(q);
      if (at < 0) continue;
      const start = Math.max(0, at - 60);
      const snippet = (start ? '…' : '') + hay.slice(start, at + q.length + 100).replace(/\s+/g, ' ');
      hits.push({ session, file, uuid: it.uuid, toolId: it.id, kind: it.kind, ts: it.ts, snippet });
      if (hits.length >= limit) return hits;
    }
    await new Promise((r) => setImmediate(r));
  }
  return hits;
}

module.exports = { TranscriptReader, searchTranscripts, cleanUserText };
