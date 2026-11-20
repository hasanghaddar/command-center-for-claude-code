// A notification from the operating system, for when the editor's window
// isn't the one in front (its own notifications can't be seen then).
// Plain Node (no vscode import). Nothing to install: Windows uses PowerShell,
// macOS osascript, Linux notify-send. Texts are passed in environment
// variables or as arguments, never spliced into a script.

const cp = require('child_process');

const xml = (s) => String(s).replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));

// Shown under Windows PowerShell's name when the editor itself isn't registered for notifications.
const POWERSHELL_APP = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const WINDOWS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
  '$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
  '$app = $env:CC_NOTIFY_APP',
  'if (-not $app -or -not (Get-StartApps | Where-Object { $_.AppID -eq $app })) { $app = $env:CC_NOTIFY_FALLBACK }',
  '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$doc.LoadXml($env:CC_NOTIFY_XML)',
  '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
  '$toast.Tag = $env:CC_NOTIFY_TAG',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)',
].join('; ');

// What to run to show it: { file, args, env }, or null on a platform without a way.
// n: { title, body, uri?, app?, tag? }. uri (Windows): opened when the
// notification is clicked, which brings the editor's window to the front.
// app (Windows): the editor's application ID, so it appears under its name.
function command(n, platform = process.platform) {
  const title = String(n.title || '').slice(0, 100);
  const body = String(n.body || '').slice(0, 300);
  if (platform === 'win32') {
    const launch = n.uri ? ` activationType="protocol" launch="${xml(n.uri)}"` : '';
    const toast = `<toast${launch}><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT],
      env: { CC_NOTIFY_XML: toast, CC_NOTIFY_APP: n.app || '', CC_NOTIFY_FALLBACK: POWERSHELL_APP, CC_NOTIFY_TAG: String(n.tag || 'command-center').slice(0, 60) },
    };
  }
  if (platform === 'darwin') {
    return {
      file: 'osascript',
      args: ['-e', 'display notification (system attribute "CC_NOTIFY_BODY") with title (system attribute "CC_NOTIFY_TITLE")'],
      env: { CC_NOTIFY_TITLE: title, CC_NOTIFY_BODY: body },
    };
  }
  if (platform === 'linux') return { file: 'notify-send', args: ['--app-name=Claude Code', '--', title, body], env: {} };
  return null;
}

// Show it. Never throws; resolves to whether the command ran without an error.
function show(n) {
  return new Promise((resolve) => {
    const c = command(n);
    if (!c) return resolve(false);
    try {
      cp.execFile(c.file, c.args, { env: { ...process.env, ...c.env }, windowsHide: true, timeout: 20000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

module.exports = { command, show, POWERSHELL_APP };
