'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  pw_hash    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'teacher')),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
CREATE TABLE IF NOT EXISTS invites (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS children (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  initials     TEXT NOT NULL,
  grade_band   TEXT NOT NULL,
  consent_date TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS children_teacher ON children(teacher_id);
CREATE UNIQUE INDEX IF NOT EXISTS children_teacher_code ON children(teacher_id, code);
CREATE TABLE IF NOT EXISTS read_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  child_id     INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
  passage_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('reference', 'new')),
  started_at   INTEGER NOT NULL,
  screen_w     INTEGER NOT NULL,
  screen_h     INTEGER NOT NULL,
  words_json   TEXT NOT NULL,
  samples_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS read_sessions_child ON read_sessions(child_id);
CREATE TABLE IF NOT EXISTS share_links (
  token      TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES read_sessions(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS share_links_session ON share_links(session_id);
`;

// Idempotent upgrades for databases created by an older schema (CREATE TABLE IF NOT EXISTS
// leaves an existing table untouched).
function migrate(db) {
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('disabled_at')) db.exec('ALTER TABLE users ADD COLUMN disabled_at INTEGER');
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  // Deleted children's pages are overwritten with zeros, so "영구 삭제" does not leave readable
  // gaze data in the file's free pages.
  db.pragma('secure_delete = ON');
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

module.exports = { openDb };
