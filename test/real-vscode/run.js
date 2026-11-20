// Runs the extension in a real VS Code and reports what happened:
//   npm run test:vscode
// A separate VS Code window opens for about a minute, with its own settings,
// no other extensions, and its own Claude folder (CLAUDE_CONFIG_DIR), so
// nothing of yours is touched. runner.js plays the part of Claude Code inside
// it. On Windows, pictures of that window are saved next to the results.
// Not part of `npm test`: it needs VS Code installed and a desktop.

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findCode() {
  if (process.env.VSCODE_EXE) return process.env.VSCODE_EXE;
  if (process.platform === 'win32') {
    const cmd = cp.execFileSync('where', ['code'], { encoding: 'utf8' }).split(/\r?\n/).find((l) => /code\.cmd$/i.test(l.trim()));
    if (cmd) return path.join(path.dirname(path.dirname(cmd.trim())), 'Code.exe');
  }
  if (process.platform === 'darwin') return '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
  return 'code';
}

const repo = path.join(__dirname, '..', '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'command-center-vscode-'));
const dir = (name) => {
  const p = path.join(work, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const workspace = dir('cc-test-ws'); // the window is found by this name for its pictures
fs.writeFileSync(path.join(workspace, 'README.md'), '# test workspace\n');
const out = dir('out');

const env = { ...process.env, CLAUDE_CONFIG_DIR: dir('claude-home'), CC_TEST_OUT: out, CC_TEST_SHOT: path.join(__dirname, 'shot.ps1'), CC_TEST_TITLE: 'cc-test-ws' };
delete env.ELECTRON_RUN_AS_NODE;
const args = [
  workspace,
  `--extensionDevelopmentPath=${repo}`,
  `--extensionTestsPath=${path.join(__dirname, 'runner.js')}`,
  `--user-data-dir=${dir('user')}`,
  `--extensions-dir=${dir('ext')}`,
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-updates',
];
const run = cp.spawnSync(findCode(), args, { env, stdio: 'ignore' });

let results;
try {
  results = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
} catch {
  console.error(`VS Code exited with ${run.status} and wrote no results (${run.error ? run.error.message : 'see ' + work})`);
  process.exit(1);
}
for (const c of results.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : `\n      ${c.detail}`}`);
const failed = results.checks.filter((c) => !c.ok).length;
console.log(`\n${results.checks.length - failed} of ${results.checks.length} checks pass. Results and pictures: ${out}`);
process.exit(failed ? 1 : 0);
