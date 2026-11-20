// How commands are grouped in the Commands view and the dashboard: under the
// session that ran them, with runs of quick, successful ones (git status, ls,
// …) folded into one row. Plain functions with no outside references: the
// dashboard also sends their source to its page (see `source`).

// A command that finished without an error in under two seconds.
function isQuick(r) {
  return r.status === 'ok' && !r.background && r.endTs != null && r.endTs - r.startTs < 2000;
}

// records: newest first. One group per session, in the order of their latest command.
function groupBySession(records) {
  const groups = new Map();
  for (const r of records) {
    const id = r.session || '';
    if (!groups.has(id)) groups.set(id, { kind: 'session', id, records: [], first: !groups.size });
    groups.get(id).records.push(r);
  }
  return [...groups.values()];
}

// Runs of three or more quick commands become one { kind: 'quick' } row. It is
// named after its oldest command, so it stays the same row as it grows.
function foldQuick(records) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) out.push({ kind: 'quick', id: run[run.length - 1].id, records: run });
    else out.push(...run);
    run = [];
  };
  for (const r of records) {
    if (isQuick(r)) run.push(r);
    else {
      flush();
      out.push(r);
    }
  }
  flush();
  return out;
}

module.exports = { isQuick, groupBySession, foldQuick, source: [isQuick, groupBySession, foldQuick].map(String).join('\n') };
