// Finding, measuring and stopping the OS processes behind a Claude Code command.
// Plain Node (no vscode import) so it can be tested on its own.

const cp = require('child_process');
const { redact } = require('./hook/log-hook.js');

// Letters and digits only, so shell quoting/escaping differences don't matter.
const normalize = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

// The command Claude Code wrapped in `bash -c "... && eval '<command>' < /dev/null && pwd -P >| ..."`.
function wrappedCommand(cmdline) {
  const start = cmdline.indexOf("&& eval '");
  const end = cmdline.lastIndexOf("' < /dev/null");
  return start >= 0 && end > start ? cmdline.slice(start + 9, end) : null;
}

// A shell Claude Code launched with its output redirected to this task's
// file, such as the cmd.exe that starts a PowerShell background task:
//   cmd.exe /c "... powershell.exe ... > "<tmp>\tasks\<taskId>.output" 2>&1"
// PowerShell tasks pass their command in an environment variable, so this is
// the only way to recognise them. A redirect is required, so a grep or an
// editor that merely mentions the file isn't matched.
function redirectsToTask(cmdline, taskId) {
  if (!taskId || !/^[\w-]+$/.test(taskId)) return false;
  return new RegExp(`>\\s*"?[^"<>|]*[\\\\/]tasks[\\\\/]${taskId}\\.output"?(\\s|$)`, 'i').test(cmdline);
}

// The processes running a background task, keeping only the top of each tree.
// procs: [{ pid, ppid, cmd }]
function matchTaskProcesses(procs, rec, selfPid = process.pid) {
  const needle = normalize(rec.command);
  const matching = procs.filter((p) => {
    if (p.pid === selfPid || !p.cmd) return false;
    if (redirectsToTask(p.cmd, rec.backgroundTaskId)) return true;
    const wrapped = wrappedCommand(p.cmd);
    if (needle.length < 4 || wrapped == null) return false;
    // The recorded command has its secrets masked; the running one doesn't.
    return normalize(wrapped) === needle || normalize(redact(wrapped, true)) === needle;
  });
  const ids = new Set(matching.map((p) => p.pid));
  return matching.filter((p) => !ids.has(p.ppid)).map((p) => p.pid);
}

// Windows: the process list comes from PowerShell, and starting PowerShell is
// most of the cost (measured: about 1.8 s for a new one each time, 0.4 s for a
// query in one that is already running). So one is kept open while readings
// are being taken, and closes after a while without use.
const PS_IDLE_MS = 90 * 1000;
const PS_QUERY_TIMEOUT_MS = 20 * 1000;
let ps = null; // { child, buf, pending, idle }
let psQueue = Promise.resolve();

function closeSession() {
  if (!ps) return;
  const s = ps;
  ps = null;
  clearTimeout(s.idle);
  if (s.pending) s.pending.finish(null);
  try {
    s.child.stdin.end(); // PowerShell exits when its input ends
  } catch {}
  const kill = setTimeout(() => {
    try {
      s.child.kill();
    } catch {}
  }, 3000);
  if (kill.unref) kill.unref();
}

function openSession() {
  const child = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const s = { child, buf: '', pending: null, idle: null };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    s.buf += d;
    if (!s.pending) return;
    const at = s.buf.indexOf(s.pending.marker);
    if (at >= 0) s.pending.finish(s.buf.slice(0, at));
  });
  const gone = () => {
    if (ps === s) ps = null;
    clearTimeout(s.idle);
    if (s.pending) s.pending.finish(null);
  };
  child.on('error', gone);
  child.on('exit', gone);
  child.stdin.on('error', () => {});
  child.stdin.write('[Console]::OutputEncoding = [Text.Encoding]::UTF8\n');
  if (child.unref) child.unref();
  return s;
}

// Run one pipeline in the kept-open PowerShell; its output, or null if that didn't work.
function psQuery(query) {
  const run = () =>
    new Promise((resolve) => {
      let s;
      try {
        s = ps || (ps = openSession());
      } catch {
        return resolve(null);
      }
      clearTimeout(s.idle);
      const marker = `<<done-${Date.now()}-${Math.random().toString(36).slice(2)}>>`;
      const timer = setTimeout(() => {
        if (ps === s) closeSession(); // stuck: start afresh next time
        else finish(null);
      }, PS_QUERY_TIMEOUT_MS);
      const finish = (out) => {
        if (s.pending !== pending) return;
        s.pending = null;
        s.buf = '';
        clearTimeout(timer);
        if (ps === s) {
          s.idle = setTimeout(closeSession, PS_IDLE_MS);
          if (s.idle.unref) s.idle.unref();
        }
        resolve(out);
      };
      const pending = (s.pending = { marker, finish });
      s.buf = '';
      try {
        s.child.stdin.write(`${query}; '${marker}'\n`);
      } catch {
        finish(null);
      }
    });
  const result = psQueue.then(run, run);
  psQueue = result.catch(() => {});
  return result;
}

function parseWindowsProcesses(out) {
  return [].concat(JSON.parse(out)).map((p) => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    cmd: p.CommandLine || '',
    mem: p.WorkingSetSize || 0,
    cpuMs: ((p.KernelModeTime || 0) + (p.UserModeTime || 0)) / 10000, // 100 ns units
  }));
}

// [{ pid, ppid, cmd, mem, cpuMs | pcpu }]: mem is resident bytes; Windows
// gives total CPU time (cpuMs), macOS and Linux a CPU percentage (pcpu, of
// one core).
function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      cp.execFile('ps', ['-eo', 'pid=,ppid=,rss=,pcpu=,args='], { maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve([]);
        resolve(
          out.split('\n').map((l) => {
            const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(l);
            return m ? { pid: +m[1], ppid: +m[2], mem: +m[3] * 1024, pcpu: +m[4], cmd: m[5] } : null;
          }).filter(Boolean)
        );
      });
      return;
    }
    // Processes without a command line (system ones) are kept for their parent
    // links and usage only.
    const query =
      'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime | ' +
      'Where-Object { $_.ProcessId -ne $PID } | ' +
      'Select-Object ProcessId,ParentProcessId,CommandLine,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress';
    psQuery(query).then((out) => {
      try {
        if (out && out.trim()) return resolve(parseWindowsProcesses(out));
      } catch {}
      // The kept-open PowerShell didn't answer: ask a new one, as before.
      cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, text) => {
        try {
          resolve(err ? [] : parseWindowsProcesses(text));
        } catch {
          resolve([]);
        }
      });
    });
  });
}

// The pids of these processes and everything they started.
function processTree(procs, rootPids) {
  const tree = [...rootPids];
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  for (let i = 0; i < tree.length; i++) {
    for (const c of children.get(tree[i]) || []) if (!tree.includes(c)) tree.push(c);
  }
  return tree;
}

async function findTaskPids(rec) {
  return matchTaskProcesses(await listProcesses(), rec);
}

// The process and everything it started. On macOS and Linux the task's shell
// isn't necessarily a process-group leader, so its descendants (the dev
// server itself) are found from the process list and signalled too.
async function killTree(pid) {
  if (process.platform === 'win32') {
    return new Promise((resolve) => cp.execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
  }
  const tree = processTree(await listProcesses(), [pid]);
  try {
    process.kill(-pid, 'SIGTERM'); // the whole group, when it is one
  } catch {}
  for (const p of tree.reverse()) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {}
  }
}

module.exports = { findTaskPids, killTree, matchTaskProcesses, redirectsToTask, wrappedCommand, listProcesses, processTree, closeSession };
