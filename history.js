// Upkeep of the recorded history (events.jsonl and events.jsonl.1): drops what
// is older than the historyDays setting, and masks secrets in what was
// recorded before masking existed. Plain Node (no vscode import). The
// extension runs it as its own process, so that reading and rewriting tens of
// megabytes never holds up the editor:
//   node history.js <log folder> '{"historyDays":30,"mask":true}'
//
// How it stays safe while hooks keep writing: the current file is moved aside
// first (a hook that runs next simply starts a new one), then merged with the
// older file into a new events.jsonl.1. Nothing is ever rewritten in place.

const fs = require('fs');
const path = require('path');
const { redact } = require('./hook/log-hook.js');

const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 40 * 1024 * 1024; // what the two files could hold before
const LOCK_STALE_MS = 10 * 60 * 1000;

const files = (logDir) => ({
  main: path.join(logDir, 'events.jsonl'),
  older: path.join(logDir, 'events.jsonl.1'),
  moved: path.join(logDir, 'events.jsonl.compacting'),
  lock: path.join(logDir, 'maintenance.lock'), // while it is there, the extension's windows wait
  stamp: path.join(logDir, 'maintenance.json'),
});

function readStamp(logDir) {
  try {
    return JSON.parse(fs.readFileSync(files(logDir).stamp, 'utf8'));
  } catch {
    return {};
  }
}

// Whether there is anything to do: asked by the extension before starting the process.
function isDue(logDir, { historyDays, mask }, now = Date.now()) {
  const stamp = readStamp(logDir);
  if (fs.existsSync(files(logDir).moved)) return true; // an earlier run didn't finish
  if (mask && !stamp.masked) return fs.existsSync(files(logDir).main) || fs.existsSync(files(logDir).older);
  return historyDays > 0 && now - (stamp.lastRun || 0) > DAY;
}

// The time of the first event in a file, read from its first few kilobytes.
function firstTs(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const m = /"ts":(\d{10,})/.exec(buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0)));
      return m ? Number(m[1]) : 0;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return Infinity; // no such file
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows refuses to replace a file another process has open; they are only open for a moment.
function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return fs.renameSync(from, to);
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleep(100);
    }
  }
}

const TEXT_FIELDS = ['stdout', 'stderr', 'error', 'description', 'oldString', 'newString', 'message'];

function maskEvent(ev) {
  for (const k of ['command', 'via']) if (typeof ev[k] === 'string') ev[k] = redact(ev[k], true);
  for (const k of TEXT_FIELDS) if (typeof ev[k] === 'string') ev[k] = redact(ev[k]);
  if (Array.isArray(ev.tasks)) for (const t of ev.tasks) if (typeof t.command === 'string') t.command = redact(t.command, true);
  return ev;
}

// The lines to keep, oldest first. A command or file change is kept or dropped
// as a whole, by its latest event, so nothing loses its start or its end.
function filterLines(lines, { cutoff, mask, maxBytes }) {
  const events = [];
  const latest = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(ev);
    if (ev.id) latest.set(ev.id, Math.max(latest.get(ev.id) || 0, ev.ts || 0));
  }
  let out = [];
  for (const ev of events) {
    if ((ev.id ? latest.get(ev.id) : ev.ts || 0) < cutoff) continue;
    out.push(JSON.stringify(mask ? maskEvent(ev) : ev));
  }
  let bytes = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    bytes += Buffer.byteLength(out[i]) + 1;
    if (bytes > maxBytes) {
      out = out.slice(i + 1); // the oldest go first
      break;
    }
  }
  return { kept: out, read: events.length };
}

function maintain(logDir, { historyDays = 0, mask = false, maxBytes = MAX_BYTES } = {}, now = Date.now()) {
  const f = files(logDir);
  try {
    if (now - fs.statSync(f.lock).mtimeMs < LOCK_STALE_MS) return { skipped: 'another window is doing it' };
    fs.unlinkSync(f.lock);
  } catch {}
  try {
    fs.writeFileSync(f.lock, String(process.pid), { flag: 'wx' });
  } catch {
    return { skipped: 'another window is doing it' };
  }
  try {
    const stamp = readStamp(logDir);
    const cutoff = historyDays > 0 ? now - historyDays * DAY : 0;
    const needMask = mask && !stamp.masked;
    const leftover = fs.existsSync(f.moved);
    const result = { read: 0, kept: 0 };
    if (needMask || leftover || Math.min(firstTs(f.main), firstTs(f.older)) < cutoff) {
      if (!leftover) {
        try {
          renameWithRetry(f.main, f.moved);
        } catch (e) {
          if (e.code !== 'ENOENT') return { skipped: `the history is in use (${e.code})` };
        }
      }
      const lines = [];
      for (const file of [f.older, f.moved]) {
        try {
          lines.push(...fs.readFileSync(file, 'utf8').split('\n'));
        } catch {}
      }
      const { kept, read } = filterLines(lines, { cutoff, mask: needMask, maxBytes });
      fs.writeFileSync(f.older + '.tmp', kept.length ? kept.join('\n') + '\n' : '');
      renameWithRetry(f.older + '.tmp', f.older);
      try {
        fs.unlinkSync(f.moved);
      } catch {}
      Object.assign(result, { read, kept: kept.length, rewritten: true });
    }
    fs.writeFileSync(f.stamp, JSON.stringify({ lastRun: now, masked: stamp.masked || !!mask }));
    return result;
  } finally {
    try {
      fs.unlinkSync(f.lock);
    } catch {}
  }
}

if (require.main === module) {
  try {
    maintain(process.argv[2], JSON.parse(process.argv[3] || '{}'));
  } catch {}
} else {
  module.exports = { maintain, isDue, filterLines, files };
}
