'use strict';
const { startTestServer } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { TEST_SSO_SECRET, TEST_ACADEMY_URL, makePayload, signToken } = require('./sso-helpers');

const H = 60 * 60 * 1000;
const FAIL_TEXT = '다힘 사이트에서 다시 들어와 주세요';
const NOT_LINKED_TEXT = '아직 측정 대상으로 등록되지 않았어요. 선생님께 말씀해 주세요.';

const get = (srv, path, cookie) => fetch(srv.url + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const me = async (srv, cookie) => { const r = await get(srv, '/api/me', cookie); return { status: r.status, body: await r.json() }; };

function assertSafeHeaders(res) {
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
}

async function assertFailurePage(res, token, status = 403) {
  assert.equal(res.status, status);
  assertSafeHeaders(res);
  assert.equal(res.headers.getSetCookie().length, 0, 'no cookie on failure');
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const html = await res.text();
  assert.match(html, new RegExp(FAIL_TEXT));
  assert.ok(html.includes(`href="${TEST_ACADEMY_URL}"`), 'links back to the academy');
  if (token) assert.ok(!html.includes(token) && !html.includes(token.split('.')[1]), 'token never echoed');
  assert.ok(!html.includes(TEST_SSO_SECRET));
  return html;
}

test('/sso: teacher entry', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);

  let first;
  await t.test('valid token: 302 to the children page, a 12 h HttpOnly session, safe headers', async () => {
    const { res, cookie, token } = await srv.ssoEnter({ role: 'teacher', uid: '12' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/children.html');
    assertSafeHeaders(res);
    const set = res.headers.getSetCookie()[0];
    assert.match(set, /^sid=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    assert.ok(!set.includes(token));
    const who = await me(srv, cookie);
    assert.equal(who.status, 200);
    assert.equal(who.body.role, 'teacher');
    first = cookie;
  });

  await t.test('auto-provisioned: external_id teacher:12, placeholder email, unusable password', async () => {
    const rows = srv.db.prepare("SELECT id, email, role, pw_hash, external_id, last_login_at FROM users WHERE external_id = 'teacher:12'").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, 'teacher-12@sso.invalid');
    assert.equal(rows[0].role, 'teacher');
    assert.doesNotMatch(rows[0].pw_hash, /^scrypt\$/);
    assert.equal(rows[0].last_login_at, srv.clock.t);
    const login = await fetch(srv.url + '/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'teacher-12@sso.invalid', password: rows[0].pw_hash }),
    });
    assert.equal(login.status, 401, 'no password can open an SSO account');
  });

  await t.test('second visit reuses the same user (idempotent)', async () => {
    const before = srv.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const { res, cookie } = await srv.ssoEnter({ role: 'teacher', uid: '12' });
    assert.equal(res.status, 302);
    assert.notEqual(cookie, first, 'a new session token each time');
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before);
  });

  await t.test('a student id in a teacher token goes to that student on the children page', async () => {
    const { res } = await srv.ssoEnter({ role: 'teacher', uid: '12', sid: '0123' }, { next: '/children.html' });
    assert.equal(res.headers.get('location'), '/children.html?student=0123');
  });

  await t.test('next: allowlisted paths are kept, open redirects fall back to the default', async () => {
    assert.equal((await srv.ssoEnter({}, { next: '/read.html?child=5' })).res.headers.get('location'), '/read.html?child=5');
    assert.equal((await srv.ssoEnter({}, { next: '/children.html?student=0456' })).res.headers.get('location'), '/children.html?student=0456');
    for (const next of ['//evil.com', '/\\evil', 'https://evil', '/children.html@evil', '%2F%2Fevil.com', '/%2F%2Fevil.com', '/children.html%40evil']) {
      const { res } = await srv.ssoEnter({}, { next });
      assert.equal(res.headers.get('location'), '/children.html', next);
    }
    // Raw (not double-encoded) variants straight in the query string.
    for (const raw of ['%2F%2Fevil.com', '%2F%5Cevil', 'https%3A%2F%2Fevil', '%2Fchildren.html%40evil', '%252F%252Fevil.com']) {
      const token = signToken(makePayload({}, srv.clock.t));
      const res = await get(srv, `/sso?t=${token}&next=${raw}`);
      assert.equal(res.headers.get('location'), '/children.html', raw);
    }
  });

  await t.test('an existing session cookie is replaced (no fixation)', async () => {
    const old = await srv.ssoAs('teacher', '12');
    const { cookie } = await srv.ssoEnter({ role: 'teacher', uid: '12' }, { cookie: old });
    assert.equal((await me(srv, old)).status, 401, 'the old session is gone');
    assert.equal((await me(srv, cookie)).status, 200);
  });

  await t.test('the SSO session ends after 12 hours', async () => {
    const cookie = await srv.ssoAs('teacher', '12');
    srv.clock.advance(12 * H - 1000);
    assert.equal((await me(srv, cookie)).status, 200);
    srv.clock.advance(2000);
    assert.equal((await me(srv, cookie)).status, 401);
  });
});

