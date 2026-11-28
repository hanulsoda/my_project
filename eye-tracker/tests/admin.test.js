'use strict';
const { startTestServer, TEST_PASSWORD } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
const NOT_FOUND_BODY = JSON.stringify({ error: 'not found' });

function call(srv, method, path, cookie, body) {
  return fetch(srv.url + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const login = (srv, email, password) => call(srv, 'POST', '/api/login', null, { email, password });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const idOf = (srv, email) => srv.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const emailOf = (srv, cookie) => srv.db.prepare(
  'SELECT u.email FROM users u JOIN auth_sessions s ON s.user_id = u.id WHERE s.token = ?',
).get(cookie.slice(4)).email;
const auditRows = (srv) => srv.db.prepare('SELECT * FROM audit_log ORDER BY id').all();

// Every text/blob cell of every table, so "the token is nowhere in the database" is one assertion.
function dumpDb(srv) {
  const tables = srv.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
  return tables.map((t) => JSON.stringify(srv.db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

test('last_login_at is set on a successful login only', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const adminCookie = await srv.loginAs('admin');
  const adminEmail = emailOf(srv, adminCookie);
  const loginTime = srv.clock.t;
  assert.equal(srv.db.prepare('SELECT last_login_at FROM users WHERE email = ?').get(adminEmail).last_login_at, loginTime);

  srv.clock.advance(5000);
  assert.equal((await login(srv, adminEmail, 'wrong-password')).status, 401);
  assert.equal(srv.db.prepare('SELECT last_login_at FROM users WHERE email = ?').get(adminEmail).last_login_at, loginTime, 'failed login leaves it');
  assert.equal((await login(srv, adminEmail, TEST_PASSWORD)).status, 200);
  assert.equal(srv.db.prepare('SELECT last_login_at FROM users WHERE email = ?').get(adminEmail).last_login_at, srv.clock.t);
});

test('GET /api/admin/teachers', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const adminCookie = await srv.loginAs('admin');
  const teacherCookie = await srv.loginAs('teacher');
  const teacherEmail = emailOf(srv, teacherCookie);
  const tid = idOf(srv, teacherEmail);
  srv.db.prepare("INSERT INTO children (teacher_id, code, initials, grade_band, consent_date, created_at) VALUES (?, 'A', 'AA', 'low', '', 1), (?, 'B', 'BB', 'low', '', 1)").run(tid, tid);
  const second = await srv.loginAs('teacher'); // never has children
  assert.ok(second);

  await t.test('requires an admin: 401 anonymous, 403 teacher', async () => {
    assert.equal((await call(srv, 'GET', '/api/admin/teachers')).status, 401);
    assert.equal((await call(srv, 'GET', '/api/admin/teachers', teacherCookie)).status, 403);
  });

  await t.test('lists id, email, role, disabled, createdAt, lastLoginAt, childCount and nothing secret', async () => {
    const res = await call(srv, 'GET', '/api/admin/teachers', adminCookie);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.doesNotMatch(text, /pw_hash|scrypt|token|password/i);
    const rows = JSON.parse(text);
    assert.equal(rows.length, 3);
    for (const r of rows) {
      assert.deepEqual(Object.keys(r).sort(), ['childCount', 'createdAt', 'disabled', 'email', 'externalId', 'id', 'lastLoginAt', 'role']);
    }
    const row = rows.find((r) => r.email === teacherEmail);
    assert.equal(row.id, tid);
    assert.equal(row.role, 'teacher');
    assert.equal(row.disabled, false);
    assert.equal(row.childCount, 2);
    assert.equal(typeof row.createdAt, 'number');
    assert.equal(row.lastLoginAt, srv.clock.t);
    assert.equal(rows.find((r) => r.role === 'admin').childCount, 0);
    assert.deepEqual(rows.map((r) => r.id), [...rows.map((r) => r.id)].sort((a, b) => a - b), 'ordered by id');
  });

  await t.test('a user who never logged in has lastLoginAt null', async () => {
    srv.db.prepare("INSERT INTO users (email, pw_hash, role, created_at) VALUES ('never@example.test', 'h', 'teacher', 1)").run();
    const rows = await (await call(srv, 'GET', '/api/admin/teachers', adminCookie)).json();
    assert.equal(rows.find((r) => r.email === 'never@example.test').lastLoginAt, null);
  });
});

test('disable / enable', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const adminCookie = await srv.loginAs('admin');
  const teacherCookie = await srv.loginAs('teacher');
  const teacherEmail = emailOf(srv, teacherCookie);
  const tid = idOf(srv, teacherEmail);
  const childId = srv.db.prepare("INSERT INTO children (teacher_id, code, initials, grade_band, consent_date, created_at) VALUES (?, 'A', 'AA', 'low', '', 1)").run(tid).lastInsertRowid;

  await t.test('admin only; unknown, non-numeric and zero ids are the shared 404', async () => {
    assert.equal((await call(srv, 'POST', `/api/admin/teachers/${tid}/disable`)).status, 401);
    assert.equal((await call(srv, 'POST', `/api/admin/teachers/${tid}/disable`, teacherCookie)).status, 403);
    for (const id of ['999999', 'abc', '0', '1.5']) {
      for (const action of ['disable', 'enable', 'reset-link']) {
        const res = await call(srv, 'POST', `/api/admin/teachers/${id}/${action}`, adminCookie);
        assert.equal(res.status, 404, `${action} ${id}`);
        assert.equal(await res.text(), NOT_FOUND_BODY);
      }
    }
    assert.equal(srv.db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(tid).disabled_at, null);
  });

  await t.test('disable: ends their logins, keeps their children, returns the row', async () => {
    srv.clock.advance(1000);
    const res = await call(srv, 'POST', `/api/admin/teachers/${tid}/disable`, adminCookie);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, tid);
    assert.equal(body.disabled, true);
    assert.ok(!('pw_hash' in body));
    assert.equal(srv.db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(tid).disabled_at, srv.clock.t);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?').get(tid).n, 0);
    assert.equal((await call(srv, 'GET', '/api/children', teacherCookie)).status, 401, 'old cookie is dead');
    assert.equal((await login(srv, teacherEmail, TEST_PASSWORD)).status, 401);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM children WHERE id = ?').get(childId).n, 1, 'children never deleted');
  });

  await t.test('disable is idempotent: the original timestamp stays and no second audit row is written', async () => {
    const before = srv.db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(tid).disabled_at;
    srv.clock.advance(1000);
    const res = await call(srv, 'POST', `/api/admin/teachers/${tid}/disable`, adminCookie);
    assert.equal(res.status, 200);
    assert.equal(srv.db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(tid).disabled_at, before);
    assert.equal(auditRows(srv).filter((r) => r.action === 'teacher.disable').length, 1);
  });

  await t.test('enable: logins work again, idempotent', async () => {
    const res = await call(srv, 'POST', `/api/admin/teachers/${tid}/enable`, adminCookie);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).disabled, false);
    assert.equal((await login(srv, teacherEmail, TEST_PASSWORD)).status, 200);
    assert.equal((await call(srv, 'POST', `/api/admin/teachers/${tid}/enable`, adminCookie)).status, 200);
    assert.equal(auditRows(srv).filter((r) => r.action === 'teacher.enable').length, 1, 'only the real change is logged');
  });

  await t.test('the last enabled admin cannot be disabled (409), a second admin makes it possible', async () => {
    const adminId = idOf(srv, emailOf(srv, adminCookie));
    const res = await call(srv, 'POST', `/api/admin/teachers/${adminId}/disable`, adminCookie);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /last admin/i);
    assert.equal(srv.db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(adminId).disabled_at, null);
    const second = await srv.loginAs('admin');
    const secondId = idOf(srv, emailOf(srv, second));
    assert.equal((await call(srv, 'POST', `/api/admin/teachers/${secondId}/disable`, adminCookie)).status, 200);
    assert.equal((await call(srv, 'POST', `/api/admin/teachers/${adminId}/disable`, adminCookie)).status, 409, 'second is disabled, first is last again');
  });

  await t.test('audit rows name the actor and the user, never more', async () => {
    const adminId = idOf(srv, emailOf(srv, adminCookie));
    const row = auditRows(srv).find((r) => r.action === 'teacher.disable');
    assert.equal(row.actor_user_id, adminId);
    assert.equal(row.target, `user:${tid}`);
  });
});

