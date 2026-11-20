# Changelog

## 0.15.0

- **Secrets are masked in the history.** Passwords in URLs, `Authorization` headers, values of settings named like a secret (`API_KEY=…`, `--password …`), keys recognisable by their shape and private keys are replaced with `***` before a command or its output is recorded. What was recorded earlier is masked once, shortly after the update. Ordinary code that only mentions `password` or `token` is left readable. Turn off with `claudeCommandCenter.maskSecrets`.
- **History is deleted after 30 days** (`claudeCommandCenter.historyDays`; 0 keeps it until the 40 MB size limit). Before, it was only limited by size.
- **Background commands end when Claude Code says so.** At the end of each turn Claude Code lists the background tasks still running; a command or watcher that is no longer listed is marked ended, without waiting for a timeout or its session to close.
- **Turns that end in an API error** (rate limit, sign-in, server error) are notified as "Claude stopped", and count as the end of a turn for **Revert Claude's last turn**. Needs Claude Code 2.1.78 or later.
- **Turn length is measured from the prompt**, which the hook now records (the time, not the text), instead of being read from the transcript. A new prompt also clears "Claude needs you" and any notification about the turn before.
- **The hook is registered for two more events**, `UserPromptSubmit` and `StopFailure`. The registration is updated by itself; Claude Code sessions that are open keep the old one until they are restarted.
- **System notifications** (off by default, `claudeCommandCenter.systemNotifications`). While the window isn't the one in front, the operating system shows "Claude finished" and "Claude needs you" too, so they reach you in another app. On Windows, clicking one brings the project's window forward.
- **CPU and memory readings cost a quarter of what they did on Windows.** One PowerShell is kept open while readings are taken instead of starting a new one each time: about 0.4 s a reading instead of 1.8 s. It closes 90 seconds after the last one.
- **One status bar item instead of two.** Token usage is shown in the Command Center item (`Claude · 5h: 12k out`), with the breakdown in its tooltip.
- **The @ button in the terminal toolbar can be hidden** with `claudeCommandCenter.terminalButton`. The same actions stay in the terminal's right-click menu.
- **The dashboard groups commands by session** and folds quick ones, like the sidebar. Click a session to fold it. A search or a filter shows every match.
- **Claude waits less on the hook.** Before every shell command the hook started git three times to find the files the command changes. Commands that can't change files (`ls`, `cat`, `grep`, `git status`, `git log`, …) now skip that, and the others need one git call. Measured on Windows, the wait the hook adds to a command went from about 0.56 s to 0.26 s for read-only commands and 0.37 s for the rest. In a repository with many files changed since the last commit, their copies are reused from one command to the next instead of being read again (with 200 changed files, about 0.48 s before a command became 0.36 s).
- **The terminal panel no longer opens by itself.** Tabs for Claude's commands open in the terminal list without coming to the front, and the status bar names the running command with its time (`Claude: npm test · 12s`); click it to watch. The tab you are reading isn't closed when the next command starts. Set `claudeCommandCenter.revealTabs` to get the earlier behavior back.
- **Notifications that still apply when you read them.** One raised while the window has no focus is shown when you come back, not stacked up meanwhile: one per session, none for a session Claude has carried on in, and a single one if several sessions are waiting.
- **"Claude needs you" in the status bar** while a session waits for permission or an answer. It clears when the session carries on: the command it asked about starts printing or finishes, a new prompt is sent, or the turn ends. Click it to open the session.
- **Commands grouped by session** in the sidebar, with runs of quick successful commands folded into one row. `claudeCommandCenter.commandList: flat` brings back the single list.
- **History no longer disappears at 20 MB.** When the hook set the full log aside, the lists went blank and session diffs and reverts lost their earlier edits. The log set aside is now read too. **Clear History** deletes it as well; before, it was left on disk.
- **Background commands that ended with their Claude Code session** are marked ended instead of staying "Background" for good (and being counted as running, and measured for CPU and memory). The check looks for the command's own process first, so one that is still running stays.
- **Faster start.** How each background command ended is now written to the history. Before, every window looked for the output file of every past background command each time it started.
- **Dashboard**: a running command's output streams live, as it does in its tab. The list is no longer redrawn every second while something runs, so keyboard focus and hover stay put, and nothing is sent to the dashboard while its tab is hidden. An empty list offers **Set up hooks** and **Check setup**.
- **Looking through finished commands reuses one tab** instead of leaving a tab open for each.
- **Dev servers**: **Don't Offer Again** on the "is serving http://localhost…" notification stops it for that address in this workspace.
- **Setup asks once.** With several windows open, only one shows the setup question, and a hook registered by an older version is updated without asking again.
- **Up to date with Claude Code 2.1.329**:
  - Watchers Claude starts with its Monitor tool were listed as running commands and then as "No result". They are now background commands marked "watching".
  - No "subagent finished" notification for the helpers Claude Code runs on its own (prompt suggestions, `/btw`).
  - Answering permission prompts from VS Code leaves questions and plan approvals to Claude Code, where they can be answered properly.