test('/sso: director entry', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  await t.test('director becomes an admin account and can use the admin API', async () => {
    const { res, cookie } = await srv.ssoEnter({ role: 'director', uid: 'admin' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/children.html');
    assert.equal((await me(srv, cookie)).body.role, 'admin');
    const row = srv.db.prepare("SELECT email, role FROM users WHERE external_id = 'director:admin'").get();
    assert.deepEqual({ ...row }, { email: 'director-admin@sso.invalid', role: 'admin' });
    assert.equal((await get(srv, '/api/admin/teachers', cookie)).status, 200);
  });
});

test('/sso: refusals', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);

  await t.test('replay: the same token works once only', async () => {
    const token = signToken(makePayload({}, srv.clock.t));
    assert.equal((await srv.ssoEnter({}, { token })).res.status, 302);
    const again = await srv.ssoEnter({}, { token });
    await assertFailurePage(again.res, token);
  });

  await t.test('bad tokens all get the same friendly page with no detail', async () => {
    const good = signToken(makePayload({}, srv.clock.t));
    const bodies = new Set();
    for (const token of [
      signToken(makePayload({}, srv.clock.t), 'wrong-secret-wrong-secret-wrong-secret!!'),
      good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a'),
      signToken(makePayload({ exp: Math.floor(srv.clock.t / 1000) - 61 }, srv.clock.t)),
      signToken(makePayload({ role: 'parent' }, srv.clock.t)),
      'A'.repeat(2000),
      'garbage',
    ]) {
      const { res } = await srv.ssoEnter({}, { token });
      bodies.add(await assertFailurePage(res, token));
    }
    assert.equal(bodies.size, 1, 'one identical page for every failure');
    for (const path of ['/sso', '/sso?t=', `/sso?t=${good}&t=${good}`]) {
      await assertFailurePage(await get(srv, path));
    }
  });

  await t.test('a disabled account is refused exactly like a password login would be', async () => {
    const admin = await srv.ssoAs('director', 'admin');
    await srv.ssoAs('teacher', '77');
    const id = srv.db.prepare("SELECT id FROM users WHERE external_id = 'teacher:77'").get().id;
    assert.equal((await fetch(`${srv.url}/api/admin/teachers/${id}/disable`, { method: 'POST', headers: { cookie: admin } })).status, 200);
    const { res, token } = await srv.ssoEnter({ role: 'teacher', uid: '77' });
    await assertFailurePage(res, token);
    // Re-enabled: the academy link works again.
    await fetch(`${srv.url}/api/admin/teachers/${id}/enable`, { method: 'POST', headers: { cookie: admin } });
    assert.equal((await srv.ssoEnter({ role: 'teacher', uid: '77' })).res.status, 302);
  });

  await t.test('nonces are kept until exp + 60 s and then purged lazily', async () => {
    const count = () => srv.db.prepare('SELECT COUNT(*) AS n FROM sso_nonces').get().n;
    assert.ok(count() > 0);
    srv.clock.advance(400 * 1000);
    await srv.ssoEnter({});
    assert.equal(count(), 1, 'only the newest nonce is left');
  });
});