test('password reset links', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const adminCookie = await srv.loginAs('admin');
  const teacherCookie = await srv.loginAs('teacher');
  const teacherEmail = emailOf(srv, teacherCookie);
  const tid = idOf(srv, teacherEmail);
  const other = await srv.loginAs('teacher');
  const otherId = idOf(srv, emailOf(srv, other));
  const reset = (token, password) => call(srv, 'POST', `/api/password-reset/${token}`, null, { password });
  const makeLink = async (id = tid) => {
    const res = await call(srv, 'POST', `/api/admin/teachers/${id}/reset-link`, adminCookie);
    assert.equal(res.status, 201);
    const body = await res.json();
    return { ...body, token: new URL(body.url, 'http://x').searchParams.get('token') };
  };

  await t.test('admin only', async () => {
    assert.equal((await call(srv, 'POST', `/api/admin/teachers/${tid}/reset-link`)).status, 401);
    assert.equal((await call(srv, 'POST', `/api/admin/teachers/${tid}/reset-link`, teacherCookie)).status, 403);
  });

  let first;
  await t.test('creates a 24 h link; only the sha256 of the token is stored', async () => {
    srv.clock.advance(1000);
    first = await makeLink();
    assert.deepEqual(Object.keys(first).sort(), ['expiresAt', 'token', 'url']);
    assert.match(first.url, /^\/reset\.html\?token=[A-Za-z0-9_-]{32}$/);
    assert.equal(first.expiresAt, srv.clock.t + 24 * HOUR);
    const row = srv.db.prepare('SELECT * FROM password_resets').get();
    assert.equal(row.token_hash, sha256(first.token));
    assert.equal(row.user_id, tid);
    assert.equal(row.expires_at, first.expiresAt);
    assert.equal(row.used_at, null);
    assert.ok(!dumpDb(srv).includes(first.token), 'the token itself is nowhere in the database');
  });

  await t.test('a new link invalidates the earlier unused one (410), and leaves other users alone', async () => {
    const otherLink = await makeLink(otherId);
    const second = await makeLink();
    assert.notEqual(second.token, first.token);
    assert.equal((await reset(first.token, 'brand-new-password')).status, 410);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE used_at IS NULL AND user_id = ?').get(otherId).n, 1);
    first = second;
    assert.ok(otherLink.token);
  });

  await t.test('unknown token 404; a short password 400 and does not burn the link', async () => {
    const res = await reset('does-not-exist', 'brand-new-password');
    assert.equal(res.status, 404);
    assert.equal((await reset(first.token, 'short')).status, 400);
    assert.equal((await reset(first.token, 'x'.repeat(257))).status, 400);
    assert.equal((await call(srv, 'POST', `/api/password-reset/${first.token}`, null, {})).status, 400);
    assert.equal(srv.db.prepare('SELECT used_at FROM password_resets WHERE token_hash = ?').get(sha256(first.token)).used_at, null);
  });

  await t.test('using it sets the password, ends every login, and the link is then spent (410)', async () => {
    const res = await reset(first.token, 'brand-new-password');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.doesNotMatch(text, /pw_hash|scrypt|token|@/);
    assert.equal((await login(srv, teacherEmail, TEST_PASSWORD)).status, 401, 'old password dead');
    assert.equal((await login(srv, teacherEmail, 'brand-new-password')).status, 200);
    assert.equal(srv.db.prepare('SELECT used_at FROM password_resets WHERE token_hash = ?').get(sha256(first.token)).used_at, srv.clock.t);
    assert.equal((await reset(first.token, 'another-password-1')).status, 410);
    assert.equal((await call(srv, 'GET', '/api/children', teacherCookie)).status, 401, 'pre-reset cookie killed');
  });

  await t.test('an expired link is 410 and changes nothing', async () => {
    const link = await makeLink();
    srv.clock.advance(24 * HOUR);
    assert.equal((await reset(link.token, 'brand-new-password-2')).status, 410);
    assert.equal((await login(srv, teacherEmail, 'brand-new-password')).status, 200, 'password unchanged');
  });

  await t.test('a link for a missing user id is the shared 404 and creates nothing', async () => {
    const before = srv.db.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n;
    const res = await call(srv, 'POST', '/api/admin/teachers/999999/reset-link', adminCookie);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), NOT_FOUND_BODY);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n, before);
  });

  await t.test('audit: reset.create and reset.use rows, none containing a token', async () => {
    const rows = auditRows(srv);
    assert.ok(rows.some((r) => r.action === 'reset.create' && r.target === `user:${tid}`));
    const used = rows.find((r) => r.action === 'reset.use');
    assert.equal(used.target, `user:${tid}`);
    assert.equal(used.actor_user_id, tid);
    const tokens = srv.db.prepare('SELECT token_hash FROM password_resets').all();
    assert.ok(tokens.length > 0);
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(first.token));
    for (const r of tokens) assert.ok(!dump.includes(r.token_hash), 'not even the hash');
  });
});

