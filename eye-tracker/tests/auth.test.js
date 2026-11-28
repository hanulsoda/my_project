'use strict';
const { startTestServer, TEST_PASSWORD } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, ensureFirstAdmin } = require('../server/auth');

const DAY = 24 * 60 * 60 * 1000;

function post(srv, path, body, cookie) {
  return fetch(srv.url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

function get(srv, path, cookie) {
  return fetch(srv.url + path, { headers: cookie ? { cookie } : {} });
}

async function addUser(srv, email, password, role = 'teacher') {
  srv.db.prepare('INSERT INTO users (email, pw_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(email, await hashPassword(password), role, srv.clock.t);
}

test('login', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  await addUser(srv, 'kim@example.test', 'pa55word-ok');

  await t.test('correct credentials: 200, sid cookie, no secrets in body', async () => {
    const res = await post(srv, '/api/login', { email: 'kim@example.test', password: 'pa55word-ok' });
    assert.equal(res.status, 200);
    const cookie = res.headers.getSetCookie()[0];
    assert.match(cookie, /^sid=[0-9a-f]{64};/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /Secure/, 'Secure omitted when NODE_ENV=test');
    const text = await res.text();
    assert.doesNotMatch(text, /pw_hash|pa55word|scrypt/);
    assert.equal(JSON.parse(text).email, 'kim@example.test');
  });

  await t.test('email is case-insensitive', async () => {
    const res = await post(srv, '/api/login', { email: ' KIM@Example.test ', password: 'pa55word-ok' });
    assert.equal(res.status, 200);
  });

  await t.test('wrong password: 401 and no cookie', async () => {
    const res = await post(srv, '/api/login', { email: 'kim@example.test', password: 'nope' });
    assert.equal(res.status, 401);
    assert.equal(res.headers.getSetCookie().length, 0);
  });

  await t.test('unknown email: 401 with the same body as wrong password', async () => {
    const a = await post(srv, '/api/login', { email: 'kim@example.test', password: 'nope' });
    const b = await post(srv, '/api/login', { email: 'ghost@example.test', password: 'nope' });
    assert.equal(b.status, 401);
    assert.equal(await b.text(), await a.text());
  });

  await t.test('malformed body: 400', async () => {
    const res = await post(srv, '/api/login', { email: 42, password: ['x'] });
    assert.equal(res.status, 400);
  });

  await t.test('Secure flag is set outside NODE_ENV=test', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await post(srv, '/api/login', { email: 'kim@example.test', password: 'pa55word-ok' });
      assert.match(res.headers.getSetCookie()[0], /; Secure/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

test('route guards and sessions', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);

  await t.test('unauthenticated /api/children, /api/sessions, /api/share: 401', async () => {
    for (const p of ['/api/children', '/api/sessions/1', '/api/share/abc']) {
      assert.equal((await get(srv, p)).status, 401, p);
    }
  });

  await t.test('bogus cookie: 401', async () => {
    assert.equal((await get(srv, '/api/children', 'sid=deadbeef')).status, 401);
  });

  await t.test('teacher passes the guard (/api/share has no route yet: 404)', async () => {
    const cookie = await srv.loginAs('teacher');
    assert.equal((await get(srv, '/api/share/x', cookie)).status, 404);
  });

  await t.test('logout invalidates the session', async () => {
    const cookie = await srv.loginAs('teacher');
    const out = await post(srv, '/api/logout', {}, cookie);
    assert.equal(out.status, 200);
    assert.match(out.headers.getSetCookie()[0], /^sid=;.*Max-Age=0/);
    assert.equal((await get(srv, '/api/children', cookie)).status, 401);
  });

  await t.test('session expires after 7 days (injected clock)', async () => {
    const cookie = await srv.loginAs('teacher');
    srv.clock.advance(6 * DAY);
    assert.equal((await get(srv, '/api/share/x', cookie)).status, 404);
    srv.clock.advance(2 * DAY);
    assert.equal((await get(srv, '/api/children', cookie)).status, 401);
  });
});

test('admin invites', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);

  await t.test('unauthenticated: 401; teacher: 403', async () => {
    assert.equal((await post(srv, '/api/admin/invites', { email: 'a@example.test' })).status, 401);
    const teacher = await srv.loginAs('teacher');
    assert.equal((await post(srv, '/api/admin/invites', { email: 'a@example.test' }, teacher)).status, 403);
  });

  await t.test('admin creates an invite; invalid email: 400', async () => {
    const admin = await srv.loginAs('admin');
    const bad = await post(srv, '/api/admin/invites', { email: 'not-an-email' }, admin);
    assert.equal(bad.status, 400);
    const res = await post(srv, '/api/admin/invites', { email: 'new@example.test' }, admin);
    assert.equal(res.status, 200);
    const { token } = await res.json();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  });

  await t.test('invite for an existing account: 409', async () => {
    const admin = await srv.loginAs('admin');
    await addUser(srv, 'dup@example.test', 'whatever-pw');
    const res = await post(srv, '/api/admin/invites', { email: 'dup@example.test' }, admin);
    assert.equal(res.status, 409);
  });

  await t.test('accepted invite creates a teacher who can log in; token is single-use', async () => {
    const admin = await srv.loginAs('admin');
    const { token } = await (await post(srv, '/api/admin/invites', { email: 'Teacher@Example.test' }, admin)).json();

    const accept = await post(srv, `/api/invites/${token}/accept`, { password: 'my-new-password' });
    assert.equal(accept.status, 201);
    assert.doesNotMatch(await accept.text(), /pw_hash|my-new-password|scrypt/);

    const login = await post(srv, '/api/login', { email: 'teacher@example.test', password: 'my-new-password' });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).role, 'teacher');

    const again = await post(srv, `/api/invites/${token}/accept`, { password: 'another-password' });
    assert.equal(again.status, 410);
  });

  await t.test('expired invite: 410 (invite lasts 7 days)', async () => {
    const admin = await srv.loginAs('admin');
    const { token } = await (await post(srv, '/api/admin/invites', { email: 'late@example.test' }, admin)).json();
    srv.clock.advance(7 * DAY + 1);
    const res = await post(srv, `/api/invites/${token}/accept`, { password: 'my-new-password' });
    assert.equal(res.status, 410);
    assert.equal(srv.db.prepare('SELECT 1 FROM users WHERE email = ?').get('late@example.test'), undefined);
  });

  await t.test('unknown token: 404; short password: 400 and invite stays usable', async () => {
    const admin = await srv.loginAs('admin');
    assert.equal((await post(srv, '/api/invites/nope/accept', { password: 'my-new-password' })).status, 404);
    const { token } = await (await post(srv, '/api/admin/invites', { email: 'short@example.test' }, admin)).json();
    assert.equal((await post(srv, `/api/invites/${token}/accept`, { password: 'short' })).status, 400);
    assert.equal((await post(srv, `/api/invites/${token}/accept`, { password: 'long-enough-pw' })).status, 201);
  });
});

