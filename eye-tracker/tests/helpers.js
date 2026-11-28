'use strict';
// Shared test harness: temp DB, app on an ephemeral port, controllable clock.
process.env.NODE_ENV = 'test';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/auth');
const { TEST_SSO_SECRET, TEST_ACADEMY_URL, makePayload, signToken } = require('./sso-helpers');

const TEST_PASSWORD = 'correct horse battery';
let userCounter = 0;

// config: the server's env-derived settings. The harness turns the password-login break-glass ON by
// default so the password, invite and reset tests keep exercising those flows; SSO tests that need
// it off pass { allowPasswordLogin: false }.
async function startTestServer({ config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-tracker-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  const clock = { t: Date.now(), advance(ms) { this.t += ms; } };
  const cfg = { ssoSecret: TEST_SSO_SECRET, academyUrl: TEST_ACADEMY_URL, allowPasswordLogin: true, ...config };
  const app = createApp({ db, now: () => clock.t, config: cfg });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Creates a user with the given role directly in the DB, logs in, returns the "sid=..." cookie.
  async function loginAs(role) {
    const email = `${role}-${++userCounter}@example.test`;
    db.prepare('INSERT INTO users (email, pw_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run(email, await hashPassword(TEST_PASSWORD), role, clock.t);
    const res = await fetch(`${url}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: TEST_PASSWORD }),
    });
    if (res.status !== 200) throw new Error(`loginAs(${role}) failed: ${res.status}`);
    return res.headers.getSetCookie()[0].split(';')[0];
  }

  // Enters through /sso with a freshly signed token (payload fields override a valid teacher token).
  // Returns the raw response, the token and the "sid=..." cookie (null when none was set).
  async function ssoEnter(fields = {}, { next, cookie, token: given } = {}) {
    const token = given ?? signToken(makePayload(fields, clock.t));
    const qs = new URLSearchParams({ t: token });
    if (next !== undefined) qs.set('next', next);
    const res = await fetch(`${url}/sso?${qs}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    const set = res.headers.getSetCookie();
    return { res, token, cookie: set.length ? set[0].split(';')[0] : null };
  }

  // role: 'director' | 'teacher' | 'student'; returns the session cookie or throws.
  async function ssoAs(role, uid, sid = '') {
    const r = await ssoEnter({ role, uid, sid: role === 'student' ? uid : sid });
    if (r.res.status !== 302 || !r.cookie) throw new Error(`ssoAs(${role}) failed: ${r.res.status}`);
    return r.cookie;
  }

  return { url, db, clock, close, loginAs, ssoEnter, ssoAs };
}

module.exports = { startTestServer, TEST_PASSWORD };
