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
  disabled_at INTEGER,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS invites (
  token      TEXT PRIMARY KEY,
  id         INTEGER,
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
  created_at   INTEGER NOT NULL,
  group_name   TEXT,
  note         TEXT
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
  metrics_json TEXT NOT NULL,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS read_sessions_child ON read_sessions(child_id);
CREATE TABLE IF NOT EXISTS share_links (
  token      TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES read_sessions(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS share_links_session ON share_links(session_id);
CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  target        TEXT NOT NULL,
  detail        TEXT
);
`;

// Idempotent upgrades for databases created by an older schema (CREATE TABLE IF NOT EXISTS
// leaves an existing table untouched).
function migrate(db) {
  const addColumn = (table, column, type) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn('users', 'disabled_at', 'INTEGER');
  addColumn('users', 'last_login_at', 'INTEGER');
  addColumn('children', 'group_name', 'TEXT');
  addColumn('children', 'note', 'TEXT');
  addColumn('read_sessions', 'note', 'TEXT');
  // invites predate the id handle (the token must never be exposed): number the old rows by rowid.
  addColumn('invites', 'id', 'INTEGER');
  db.exec('UPDATE invites SET id = rowid WHERE id IS NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS invites_id ON invites(id)');
  addColumn('password_resets', 'created_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');

  // One child code per teacher, ignoring case and surrounding spaces. If rows already collide
  // that way the index cannot be built: leave the data alone, warn, and start anyway (the exact
  // children_teacher_code index still applies; the API trims codes on write).
  const ci = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'children_teacher_code_ci'").get();
  if (!ci) {
    const clash = db.prepare('SELECT 1 FROM children GROUP BY teacher_id, lower(trim(code)) HAVING COUNT(*) > 1 LIMIT 1').get();
    if (clash) {
      console.warn('[db] children_teacher_code_ci not created: some teacher already has child codes that differ only by case or spaces; fix them and restart');
    } else {
      db.exec('CREATE UNIQUE INDEX children_teacher_code_ci ON children(teacher_id, lower(trim(code)))');
    }
  }
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
