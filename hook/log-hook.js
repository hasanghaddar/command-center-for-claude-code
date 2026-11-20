#!/usr/bin/env node
// Claude Code hook: records every Bash/PowerShell tool call, every file edit
// (with before/after snapshots, including files a shell command changed in a
// git repo), and turn ends, subagents and permission
// prompts, to ~/.claude/command-center/log/events.jsonl so the VS Code
// extension can show it.
// It never blocks the tool call: it always exits 0, and prints nothing except
// a permission decision made in VS Code (see askVsCode).

const fs = require('fs');
const os = require('os');
const path = require('path');
// Loaded when first used: most calls never start git or hash a file.
const lazy = (name) => {
  let m;
  return () => m || (m = require(name));
};
const cp = lazy('child_process');
const crypto = lazy('crypto');

const LOG_DIR =
  process.env.CLAUDE_COMMAND_CENTER_LOG_DIR ||
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'command-center', 'log');
const EVENTS_FILE = path.join(LOG_DIR, 'events.jsonl');
const MAX_OUTPUT = 256 * 1024;
const MAX_EVENTS_BYTES = 20 * 1024 * 1024;

function clip(value) {
  if (typeof value !== 'string') return value;
  if (value.length <= MAX_OUTPUT) return value;
  return value.slice(0, MAX_OUTPUT / 2) + '\n\n… [output truncated by process monitor] …\n\n' + value.slice(-MAX_OUTPUT / 2);
}

// ---------------------------------------------------------------------------
// Secrets are masked before anything is written: passwords in URLs,
// Authorization headers, values of settings named like a secret
// (API_KEY=…, --password …, "token": "…"), keys recognisable by their shape,
// and private keys. In a command every such value is masked. In output and
// in edited text, where the same words appear in ordinary code
// (password: req.body.password), a named value is masked only if it looks like
// a secret: six characters or more, with both letters and digits.
// Turned off with the extension's maskSecrets setting (config.json).
// ---------------------------------------------------------------------------

const HOME = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'command-center');

