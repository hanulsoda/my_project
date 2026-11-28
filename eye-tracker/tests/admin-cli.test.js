'use strict';
const { startTestServer } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { openDb } = require('../server/db');
const { hashPassword, verifyPassword } = require('../server/auth');
const { setPassword, disableUser, enableUser, listUsers } = require('../server/admin-cli');

const CLI = path.join(__dirname, '..', 'server', 'admin-cli.js');

async function addUser(db, email, password, role = 'teacher') {
  return db.prepare('INSERT INTO users (email, pw_hash, role, created_at) VALUES (?, ?, ?, 1)')
    .run(email, await hashPassword(password), role).lastInsertRowid;
}

const login = (srv, email, password) => fetch(`${srv.url}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

test('setPassword: replaces the hash, kills old sessions, rejects bad input', async () => {
  const db = openDb(':memory:');
  const id = await addUser(db, 'kim@example.test', 'old-password-1');
  const other = await addUser(db, 'lee@example.test', 'other-password-1');
  db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run('s-kim', id, 9e15);
  db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run('s-lee', other, 9e15);

  await setPassword(db, ' KIM@example.test ', 'brand-new-password');
  const { pw_hash: hash } = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(id);
  assert.ok(await verifyPassword('brand-new-password', hash));
  assert.ok(!(await verifyPassword('old-password-1', hash)));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?').get(id).n, 0, 'old sessions die');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?').get(other).n, 1, 'others untouched');

  await assert.rejects(() => setPassword(db, 'ghost@example.test', 'brand-new-password'), /no user/i);
  await assert.rejects(() => setPassword(db, 'kim@example.test', 'short'), /8/);
  await assert.rejects(() => setPassword(db, 'kim@example.test', 'x'.repeat(257)), /256/);
  assert.ok(await verifyPassword('brand-new-password', db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(id).pw_hash), 'failed calls change nothing');
});

test('disableUser / enableUser: flag, sessions and the last-admin guard', async () => {
  const db = openDb(':memory:');
  const t = await addUser(db, 't@example.test', 'teacher-password');
  const a1 = await addUser(db, 'a1@example.test', 'admin-password-1', 'admin');
  db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run('s-t', t, 9e15);

  disableUser(db, 't@example.test', { now: () => 1234 });
  assert.equal(db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(t).disabled_at, 1234);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?').get(t).n, 0);
  enableUser(db, 't@example.test');
  assert.equal(db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(t).disabled_at, null);

  assert.throws(() => disableUser(db, 'ghost@example.test'), /no user/i);
  assert.throws(() => enableUser(db, 'ghost@example.test'), /no user/i);

  // The only enabled admin cannot be disabled; with a second admin it can.
  assert.throws(() => disableUser(db, 'a1@example.test'), /last admin/i);
  assert.equal(db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(a1).disabled_at, null);
  await addUser(db, 'a2@example.test', 'admin-password-2', 'admin');
  disableUser(db, 'a1@example.test');
  assert.throws(() => disableUser(db, 'a2@example.test'), /last admin/i, 'a1 is disabled, so a2 is now the last enabled admin');
});

test('listUsers: email, role, disabled only, never a hash', async () => {
  const db = openDb(':memory:');
  await addUser(db, 'a@example.test', 'admin-password-1', 'admin');
  await addUser(db, 'b@example.test', 'teacher-password');
  disableUser(db, 'b@example.test');
  const rows = listUsers(db);
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { email: 'a@example.test', role: 'admin', disabled: 'no' },
    { email: 'b@example.test', role: 'teacher', disabled: 'yes' },
  ]);
});

test('offboarding over HTTP: disabled cookie dies at once, cannot log in, enable restores, data stays', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const email = 'gone@example.test';
  const id = await addUser(srv.db, email, 'teacher-password');
  const res = await login(srv, email, 'teacher-password');
  assert.equal(res.status, 200);
  const cookie = res.headers.getSetCookie()[0].split(';')[0];
  srv.db.prepare("INSERT INTO children (teacher_id, code, initials, grade_band, consent_date, created_at) VALUES (?, 'C1', 'AB', 'elementary', '2026-01-01', 1)").run(id);
  const list = (c) => fetch(`${srv.url}/api/children`, { headers: { cookie: c } });
  assert.equal((await list(cookie)).status, 200);

  // Flag only (no session delete) must already lock the cookie out: authenticate() checks it.
  srv.db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(srv.clock.t, id);
  assert.equal((await list(cookie)).status, 401);
  assert.equal((await fetch(`${srv.url}/api/me`, { headers: { cookie } })).status, 401);

  const wrong = await login(srv, email, 'not-the-password');
  const disabled = await login(srv, email, 'teacher-password');
  assert.equal(disabled.status, 401);
  assert.equal(disabled.headers.getSetCookie().length, 0);
  assert.equal(await disabled.text(), await wrong.text(), 'same body as a wrong password');

  enableUser(srv.db, email);
  assert.equal((await list(cookie)).status, 200, 'the old cookie works again if its session still exists');
  assert.equal((await login(srv, email, 'teacher-password')).status, 200);
});

test('disabling a teacher via the CLI helper keeps their children and sessions', async () => {
  const db = openDb(':memory:');
  const id = await addUser(db, 't@example.test', 'teacher-password');
  const child = db.prepare("INSERT INTO children (teacher_id, code, initials, grade_band, consent_date, created_at) VALUES (?, 'C1', 'AB', 'low', '2026-01-01', 1)").run(id).lastInsertRowid;
  db.prepare("INSERT INTO read_sessions (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json) VALUES (?, 'p', 'new', 1, 1, 1, '[]', '[]', '{}')").run(child);
  disableUser(db, 't@example.test');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM children WHERE teacher_id = ?').get(id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM read_sessions').get().n, 1);
});

test('CLI process: set-password via stdin, list, disable, errors exit non-zero', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-tracker-cli-'));
  const file = path.join(dir, 'cli.db');
  try {
    const db = openDb(file);
    await addUser(db, 'a@example.test', 'admin-password-1', 'admin');
    await addUser(db, 'kim@example.test', 'old-password-1');
    db.close();
    const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, DB_PATH: file }, input, encoding: 'utf8',
    });

    const ok = run(['set-password', 'kim@example.test'], 'p@ss$word #1 "quoted"\n');
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotMatch(ok.stdout + ok.stderr, /p@ss/, 'never echoes the password');
    const chk = openDb(file);
    const hash = chk.prepare("SELECT pw_hash FROM users WHERE email = 'kim@example.test'").get().pw_hash;
    chk.close();
    assert.ok(await verifyPassword('p@ss$word #1 "quoted"', hash), 'trailing newline stripped, special chars kept');

    const unknown = run(['set-password', 'ghost@example.test'], 'long-enough-password\n');
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /no user/i);
    const short = run(['set-password', 'kim@example.test'], 'short\n');
    assert.notEqual(short.status, 0);
    assert.match(short.stderr, /8/);
    assert.notEqual(run(['set-password'], 'x').status, 0, 'email required');
    assert.notEqual(run(['bogus']).status, 0);

    const lastAdmin = run(['disable', 'a@example.test']);
    assert.notEqual(lastAdmin.status, 0);
    assert.match(lastAdmin.stderr, /last admin/i);

    assert.equal(run(['disable', 'kim@example.test']).status, 0);
    const list = run(['list']);
    assert.equal(list.status, 0);
    assert.match(list.stdout, /kim@example\.test\s+teacher\s+yes/);
    assert.match(list.stdout, /a@example\.test\s+admin\s+no/);
    assert.doesNotMatch(list.stdout, /scrypt/);
    assert.equal(run(['enable', 'kim@example.test']).status, 0);
    assert.match(run(['list']).stdout, /kim@example\.test\s+teacher\s+no/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
