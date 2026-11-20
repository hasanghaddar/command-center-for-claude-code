// Runs inside a real VS Code (as its extension test), with its own user data
// and its own Claude folder (CLAUDE_CONFIG_DIR). It plays the part of Claude
// Code by running the installed hook with the payloads Claude Code sends, and
// records what the extension does: checks through the VS Code API, and
// pictures of the window for what the API can't tell.

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = process.env.CC_TEST_OUT;
const CLAUDE = process.env.CLAUDE_CONFIG_DIR;
const SHOT = process.env.CC_TEST_SHOT;
const TITLE = process.env.CC_TEST_TITLE;
const HOOK = path.join(CLAUDE, 'command-center', 'hook', 'log-hook.js');
const LOG = path.join(CLAUDE, 'command-center', 'log', 'events.jsonl');

const results = { checks: [], notes: [] };
const check = (name, ok, detail) => results.checks.push({ name, ok: !!ok, detail });
const note = (text) => results.notes.push(text);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const save = () => fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));

function shot(name) {
  try {
    const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SHOT, '-Title', TITLE, '-Out', path.join(OUT, `${name}.png`)], { windowsHide: true, encoding: 'utf8' });
    note(`picture ${name}: ${out.trim()}`);
  } catch (e) {
    note(`picture ${name} failed: ${String(e.stdout || e.message).trim()}`);
  }
}

// Run the hook as Claude Code does: the payload on stdin.
function hook(payload) {
  return cp.execFileSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true });
}

const folder = () => vscode.workspace.workspaceFolders[0].uri.fsPath;
let nextTool = 0;

function tool(session, command, extra = {}) {
  const id = `toolu_test_${++nextTool}`;
  const base = { session_id: session, tool_name: 'Bash', tool_use_id: id, cwd: folder(), tool_input: { command, ...(extra.input || {}) } };
  return {
    id,
    start: () => hook({ ...base, hook_event_name: 'PreToolUse' }),
    end: (stdout = '', ms = 100) => hook({ ...base, hook_event_name: 'PostToolUse', duration_ms: ms, tool_response: { stdout, stderr: '', interrupted: false } }),
    fail: (code, text) => hook({ ...base, hook_event_name: 'PostToolUseFailure', duration_ms: 900, error: `Exit code ${code}\n${text}` }),
    // The call returns at once and the process runs on, writing to outputFile.
    toBackground: (taskId, outputFile) => hook({ ...base, hook_event_name: 'PostToolUse', duration_ms: 50, tool_response: { stdout: '', stderr: '', backgroundTaskId: taskId, outputFile } }),
  };
}

const terminals = () => vscode.window.terminals.map((t) => t.name);
const active = () => (vscode.window.activeTerminal ? vscode.window.activeTerminal.name : null);

