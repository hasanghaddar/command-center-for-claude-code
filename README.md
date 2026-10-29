# Command Center for Claude Code

One place in VS Code to watch, control and feed context to Claude Code:

- **Watch** every shell command it runs, with its output, and every file it edits, with a diff one click away.
- **Control** background processes such as dev servers: live logs, and a Stop button.
- **Feed context** to the Claude chat: files, folders, editor and terminal selections, command output.

> **Unofficial.** This extension is made by [Hynexia](https://hynexia.net) and is not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## Features

**Commands**
- A **Command Center** sidebar and a full **dashboard** tab listing every Bash and PowerShell command Claude runs: status, folder, duration, exit code and colored output.
- Click the **Running**, **Background** or **Failed** counts to filter. Search with `/`, move with ↑/↓.
- **Background processes** (dev servers, watchers) stream their output live, open a log tab automatically, and switch to done or failed when they exit.
- **Stop** a background process. It finds the exact process Claude started and stops its whole process tree, after asking you.
- **Run again in my terminal** pastes the command into a real terminal without running it. **Live feed** prints every command as it happens.

**File changes**
- Every file Claude edits or creates, newest first. **Click one to open its diff**: the file just before and just after that edit.
- **Compare with current** diffs the pre-edit version against the file as it is now.

**Add to Claude Chat**
- Right-click files or folders in the Explorer, an editor tab, or selected lines in the editor.
- In a terminal, select text and use the **@** button in the terminal toolbar (or Alt+K) to send the selection. With nothing selected, it sends the last command's output.
- From the dashboard, send a file change (with its edited lines) or a recorded command together with its output.

**Per-workspace**
- Each VS Code window shows only commands and changes inside its own folders. Toggle **All** to see every project.

## Getting started

1. Install the extension.
2. When it asks **"Set up Command Center for Claude Code?"**, click **Enable**.
3. Start a new Claude Code session. Commands and edits now appear in the **Command Center** sidebar. Open the dashboard from the status bar.

**What setup changes**
- Copies a small logging hook to `~/.claude/command-center/hook/log-hook.js`. It's refreshed on every update.
- Registers it in `~/.claude/settings.json` for Claude Code's `PreToolUse`, `PostToolUse` and `PostToolUseFailure` hooks. Your other settings and hooks are left alone, and the previous file is saved as `settings.json.bak-command-center`.
- Adds the Alt+K terminal shortcut to `terminal.integrated.commandsToSkipShell` in your VS Code settings.

Run **Command Center: Set Up Hooks** to redo it, or **Command Center: Remove Hooks** to undo it. Uninstalling the extension removes the hooks automatically.

**Requirements**
- VS Code 1.90 or later.
- [Claude Code](https://code.claude.com). Its VS Code extension is needed for **Add to Claude Chat**; without it, mentions are copied to the clipboard instead.
- [Node.js](https://nodejs.org) on your PATH, which the logging hook runs with.

## Privacy

Everything stays on your machine. The extension makes no network requests and sends nothing anywhere.

What gets recorded, in `~/.claude/command-center/log/`:
- **Every command Claude runs, in full, with its output.** If a command contains a token or password, for example a `curl` with an `Authorization` header, it is recorded too.
- **Copies of files before and after each edit** (`snapshots/`), so diffs can be shown. Files over 5 MB are skipped.
- **The text you send with Add to Claude Chat** (`context/`), such as terminal selections, because the chat receives a link to a file rather than the text itself.

How long it is kept:
- Edit snapshots: 7 days (`claudeCommandCenter.retentionDays`).
- Chat files: 24 hours (`claudeCommandCenter.chatFileRetentionHours`).
- The command history rotates at 20 MB.
- **Clear History** (the trash icon in the sidebar) deletes all of it at once.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeCommandCenter.scope` | `workspace` | Show only this window's projects, or `all`. |
| `claudeCommandCenter.autoOpenBackground` | `true` | Open a live log tab when Claude starts a background process. |
| `claudeCommandCenter.retentionDays` | `7` | Days to keep edit snapshots. `0` keeps them forever. |
| `claudeCommandCenter.chatFileRetentionHours` | `24` | Hours to keep files made for chat mentions. `0` keeps them forever. |
| `claudeCommandCenter.maxItems` | `200` | Most items shown per list. |
| `claudeCommandCenter.logDir` | | Where the history is read from. Empty means `~/.claude/command-center/log`. |

## Known limitations

- **Foreground output appears when a command finishes**, not while it runs. Claude Code's hooks don't expose output mid-run.
- **Stop has been tested on Windows only**, and only for Bash background tasks. On macOS and Linux, or for background tasks started through the PowerShell tool, it may not find the process.
- **Files changed by shell commands** (such as `sed` or a script) appear in the command list but get no diff.
- **Folders** can't be sent to the Claude chat directly. Their `@folder/` mention is copied to the clipboard for you to paste.

## Troubleshooting

- **Nothing shows up:** check that setup ran (**Command Center: Set Up Hooks**), then start a new Claude Code session. Hooks are read when a session starts.
- **Raw hook data:** create an empty file `~/.claude/command-center/log/debug`, and the hook also writes everything it receives to `~/.claude/command-center/log/raw.jsonl`.

Questions or problems: [open an issue](https://github.com/hasanghaddar/command-center-for-claude-code/issues) or email [info@hynexia.net](mailto:info@hynexia.net).