test('reset and invite endpoints rate-limit repeated bad tokens', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const adminCookie = await srv.loginAs('admin');
  const reset = (token) => call(srv, 'POST', `/api/password-reset/${token}`, null, { password: 'brand-new-password' });
  const accept = (token) => call(srv, 'POST', `/api/invites/${token}/accept`, null, { password: 'brand-new-password' });

  for (const [name, hit, bad] of [['reset', reset, 404], ['invite accept', accept, 404]]) {
    await t.test(`${name}: 10 failures on one token, then 429 with Retry-After and an error body`, async () => {
      for (let i = 0; i < 10; i++) assert.equal((await hit(`guess-${name.length}`)).status, bad, `failure ${i + 1}`);
      const res = await hit(`guess-${name.length}`);
      assert.equal(res.status, 429);
      assert.deepEqual(await res.json(), { error: 'too_many_attempts' });
      const retry = Number(res.headers.get('retry-after'));
      assert.ok(Number.isInteger(retry) && retry > 0 && retry <= 15 * 60, `Retry-After ${retry}`);
      assert.equal((await hit(`other-${name.length}`)).status, 404, 'a different token is unaffected');
    });
    await t.test(`${name}: the lock lifts when the window passes`, async () => {
      srv.clock.advance(15 * MIN + 1);
      assert.equal((await hit(`guess-${name.length}`)).status, 404);
    });
  }

  await t.test('a used link counts as a failure too (410), but a valid token is never locked', async () => {
    const teacher = await srv.loginAs('teacher');
    const tid = idOf(srv, emailOf(srv, teacher));
    const link = await (await call(srv, 'POST', `/api/admin/teachers/${tid}/reset-link`, adminCookie)).json();
    const token = new URL(link.url, 'http://x').searchParams.get('token');
    assert.equal((await reset(token)).status, 200);
    for (let i = 0; i < 9; i++) assert.equal((await reset(token)).status, 410, `spent ${i}`);
    assert.equal((await reset(token)).status, 410, 'the 10th failure');
    assert.equal((await reset(token)).status, 429, 'then the spent token is locked');
    // short passwords on a valid token never accumulate towards the limit
    const link2 = await (await call(srv, 'POST', `/api/admin/teachers/${tid}/reset-link`, adminCookie)).json();
    const token2 = new URL(link2.url, 'http://x').searchParams.get('token');
    for (let i = 0; i < 12; i++) {
      assert.equal((await call(srv, 'POST', `/api/password-reset/${token2}`, null, { password: 'short' })).status, 400, `short ${i}`);
    }
    assert.equal((await reset(token2)).status, 200);
  });

  await t.test('a valid invite is never locked by short passwords, and still accepts', async () => {
    const { token } = await (await call(srv, 'POST', '/api/admin/invites', adminCookie, { email: 'lock@example.test' })).json();
    for (let i = 0; i < 12; i++) {
      assert.equal((await call(srv, 'POST', `/api/invites/${token}/accept`, null, { password: 'short' })).status, 400);
    }
    assert.equal((await accept(token)).status, 201);
  });
});

