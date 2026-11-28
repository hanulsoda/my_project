'use strict';
const { startTestServer } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword } = require('../server/auth');
const { createLoginLimiter } = require('../server/login-limiter');

const MIN = 60 * 1000;

const login = (srv, email, password) => fetch(`${srv.url}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

async function addUser(srv, email, password) {
  srv.db.prepare("INSERT INTO users (email, pw_hash, role, created_at) VALUES (?, ?, 'teacher', ?)")
    .run(email, await hashPassword(password), srv.clock.t);
}

async function fail(srv, email, n) {
  for (let i = 0; i < n; i++) assert.equal((await login(srv, email, 'wrong-password')).status, 401, `failure ${i + 1}`);
}

test('login rate limit', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  await addUser(srv, 'a@example.test', 'right-password');
  await addUser(srv, 'b@example.test', 'right-password');
  await addUser(srv, 'c@example.test', 'right-password');

  await t.test('10 failures, then 429 with Retry-After and an error body', async () => {
    await fail(srv, 'a@example.test', 10);
    const res = await login(srv, 'a@example.test', 'wrong-password');
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'too_many_attempts' });
    const retry = Number(res.headers.get('retry-after'));
    assert.ok(Number.isInteger(retry) && retry > 0 && retry <= 15 * 60, `Retry-After ${retry}`);
  });

  await t.test('the correct password during lockout is still 429 (checked before scrypt) and sets no cookie', async () => {
    const res = await login(srv, 'a@example.test', 'right-password');
    assert.equal(res.status, 429);
    assert.equal(res.headers.getSetCookie().length, 0);
  });

  await t.test('the key is the normalized email', async () => {
    assert.equal((await login(srv, '  A@Example.TEST ', 'right-password')).status, 429);
  });

  await t.test('a different email is unaffected', async () => {
    assert.equal((await login(srv, 'b@example.test', 'right-password')).status, 200);
  });

  await t.test('Retry-After counts down and the lock lifts when the 15-minute window passes', async () => {
    srv.clock.advance(14 * MIN);
    const still = await login(srv, 'a@example.test', 'right-password');
    assert.equal(still.status, 429);
    assert.ok(Number(still.headers.get('retry-after')) <= 60);
    srv.clock.advance(1 * MIN + 1);
    assert.equal((await login(srv, 'a@example.test', 'right-password')).status, 200);
  });

  await t.test('success clears the counter, so failures start from zero again', async () => {
    await fail(srv, 'c@example.test', 9);
    assert.equal((await login(srv, 'c@example.test', 'right-password')).status, 200);
    await fail(srv, 'c@example.test', 9); // would be 18 without the reset
    assert.equal((await login(srv, 'c@example.test', 'right-password')).status, 200);
  });

  await t.test('failures older than the window do not add up', async () => {
    await fail(srv, 'c@example.test', 9);
    srv.clock.advance(16 * MIN);
    await fail(srv, 'c@example.test', 9);
    assert.equal((await login(srv, 'c@example.test', 'right-password')).status, 200);
  });

  await t.test('an unknown email is counted the same way, with the same bodies', async () => {
    const first = await login(srv, 'ghost@example.test', 'whatever-123');
    assert.equal(first.status, 401);
    const known = await login(srv, 'b@example.test', 'whatever-123');
    assert.equal(await first.text(), await known.text(), '401 bodies stay identical');
    await fail(srv, 'ghost@example.test', 8); // 9 so far
    assert.equal((await login(srv, 'ghost@example.test', 'whatever-123')).status, 401); // the 10th
    const locked = await login(srv, 'ghost@example.test', 'whatever-123');
    assert.equal(locked.status, 429);
    assert.deepEqual(await locked.json(), { error: 'too_many_attempts' });
  });

  await t.test('a disabled account counts like any other wrong attempt', async () => {
    srv.db.prepare("UPDATE users SET disabled_at = 1 WHERE email = 'b@example.test'").run();
    assert.equal((await login(srv, 'b@example.test', 'right-password')).status, 401);
  });
});

test('createLoginLimiter: bounded size, lazy purge, oldest dropped first', () => {
  let t = 0;
  const lim = createLoginLimiter({ now: () => t, max: 3, windowMs: 1000, cap: 4 });
  for (const k of ['k1', 'k2', 'k3', 'k4']) lim.recordFailure(k);
  assert.equal(lim.size(), 4);
  lim.recordFailure('k5'); // over cap, nothing expired: the oldest (k1) goes
  assert.equal(lim.size(), 4);
  assert.equal(lim.check('k1').blocked, false);
  for (let i = 0; i < 2; i++) lim.recordFailure('k5');
  assert.equal(lim.check('k5').blocked, true);
  t = 1500; // everything expired; the next insert purges them
  lim.recordFailure('fresh');
  assert.equal(lim.size(), 1);
  assert.equal(lim.check('k5').blocked, false);
});

test('createLoginLimiter: a long run of distinct emails never grows past the cap', () => {
  const lim = createLoginLimiter({ now: () => 0, cap: 10_000 });
  for (let i = 0; i < 25_000; i++) lim.recordFailure(`user${i}@example.test`);
  assert.equal(lim.size(), 10_000);
});
