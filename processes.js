// Finding and stopping the OS processes behind a Claude Code background task.
// Plain Node (no vscode import) so it can be tested on its own.

const cp = require('child_process');

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
    return needle.length >= 4 && wrapped != null && normalize(wrapped) === needle;
  });
  const ids = new Set(matching.map((p) => p.pid));
  return matching.filter((p) => !ids.has(p.ppid)).map((p) => p.pid);
}

function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      cp.execFile('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve([]);
        resolve(
          out.split('\n').map((l) => {
            const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
            return m ? { pid: +m[1], ppid: +m[2], cmd: m[3] } : null;
          }).filter(Boolean)
        );
      });
      return;
    }
    const ps =
      'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne $PID } | ' +
      'Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
    cp.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      try {
        resolve([].concat(JSON.parse(out)).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, cmd: p.CommandLine })));
      } catch {
        resolve([]);
      }
    });
  });
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
  const procs = await listProcesses();
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) {
    for (const p of procs) if (p.ppid === tree[i] && !tree.includes(p.pid)) tree.push(p.pid);
  }
  try {
    process.kill(-pid, 'SIGTERM'); // the whole group, when it is one
  } catch {}
  for (const p of tree.reverse()) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {}
  }
}

module.exports = { findTaskPids, killTree, matchTaskProcesses, redirectsToTask, wrappedCommand, listProcesses };
