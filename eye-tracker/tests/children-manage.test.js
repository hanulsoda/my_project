'use strict';
const { startTestServer } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const NOT_FOUND_BODY = JSON.stringify({ error: 'not found' });

function call(srv, method, path, cookie, body) {
  return fetch(srv.url + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const VALID = { code: 'A-01', initials: 'KJ', gradeBand: 'elementary', consentDate: '2026-03-02' };

test('children: group, note and partial updates', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const cookieA = await srv.loginAs('teacher');
  const cookieB = await srv.loginAs('teacher');
  const adminCookie = await srv.loginAs('admin');
  const create = async (cookie, body) => {
    const res = await call(srv, 'POST', '/api/children', cookie, body);
    assert.equal(res.status, 201, JSON.stringify(body));
    return res.json();
  };
  const a1 = await create(cookieA, VALID);
  const row = (id) => srv.db.prepare('SELECT * FROM children WHERE id = ?').get(id);

  await t.test('a new child has group and note null in create, list and detail', async () => {
    assert.equal(a1.group, null);
    assert.equal(a1.note, null);
    const list = await (await call(srv, 'GET', '/api/children', cookieA)).json();
    assert.deepEqual([list[0].group, list[0].note], [null, null]);
    const detail = await call(srv, 'GET', `/api/children/${a1.id}`, cookieA);
    assert.equal(detail.status, 200);
    assert.deepEqual(await detail.json(), a1);
  });

  await t.test('detail is teacher-scoped: foreign, unknown, non-numeric and admin all get the shared 404', async () => {
    for (const [cookie, id] of [[cookieB, a1.id], [adminCookie, a1.id], [cookieA, 999999], [cookieA, 'abc']]) {
      const res = await call(srv, 'GET', `/api/children/${id}`, cookie);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), NOT_FOUND_BODY);
    }
    assert.equal((await call(srv, 'GET', `/api/children/${a1.id}`)).status, 401);
  });

  await t.test('POST accepts an optional group and note, trimmed and validated', async () => {
    const c = await create(cookieA, { ...VALID, code: 'G-1', group: ' 토요반 ', note: '안경 착용' });
    assert.equal(c.group, '토요반');
    assert.equal(c.note, '안경 착용');
    for (const bad of [{ group: 5 }, { group: 'g'.repeat(33) }, { note: 5 }, { note: 'n'.repeat(501) }]) {
      assert.equal((await call(srv, 'POST', '/api/children', cookieA, { ...VALID, code: 'G-bad', ...bad })).status, 400, JSON.stringify(bad).slice(0, 40));
    }
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM children WHERE code = 'G-bad'").get().n, 0);
  });

  await t.test('PATCH updates only the fields sent and returns the child', async () => {
    const res = await call(srv, 'PATCH', `/api/children/${a1.id}`, cookieA, { group: '월요반', note: '  메모  ' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.group, '월요반');
    assert.equal(body.note, '  메모  ', 'note is stored as typed');
    assert.deepEqual({ code: body.code, initials: body.initials, gradeBand: body.gradeBand, consentDate: body.consentDate },
      { code: 'A-01', initials: 'KJ', gradeBand: 'elementary', consentDate: '2026-03-02' }, 'untouched fields stay');
    assert.equal(row(a1.id).group_name, '월요반');

    const second = await call(srv, 'PATCH', `/api/children/${a1.id}`, cookieA, { code: 'A-01b', initials: 'LS', gradeBand: 'middle' });
    assert.equal(second.status, 200);
    const b2 = await second.json();
    assert.deepEqual({ code: b2.code, initials: b2.initials, gradeBand: b2.gradeBand, group: b2.group }, { code: 'A-01b', initials: 'LS', gradeBand: 'middle', group: '월요반' });
    const list = await (await call(srv, 'GET', '/api/children', cookieA)).json();
    assert.equal(list.find((c) => c.id === a1.id).code, 'A-01b');
  });

  await t.test('consentDate can still be patched alone, together with other fields, and cleared', async () => {
    const both = await call(srv, 'PATCH', `/api/children/${a1.id}`, cookieA, { consentDate: '2026-05-05', group: '화요반' });
    assert.equal(both.status, 200);
    assert.deepEqual([(await both.json()).consentDate, row(a1.id).group_name], ['2026-05-05', '화요반']);
    assert.equal((await call(srv, 'PATCH', `/api/children/${a1.id}`, cookieA, { consentDate: null })).status, 200);
    assert.equal(row(a1.id).consent_date, '');
    assert.equal(row(a1.id).group_name, '화요반');
  });

  await t.test('group and note clear with null or an empty/blank string', async () => {
    for (const cleared of [null, '', '   ']) {
      await call(srv, 'PATCH', `/api/children/${a1.id}`, cookieA, { group: 'x', note: 'y' });
      const res = await call(srv, 'PATCH', `/api/children/${a1.id}`, cookieA, { group: cleared, note: cleared });
      assert.equal(res.status, 200, JSON.stringify(cleared));
      const body = await res.json();
      assert.deepEqual([body.group, body.note], [null, null]);
      assert.deepEqual([row(a1.id).group_name, row(a1.id).note], [null, null], 'stored as NULL');
    }
  });

  await t.test('validation: empty body, unknown-only body and bad values are 400 and change nothing', async () => {
    const before = JSON.stringify(row(a1.id));
    const bad = [
      {}, { nothing: 1 },
      { code: '' }, { code: 5 }, { code: 'x'.repeat(33) },
      { initials: '' }, { initials: null }, { initials: 'x'.repeat(33) },
      { gradeBand: 'college' }, { gradeBand: null },
      { group: 5 }, { group: 'g'.repeat(33) }, { group: ['a'] },
      { note: 5 }, { note: 'n'.repeat(501) }, { note: { a: 1 } },
      { consentDate: '2026-02-30' },
      { group: 'ok', code: '' }, // one bad field rejects the whole request
    ];
    for (const body of bad) {
      const res = await call(srv, 'PATCH', `/api/children/${a1.id}`, cookieA, body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(JSON.stringify(row(a1.id)), before);
    const noBody = await fetch(`${srv.url}/api/children/${a1.id}`, { method: 'PATCH', headers: { cookie: cookieA } });
    assert.equal(noBody.status, 400);
  });

  await t.test('boundary lengths pass: 32-char code/group, 500-char note', async () => {
    const res = await call(srv, 'PATCH', `/api/children/${a1.id}`, cookieA, { code: 'c'.repeat(32), group: 'g'.repeat(32), note: 'n'.repeat(500) });
    assert.equal(res.status, 200);
  });

  await t.test('duplicate code: 409 for the same teacher, fine for another, and the same code again is a no-op', async () => {
    const a2 = await create(cookieA, { ...VALID, code: 'DUP-2' });
    const clash = await call(srv, 'PATCH', `/api/children/${a2.id}`, cookieA, { code: 'c'.repeat(32) });
    assert.equal(clash.status, 409);
    assert.equal(row(a2.id).code, 'DUP-2');
    assert.equal((await call(srv, 'PATCH', `/api/children/${a2.id}`, cookieA, { code: 'DUP-2' })).status, 200, 'own code unchanged');
    await create(cookieB, { ...VALID, code: 'B-ONLY' });
    assert.equal((await call(srv, 'PATCH', `/api/children/${a2.id}`, cookieA, { code: 'B-ONLY' })).status, 200, 'unique per teacher');
  });

  await t.test('tenancy: another teacher, admin and unknown ids get the shared 404 and change nothing', async () => {
    const before = JSON.stringify(row(a1.id));
    for (const cookie of [cookieB, adminCookie]) {
      const res = await call(srv, 'PATCH', `/api/children/${a1.id}`, cookie, { group: 'hijack', note: 'hijack', code: 'HIJ' });
      assert.equal(res.status, 404);
      assert.equal(await res.text(), NOT_FOUND_BODY);
    }
    const unknown = await call(srv, 'PATCH', '/api/children/999999', cookieA, { group: 'x' });
    assert.equal(unknown.status, 404);
    assert.equal(await unknown.text(), NOT_FOUND_BODY);
    assert.equal(JSON.stringify(row(a1.id)), before);
    assert.equal((await call(srv, 'PATCH', `/api/children/${a1.id}`, null, { group: 'x' })).status, 401);
  });

  await t.test('GET /api/children?group= filters by exact name, scoped to the teacher', async () => {
    const cookieC = await srv.loginAs('teacher');
    await create(cookieC, { ...VALID, code: 'C-1', group: '토요반' });
    const names = async (cookie, qs) => (await (await call(srv, 'GET', `/api/children${qs}`, cookie)).json()).map((c) => c.code);
    assert.deepEqual(await names(cookieA, `?group=${encodeURIComponent('토요반')}`), ['G-1']);
    assert.deepEqual(await names(cookieC, `?group=${encodeURIComponent('토요반')}`), ['C-1'], 'another teacher\'s group of the same name is separate');
    assert.deepEqual(await names(cookieA, '?group=%ED%86%A0'), [], 'exact match, not a prefix');
    assert.deepEqual(await names(cookieA, `?group=${encodeURIComponent('토요반 ')}`), [], 'no trimming of the query');
    assert.deepEqual(await names(cookieA, '?group=nobody'), []);
    assert.deepEqual(await names(adminCookie, `?group=${encodeURIComponent('토요반')}`), [], 'admin has no bypass');
    assert.ok((await names(cookieA, '')).length > 1, 'no filter lists everything');
    assert.equal((await call(srv, 'GET', '/api/children?group=a&group=b', cookieA)).status, 400);
  });

  await t.test('the note never reaches the public parent report', async () => {
    const c = await create(cookieA, { ...VALID, code: 'RPT-1', group: 'SECRET-GROUP', note: 'SECRET-CHILD-NOTE' });
    const sid = srv.db.prepare(
      `INSERT INTO read_sessions (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json)
       VALUES (?, 'p', 'new', 1, 1280, 720, '[]', '[]', '{"wpm":1,"detail":"word"}')`,
    ).run(c.id).lastInsertRowid;
    const share = await (await call(srv, 'POST', `/api/sessions/${sid}/share`, cookieA, {})).json();
    const text = await (await fetch(`${srv.url}/api/report/${share.token}`)).text();
    assert.ok(text.includes('RPT-1'), 'the report works');
    assert.doesNotMatch(text, /SECRET-CHILD-NOTE|SECRET-GROUP/);
  });
});

test('children: code, initials and group are trimmed; duplicate codes ignore case and surrounding spaces', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const cookieA = await srv.loginAs('teacher');
  const cookieB = await srv.loginAs('teacher');
  const post = (cookie, body) => call(srv, 'POST', '/api/children', cookie, { gradeBand: 'elementary', initials: 'KJ', ...body });

  await t.test('POST stores trimmed values', async () => {
    const res = await post(cookieA, { code: '  M1  ', initials: ' KJ ', group: '  반  ' });
    assert.equal(res.status, 201);
    const c = await res.json();
    assert.deepEqual([c.code, c.initials, c.group], ['M1', 'KJ', '반']);
    const row = srv.db.prepare('SELECT code, initials, group_name FROM children WHERE id = ?').get(c.id);
    assert.deepEqual({ ...row }, { code: 'M1', initials: 'KJ', group_name: '반' });
  });

  await t.test("' M1 ' and 'm1' are duplicates of 'M1' (409), for POST and PATCH; another teacher may reuse it", async () => {
    for (const code of [' M1 ', 'm1', 'M1', ' m1']) {
      assert.equal((await post(cookieA, { code })).status, 409, JSON.stringify(code));
    }
    assert.equal((await post(cookieB, { code: 'm1' })).status, 201);
    const other = await (await post(cookieA, { code: 'M2' })).json();
    for (const code of [' M1 ', 'm1']) {
      assert.equal((await call(srv, 'PATCH', `/api/children/${other.id}`, cookieA, { code })).status, 409, `PATCH ${JSON.stringify(code)}`);
    }
    assert.equal(srv.db.prepare('SELECT code FROM children WHERE id = ?').get(other.id).code, 'M2');
    // Changing only the case of its own code is allowed.
    const own = await call(srv, 'PATCH', `/api/children/${other.id}`, cookieA, { code: '  m2 ' });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).code, 'm2');
  });

  await t.test('PATCH trims initials, code and group; blank-after-trim is still 400', async () => {
    const c = await (await post(cookieA, { code: 'T-1' })).json();
    const res = await call(srv, 'PATCH', `/api/children/${c.id}`, cookieA, { code: ' T-2 ', initials: '  LS ', group: ' g ' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([body.code, body.initials, body.group], ['T-2', 'LS', 'g']);
    for (const bad of [{ code: '   ' }, { initials: '\t' }, { code: ` ${'x'.repeat(33)} ` }]) {
      assert.equal((await call(srv, 'PATCH', `/api/children/${c.id}`, cookieA, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await post(cookieA, { code: ` ${'y'.repeat(32)} ` })).status, 201, '32 chars plus padding is fine');
  });
});
