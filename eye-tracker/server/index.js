'use strict';
const { openDb } = require('./db');
const { createApp } = require('./app');
const { ensureFirstAdmin } = require('./auth');

async function main() {
  const db = openDb(process.env.DB_PATH || 'data/app.db');
  const created = await ensureFirstAdmin(db, {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  if (created) console.log(`created first admin ${process.env.ADMIN_EMAIL}`);
  else if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    console.warn('no users yet: set ADMIN_EMAIL and ADMIN_PASSWORD to create the first admin');
  }
  const port = Number(process.env.PORT) || 3000;
  createApp({ db }).listen(port, () => console.log(`listening on :${port}`));
}

main().catch((err) => { console.error(err); process.exit(1); });