test('/sso: student entry', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const teacher = await srv.ssoAs('teacher', '12');
  const made = await fetch(`${srv.url}/api/children`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: teacher },
    body: JSON.stringify({ code: 'S-0123', initials: 'KJ', gradeBand: 'elementary', consentDate: '2026-03-01', externalStudentId: '0123' }),
  });
  assert.equal(made.status, 201);
  const child = await made.json();

  await t.test('a linked student lands on their own measurement with a student session', async () => {
    const { res, cookie } = await srv.ssoEnter({ role: 'student', uid: '0123', sid: '0123' }, { next: '/children.html' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/read.html?child=${child.id}`);
    assertSafeHeaders(res);
    const who = await me(srv, cookie);
    assert.equal(who.status, 200);
    assert.deepEqual(who.body, {
      role: 'student',
      child: { id: child.id, code: 'S-0123', initials: 'KJ', gradeBand: 'elementary', consentDate: '2026-03-01' },
    });
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM student_sessions').get().n, 1);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM users WHERE external_id LIKE 'student:%'").get().n, 0, 'a student never becomes a users row');
  });

  await t.test('an unlinked student gets the "not registered yet" page and no session', async () => {
    const { res } = await srv.ssoEnter({ role: 'student', uid: '0999', sid: '0999' });
    assert.equal(res.status, 404);
    assertSafeHeaders(res);
    assert.equal(res.headers.getSetCookie().length, 0);
    assert.match(await res.text(), new RegExp(NOT_LINKED_TEXT.replace(/[.]/g, '\\.')));
  });
});

test('/sso: disabled when SSO_SECRET is unset', async (t) => {
  const srv = await startTestServer({ config: { ssoSecret: null } });
  t.after(srv.close);
  const { res, token } = await srv.ssoEnter({});
  await assertFailurePage(res, token, 503);
});

test('no token or secret in any response, header, log line or DB dump', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const lines = [];
  for (const m of ['log', 'info', 'warn', 'error']) t.mock.method(console, m, (...a) => { lines.push(a.map(String).join(' ')); });

  const tokens = [];
  const seen = [];
  const record = async (res) => {
    seen.push(JSON.stringify([...res.headers]));
    seen.push(await res.text());
  };
  const teacher = await srv.ssoEnter({ role: 'teacher', uid: '5' });
  tokens.push(teacher.token);
  await record(teacher.res);
  await fetch(`${srv.url}/api/children`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: teacher.cookie },
    body: JSON.stringify({ code: 'C1', initials: 'AB', gradeBand: 'elementary', externalStudentId: '0042' }),
  });
  const student = await srv.ssoEnter({ role: 'student', uid: '0042', sid: '0042' });
  tokens.push(student.token);
  await record(student.res);
  const replay = await srv.ssoEnter({}, { token: teacher.token });
  await record(replay.res);
  const bad = await srv.ssoEnter({}, { token: `${teacher.token.split('.')[0]}.${'0'.repeat(64)}` });
  tokens.push(bad.token);
  await record(bad.res);
  for (const c of [teacher.cookie, student.cookie]) await record(await get(srv, '/api/me', c));

  const dump = srv.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .flatMap(({ name }) => srv.db.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r))).join('\n');
  const haystacks = { responses: seen.join('\n'), logs: lines.join('\n'), db: dump };
  for (const [where, text] of Object.entries(haystacks)) {
    assert.ok(!text.includes(TEST_SSO_SECRET), `secret in ${where}`);
    for (const token of tokens) {
      const [b64, sig] = token.split('.');
      assert.ok(!text.includes(sig), `signature in ${where}`);
      assert.ok(!text.includes(b64), `payload in ${where}`);
    }
  }
  // The student's cookie value is only stored hashed.
  const studentSid = student.cookie.split('=')[1];
  assert.ok(!dump.includes(studentSid), 'student cookie value not stored in clear');
});
