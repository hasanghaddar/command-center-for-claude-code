// Keeping secrets out of the history, and the upkeep that drops old history
// and masks what was recorded before masking existed.

const test = require('node:test');
const assert = require('node:assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { state } = require('./stub-vscode');
const { Store } = require('../extension.js')._internals;
const history = require('../history.js');
const { redact } = require('../hook/log-hook.js');
const { matchTaskProcesses } = require('../processes.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'command-center-history-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
let n = 0;
function logFolder() {
  const dir = path.join(tmp, `log${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  state.config = { logDir: dir, maxItems: 200 };
  const f = history.files(dir);
  const write = (file, events) => fs.writeFileSync(file, events.map((e) => JSON.stringify(e) + '\n').join(''));
  const read = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, f, write, read };
}

test('secrets in a command are masked, and what is not a secret is left alone', () => {
  const masked = {
    'DATABASE_URL="postgresql://postgres:P%40ssw0rd@localhost:5432/app" npx prisma migrate deploy': 'DATABASE_URL="postgresql://postgres:***@localhost:5432/app" npx prisma migrate deploy',
    'curl -H "Authorization: Bearer abc123def456ghi789" https://api.example.com': 'curl -H "Authorization: Bearer ***" https://api.example.com',
    'curl -u admin:hunter2 https://example.com': 'curl -u admin:*** https://example.com',
    'PGPASSWORD=correcthorse psql -U app': 'PGPASSWORD=*** psql -U app',
    '$env:API_KEY = "live_9f8e7d6c5b4a"; npm run deploy': '$env:API_KEY = "***"; npm run deploy',
    'az login -u app --password "S3cret!value" --tenant t': 'az login -u app --password "***" --tenant t',
    'mysql -u root -pSecret123 mydb': 'mysql -u root -p*** mydb',
    'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789': 'export GITHUB_TOKEN=***',
  };
  for (const [command, expected] of Object.entries(masked)) assert.equal(redact(command, true), expected);

  for (const command of [
    'curl -H "Authorization: Bearer $TOKEN" https://x && echo "password=$DB_PASSWORD"', // variables, not values
    'docker run -e POSTGRES_PASSWORD=${PG_PASS} postgres',
    'gh auth login --with-token < token.txt',
    'git clone https://github.com/user/repo.git && npm test -- --token-count 5',
    'npm run build',
  ]) {
    assert.equal(redact(command, true), command);
  }
  const once = redact('PGPASSWORD=correcthorse psql; curl -u a:b1234567 x', true);
  assert.equal(redact(once, true), once, 'masking again changes nothing');
});

test('in output, a named value is masked only when it looks like a secret', () => {
  assert.equal(redact('API_KEY=sk_live_9f8e7d6c5b4a3210\nDEBUG=true\nDB_PASSWORD=hunter2\nPORT=3000'), 'API_KEY=***\nDEBUG=true\nDB_PASSWORD=***\nPORT=3000');
  assert.equal(redact('{"access_token": "ya29.a0AfH6SMBx1234567890", "expires_in": 3599, "max_tokens": 4096}'), '{"access_token": "***", "expires_in": 3599, "max_tokens": 4096}');
  assert.equal(redact('remote: https://oauth2:glpat-abcdefghij0123456789@gitlab.com/x.git'), 'remote: https://oauth2:***@gitlab.com/x.git');
  assert.equal(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'), '-----BEGIN PRIVATE KEY----- *** -----END PRIVATE KEY-----');
  // Ordinary code and text that only mention the words.
  for (const text of [
    'const token = getToken();\nif (!user.password) throw new Error("password: required");\n  password: req.body.password,',
    'Total tokens: 12,345   secretName: my-secret   passwordless: true',
    'src/auth.ts:14:  const secret = process.env.JWT_SECRET;',
  ]) {
    assert.equal(redact(text), text);
  }
});

test('a running command is still found by its command line after its secret was masked', () => {
  const real = 'DATABASE_URL="postgresql://postgres:P%40ssw0rd@localhost/app" npm run dev';
  const procs = [{ pid: 5, ppid: 1, cmd: `bash -c "shopt -u extglob && eval '${real}' < /dev/null && pwd -P >| /tmp/x"` }];
  assert.deepEqual(matchTaskProcesses(procs, { command: redact(real, true) }, -1), [5]);
});

test('upkeep drops history older than historyDays, whole commands at a time', () => {
  const log = logFolder();
  const now = Date.now();
  const old = now - 40 * DAY;
  log.write(log.f.older, [
    { type: 'start', id: 'old', session: 's', command: 'ls', ts: old },
    { type: 'end', id: 'old', session: 's', stdout: 'x', ts: old + 1000 },
    { type: 'turnEnd', session: 's', ts: old + 2000 },
    { type: 'start', id: 'long', session: 's', command: 'npm run dev', ts: old + 3000 }, // started long ago…
  ]);
  log.write(log.f.main, [
    { type: 'end', id: 'long', session: 's', stdout: 'done', ts: now - DAY }, // …and ended yesterday: kept whole
    { type: 'start', id: 'new', session: 's', command: 'git status', ts: now - 1000 },
    { type: 'turnEnd', session: 's', ts: now - 500 },
  ]);
  const { store, announced } = (() => {
    const s = new Store();
    s.scope = 'all';
    s.load();
    const seen = [];
    s.onRecord(({ rec, type }) => seen.push(`${type}:${rec.id}`));
    return { store: s, announced: seen };
  })();
  const running = store.records.get('new');
  assert.equal(store.records.size, 3);

  assert.equal(history.isDue(log.dir, { historyDays: 30, mask: false }), true);
  const result = history.maintain(log.dir, { historyDays: 30, mask: false }, now);
  assert.equal(result.rewritten, true);
  assert.deepEqual(log.read(log.f.older).map((e) => `${e.type}:${e.id || ''}`), ['start:long', 'end:long', 'start:new', 'turnEnd:']);
  assert.equal(fs.existsSync(log.f.main), false, 'the next hook call starts a new file');
  assert.equal(fs.existsSync(log.f.lock), false);
  assert.equal(history.isDue(log.dir, { historyDays: 30, mask: false }, now + 1000), false, 'not again today');

  // A window that was open reads the rewritten history without announcing anything as new,
  // and a command it was showing is still the same object.
  store.read();
  assert.deepEqual([...store.records.keys()].sort(), ['long', 'new']);
  assert.equal(store.records.get('new'), running);
  assert.deepEqual(announced, []);

  // The hook goes on writing to a new file, which is followed.
  fs.appendFileSync(log.f.main, JSON.stringify({ type: 'end', id: 'new', session: 's', stdout: 'clean', ts: now }) + '\n');
  store.read();
  assert.equal(running.status, 'ok');
  assert.deepEqual(announced, ['end:new']);
});

test('upkeep masks secrets recorded before masking existed, once', () => {
  const log = logFolder();
  const now = Date.now();
  const secretCommand = 'PGPASSWORD=correcthorse psql -c "select 1"';
  log.write(log.f.main, [
    { type: 'start', id: 'a', session: 's', command: secretCommand, ts: now - 2000 },
    { type: 'end', id: 'a', session: 's', command: secretCommand, stdout: 'API_KEY=sk_live_9f8e7d6c5b4a3210\n', ts: now - 1000 },
  ]);
  assert.equal(history.isDue(log.dir, { historyDays: 0, mask: true }), true);
  history.maintain(log.dir, { historyDays: 0, mask: true }, now);
  const text = fs.readFileSync(log.f.older, 'utf8');
  assert.ok(!text.includes('correcthorse') && !text.includes('sk_live'), text);
  assert.match(text, /PGPASSWORD=\*\*\*/);
  assert.equal(history.isDue(log.dir, { historyDays: 0, mask: true }, now + 2 * DAY), false, 'done once; new events are masked by the hook');
});

test('upkeep keeps the history within its size limit, dropping the oldest', () => {
  const lines = [1, 2, 3, 4].map((i) => JSON.stringify({ type: 'turnEnd', session: 's', ts: i, message: 'x'.repeat(100) }));
  const { kept } = history.filterLines(lines, { cutoff: 0, mask: false, maxBytes: 400 });
  assert.deepEqual(kept.map((l) => JSON.parse(l).ts), [3, 4]);
});

test('upkeep waits when another window is doing it, and finishes a run that was cut short', () => {
  const log = logFolder();
  const now = Date.now();
  log.write(log.f.main, [{ type: 'turnEnd', session: 's', ts: now }]);
  fs.writeFileSync(log.f.lock, '1');
  assert.deepEqual(history.maintain(log.dir, { historyDays: 30, mask: true }, now), { skipped: 'another window is doing it' });
  fs.unlinkSync(log.f.lock);

  // A run that moved the file aside and then died.
  fs.renameSync(log.f.main, log.f.moved);
  assert.equal(history.isDue(log.dir, { historyDays: 0, mask: false }), true);
  history.maintain(log.dir, { historyDays: 0, mask: false }, now);
  assert.equal(fs.existsSync(log.f.moved), false);
  assert.equal(log.read(log.f.older).length, 1, 'its events are back in the history');
});

test('history.js runs as a process of its own', () => {
  const log = logFolder();
  log.write(log.f.main, [{ type: 'start', id: 'a', session: 's', command: 'curl -u admin:hunter2 https://x', ts: Date.now() }]);
  cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'history.js'), log.dir, JSON.stringify({ historyDays: 30, mask: true })]);
  assert.equal(log.read(log.f.older)[0].command, 'curl -u admin:*** https://x');
});

test('where a password goes, anything is masked; after a name, plain values are not', () => {
  assert.equal(redact('psql postgresql://postgres:1234@10.0.0.5/db', true), 'psql postgresql://postgres:***@10.0.0.5/db');
  assert.equal(redact('connecting to postgresql://app:true@db.internal/x'), 'connecting to postgresql://app:***@db.internal/x');
  for (const text of ['DEBUG_TOKEN=true max_token: 5', 'postgresql://postgres:****@host/db', 'postgresql://${DbUser}:${DbPass}@host/db', 'http://example.com:8080/a?x=b@c']) {
    assert.equal(redact(text, true), text);
  }
});
