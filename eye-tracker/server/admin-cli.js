'use strict';
// Operator CLI for account upkeep (there is no web UI for this):
//   node server/admin-cli.js set-password <email>   new password on STDIN (never argv)
//   node server/admin-cli.js disable <email>        account can no longer log in; data is kept
//   node server/admin-cli.js enable <email>
//   node server/admin-cli.js list                   email, role, disabled (never hashes)
// Opens the database from DB_PATH like server/index.js.
const { openDb } = require('./db');
const { hashPassword, normEmail, isValidPassword, MIN_PASSWORD_LEN, MAX_PASSWORD_LEN } = require('./auth');

const fail = (message) => Object.assign(new Error(message), { cliError: true });

function findUser(db, email) {
  const norm = normEmail(email);
  const user = norm ? db.prepare('SELECT id, email, role, disabled_at FROM users WHERE email = ?').get(norm) : undefined;
  if (!user) throw fail(`no user with email ${norm || '(empty)'}`);
  return user;
}

async function setPassword(db, email, password) {
  const user = findUser(db, email);
  if (!isValidPassword(password)) throw fail(`password must be ${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN} characters`);
  const hash = await hashPassword(password);
  db.transaction(() => {
    db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hash, user.id);
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id); // old logins must not survive a reset
  })();
}

function disableUser(db, email, { now = Date.now } = {}) {
  const user = findUser(db, email);
  if (user.role === 'admin' && user.disabled_at === null) {
    const others = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id != ?").get(user.id).n;
    if (others === 0) throw fail('refusing to disable the last admin: nobody could log in to manage accounts');
  }
  db.transaction(() => {
    db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(now(), user.id);
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id);
  })();
}

function enableUser(db, email) {
  const user = findUser(db, email);
  db.prepare('UPDATE users SET disabled_at = NULL WHERE id = ?').run(user.id);
}

function listUsers(db) {
  return db.prepare('SELECT email, role, disabled_at FROM users ORDER BY id').all()
    .map((u) => ({ email: u.email, role: u.role, disabled: u.disabled_at === null ? 'no' : 'yes' }));
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

const USAGE = 'usage: node server/admin-cli.js <set-password|disable|enable> <email> | list\n'
  + '  set-password reads the new password from stdin, e.g. printf %s "$PW" | node server/admin-cli.js set-password a@b.kr';

async function main(argv) {
  const [cmd, email] = argv;
  if (cmd === 'list' && argv.length === 1) {
    const db = openDb(process.env.DB_PATH || 'data/app.db');
    for (const u of listUsers(db)) console.log(`${u.email}\t${u.role}\t${u.disabled}`);
    return;
  }
  if (!['set-password', 'disable', 'enable'].includes(cmd) || !email || argv.length !== 2) throw fail(USAGE);
  let password;
  if (cmd === 'set-password') {
    if (process.stdin.isTTY) throw fail('pipe the new password on stdin (it must not be typed as an argument)\n' + USAGE);
    password = await readStdin();
  }
  const db = openDb(process.env.DB_PATH || 'data/app.db');
  if (cmd === 'set-password') {
    await setPassword(db, email, password);
    console.log(`password updated for ${normEmail(email)}; existing logins were ended`);
  } else if (cmd === 'disable') {
    disableUser(db, email);
    console.log(`disabled ${normEmail(email)}; their data is kept`);
  } else {
    enableUser(db, email);
    console.log(`enabled ${normEmail(email)}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      console.error(err.cliError ? err.message : err);
      process.exit(1);
    },
  );
}

module.exports = { setPassword, disableUser, enableUser, listUsers };
