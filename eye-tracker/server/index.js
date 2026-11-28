'use strict';
const { openDb } = require('./db');
const { createApp } = require('./app');
const { ensureFirstAdmin } = require('./auth');
const { loadConfig } = require('./config');

// Start-up checks and the break-glass bootstrap admin. People normally arrive from the academy
// site (/sso); a first admin from ADMIN_EMAIL/ADMIN_PASSWORD is made only with
// ALLOW_PASSWORD_LOGIN=1, since without it nobody could use a password anyway.
// Never prints a secret: only whether each setting is usable.
async function bootstrap(db, config, env, log = console) {
  if (!config.ssoSecret) {
    log.warn(config.ssoSecretTooShort
      ? 'SSO_SECRET is shorter than 32 characters: academy sign-in is OFF (/sso answers 503)'
      : 'SSO_SECRET is not set: academy sign-in is OFF (/sso answers 503)');
  }
  if (!config.academyUrl) log.warn('ACADEMY_URL is not set or not an http(s) URL: the "다힘 사이트로" links have nowhere to go');
  if (!config.allowPasswordLogin) return false;
  log.warn('ALLOW_PASSWORD_LOGIN=1: password login, invites and reset links are ON (break-glass); turn it off again afterwards');
  const created = await ensureFirstAdmin(db, { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD });
  if (created) log.log(`created first admin ${env.ADMIN_EMAIL}`);
  else if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    log.warn('no users yet: set ADMIN_EMAIL and ADMIN_PASSWORD to create the first admin');
  }
  return created;
}

async function main() {
  const db = openDb(process.env.DB_PATH || 'data/app.db');
  const config = loadConfig(process.env);
  await bootstrap(db, config, process.env);
  const port = Number(process.env.PORT) || 3000;
  createApp({ db, config }).listen(port, () => console.log(`listening on :${port}`));
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { bootstrap };