test('invite list and revoke', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const adminCookie = await srv.loginAs('admin');
  const teacherCookie = await srv.loginAs('teacher');
  const invite = async (email) => (await call(srv, 'POST', '/api/admin/invites', adminCookie, { email })).json();

  await t.test('admin only', async () => {
    assert.equal((await call(srv, 'GET', '/api/admin/invites')).status, 401);
    assert.equal((await call(srv, 'GET', '/api/admin/invites', teacherCookie)).status, 403);
    assert.equal((await call(srv, 'DELETE', '/api/admin/invites/1', teacherCookie)).status, 403);
  });

  const a = await invite('a@example.test');
  const b = await invite('b@example.test');
  const used = await invite('used@example.test');
  const expired = await invite('expired@example.test');
  srv.db.prepare('UPDATE invites SET used_at = 1 WHERE token = ?').run(used.token);
  srv.db.prepare('UPDATE invites SET expires_at = ? WHERE token = ?').run(srv.clock.t - 1, expired.token);

  let list;
  await t.test('lists only pending (unused, unexpired) invites: id, email, expiresAt, never a token', async () => {
    const res = await call(srv, 'GET', '/api/admin/invites', adminCookie);
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const t2 of [a, b, used, expired]) assert.ok(!text.includes(t2.token), 'no token in the list');
    list = JSON.parse(text);
    assert.deepEqual(list.map((i) => i.email), ['a@example.test', 'b@example.test']);
    for (const i of list) {
      assert.deepEqual(Object.keys(i).sort(), ['email', 'expiresAt', 'id']);
      assert.equal(typeof i.id, 'number');
      assert.equal(i.expiresAt, srv.clock.t + 7 * 24 * HOUR);
    }
    assert.notEqual(list[0].id, list[1].id);
  });

  await t.test('revoke: 204, the invite disappears and its link is dead (410), idempotently 404 afterwards', async () => {
    const res = await call(srv, 'DELETE', `/api/admin/invites/${list[0].id}`, adminCookie);
    assert.equal(res.status, 204);
    assert.deepEqual((await (await call(srv, 'GET', '/api/admin/invites', adminCookie)).json()).map((i) => i.email), ['b@example.test']);
    assert.equal((await call(srv, 'POST', `/api/invites/${a.token}/accept`, null, { password: 'brand-new-password' })).status, 410);
    const again = await call(srv, 'DELETE', `/api/admin/invites/${list[0].id}`, adminCookie);
    assert.equal(again.status, 404);
    assert.equal(await again.text(), NOT_FOUND_BODY);
  });

  await t.test('missing, non-numeric, already-used and expired ids are the shared 404', async () => {
    const usedId = srv.db.prepare('SELECT id FROM invites WHERE token = ?').get(used.token).id;
    const expiredId = srv.db.prepare('SELECT id FROM invites WHERE token = ?').get(expired.token).id;
    for (const id of ['999999', 'abc', usedId, expiredId]) {
      const res = await call(srv, 'DELETE', `/api/admin/invites/${id}`, adminCookie);
      assert.equal(res.status, 404, String(id));
      assert.equal(await res.text(), NOT_FOUND_BODY);
    }
    assert.equal(srv.db.prepare('SELECT used_at FROM invites WHERE id = ?').get(usedId).used_at, 1, 'untouched');
  });

  await t.test('the remaining invite still works; ids are never reused after a revoke', async () => {
    const c = await invite('c@example.test');
    const ids = srv.db.prepare('SELECT id FROM invites').all().map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    assert.equal((await call(srv, 'POST', `/api/invites/${c.token}/accept`, null, { password: 'brand-new-password' })).status, 201);
    assert.equal((await call(srv, 'POST', `/api/invites/${b.token}/accept`, null, { password: 'brand-new-password' })).status, 201);
  });

  await t.test('audit: invite.create and invite.revoke, without token or secret', async () => {
    const rows = auditRows(srv);
    assert.equal(rows.filter((r) => r.action === 'invite.create').length, 5);
    const revoke = rows.find((r) => r.action === 'invite.revoke');
    assert.equal(revoke.target, `invite:${list[0].id}`);
    const dump = JSON.stringify(rows);
    for (const t2 of [a, b, used, expired]) assert.ok(!dump.includes(t2.token));
  });
});