- **Refresh** reads the history again without treating old commands as new (with `autoOpenDelay` 0 it could reopen their tabs).

## 0.14.1

- **Readable names on macOS and Linux.** Commands Claude starts with setup steps (`source ~/.nvm/nvm.sh > /dev/null 2>&1 &&`, `nvm use 20;`, `eval "$(fnm env)" &&`, `export PATH=…;`, `source .venv/bin/activate &&`) are named after the real command, not the setup. Files such a command changes in a git repository are now found too, when a `cd` comes after the setup.
- Tests run on Windows, macOS and Linux on every push (GitHub Actions).

## 0.14.0

- **Failed commands in the status bar.** A count of the commands Claude ran that failed in the last 10 minutes and whose output you haven't opened. Click it to see the output (with several, pick one). Turn off with `claudeCommandCenter.showFailures`.
- **Fewer "Claude finished" notifications.** A finished turn is only notified if it took 30 seconds or more, counted from your prompt. Change with `claudeCommandCenter.notifyTurnMinSeconds` (0 notifies for every turn).
- **One shared tab** (optional): set `claudeCommandCenter.commandTabs` to `shared` and regular commands print into a single tab instead of one tab each. Background processes keep their own tabs.
- The empty Commands and File Changes views offer **Check setup** next to Set up hooks.
- Automated tests (`npm test`) for the hook, its registration, the tabs, notifications and the failure count.
- **Node.js no longer has to be installed.** Setup tries the hook the way Claude Code runs it: with `node` when that works, otherwise with the editor's own runtime (VS Code, Cursor and other VS Code-based editors). If that editor is later moved or removed, the hook is repaired the next time Command Center starts.
- **No tab for quick commands.** A regular command gets a terminal tab only once it has run for 2 seconds, so `git status`, `ls` and the like no longer flash a tab open. Change the wait with `claudeCommandCenter.autoOpenDelay` (0 opens every command at once).
- **Claude's tabs no longer take over your terminal.** After you switch to a terminal of your own (a shell, or Claude Code running in a terminal), tabs for the commands Claude runs open in the terminal list without coming to the front. Select any of Claude's tabs and they come to the front again.

## 0.13.0

- **Command Center: Check Setup** (also in the Commands view's `…` menu) finds out why commands don't show up. It runs the registered hook the way Claude Code does (with Git Bash on Windows) and reports, with a fix for each: Node.js missing from the hook's PATH, the hook not registered or out of date, hooks turned off (`disableAllHooks`, managed settings), the hook writing to a different folder, Claude Code sessions from the last 24 hours that sent nothing, and commands that ran outside this window's folders.
- A warning appears when an open Claude Code session in this window has sent nothing for 5 minutes although the hook is set up, with a button to run the check.

## 0.12.2

- Commands Claude runs without a description are named after the command itself, without the leading `cd "<project folder>";` (or `&&`, `Set-Location`, `pushd`). Tabs read `Claude: npx tsc --noEmit …` instead of `Claude: cd "E:/Work/…`.

## 0.12.1

- A command Claude moves to the background while it runs (a long build or deploy) keeps its tab open; only finished commands' tabs close when the next command starts.

## 0.12.0

- **Live output for every command**: a command's tab now streams its output while it runs, not only when it finishes. Claude Code writes the output to a file as it goes, and the tab reads from it.
- **CPU and memory** of running commands, summed over everything each one started: in the Commands view, in the tab title (`· 12% · 1.3 GB`), and peak memory in the footer when it finishes. Measured only while the window is focused and the Commands view or the command's tab is showing, every 10 seconds on Windows (3 on macOS and Linux), less often for long-running processes or when the machine is busy. Turn off with `claudeCommandCenter.resourceUsage`.

## 0.11.2

- **Finished command tabs close themselves**: when Claude starts a new command, the tabs of earlier finished commands that opened automatically are closed, so only the latest stays. Reopen any of them from the dashboard or the Commands view. Tabs you opened yourself and background-process logs are left open.

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
