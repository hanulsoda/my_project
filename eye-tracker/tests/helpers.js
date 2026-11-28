'use strict';
// Shared test harness: temp DB, app on an ephemeral port, controllable clock.
process.env.NODE_ENV = 'test';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/auth');

const TEST_PASSWORD = 'correct horse battery';
let userCounter = 0;

async function startTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eye-tracker-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  const clock = { t: Date.now(), advance(ms) { this.t += ms; } };
  const app = createApp({ db, now: () => clock.t });
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

  return { url, db, clock, close, loginAs };
}

module.exports = { startTestServer, TEST_PASSWORD };
