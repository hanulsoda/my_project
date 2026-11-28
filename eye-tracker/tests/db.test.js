'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../server/db');

test('schema enforces foreign keys with ON DELETE CASCADE', () => {
  const db = openDb(':memory:');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

  const user = db.prepare("INSERT INTO users (email, pw_hash, role, created_at) VALUES ('t@example.test', 'h', 'teacher', 1)").run();
  db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run('s1', user.lastInsertRowid, 99);
  const child = db.prepare("INSERT INTO children (teacher_id, code, initials, grade_band, consent_date, created_at) VALUES (?, 'C1', 'AB', 'low', '2026-01-01', 1)").run(user.lastInsertRowid);
  const rs = db.prepare("INSERT INTO read_sessions (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json) VALUES (?, 'p1', 'new', 1, 1280, 720, '[]', '[]', '{}')").run(child.lastInsertRowid);
  db.prepare('INSERT INTO share_links (token, session_id, expires_at) VALUES (?, ?, ?)').run('sh1', rs.lastInsertRowid, 99);

  assert.throws(() => db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run('s2', 9999, 99), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO users (email, pw_hash, role, created_at) VALUES ('x@example.test', 'h', 'root', 1)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO read_sessions (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json) VALUES (?, 'p', 'bogus', 1, 1, 1, '[]', '[]', '{}')").run(child.lastInsertRowid), /CHECK/);

  db.prepare('DELETE FROM users WHERE id = ?').run(user.lastInsertRowid);
  for (const table of ['auth_sessions', 'children', 'read_sessions', 'share_links']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} cascaded`);
  }
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

function tmpDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-tracker-db-'));
  return { dir, file: path.join(dir, 'app.db') };
}

test('secure_delete is ON so a deleted child leaves no readable payload in the file', () => {
  const { dir, file } = tmpDbFile();
  try {
    const marker = 'DISTINCTIVE-PAYLOAD-7f3a9c1e';
    const db = openDb(file);
    assert.equal(db.pragma('secure_delete', { simple: true }), 1);
    const user = db.prepare("INSERT INTO users (email, pw_hash, role, created_at) VALUES ('t@example.test', 'h', 'teacher', 1)").run();
    const child = db.prepare("INSERT INTO children (teacher_id, code, initials, grade_band, consent_date, created_at) VALUES (?, 'C1', 'AB', 'low', '2026-01-01', 1)").run(user.lastInsertRowid);
    const payload = JSON.stringify([{ t: 0, x: 1, y: 2, note: marker }]).padEnd(20000, ' ');
    db.prepare("INSERT INTO read_sessions (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json) VALUES (?, 'p1', 'new', 1, 1280, 720, '[]', ?, '{}')")
      .run(child.lastInsertRowid, payload);
    db.pragma('wal_checkpoint(TRUNCATE)');
    assert.ok(fs.readFileSync(file).includes(marker), 'precondition: the payload is in the file before delete');

    db.prepare('DELETE FROM children WHERE id = ?').run(child.lastInsertRowid);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    assert.ok(!fs.readFileSync(file).includes(marker), 'payload must be overwritten in the main file');
    for (const side of [`${file}-wal`, `${file}-shm`]) {
      if (fs.existsSync(side)) assert.ok(!fs.readFileSync(side).includes(marker), `${side} must not hold it`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('users.disabled_at exists on a fresh database', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('disabled_at'));
  db.close();
});

test('openDb migrates a database created with the old users schema and keeps its data', () => {
  const { dir, file } = tmpDbFile();
  try {
    const old = new Database(file);
    old.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, pw_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'teacher')), created_at INTEGER NOT NULL);`);
    old.prepare("INSERT INTO users (email, pw_hash, role, created_at) VALUES ('old@example.test', 'scrypt$a$b', 'teacher', 5)").run();
    old.close();

    const db = openDb(file);
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    assert.ok(cols.includes('disabled_at'), 'column added');
    const row = db.prepare("SELECT email, pw_hash, role, created_at, disabled_at FROM users WHERE email = 'old@example.test'").get();
    assert.deepEqual({ ...row }, { email: 'old@example.test', pw_hash: 'scrypt$a$b', role: 'teacher', created_at: 5, disabled_at: null });
    db.close();
    openDb(file).close(); // running the migration again is a no-op
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
