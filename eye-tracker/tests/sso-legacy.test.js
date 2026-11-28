'use strict';
// Separate logins are gone: password login, invites and reset links answer 404 unless the
// break-glass flag ALLOW_PASSWORD_LOGIN=1 is set (the other test files run with it on).
const { startTestServer } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('../server/auth');
const { loadConfig } = require('../server/config');
const { TEST_ACADEMY_URL } = require('./sso-helpers');

const PUBLIC = path.join(__dirname, '..', 'public');

function call(srv, method, p, cookie, body) {
  return fetch(srv.url + p, {
    method,
    redirect: 'manual',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function rawGet(baseUrl, rawPath) {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: u.port, path: rawPath }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

const LEGACY = [
  ['POST', '/api/login', { email: 'a@example.test', password: 'whatever-123' }],
  ['POST', '/API/LOGIN', { email: 'a@example.test', password: 'whatever-123' }],
  ['POST', '/api/invites/sometoken/accept', { password: 'whatever-123' }],
  ['POST', '/api/password-reset/sometoken', { password: 'whatever-123' }],
  ['GET', '/api/admin/invites'],
  ['POST', '/api/admin/invites', { email: 'x@example.test' }],
  ['DELETE', '/api/admin/invites/1'],
  ['POST', '/api/admin/teachers/1/reset-link'],
  ['GET', '/invite.html'],
  ['GET', '/login.html'],
  ['GET', '/reset.html'],
  ['GET', '/js/invite.js'],
  ['GET', '/js/login.js'],
];

test('ALLOW_PASSWORD_LOGIN off: every legacy flow is 404, for anyone', async (t) => {
  const srv = await startTestServer({ config: { allowPasswordLogin: false } });
  t.after(srv.close);
  srv.db.prepare("INSERT INTO users (email, pw_hash, role, created_at) VALUES ('a@example.test', ?, 'admin', 1)")
    .run(await hashPassword('whatever-123'));
  const director = await srv.ssoAs('director', 'admin');

  for (const [method, p, body] of LEGACY) {
    await t.test(`${method} ${p}`, async () => {
      for (const cookie of [null, director]) {
        const res = await call(srv, method, p, cookie, body);
        assert.equal(res.status, 404, `${cookie ? 'director' : 'anonymous'}`);
        assert.equal(res.headers.getSetCookie().length, 0);
        await res.arrayBuffer();
      }
    });
  }

  await t.test('encoded spellings of the legacy pages are 404 too', async () => {
    for (const raw of ['/invite%2ehtml', '/%69nvite.html', '/js/invite%2Ejs', '/INVITE.HTML']) {
      assert.equal(await rawGet(srv.url, raw), 404, raw);
    }
  });

  await t.test('the rest of the admin API keeps working: list and disable SSO accounts', async () => {
    await srv.ssoAs('teacher', '9');
    const list = await (await call(srv, 'GET', '/api/admin/teachers', director)).json();
    const t9 = list.find((u) => u.externalId === 'teacher:9');
    assert.ok(t9);
    assert.equal((await call(srv, 'POST', `/api/admin/teachers/${t9.id}/disable`, director)).status, 200);
    assert.equal((await srv.ssoEnter({ role: 'teacher', uid: '9' })).res.status, 403, 'disable blocks /sso');
  });

  await t.test('/api/me says password login is off', async () => {
    assert.equal((await (await call(srv, 'GET', '/api/me', director)).json()).passwordLogin, false);
  });
});

test('ALLOW_PASSWORD_LOGIN on: the legacy routes exist again', async (t) => {
  const srv = await startTestServer({ config: { allowPasswordLogin: true } });
  t.after(srv.close);
  for (const p of ['/login.html', '/invite.html', '/js/login.js', '/js/invite.js']) {
    assert.equal((await call(srv, 'GET', p)).status, 200, p);
  }
  assert.equal((await call(srv, 'POST', '/api/login', null, { email: 'nobody@example.test', password: 'x' })).status, 401);
  assert.equal((await call(srv, 'POST', '/api/invites/nope/accept', null, { password: 'x' })).status, 404, 'unknown invite (the route answers)');
  const admin = await srv.loginAs('admin');
  assert.equal((await call(srv, 'GET', '/api/admin/invites', admin)).status, 200);
});

test('front door: a calm notice that sends people to the academy site', async (t) => {
  const srv = await startTestServer({ config: { allowPasswordLogin: false } });
  t.after(srv.close);

  await t.test('index.html has no form and no login script, and links to /academy', async () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<form|<input|login\.js|password/i);
    assert.match(html, /href="\/academy"/);
    assert.equal((await call(srv, 'GET', '/')).status, 200);
  });

  await t.test('/academy redirects to ACADEMY_URL with no-store', async () => {
    const res = await call(srv, 'GET', '/academy');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), TEST_ACADEMY_URL);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  await t.test('logout clears the cookie and points the UI at /academy', async () => {
    const cookie = await srv.ssoAs('teacher', '3');
    const res = await call(srv, 'POST', '/api/logout', cookie, {});
    assert.deepEqual(await res.json(), { ok: true, next: '/academy' });
    assert.match(res.headers.getSetCookie()[0], /^sid=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    assert.equal((await call(srv, 'GET', '/api/me', cookie)).status, 401);
  });
});

test('/academy without ACADEMY_URL: the friendly page, no redirect', async (t) => {
  const srv = await startTestServer({ config: { academyUrl: null } });
  t.after(srv.close);
  const res = await call(srv, 'GET', '/academy');
  assert.equal(res.status, 503);
  assert.match(await res.text(), /다힘 사이트에서 다시 들어와 주세요/);
});

test('loadConfig: env parsing', () => {
  const long = 'x'.repeat(32);
  assert.deepEqual(loadConfig({}), { ssoSecret: null, ssoSecretTooShort: false, academyUrl: null, allowPasswordLogin: false });
  assert.equal(loadConfig({ SSO_SECRET: `  ${long}\n` }).ssoSecret, long, 'trimmed like the academy side');
  assert.equal(loadConfig({ SSO_SECRET: 'x'.repeat(31) }).ssoSecret, null, 'too short: SSO off');
  assert.equal(loadConfig({ SSO_SECRET: 'x'.repeat(31) }).ssoSecretTooShort, true);
  const example = require('node:fs').readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8').match(/^SSO_SECRET=(.*)$/m)[1];
  assert.ok(example.length >= 32);
  assert.equal(loadConfig({ SSO_SECRET: example }).ssoSecret, null, 'the .env.example placeholder never turns SSO on');
  assert.equal(loadConfig({ ALLOW_PASSWORD_LOGIN: require('node:fs').readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8').match(/^ALLOW_PASSWORD_LOGIN=(.*)$/m)[1] }).allowPasswordLogin, false, '.env.example keeps the break-glass off');
  assert.equal(loadConfig({ ACADEMY_URL: 'https://dahim.example/' }).academyUrl, 'https://dahim.example/');
  for (const bad of ['javascript:alert(1)', 'ftp://x', 'not a url', 'https://user:pw@x.example/']) {
    assert.equal(loadConfig({ ACADEMY_URL: bad }).academyUrl, null, bad);
  }
  for (const [v, want] of [['1', true], ['0', false], ['true', false], ['', false], [undefined, false]]) {
    assert.equal(loadConfig({ ALLOW_PASSWORD_LOGIN: v }).allowPasswordLogin, want, String(v));
  }
});

test('bootstrap: the first admin from ADMIN_EMAIL/ADMIN_PASSWORD only with ALLOW_PASSWORD_LOGIN=1', async () => {
  const { openDb } = require('../server/db');
  const { bootstrap } = require('../server/index');
  const env = { ADMIN_EMAIL: 'boss@example.test', ADMIN_PASSWORD: 'long-enough-password', SSO_SECRET: 'SECRET-VALUE-'.repeat(4) };
  const lines = [];
  const log = { log: (m) => lines.push(m), warn: (m) => lines.push(m) };
  const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

  const off = openDb(':memory:');
  assert.equal(await bootstrap(off, loadConfig(env), env, log), false);
  assert.equal(count(off), 0, 'flag off: no password account is made');
  off.close();

  const on = openDb(':memory:');
  assert.equal(await bootstrap(on, loadConfig({ ...env, ALLOW_PASSWORD_LOGIN: '1' }), env, log), true);
  assert.equal(on.prepare('SELECT role FROM users').get().role, 'admin');
  on.close();
  assert.ok(lines.every((l) => !l.includes('SECRET-VALUE') && !l.includes('long-enough-password')), 'never logs a secret');

  const warned = [];
  await bootstrap(openDb(':memory:'), loadConfig({}), {}, { log() {}, warn: (m) => warned.push(m) });
  assert.ok(warned.some((m) => /SSO_SECRET is not set/.test(m)));
  assert.ok(warned.some((m) => /ACADEMY_URL/.test(m)));
});