test('ensureFirstAdmin creates an admin only when no users exist', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const opts = { email: 'Boss@Example.test', password: TEST_PASSWORD, now: () => srv.clock.t };

  assert.equal(await ensureFirstAdmin(srv.db, opts), true);
  const row = srv.db.prepare('SELECT email, role FROM users').get();
  assert.deepEqual({ ...row }, { email: 'boss@example.test', role: 'admin' });
  const login = await post(srv, '/api/login', { email: 'boss@example.test', password: TEST_PASSWORD });
  assert.equal(login.status, 200);

  assert.equal(await ensureFirstAdmin(srv.db, { ...opts, email: 'other@example.test' }), false);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(await ensureFirstAdmin(srv.db, { ...opts, email: undefined }), false);
});

test('verifyPassword', async (t) => {
  await t.test('accepts the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('pa55word-ok');
    assert.equal(await verifyPassword('pa55word-ok', stored), true);
    assert.equal(await verifyPassword('pa55word-no', stored), false);
  });

  await t.test('rejects every password when the stored hash is malformed', async () => {
    const [, salt, key] = (await hashPassword('pa55word-ok')).split('$');
    const malformed = [
      'scrypt$00$zz', 'scrypt$zz$zz', `scrypt$$${key}`, `scrypt$${salt}$`, `scrypt$${salt}$${key.slice(2)}`,
      `scrypt$${salt}$${key}00`, `scrypt$zz$${key}`, 'bcrypt$00$00', 'garbage', '', null, undefined,
    ];
    for (const stored of malformed) {
      assert.equal(await verifyPassword('anything', stored), false, String(stored));
      assert.equal(await verifyPassword('pa55word-ok', stored), false, String(stored));
    }
  });
});
