// Claude Code's own session transcripts (~/.claude/projects/<project>/<session>.jsonl):
// titles, live status, token usage and cost, and moving a session to another
// project. Plain Node (no vscode import) so it can be tested on its own.

const fs = require('fs');
const path = require('path');
const { claudeDir } = require('./hook-setup');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const USAGE_DAYS = 7; // token usage is kept for this long
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const CHUNK = 4 * 1024 * 1024;

function projectsDir() {
  return path.join(claudeDir(), 'projects');
}

// Claude Code names a project's folder after its path, with every character
// other than a letter or digit turned into "-".
function projectFolderName(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Running Claude Code processes register themselves in ~/.claude/sessions/<pid>.json,
// with their session ID and whether they are busy or idle.
function liveSessions() {
  const live = new Map();
  const dir = path.join(claudeDir(), 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return live;
  }
  for (const n of names) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (s.sessionId && s.pid && isAlive(s.pid)) {
        live.set(s.sessionId, { pid: s.pid, status: s.status, entrypoint: s.entrypoint, cwd: s.cwd });
      }
    } catch {}
  }
  return live;
}

function newEntry(file, subagentOf) {
  return {
    file,
    id: subagentOf || path.basename(file, '.jsonl'),
    subagent: !!subagentOf,
    projectDir: path.dirname(subagentOf ? path.dirname(path.dirname(file)) : file),
    cwd: null,
    title: null,
    customTitle: null,
    lastPrompt: null,
    firstTs: 0,
    lastTs: 0,
    cost: null,
    entrypoint: null,
    usage: [], // { ts, model, input, output, cacheRead, cacheWrite }
    seen: new Set(), // assistant message IDs already counted (one line per content block)
    offset: 0,
    partial: '',
    size: 0,
    mtime: 0,
    lastTsSeen: 0,
  };
}

// Apply one transcript line. Request records are big and carry nothing we
// need, so they are skipped before parsing.
function applyLine(e, line, keepUsageSince) {
  if (!line || line.startsWith('{"type":"api-request') || line.startsWith('{"type":"file-history')) return;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const ts = o.timestamp ? Date.parse(o.timestamp) : 0;
  if (ts) {
    if (!e.firstTs || ts < e.firstTs) e.firstTs = ts;
    if (ts > e.lastTs) e.lastTs = ts;
    e.lastTsSeen = ts;
  }
  // The first cwd is the folder the session was started in; later ones
  // follow Claude's `cd`s into subfolders.
  if (o.cwd && !e.cwd) e.cwd = o.cwd;
  if (o.entrypoint) e.entrypoint = o.entrypoint;
  switch (o.type) {
    case 'ai-title':
      if (o.aiTitle) e.title = o.aiTitle;
      break;
    case 'custom-title':
      if (o.customTitle) e.customTitle = o.customTitle;
      break;
    case 'summary':
      if (o.summary && !e.title) e.title = o.summary;
      break;
    case 'last-prompt':
      if (o.lastPrompt) e.lastPrompt = o.lastPrompt;
      break;
    case 'cost-state':
      if (typeof o.totalCostUSD === 'number') e.cost = o.totalCostUSD;
      break;
    case 'assistant': {
      const m = o.message;
      const u = m && m.usage;
      if (!u || !ts || ts < keepUsageSince || m.model === '<synthetic>') break;
      const key = m.id || o.uuid;
      if (key && e.seen.has(key)) break;
      if (key) e.seen.add(key);
      e.usage.push({
        ts,
        model: m.model || 'unknown',
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
      });
      break;
    }
  }
}

async function readRange(fh, start, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, start);
  return buf.toString('utf8', 0, bytesRead);
}

class SessionIndex {
  constructor() {
    this.entries = new Map(); // transcript path -> entry
    this.busy = null;
    this.live = new Map();
    this.list = [];
    this.byId = new Map();
  }

  // Find transcripts touched in the last `days` days, then read what is new
  // in each. Older ones only need their title and cost, so for those just the
  // start and end of the file are read.
  refresh(days = 30) {
    if (!this.busy) this.busy = this._refresh(days).finally(() => (this.busy = null));
    return this.busy;
  }