test('audit log', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const adminCookie = await srv.loginAs('admin');
  const teacherCookie = await srv.loginAs('teacher');
  const teacherEmail = emailOf(srv, teacherCookie);
  const teacherId = idOf(srv, teacherEmail);
  const adminId = idOf(srv, emailOf(srv, adminCookie));

  // Generate one of each action.
  const inv = await (await call(srv, 'POST', '/api/admin/invites', adminCookie, { email: 'x@example.test' })).json();
  const invId = srv.db.prepare('SELECT id FROM invites WHERE token = ?').get(inv.token).id;
  await call(srv, 'DELETE', `/api/admin/invites/${invId}`, adminCookie);
  await call(srv, 'POST', `/api/admin/teachers/${teacherId}/disable`, adminCookie);
  await call(srv, 'POST', `/api/admin/teachers/${teacherId}/enable`, adminCookie);
  const link = await (await call(srv, 'POST', `/api/admin/teachers/${teacherId}/reset-link`, adminCookie)).json();
  const resetToken = new URL(link.url, 'http://x').searchParams.get('token');
  await call(srv, 'POST', `/api/password-reset/${resetToken}`, null, { password: 'brand-new-password' });
  const teacher2 = await call(srv, 'POST', '/api/login', null, { email: teacherEmail, password: 'brand-new-password' });
  const cookie = teacher2.headers.getSetCookie()[0].split(';')[0];
  const child = await (await call(srv, 'POST', '/api/children', cookie, { code: 'AUD-1', initials: 'ZZ', gradeBand: 'elementary', consentDate: '2026-03-02' })).json();
  const sessionId = srv.db.prepare(
    `INSERT INTO read_sessions (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json)
     VALUES (?, 'p', 'new', 1, 1280, 720, '[]', '[]', '{}')`,
  ).run(child.id).lastInsertRowid;
  const share = await (await call(srv, 'POST', `/api/sessions/${sessionId}/share`, cookie, { days: 3 })).json();
  assert.equal((await call(srv, 'DELETE', `/api/share/${share.token}`, cookie)).status, 204);
  assert.equal((await call(srv, 'DELETE', `/api/children/${child.id}`, cookie)).status, 204);

  await t.test('admin only', async () => {
    assert.equal((await call(srv, 'GET', '/api/admin/audit')).status, 401);
    assert.equal((await call(srv, 'GET', '/api/admin/audit', cookie)).status, 403);
  });

  await t.test('every action is recorded, newest first, with actor and target', async () => {
    const res = await call(srv, 'GET', '/api/admin/audit', adminCookie);
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.deepEqual(rows.map((r) => r.action), [
      'child.delete', 'share.revoke', 'share.create', 'reset.use', 'reset.create',
      'teacher.enable', 'teacher.disable', 'invite.revoke', 'invite.create',
    ]);
    for (const r of rows) {
      assert.deepEqual(Object.keys(r).sort(), ['action', 'actorEmail', 'actorUserId', 'at', 'detail', 'id', 'target']);
      assert.equal(typeof r.at, 'number');
    }
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]));
    assert.equal(byAction['invite.create'].actorUserId, adminId);
    assert.equal(byAction['invite.create'].target, `invite:${invId}`);
    assert.equal(byAction['teacher.disable'].target, `user:${teacherId}`);
    assert.equal(byAction['reset.use'].actorUserId, teacherId);
    assert.equal(byAction['share.create'].actorUserId, teacherId);
    assert.equal(byAction['share.create'].target, `session:${sessionId}`);
    assert.equal(byAction['share.revoke'].target, `session:${sessionId}`);
    assert.equal(byAction['child.delete'].target, `child:${child.id}`);
    assert.equal(byAction['child.delete'].actorUserId, teacherId);
    assert.ok(rows.every((r, i) => i === 0 || rows[i - 1].id > r.id), 'strictly newest first');
  });

  await t.test('no token, hash, password or child code/initials anywhere in the log or its response', async () => {
    const text = await (await call(srv, 'GET', '/api/admin/audit', adminCookie)).text();
    const dump = JSON.stringify(auditRows(srv)) + text;
    for (const secret of [inv.token, resetToken, share.token, 'brand-new-password', 'scrypt$', 'AUD-1', 'ZZ', sha256(resetToken)]) {
      assert.ok(!dump.includes(secret), `leaked ${secret.slice(0, 6)}`);
    }
  });

  await t.test('limit: default 100, 1..500 honoured, above 500 clamped, garbage is 400', async () => {
    const insert = srv.db.prepare("INSERT INTO audit_log (at, actor_user_id, action, target) VALUES (1, NULL, 'bulk', 'x')");
    srv.db.transaction(() => { for (let i = 0; i < 600; i++) insert.run(); })();
    assert.equal((await (await call(srv, 'GET', '/api/admin/audit', adminCookie)).json()).length, 100);
    assert.equal((await (await call(srv, 'GET', '/api/admin/audit?limit=3', adminCookie)).json()).length, 3);
    assert.equal((await (await call(srv, 'GET', '/api/admin/audit?limit=1000', adminCookie)).json()).length, 500);
    for (const bad of ['0', '-1', 'abc', '1.5', '']) {
      assert.equal((await call(srv, 'GET', `/api/admin/audit?limit=${bad}`, adminCookie)).status, 400, `limit=${bad}`);
    }
    assert.equal((await call(srv, 'GET', '/api/admin/audit?limit=1&limit=2', adminCookie)).status, 400);
  });

  await t.test('a long detail is cut to 200 chars by the helper', () => {
    const { audit } = require('../server/audit');
    audit(srv.db, () => 5, adminId, 'x.long', 'y', 'd'.repeat(500));
    assert.equal(srv.db.prepare("SELECT detail FROM audit_log WHERE action = 'x.long'").get().detail.length, 200);
  });
});

