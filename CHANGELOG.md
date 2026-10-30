# Changelog

## 0.11.1

- **Open Session** from a notification or the Sessions view no longer asks to "resume anyway" for a session that is open in the Claude Code panel of this window. A session's project is now the folder it was started in, not the last folder Claude `cd`'d into, which also fixes the project shown in the Sessions list.

## 0.11.0

- **Regular commands open a terminal tab** when Claude starts them, not only background processes. The tab shows the command right away and its output when it finishes. Turn this off with `claudeCommandCenter.autoOpenForeground`.

## 0.10.0

- **File changes made by shell commands**: in a git repository, files Claude changes through Bash or PowerShell (`sed`, a Python script, a code generator, `git checkout`) now appear in File Changes with the command that made them, and can be diffed, included in session diffs and reverted. Deleted files are shown too. Background commands and git-ignored files aren't tracked.
- Tested on macOS: hook, Stop for background tasks, dev-server URLs, sessions, transcripts and Move Session.

## 0.9.0

- **Sessions** view: your Claude Code sessions for this workspace, with titles and which are open or working. Open one in the Claude Code panel or resume it in a terminal.
- **Transcript viewer**: a session's conversation in a tab, with prompts, replies, thinking and tool calls (merged with their results, edits as diffs), search with ↑/↓ and "only matches", filters, and live following. **Show in Transcript** jumps there from any command or file change, and **Search Sessions…** searches across all sessions.
- **Move a session to another project**, so Claude Code lists and resumes it there (for example after renaming or moving a project folder).
- **Notifications** when Claude finishes a turn or needs permission or an answer (by default while the window isn't focused), and optionally when a long subagent finishes.
- **Token usage** in the status bar: output tokens in the last 5 hours, with today and 7-day totals and a per-model breakdown on hover. Counted from local transcripts.
- Dashboard: every command and file change shows its session, with **Open session**, **Session diff** and **Only this session**.
- **Session diff**: all files a session changed in one multi-file diff, or one file across the whole session.
- **Revert** a session's edits, Claude's last turn, or an edit and everything after it, choosing the files. Files you changed since are left unticked, and **Undo** restores what was there.
- **Dev servers**: when a background process prints a local URL, open it in your browser or in VS Code. The address shows in the command list.
- **Answer permission prompts from VS Code** for Claude Code running in a terminal (opt-in): Allow or Deny in the window that has the project open, falling back to the terminal prompt after 60 seconds.
- **Stop** now works for background tasks started through the PowerShell tool (matched by task ID, since their command isn't on the process command line).
- The hook now also listens to `Stop`, `SubagentStart`, `SubagentStop` and `Notification`. You'll be asked to update it.

## 0.8.2

- Commands that Claude Code was denied permission for, or that were cancelled, no longer stay "running" forever. Once past their timeout they show as **No result**.
- Fixed history moved from older versions sometimes being merged out of order, which could leave a finished command shown as running.

## 0.8.1

- File Changes shows the project name for files at the top of a workspace, instead of the full folder path.
- The dashboard toolbar fits on one line at narrower widths.
- README: Marketplace install link.

## 0.8.0 — first public release

- **Commands**: sidebar list and dashboard of every Bash/PowerShell command Claude Code runs, with status, duration, exit code and colored output. Background processes stream their logs live and are marked done when they exit.
- **Stop** for background processes: finds the exact process Claude Code launched and kills its whole tree, after asking. Tested on Windows only so far.
- **File changes**: every Edit/Write/MultiEdit/NotebookEdit, with a click-to-open before/after diff, **Compare with current** and **Open file**.
- **Add to Claude Chat**: @-mention files, folders, editor selections, terminal selections, the last terminal command's output, a file change's edited lines, or a recorded command with its output.
- **Per-workspace view**: each window shows only what happened inside its own folders, with a toggle to show everything.
- **One-click setup** of the Claude Code hook (with a backup of `~/.claude/settings.json`), refreshed on every update and removed on uninstall.
- **Cleanup**: edit snapshots are kept 7 days and chat-mention files 24 hours, both configurable.
