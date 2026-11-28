'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openDb } = require('../server/db');

// The schema as it stood before the management features: no users.last_login_at, no
// invites.id, no children.group_name / note, no read_sessions.note, no password_resets /
// audit_log tables.
const OLD_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher')), created_at INTEGER NOT NULL, disabled_at INTEGER);
CREATE TABLE invites (token TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE auth_sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE children (
  id INTEGER PRIMARY KEY AUTOINCREMENT, teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL, initials TEXT NOT NULL, grade_band TEXT NOT NULL, consent_date TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX children_teacher_code ON children(teacher_id, code);
CREATE TABLE read_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  passage_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('reference', 'new')), started_at INTEGER NOT NULL,
  screen_w INTEGER NOT NULL, screen_h INTEGER NOT NULL, words_json TEXT NOT NULL, samples_json TEXT NOT NULL, metrics_json TEXT NOT NULL);
CREATE TABLE share_links (token TEXT PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES read_sessions(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, revoked_at INTEGER);
`;

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

function withOldDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-tracker-migrate-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new Database(file);
    old.exec(OLD_SCHEMA);
    old.prepare("INSERT INTO users (email, pw_hash, role, created_at) VALUES ('t@example.test', 'scrypt$a$b', 'teacher', 5)").run();
    old.prepare("INSERT INTO invites (token, email, expires_at) VALUES ('tok-a', 'a@example.test', 100), ('tok-b', 'b@example.test', 100)").run();
    old.prepare("INSERT INTO children (teacher_id, code, initials, grade_band, consent_date, created_at) VALUES (1, 'C1', 'AB', 'low', '2026-01-01', 1)").run();
    old.prepare("INSERT INTO read_sessions (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json) VALUES (1, 'p', 'new', 1, 1, 1, '[]', '[]', '{}')").run();
    old.close();
    fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('fresh database has every management column and table', () => {
  const db = openDb(':memory:');
  assert.ok(cols(db, 'users').includes('last_login_at'));
  assert.ok(cols(db, 'invites').includes('id'));
  assert.ok(cols(db, 'children').includes('group_name'));
  assert.ok(cols(db, 'children').includes('note'));
  assert.ok(cols(db, 'read_sessions').includes('note'));
  assert.deepEqual(cols(db, 'password_resets'), ['id', 'user_id', 'token_hash', 'created_at', 'expires_at', 'used_at']);
  assert.deepEqual(cols(db, 'audit_log'), ['id', 'at', 'actor_user_id', 'action', 'target', 'detail']);
  db.close();
});

test('old-schema database: every column and table is added, data is kept, a second open is a no-op', () => {
  withOldDb((file) => {
    const db = openDb(file);
    assert.ok(cols(db, 'users').includes('last_login_at'));
    assert.equal(db.prepare('SELECT last_login_at FROM users').get().last_login_at, null);
    assert.ok(cols(db, 'children').includes('group_name'));
    assert.ok(cols(db, 'children').includes('note'));
    assert.deepEqual({ ...db.prepare('SELECT code, group_name, note FROM children').get() }, { code: 'C1', group_name: null, note: null });
    assert.ok(cols(db, 'read_sessions').includes('note'));
    assert.equal(db.prepare('SELECT note FROM read_sessions').get().note, null);

    // Existing invites get distinct ids; the token column is untouched.
    const invites = db.prepare('SELECT id, token FROM invites ORDER BY token').all();
    assert.deepEqual(invites.map((i) => i.token), ['tok-a', 'tok-b']);
    assert.ok(invites.every((i) => Number.isInteger(i.id)));
    assert.equal(new Set(invites.map((i) => i.id)).size, 2);

    // password_resets and audit_log are usable.
    db.prepare('INSERT INTO password_resets (user_id, token_hash, created_at, expires_at) VALUES (1, ?, 1, 2)').run('h');
    db.prepare("INSERT INTO audit_log (at, actor_user_id, action, target) VALUES (1, 1, 'x', 'y')").run();
    db.close();

    const again = openDb(file);
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n, 1);
    assert.deepEqual(again.prepare('SELECT id FROM invites ORDER BY id').all().map((i) => i.id), invites.map((i) => i.id).sort((a, b) => a - b));
    again.close();
  });
});

test('new invites get an id above every existing one', () => {
  withOldDb((file) => {
    const db = openDb(file);
    const before = db.prepare('SELECT MAX(id) AS m FROM invites').get().m;
    db.prepare('INSERT INTO invites (id, token, email, expires_at) VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM invites), ?, ?, ?)').run('tok-c', 'c@example.test', 5);
    assert.equal(db.prepare("SELECT id FROM invites WHERE token = 'tok-c'").get().id, before + 1);
    db.close();
  });
});

test('deleting a user keeps the audit rows it acted in, with the actor cleared', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (email, pw_hash, role, created_at) VALUES ('t@example.test', 'h', 'teacher', 1)").run();
  db.prepare("INSERT INTO audit_log (at, actor_user_id, action, target) VALUES (1, 1, 'child.delete', 'child:9')").run();
  db.prepare('DELETE FROM users WHERE id = 1').run();
  assert.deepEqual({ ...db.prepare('SELECT actor_user_id, action FROM audit_log').get() }, { actor_user_id: null, action: 'child.delete' });
  db.close();
});