test('reset links: concurrency, disabled accounts, audit linkage, login limiter', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const adminCookie = await srv.loginAs('admin');
  const adminId = idOf(srv, emailOf(srv, adminCookie));
  const mk = async () => {
    const cookie = await srv.loginAs('teacher');
    const email = emailOf(srv, cookie);
    return { cookie, email, id: idOf(srv, email) };
  };
  const link = async (id) => {
    const res = await call(srv, 'POST', `/api/admin/teachers/${id}/reset-link`, adminCookie);
    assert.equal(res.status, 201);
    return new URL((await res.json()).url, 'http://x').searchParams.get('token');
  };
  const reset = (token, password) => call(srv, 'POST', `/api/password-reset/${token}`, null, { password });

  await t.test('4 simultaneous uses of one valid link: exactly one 200, three 410', async () => {
    const u = await mk();
    const token = await link(u.id);
    const results = await Promise.all([0, 1, 2, 3].map(() => reset(token, 'brand-new-password')));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 410, 410, 410]);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reset.use'").get().n, 1, 'one audit row, not four');
    assert.equal((await login(srv, u.email, 'brand-new-password')).status, 200);
  });

  await t.test('a disabled account gets no link: 409 with a clear message, nothing created; enabling allows it again', async () => {
    const u = await mk();
    await call(srv, 'POST', `/api/admin/teachers/${u.id}/disable`, adminCookie);
    const before = srv.db.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n;
    const res = await call(srv, 'POST', `/api/admin/teachers/${u.id}/reset-link`, adminCookie);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: '비활성화된 계정은 재설정할 수 없습니다. 먼저 활성화해 주세요' });
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n, before);
    await call(srv, 'POST', `/api/admin/teachers/${u.id}/enable`, adminCookie);
    assert.equal((await call(srv, 'POST', `/api/admin/teachers/${u.id}/reset-link`, adminCookie)).status, 201);
  });

  await t.test('a reset never re-enables an account that was disabled after the link was made', async () => {
    const u = await mk();
    const token = await link(u.id);
    await call(srv, 'POST', `/api/admin/teachers/${u.id}/disable`, adminCookie);
    assert.equal((await reset(token, 'brand-new-password')).status, 200);
    assert.notEqual(srv.db.prepare('SELECT disabled_at FROM users WHERE id = ?').get(u.id).disabled_at, null, 'still disabled');
    assert.equal((await login(srv, u.email, 'brand-new-password')).status, 401);
  });

  await t.test('audit: reset.create and reset.use name the reset id, reset.use also the creating admin; never the token', async () => {
    const u = await mk();
    const token = await link(u.id);
    const resetId = srv.db.prepare('SELECT id, created_by FROM password_resets WHERE token_hash = ?').get(sha256(token));
    assert.equal(resetId.created_by, adminId);
    await reset(token, 'brand-new-password');
    const rows = srv.db.prepare("SELECT * FROM audit_log WHERE target = ? AND action IN ('reset.create', 'reset.use') ORDER BY id DESC LIMIT 2").all(`user:${u.id}`);
    const [use, create] = rows;
    assert.equal(create.action, 'reset.create');
    assert.equal(create.detail, `reset=${resetId.id}`);
    assert.equal(use.action, 'reset.use');
    assert.equal(use.detail, `reset=${resetId.id} created_by=${adminId}`);
    for (const r of rows) assert.ok(!JSON.stringify(r).includes(token));
  });

  await t.test('a successful reset clears the login lockout for that email', async () => {
    const u = await mk();
    for (let i = 0; i < 10; i++) assert.equal((await login(srv, u.email, 'wrong-password')).status, 401);
    assert.equal((await login(srv, u.email, TEST_PASSWORD)).status, 429, 'locked out');
    const token = await link(u.id);
    assert.equal((await reset(token, 'brand-new-password')).status, 200);
    assert.equal((await login(srv, u.email, 'brand-new-password')).status, 200, 'no waiting out the window');
  });
});