exports.run = async function run() {
  try {
    const ext = vscode.extensions.getExtension('hynexia.command-center-for-claude-code');
    await ext.activate();
    check('the extension activates in a real VS Code', ext.isActive, `version ${ext.packageJSON.version}, VS Code ${vscode.version}`);

    const commands = await vscode.commands.getCommands(true);
    const declared = ext.packageJSON.contributes.commands.map((c) => c.command).concat(['claudeCommandCenter.statusClick', 'claudeCommandCenter.openWaiting']);
    const missing = declared.filter((c) => !commands.includes(c));
    check('every command is registered', !missing.length, missing.length ? `missing: ${missing.join(', ')}` : `${declared.length} commands`);

    // Setup, as the Enable button does it.
    await vscode.commands.executeCommand('claudeCommandCenter.setup');
    const settings = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
    const events = Object.keys(settings.hooks || {});
    check('setup registers the hook in Claude Code\'s settings', ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'Notification'].every((e) => events.includes(e)), events.join(', '));
    check('StopFailure is left out while no Claude Code version is known', !events.includes('StopFailure'));
    check('the hook file is installed', fs.existsSync(HOOK));
    check('the hook\'s settings file is written', fs.existsSync(path.join(CLAUDE, 'command-center', 'config.json')), fs.readFileSync(path.join(CLAUDE, 'command-center', 'config.json'), 'utf8'));

    // Two sessions with titles, as Claude Code's transcripts would give them.
    const projectDir = path.join(CLAUDE, 'projects', folder().replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(projectDir, { recursive: true });
    const transcript = (id, title) =>
      fs.writeFileSync(
        path.join(projectDir, `${id}.jsonl`),
        [
          { type: 'user', sessionId: id, cwd: folder(), timestamp: new Date(Date.now() - 120000).toISOString(), message: { role: 'user', content: title } },
          { type: 'ai-title', sessionId: id, aiTitle: title },
        ]
          .map((l) => JSON.stringify(l))
          .join('\n') + '\n'
      );
    const S1 = '11111111-aaaa-4bbb-8ccc-000000000001';
    const S2 = '22222222-aaaa-4bbb-8ccc-000000000002';
    transcript(S1, 'Fix the login bug');
    transcript(S2, 'Update the docs');
    await vscode.commands.executeCommand('claudeCommandCenter.refreshSessions');

    // What Claude ran: quick commands, one with a password, a failure, a slow one.
    for (const c of ['ls docs', 'cat docs/index.md']) {
      const t = tool(S2, c);
      t.start();
      t.end('ok');
    }
    hook({ session_id: S1, hook_event_name: 'UserPromptSubmit', cwd: folder(), prompt: 'fix the login bug' });
    for (const c of ['git status', 'git log --oneline -5', 'ls src', 'cat package.json']) {
      const t = tool(S1, c);
      t.start();
      t.end('output of ' + c);
    }
    const secret = tool(S1, 'curl -u admin:hunter2 https://example.com/api/health');
    secret.start();
    secret.end('{"ok":true}', 3000);
    const lint = tool(S1, 'npm run lint');
    lint.start();
    lint.fail(1, 'src/login.ts:12 error  Unexpected any');
    const build = tool(S1, 'npm run build');
    build.start();
    build.end('built in 8.0s', 8000);
    await wait(1800);

    await vscode.commands.executeCommand('workbench.view.extension.claudeCommandCenter');
    await wait(1500);
    shot('1-sidebar');

    const log = fs.readFileSync(LOG, 'utf8');
    check('the password is masked in what is recorded', log.includes('curl -u admin:*** https://example.com') && !log.includes('hunter2'));
    check('the prompt is recorded without its text', log.includes('"type":"prompt"') && !log.includes('fix the login bug'));

    // A command that keeps running: by default its tab must not open the panel.
    const before = terminals();
    const testRun = tool(S1, 'npm test');
    testRun.start();
    await wait(4000);
    check('a running command gets a tab', terminals().includes('Claude: npm test'), `terminals: ${JSON.stringify(terminals())} (before: ${JSON.stringify(before)})`);
    note(`active terminal after the tab opened quietly: ${active()}`);
    shot('2-running-quiet');

    await vscode.commands.executeCommand('claudeCommandCenter.statusClick');
    await wait(1500);
    check('clicking the status bar brings the running command\'s tab forward', active() === 'Claude: npm test', `active terminal: ${active()}`);
    shot('3-tab-after-click');

    testRun.end('Tests: 12 passed, 12 total', 9000);
    await wait(1500);

    // The user closes the panel; the next long command must leave it closed.
    await vscode.commands.executeCommand('workbench.action.closePanel');
    await wait(500);
    const e2e = tool(S1, 'npm run e2e');
    e2e.start();
    await wait(4000);
    check('the next command also gets a tab', terminals().includes('Claude: npm run e2e'), `terminals: ${JSON.stringify(terminals())}`);
    check('the finished command\'s tab was closed', !terminals().includes('Claude: npm test') || active() === 'Claude: npm test', `terminals: ${JSON.stringify(terminals())}, active: ${active()}`);
    shot('4-panel-stays-closed');
    e2e.end('3 passed', 7000);
    await wait(1200);

    // A background process: its tab stays while it runs, and goes once it has ended and something else opens.
    const taskOutput = path.join(OUT, 'background-task.output');
    fs.writeFileSync(taskOutput, 'watching for changes…\n');
    const watcher = tool(S1, 'npm run build:watch', { input: { run_in_background: true } });
    watcher.start();
    watcher.toBackground('bgtest1', taskOutput);
    await wait(2000);
    check('a background process gets a tab', terminals().includes('Claude: npm run build:watch'), JSON.stringify(terminals()));
    fs.appendFileSync(taskOutput, 'done\n[exited with code 0]\n'); // the process ends
    await wait(3500);
    const typecheck = tool(S1, 'npm run typecheck');
    typecheck.start();
    await wait(4000);
    check("the ended background process's tab is closed when the next tab opens", !terminals().includes('Claude: npm run build:watch'), JSON.stringify(terminals()));
    check('finished tabs do not pile up', terminals().filter((n) => n.startsWith('Claude: ')).length <= 2, JSON.stringify(terminals()));
    typecheck.end('no errors', 6000);
    await wait(1200);

    // Claude asks for permission.
    const risky = tool(S1, 'rm -rf build');
    risky.start();
    hook({ session_id: S1, hook_event_name: 'Notification', cwd: folder(), notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    await wait(1800);
    shot('5-needs-you');
    risky.end('', 200); // allowed, and it ran
    await wait(1800);
    shot('6-needs-you-cleared');

    hook({ session_id: S1, hook_event_name: 'Stop', cwd: folder(), last_assistant_message: 'The login bug is fixed and the tests pass.', background_tasks: [] });
    await wait(1000);

    await vscode.commands.executeCommand('claudeCommandCenter.dashboard');
    await wait(3000);
    shot('7-dashboard');

    const finalLog = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    check('a turn end with its task list is recorded', finalLog.some((e) => e.type === 'turnEnd' && Array.isArray(e.tasks)));
    note(`events recorded: ${finalLog.length}`);
  } catch (e) {
    check('the run finished without an error', false, String(e && e.stack ? e.stack : e));
  }
  save();
};
