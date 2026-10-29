# Changelog

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