  async _refresh(days) {
    const now = Date.now();
    const cutoff = now - days * DAY;
    const usageSince = now - USAGE_DAYS * DAY;
    const found = new Set();
    let projects = [];
    try {
      projects = fs.readdirSync(projectsDir(), { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {}
    for (const p of projects) {
      const dir = path.join(projectsDir(), p.name);
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const file = path.join(dir, n);
        const st = statOrNull(file);
        if (!st || st.mtimeMs < cutoff) continue;
        found.add(file);
        await this.update(file, st, null, st.mtimeMs >= usageSince ? usageSince : null);
        // Subagent transcripts count toward usage only.
        if (st.mtimeMs < usageSince) continue;
        const subDir = path.join(dir, n.slice(0, -6), 'subagents');
        let subs = [];
        try {
          subs = fs.readdirSync(subDir).filter((s) => s.endsWith('.jsonl'));
        } catch {}
        for (const s of subs) {
          const subFile = path.join(subDir, s);
          const sst = statOrNull(subFile);
          if (!sst || sst.mtimeMs < usageSince) continue;
          found.add(subFile);
          await this.update(subFile, sst, n.slice(0, -6), usageSince);
        }
      }
    }
    for (const file of [...this.entries.keys()]) if (!found.has(file)) this.entries.delete(file);
    for (const e of this.entries.values()) {
      if (e.usage.length && e.usage[0].ts < usageSince) e.usage = e.usage.filter((u) => u.ts >= usageSince);
    }
    this.live = liveSessions();
    this.list = this.build();
    this.byId = new Map(this.list.map((s) => [s.id, s]));
  }

  // usageSince null: an old transcript, only its head and tail are read.
  async update(file, st, subagentOf, usageSince) {
    let e = this.entries.get(file);
    if (e && e.size === st.size && e.mtime === st.mtimeMs) return;
    if (!e || st.size < e.size || (usageSince == null && e.offset)) {
      e = newEntry(file, subagentOf);
      this.entries.set(file, e);
    }
    e.size = st.size;
    e.mtime = st.mtimeMs;
    let fh;
    try {
      fh = await fs.promises.open(file, 'r');
      if (usageSince == null) {
        const head = await readRange(fh, 0, Math.min(HEAD_BYTES, st.size));
        for (const l of head.split('\n').slice(0, -1)) applyLine(e, l, Infinity);
        if (st.size > HEAD_BYTES) {
          const start = Math.max(HEAD_BYTES, st.size - TAIL_BYTES);
          const tail = await readRange(fh, start, st.size - start);
          for (const l of tail.split('\n').slice(1)) applyLine(e, l, Infinity);
        }
        if (!e.lastTs) e.lastTs = st.mtimeMs;
        return;
      }
      while (e.offset < st.size) {
        const len = Math.min(CHUNK, st.size - e.offset);
        const text = e.partial + (await readRange(fh, e.offset, len));
        e.offset += len;
        const lines = text.split('\n');
        e.partial = lines.pop();
        for (const l of lines) applyLine(e, l, usageSince);
        await new Promise((r) => setImmediate(r)); // let the extension host breathe
      }
    } catch {
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  sessions() {
    return this.list;
  }

  get(id) {
    return this.byId.get(id);
  }

  // One row per session (subagent transcripts folded into their parent).
  build() {
    const byId = new Map();
    for (const e of this.entries.values()) {
      if (e.subagent) continue;
      const live = this.live.get(e.id);
      byId.set(e.id, {
        id: e.id,
        file: e.file,
        projectDir: e.projectDir,
        cwd: (live && live.cwd) || e.cwd,
        title: e.customTitle || e.title,
        lastPrompt: e.lastPrompt,
        firstTs: e.firstTs,
        lastTs: e.lastTs || e.mtime,
        cost: e.cost,
        entrypoint: e.entrypoint,
        live: live ? live.status || 'idle' : null,
        liveEntrypoint: live ? live.entrypoint : null,
        tokens: 0,
      });
    }
    for (const e of this.entries.values()) {
      const s = byId.get(e.id);
      if (s) for (const u of e.usage) s.tokens += u.input + u.output + u.cacheRead + u.cacheWrite;
    }
    return [...byId.values()].sort((a, b) => b.lastTs - a.lastTs);
  }

  // Token totals for the last 5 hours, today and the last 7 days.
  usage(now = Date.now()) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const windows = { fiveHours: now - 5 * HOUR, today: midnight.getTime(), week: now - USAGE_DAYS * DAY };
    const out = {};
    for (const [k, since] of Object.entries(windows)) {
      out[k] = { since, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, models: {} };
    }
    for (const e of this.entries.values()) {
      for (const u of e.usage) {
        for (const w of Object.values(out)) {
          if (u.ts < w.since) continue;
          const t = u.input + u.output + u.cacheRead + u.cacheWrite;
          w.input += u.input;
          w.output += u.output;
          w.cacheRead += u.cacheRead;
          w.cacheWrite += u.cacheWrite;
          w.total += t;
          w.models[u.model] = (w.models[u.model] || 0) + t;
        }
      }
    }
    return out;
  }
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// Move a session so that Claude Code lists and resumes it in another project:
// its transcript (with the recorded working folder rewritten) and its side
// folder (subagents, saved tool results) go to that project's folder.
function moveSession(session, targetCwd) {
  if (liveSessions().has(session.id)) {
    throw new Error('This session is still open in Claude Code. Close it (or end that Claude process) first.');
  }
  // Claude Code shortens longer names with a hash we can't reproduce.
  if (projectFolderName(targetCwd).length > 200) throw new Error('That folder path is too long to move a session to.');
  const destDir = path.join(projectsDir(), projectFolderName(targetCwd));
  const src = session.file;
  const dest = path.join(destDir, path.basename(src));
  if (samePath(path.dirname(src), destDir)) throw new Error('The session is already in that project.');
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists.`);

  const fromCwd = session.cwd;
  const lines = fs.readFileSync(src, 'utf8').split('\n');
  const rewritten = lines.map((l) => {
    if (!l.includes('"cwd"')) return l;
    try {
      const o = JSON.parse(l);
      if (!o.cwd || (fromCwd && !samePath(o.cwd, fromCwd))) return l;
      o.cwd = targetCwd;
      return JSON.stringify(o);
    } catch {
      return l;
    }
  });
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, rewritten.join('\n'));

  const srcSide = src.slice(0, -'.jsonl'.length);
  const destSide = dest.slice(0, -'.jsonl'.length);
  if (fs.existsSync(srcSide)) {
    try {
      fs.renameSync(srcSide, destSide);
    } catch {
      fs.cpSync(srcSide, destSide, { recursive: true });
      fs.rmSync(srcSide, { recursive: true, force: true });
    }
  }
  fs.unlinkSync(src);
  return dest;
}

module.exports = { SessionIndex, liveSessions, moveSession, projectFolderName, projectsDir, samePath };