test('revoking an already revoked share link is idempotent: no second audit row, revoked_at kept', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const cookie = await srv.loginAs('teacher');
  const child = await (await call(srv, 'POST', '/api/children', cookie, { code: 'R-1', initials: 'KJ', gradeBand: 'elementary', consentDate: '2026-03-02' })).json();
  const sid = srv.db.prepare(
    `INSERT INTO read_sessions (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json)
     VALUES (?, 'p', 'new', 1, 1280, 720, '[]', '[]', '{}')`,
  ).run(child.id).lastInsertRowid;
  const share = await (await call(srv, 'POST', `/api/sessions/${sid}/share`, cookie, {})).json();
  assert.equal((await call(srv, 'DELETE', `/api/share/${share.token}`, cookie)).status, 204);
  const stamp = srv.db.prepare('SELECT revoked_at FROM share_links WHERE token = ?').get(share.token).revoked_at;
  srv.clock.advance(5000);
  assert.equal((await call(srv, 'DELETE', `/api/share/${share.token}`, cookie)).status, 204, 'still 204');
  assert.equal(srv.db.prepare('SELECT revoked_at FROM share_links WHERE token = ?').get(share.token).revoked_at, stamp);
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'share.revoke'").get().n, 1);
  assert.equal((await call(srv, 'DELETE', '/api/share/unknown-token', cookie)).status, 404);
});