// Written by the extension from its settings; without it the defaults apply.
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const MASK = '***';
const SECRET_NAME = String.raw`[A-Za-z0-9_-]{0,40}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key)`;
const SECRET_VALUE = String.raw`"[^"\n]{1,500}"|'[^'\n]{1,500}'|[^\s"',;&|)]{1,500}`;
// Never masked: variables ($TOKEN, ${TOKEN}, %TOKEN%, $env:TOKEN, {{ … }},
// $(…)), placeholders (<token>), and what is masked already.
const NOT_A_VALUE = /^(?:\*+|<[^>]*>|\$\{?[\w:.]+\}?|%\w+%|\{\{.*|\$\(.*)$/;
// After a name (DEBUG_TOKEN=true, max_token: 5), these aren't secrets either.
// Where a password is expected (user:1234@host), anything is one.
const PLAIN_VALUE = /^(?:true|false|null|none|undefined|yes|no|\d{1,6})$/i;
const LOOKS_SECRET = /^(?=.*\d)(?=.*[A-Za-z])[^\s(]{6,}$/;
const TOKEN_SHAPES =
  /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]{1,10000}?-----END [A-Z ]{0,30}PRIVATE KEY-----/g;

// A replacer for rules of the form (what comes before)(the value).
// named: the value follows a name, rather than standing where a password goes.
const masker = (named, always) => (match, before, value) => {
  const quote = /^["']/.test(value) ? value[0] : '';
  const bare = quote ? value.slice(1, -1) : value;
  if (NOT_A_VALUE.test(bare)) return match;
  if (named && (PLAIN_VALUE.test(bare) || !(always || LOOKS_SECRET.test(bare)))) return match;
  return before + quote + MASK + quote;
};

// [pattern, false if the value follows a name: those are masked without
// exception only in a command]
const SECRET_RULES = [
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@\/'"]{1,100}:)([^\s@\/'"]{1,200})(?=@)/gi, true],
  // Authorization: Bearer …
  [/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token|digest|negotiate)\s+)?)([^\s"',;]{6,500})/gi, true],
  // NAME=value, name: value, "name": "value", $env:NAME = "value", --name=value
  [new RegExp(String.raw`\b(${SECRET_NAME}["']?\s*[:=]\s*)(${SECRET_VALUE})`, 'gi'), false],
  // --name value
  [new RegExp(String.raw`(--${SECRET_NAME}\s+)(?![<>|&-])(${SECRET_VALUE})`, 'gi'), false],
  // curl -u user:password, mysql -pPassword, sshpass -p password
  [/(\s(?:-u|--user)\s+["']?[^\s:"']{1,100}:)([^\s"']{1,200})/g, true],
  [/(\bmysql(?:dump|admin)?\b[^\n|;&]{0,200}?\s-p)([^\s-]\S{0,200})/g, true],
  [/(\bsshpass\s+-p\s*)(\S{1,200})/g, true],
];

// command: the text is a command line (see above).
function redact(text, command = false) {
  if (typeof text !== 'string' || text.length < 8) return text;
  let out = text.replace(PRIVATE_KEY, `-----BEGIN PRIVATE KEY----- ${MASK} -----END PRIVATE KEY-----`);
  for (const [pattern, positional] of SECRET_RULES) out = out.replace(pattern, masker(!positional, command));
  return out.replace(TOKEN_SHAPES, MASK);
}

// Set from config.json when the hook runs.
let masking = true;
const secret = (text, command) => (masking ? redact(text, command) : text);

function rotateIfLarge() {
  try {
    if (fs.statSync(EVENTS_FILE).size > MAX_EVENTS_BYTES) {
      fs.renameSync(EVENTS_FILE, EVENTS_FILE + '.1');
    }
  } catch {}
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SNAPSHOT_DIR = path.join(LOG_DIR, 'snapshots');
const MAX_SNAPSHOT = 5 * 1024 * 1024;
const MAX_SNIPPET = 64 * 1024;

// Copy the file as it is right now to snapshots/<id>.<when><ext>, keeping the
// extension so the diff editor picks the right language.
function snapshot(id, file, when) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_SNAPSHOT) return { exists: true, tooLarge: st.size > MAX_SNAPSHOT };
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const dest = path.join(SNAPSHOT_DIR, `${id.replace(/[^\w.-]/g, '_')}.${when}${path.extname(file)}`);
    fs.copyFileSync(file, dest);
    return { exists: true, path: dest };
  } catch {
    return { exists: false };
  }
}

function snippet(s) {
  return typeof s === 'string' && s.length > MAX_SNIPPET ? s.slice(0, MAX_SNIPPET) + '\n…' : s;
}

function buildFileEvent(input, base) {
  const ti = input.tool_input || {};
  const file = ti.file_path || ti.notebook_path;
  if (!file || !base.id) return null;
  if (input.hook_event_name === 'PreToolUse') {
    const before = snapshot(base.id, file, 'before');
    const ev = { ...base, type: 'fileStart', file, cwd: input.cwd, existed: before.exists, before: before.path, tooLarge: before.tooLarge };
    if (input.tool_name === 'Edit') {
      ev.oldString = secret(snippet(ti.old_string));
      ev.newString = secret(snippet(ti.new_string));
      ev.replaceAll = !!ti.replace_all;
    } else if (input.tool_name === 'MultiEdit' && Array.isArray(ti.edits)) {
      ev.edits = ti.edits.length;
    }
    return ev;
  }
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const after = failed ? {} : snapshot(base.id, file, 'after');
  const ev = { ...base, type: 'fileEnd', file, failed, after: after.path, tooLarge: after.tooLarge };
  if (failed && input.error) ev.error = secret(clip(typeof input.error === 'string' ? input.error : JSON.stringify(input.error)));
  return ev;
}

// ---------------------------------------------------------------------------
// Files changed by shell commands. Before a foreground Bash/PowerShell call in
// a git repo, note HEAD and copy the files that already differ from it. After
// it, every file that differs from that state was changed by the command; its
// "before" is the copy, or the file at that HEAD.
// ---------------------------------------------------------------------------

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const SHELL_STATE_DIR = path.join(LOG_DIR, 'shell');
const MAX_DIRTY = 500; // more files than this already changed: don't track
const MAX_DIRTY_BYTES = 50 * 1024 * 1024;
const MAX_SHELL_CHANGES = 200;
const STALE_STATE_MS = 24 * 60 * 60 * 1000;

// --no-optional-locks: never write the index, so this can't get in the way of a git command Claude runs.
function git(cwd, args) {
  return cp().execFileSync('git', ['--no-optional-locks', ...args], { cwd, windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

// Setup steps in front of the real command that don't change the folder:
// loading a version manager (`source ~/.nvm/nvm.sh > /dev/null 2>&1`,
// `nvm use 20`, `eval "$(fnm env)"`) and exporting variables.
const WORD = String.raw`(?:"[^"]*"|'[^']*'|[^\s;&|<>]+)`;
const REDIRECTS = String.raw`(?:\s*(?:&>|[0-9]?>>?)\s*(?:&[0-9]|${WORD}))*`;
const END = String.raw`\s*(?:;|&&|\r?\n)\s*`;
const SETUP_STEPS = [
  String.raw`(?:source|\.)\s+${WORD}(?:\s+${WORD})*?${REDIRECTS}`,
  String.raw`(?:nvm|fnm|volta|asdf|pyenv|rbenv|conda)\s+(?:use|activate|shell|local)(?:\s+${WORD})*?${REDIRECTS}`,
  String.raw`eval\s+"\$\([^)]*\)"${REDIRECTS}`,
  String.raw`export\s+[A-Za-z_]\w*=${WORD}?(?:\s+[A-Za-z_]\w*=${WORD}?)*`,
].map((p) => new RegExp(String.raw`^\s*${p}${END}`, 'i'));
const LEADING_CD = new RegExp(String.raw`^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))${END}`);

// Where the command runs (the session's folder, or the one the leading
// `cd <dir> &&` / `cd <dir>;` steps move to, past any setup steps) and what
// is left of the command after those steps.
function shellTarget(input) {
  let dir = input.cwd || process.cwd();
  let cmd = (input.tool_input || {}).command || '';
  for (let more = true; more; ) {
    more = false;
    const cd = LEADING_CD.exec(cmd);
    if (cd) {
      dir = path.resolve(dir, (cd[1] || cd[2] || cd[3]).replace(/^~(?=$|[\\/])/, os.homedir()));
      cmd = cmd.slice(cd[0].length);
      more = true;
      continue;
    }
    for (const re of SETUP_STEPS) {
      const m = re.exec(cmd);
      if (m) {
        cmd = cmd.slice(m[0].length);
        more = true;
        break;
      }
    }
  }
  return { dir, rest: cmd };
}

// ---------------------------------------------------------------------------
// Commands that can't change files (`ls`, `cat`, `grep`, `git status`, …)
// are not compared before and after, which saves starting git twice for most
// of what Claude runs. A command counts only if every step of it is on the
// list and nothing is written to a file; anything not understood is compared
// as before.
// ---------------------------------------------------------------------------

const READ_ONLY = new Set(
  (
    'ls dir cat head tail wc pwd echo printf which where whereis type whoami id date hostname uname ' +
    'grep egrep fgrep rg ag tree stat file du df basename dirname realpath readlink cut tr nl tac diff cmp jq ' +
    'test [ true false sleep cd pushd popd export printenv column sha1sum sha256sum md5sum ps ' +
    // PowerShell
    'get-childitem gci get-content gc select-string sls get-location gl test-path get-item gi resolve-path ' +
    'split-path join-path get-command gcm get-process gps get-date write-output write-host measure-object ' +
    'select-object select where-object sort-object format-table ft format-list fl out-string get-filehash ' +
    'set-location sl push-location pop-location'
  ).split(' ')
);
const READ_ONLY_GIT = new Set(
  'status log diff show rev-parse rev-list ls-files ls-tree blame describe cat-file grep shortlog reflog branch remote tag merge-base name-rev show-ref for-each-ref version'.split(' ')
);
// PowerShell words that change something, wherever they appear (a script block, say).
const POWERSHELL_WRITES = /^(remove-|set-(?!location)|new-|move-|copy-|rename-|clear-|add-|out-file|export-|invoke-|start-|stop-|tee-|foreach-object$|rm$|del$|ri$|mv$|cp$|ni$|iex$|sc$|ac$|%$)/i;
// Where output may be redirected without writing a file.
const NO_FILE = /^(&[0-9-]|\/dev\/null|\$null|nul)$/i;

// Where the quoted string opening at `from` closes, or -1.
function closingQuote(command, from, powershell) {
  const quote = command[from];
  for (let j = from + 1; j < command.length; j++) {
    if (command[j] === '\\' && quote === '"' && !powershell) j++;
    else if (command[j] === quote) return j;
  }
  return -1;
}

// The command line as steps (split at ; && || | and new lines), each a list of
// words with their quotes removed. null when it contains something this
// doesn't follow: command substitution, a here-document, a background `&`, or
// output redirected to a file.
function splitSteps(command, powershell) {
  const steps = [];
  let words = [];
  let word = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endStep = () => {
    endWord();
    if (words.length) steps.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (ch === "'" || ch === '"') {
      const end = closingQuote(command, i, powershell);
      if (end < 0) return null;
      const inner = command.slice(i + 1, end);
      if (ch === '"' && /`|\$\(/.test(inner)) return null; // runs a command
      word = (word || '') + inner;
      i = end;
    } else if (ch === '\n' || ch === ';') {
      endStep();
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
    } else if (ch === '|') {
      endStep();
      if (next === '|' || next === '&') i++;
    } else if (ch === '&') {
      if (next === '&') {
        endStep();
        i++;
      } else if (next !== '>') return null; // run in the background
    } else if (ch === '>') {
      if (word !== null && /^\d+$/.test(word)) word = null; // 2>
      endWord();
      let j = i + 1;
      if (command[j] === '>') j++;
      if (command[j] === '|') j++;
      while (command[j] === ' ') j++;
      const m = /^[^\s;|<>]+/.exec(command.slice(j));
      if (!m || !NO_FILE.test(m[0].replace(/^["']|["']$/g, ''))) return null; // writes a file
      i = j + m[0].length - 1;
    } else if (ch === '<') {
      if (next === '<' || next === '(') return null;
      endWord(); // reads a file
    } else if (ch === '`' || (ch === '$' && next === '(')) {
      return null;
    } else if (ch === '#' && word === null) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i++; // a comment
    } else if (ch === '\\' && !powershell && next !== undefined) {
      word = (word || '') + next;
      i++;
    } else {
      word = (word || '') + ch;
    }
  }
  endStep();
  return steps;
}

function readOnlyGit(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i] !== '--version') i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
  const sub = args[i];
  if (sub === '--version') return true;
  if (!READ_ONLY_GIT.has(sub)) return false;
  return !args.slice(i + 1).some((a) => a.startsWith('--output'));
}

function readOnlyStep(words, powershell) {
  if (powershell && words.some((w) => POWERSHELL_WRITES.test(w))) return false;
  const cmd = words[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  const args = words.slice(1);
  if (cmd === 'git') return readOnlyGit(args);
  if (cmd === 'find') return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(a));
  if (cmd === 'sed') return args.includes('-n') && !args.some((a) => /^-[a-z]*i|^--in-place/i.test(a)); // printing lines
  if (cmd === 'sort') return !args.some((a) => /^(-o|--output)/.test(a));
  if (cmd === 'command') return args[0] === '-v' || args[0] === '-V';
  return READ_ONLY.has(cmd);
}

function readOnly(command, tool) {
  const powershell = tool === 'PowerShell';
  const steps = splitSteps(String(command || ''), powershell);
  return !!steps && steps.length > 0 && steps.every((words) => readOnlyStep(words, powershell));
}

// The repository a folder is in: the nearest folder up from it that has a
// `.git` (a folder, or a file in a worktree or submodule). Found without
// starting git, so a folder outside any repository costs nothing.
function repoRoot(dir) {
  for (let d = path.resolve(dir); ; ) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// What follows the first n space-separated fields of a status line.
function afterFields(line, n) {
  let at = 0;
  for (; n > 0; n--) at = line.indexOf(' ', at) + 1;
  return line.slice(at);
}

// From one `git status`: HEAD (null before the first commit) and the paths,
// relative to the repo root, that differ from it or the index, untracked ones
// included.
function gitState(root) {
  const out = git(root, ['status', '--porcelain=v2', '--branch', '-z', '-uall']).toString('utf8').split('\0');
  let head = null;
  const paths = [];
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e.startsWith('# branch.oid ')) {
      if (/^[0-9a-f]{40,64}$/.test(e.slice(13))) head = e.slice(13);
    } else if (e[0] === '1') paths.push(afterFields(e, 8));
    else if (e[0] === '2') paths.push(afterFields(e, 9), out[++i]); // renamed or copied: the new path, then its source
    else if (e[0] === 'u') paths.push(afterFields(e, 10));
    else if (e[0] === '?') paths.push(e.slice(2));
  }
  return { head, paths: paths.filter(Boolean) };
}

// Store contents once per hash, keeping the extension so diffs get the right
// language. Reusing a copy refreshes its age so it isn't pruned while in use.
function storeBlob(buf, file) {
  const dest = path.join(SNAPSHOT_DIR, `blob-${crypto().createHash('sha1').update(buf).digest('hex')}${path.extname(file)}`);
  try {
    const now = new Date();
    fs.utimesSync(dest, now, now);
  } catch {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  return dest;
}

const shellStateFile = (id) => path.join(SHELL_STATE_DIR, `${id.replace(/[^\w.-]/g, '_')}.json`);

// Mid-task a repository has many files that differ from the last commit, and
// every command would read and hash all of them again. The copies made last
// time are remembered per repository, and reused for files whose size and
// time haven't changed since.
const DAY_MS = 24 * 60 * 60 * 1000;
const copiesFile = (root) => path.join(SHELL_STATE_DIR, `copies-${root.replace(/[^\w.-]/g, '_').slice(-150)}.json`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The remembered copy of a file, if it is still the same file and the copy still exists.
function knownCopy(was, st, now) {
  if (!was || !was.blob || was.size !== st.size || was.mtime !== st.mtimeMs || !fs.existsSync(was.blob)) return null;
  if (now - was.touched > DAY_MS / 2) {
    try {
      fs.utimesSync(was.blob, new Date(now), new Date(now)); // in use: not to be cleaned up as old
      was.touched = now;
    } catch {
      return null;
    }
  }
  return was;
}

function shellBefore(input) {
  const ti = input.tool_input || {};
  if (!input.tool_use_id || ti.run_in_background || isMonitor(input)) return; // a background task changes files after its hook has run
  const { dir, rest } = shellTarget(input);
  if (readOnly(rest, input.tool_name)) return; // it can't change files
  const root = repoRoot(dir);
  if (!root) return; // not in a git repo
  const { head, paths } = gitState(root); // throws without git: nothing is tracked
  if (paths.length > MAX_DIRTY) return;
  const now = Date.now();
  const before = readJson(copiesFile(root));
  const known = before || {};
  const copies = {};
  const dirty = {};
  let bytes = 0;
  for (const rel of paths) {
    const file = path.join(root, rel);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      const entry = { size: st.size, mtime: st.mtimeMs };
      if (st.size > MAX_SNAPSHOT || bytes + st.size > MAX_DIRTY_BYTES) entry.tooLarge = true;
      else {
        const copy = knownCopy(known[rel], st, now) || { size: st.size, mtime: st.mtimeMs, blob: storeBlob(fs.readFileSync(file), file), touched: now };
        copies[rel] = copy;
        entry.blob = copy.blob;
        bytes += st.size;
      }
      dirty[rel] = entry;
    } catch {
      dirty[rel] = { missing: true };
    }
  }
  fs.mkdirSync(SHELL_STATE_DIR, { recursive: true });
  fs.writeFileSync(shellStateFile(input.tool_use_id), JSON.stringify({ root, head, ts: now, dirty }));
  const remembered = JSON.stringify(copies);
  if (remembered !== JSON.stringify(before)) fs.writeFileSync(copiesFile(root), remembered);
  // State left by calls that never finished (denied, or Claude Code quit).
  try {
    for (const n of fs.readdirSync(SHELL_STATE_DIR)) {
      const p = path.join(SHELL_STATE_DIR, n);
      if (Date.now() - fs.statSync(p).mtimeMs > STALE_STATE_MS) fs.unlinkSync(p);
    }
  } catch {}
}

// fileStart/fileEnd pairs, one per file the command changed.
function shellAfter(input, base) {
  if (!input.tool_use_id) return [];
  const stateFile = shellStateFile(input.tool_use_id);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.unlinkSync(stateFile);
  } catch {
    return [];
  }
  const { root, head, dirty } = state;
  const now = gitState(root);
  const candidates = new Set([...Object.keys(dirty), ...now.paths]);
  // A commit or checkout during the command: files may now match the new HEAD
  // but still differ from the one before.
  if (head && now.head !== head) {
    for (const rel of git(root, ['diff', '--name-only', '-z', head]).toString('utf8').split('\0')) if (rel) candidates.add(rel);
  }

  const ti = input.tool_input || {};
  const via = ti.description ? secret(ti.description) : secret(String(ti.command || '').split('\n')[0], true);
  const events = [];
  for (const rel of candidates) {
    if (events.length >= MAX_SHELL_CHANGES * 2) break;
    const file = path.join(root, rel);
    let st = null;
    try {
      st = fs.statSync(file);
      if (!st.isFile()) continue;
    } catch {}
    const was = dirty[rel];
    if (was && !was.missing && st && st.size === was.size && st.mtimeMs === was.mtime) continue; // untouched

    // The file as it was: the copy if it already differed from HEAD, else HEAD's.
    let before = null;
    let tooLarge = false;
    if (was) {
      if (was.tooLarge) tooLarge = true;
      else if (was.blob) before = readOrNull(was.blob);
    } else if (head) {
      try {
        before = git(root, ['cat-file', 'blob', `${head}:${rel}`]);
      } catch {} // not in HEAD
    }
    const after = st ? (st.size > MAX_SNAPSHOT ? null : readOrNull(file)) : null;
    if (st && st.size > MAX_SNAPSHOT) tooLarge = true;
    if (!tooLarge && before == null && after == null) continue;
    if (!tooLarge && before && after && Buffer.compare(before, after) === 0) continue;

    const ev = { ...base, id: `${base.id}:${rel}`, toolId: base.id, file, via };
    events.push({
      ...ev,
      type: 'fileStart',
      ts: state.ts,
      cwd: input.cwd,
      existed: was ? !was.missing : before != null,
      before: before && storeBlob(before, file),
      tooLarge: tooLarge || undefined,
    });
    events.push({ ...ev, type: 'fileEnd', failed: false, after: after && storeBlob(after, file), deleted: !st || undefined, tooLarge: tooLarge || undefined });
  }
  return events;
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

// Session-level events: a turn ending, subagents starting and stopping, and
// Claude asking for permission or input. They drive the extension's notifications.
const SESSION_EVENTS = {
  UserPromptSubmit: 'prompt', // a turn starts
  Stop: 'turnEnd',
  StopFailure: 'turnEnd', // the turn ended in an API error
  SubagentStart: 'subagentStart',
  SubagentStop: 'subagentEnd',
  Notification: 'attention',
};
const MAX_MESSAGE = 300;
const MAX_TASKS = 50;

// The background tasks still going when a turn or subagent ends, as Claude
// Code lists them (Stop and SubagentStop). The extension uses it to tell which
// background commands have ended, since nothing else reports that.
function runningTasks(list) {
  if (!Array.isArray(list)) return undefined; // an older Claude Code, or the list couldn't be read
  return list.slice(0, MAX_TASKS).map((t) => ({
    id: t.id,
    type: t.type,
    command: typeof t.command === 'string' ? secret(t.command.slice(0, 2000), true) : undefined,
  }));
}

function buildSessionEvent(input) {
  const ev = {
    type: SESSION_EVENTS[input.hook_event_name],
    session: input.session_id || null,
    cwd: input.cwd,
    ts: Date.now(),
  };
  if (ev.type === 'prompt') return ev; // when, not what: the prompt itself is in Claude Code's transcript
  if (input.hook_event_name === 'StopFailure') {
    ev.failed = true;
    ev.error = String(input.error || 'unknown').slice(0, 100); // rate_limit, authentication_failed, …
  }
  const tasks = runningTasks(input.background_tasks);
  if (tasks) ev.tasks = tasks;
  const text = input.last_assistant_message || input.message;
  if (typeof text === 'string' && text.trim()) {
    ev.message = secret(text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE) + '…' : text);
  }
  if (input.agent_id) ev.agentId = input.agent_id;
  if (input.agent_type) ev.agentType = input.agent_type;
  if (input.notification_type) ev.kind = input.notification_type;
  return ev;
}

// Claude's Monitor tool (a script it leaves watching in the background) reaches
// hooks registered for Bash when it starts, with `timeout_ms` where Bash has
// `timeout`. Nothing is sent when it ends.
function isMonitor(input) {
  const ti = input.tool_input || {};
  return input.tool_name === 'Monitor' || (ti.timeout_ms !== undefined && ti.timeout === undefined);
}

function buildEvent(input) {
  if (SESSION_EVENTS[input.hook_event_name]) return buildSessionEvent(input);

  const ti = input.tool_input || {};
  const base = {
    id: input.tool_use_id || null,
    session: input.session_id || null,
    tool: input.tool_name || null,
    ts: Date.now(),
  };

  if (FILE_TOOLS.has(input.tool_name)) return buildFileEvent(input, base);

  switch (input.hook_event_name) {
    case 'PreToolUse':
      return {
        ...base,
        type: 'start',
        command: secret(ti.command, true),
        description: secret(ti.description),
        background: !!ti.run_in_background,
        timeout: ti.timeout ?? ti.timeout_ms,
        monitor: isMonitor(input) || undefined,
        cwd: input.cwd,
        transcript: input.transcript_path,
      };
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const r = input.tool_response;
      const ev = {
        ...base,
        type: 'end',
        failed: input.hook_event_name === 'PostToolUseFailure',
        command: secret(ti.command, true), // lets the extension pair start/end if tool_use_id is missing
        durationMs: input.duration_ms,
      };
      if (input.is_interrupt) ev.interrupted = true;
      if (r && typeof r === 'object') {
        ev.stdout = secret(clip(r.stdout));
        ev.stderr = secret(clip(r.stderr));
        ev.interrupted = r.interrupted;
        ev.exitCode = r.exitCode ?? r.exit_code ?? r.code;
        ev.backgroundTaskId = r.backgroundTaskId;
        ev.outputFile = r.outputFile || r.output_file || r.outputPath;
        ev.responseKeys = Object.keys(r);
      } else if (r !== undefined) {
        ev.stdout = secret(clip(String(r)));
      }
      if (input.error) {
        const err = typeof input.error === 'string' ? input.error : JSON.stringify(input.error);
        ev.error = secret(clip(err));
        // Bash failures arrive as "Exit code N\n<output>"
        const m = /^Exit code (\d+)/.exec(err);
        if (m && ev.exitCode == null) ev.exitCode = Number(m[1]);
      }
      return ev;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Permission requests: for sessions running in a terminal, ask the VS Code
// window that has the project open, if one has this turned on. It answers by
// writing permissions/<id>.response.json. If no window is listening, or none
// answers in time, nothing is printed and Claude Code asks in the terminal.
// ---------------------------------------------------------------------------

const PERMISSION_DIR = path.join(LOG_DIR, 'permissions');
const LISTENER_FRESH_MS = 15 * 1000;
const MAX_TOOL_INPUT = 4 * 1024;

const normPath = (p) => {
  const s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

// Claude Code sessions in its VS Code panel ask there already.
function inVsCodePanel(sessionId) {
  if (process.env.CLAUDE_CODE_ENTRYPOINT) return process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode';
  try {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
    for (const n of fs.readdirSync(dir)) {
      const s = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (s.sessionId === sessionId) return s.entrypoint === 'claude-vscode';
    }
  } catch {}
  return false;
}

// The longest wait among VS Code windows listening for this folder, or 0.
function listenerTimeout(cwd) {
  let best = 0;
  let names = [];
  try {
    names = fs.readdirSync(PERMISSION_DIR).filter((n) => /^listener-.*\.json$/.test(n));
  } catch {}
  const target = cwd ? normPath(cwd) : '';
  for (const n of names) {
    try {
      const l = JSON.parse(fs.readFileSync(path.join(PERMISSION_DIR, n), 'utf8'));
      if (Date.now() - l.ts > LISTENER_FRESH_MS) continue;
      const covers = (l.folders || []).some((f) => target === normPath(f) || target.startsWith(normPath(f) + '/'));
      if (covers) best = Math.max(best, (l.timeoutSeconds || 60) * 1000);
    } catch {}
  }
  return best;
}

function clipInput(ti) {
  const json = JSON.stringify(ti || {});
  if (json.length <= MAX_TOOL_INPUT) return ti;
  const out = {};
  for (const [k, v] of Object.entries(ti)) out[k] = typeof v === 'string' && v.length > 1000 ? v.slice(0, 1000) + '…' : v;
  return out;
}

// Requests that need more than Allow or Deny (an answer to a question, a plan
// to approve) are left to Claude Code.
const ASKED_IN_CLAUDE_CODE = new Set(['AskUserQuestion', 'ExitPlanMode']);

async function askVsCode(input) {
  if (ASKED_IN_CLAUDE_CODE.has(input.tool_name)) return;
  if (inVsCodePanel(input.session_id)) return;
  const timeout = listenerTimeout(input.cwd);
  if (!timeout) return;
  const id = `${Date.now()}-${process.pid}`;
  const request = path.join(PERMISSION_DIR, `${id}.request.json`);
  const response = path.join(PERMISSION_DIR, `${id}.response.json`);
  fs.writeFileSync(
    request,
    JSON.stringify({ id, session: input.session_id, cwd: input.cwd, tool: input.tool_name, input: clipInput(input.tool_input), ts: Date.now() })
  );
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      let answer;
      try {
        answer = JSON.parse(fs.readFileSync(response, 'utf8'));
      } catch {
        continue; // not answered yet
      }
      const decision =
        answer.behavior === 'allow'
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: answer.message || 'Denied from VS Code.' };
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
      return;
    }
  } finally {
    for (const f of [request, response]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  }
}

// Loaded by the tests rather than run by Claude Code.
if (require.main !== module) {
  module.exports = { readOnly, splitSteps, gitState, repoRoot, shellTarget, redact };
  return;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(raw);
    // Sent only by the extension's "Check Setup" command, never by Claude Code:
    // report where events would go and whether that folder is writable.
    if (input.hook_event_name === 'CommandCenterCheck') {
      let writable = true;
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.accessSync(LOG_DIR, fs.constants.W_OK);
      } catch {
        writable = false;
      }
      process.stdout.write(JSON.stringify({ commandCenterCheck: true, node: process.version, logDir: LOG_DIR, writable }) + '\n');
      process.exit(0);
    }
    if (input.hook_event_name === 'PermissionRequest') {
      await askVsCode(input);
      process.exit(0);
    }
    masking = readConfig().maskSecrets !== false;
    const ev = buildEvent(input);
    const events = ev ? [ev] : [];
    if (SHELL_TOOLS.has(input.tool_name)) {
      try {
        if (input.hook_event_name === 'PreToolUse') shellBefore(input);
        else events.push(...shellAfter(input, { session: ev.session, tool: ev.tool, id: ev.id, ts: ev.ts }));
      } catch {}
    }
    if (events.length) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      rotateIfLarge();
      fs.appendFileSync(EVENTS_FILE, events.map((e) => JSON.stringify(e) + '\n').join(''));
    }
    // Create ~/.claude/command-center/log/debug to also record the raw hook payloads.
    if (process.env.CLAUDE_COMMAND_CENTER_DEBUG || fs.existsSync(path.join(LOG_DIR, 'debug'))) {
      fs.appendFileSync(path.join(LOG_DIR, 'raw.jsonl'), raw.trim() + '\n');
    }
  } catch {}
  process.exit(0);
});
