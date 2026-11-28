'use strict';
const { startTestServer } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

function call(srv, method, path, cookie, body) {
  return fetch(srv.url + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const VALID = { code: 'A-01', initials: 'KJ', gradeBand: 'elementary', consentDate: '2026-03-02' };

test('children', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const cookieA = await srv.loginAs('teacher');
  const cookieB = await srv.loginAs('teacher');
  const adminCookie = await srv.loginAs('admin');

  await t.test('requires login', async () => {
    assert.equal((await call(srv, 'GET', '/api/children')).status, 401);
    assert.equal((await call(srv, 'POST', '/api/children', null, VALID)).status, 401);
  });

  let childId;
  await t.test('create returns 201 with the child and no teacher identifiers', async () => {
    const res = await call(srv, 'POST', '/api/children', cookieA, VALID);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(typeof body.id, 'number');
    assert.deepEqual(
      { code: body.code, initials: body.initials, gradeBand: body.gradeBand, consentDate: body.consentDate },
      VALID,
    );
    assert.deepEqual(Object.keys(body).sort(), ['code', 'consentDate', 'createdAt', 'externalStudentId', 'gradeBand', 'group', 'id', 'initials', 'note']);
    childId = body.id;
  });

  await t.test('list returns only own children', async () => {
    await call(srv, 'POST', '/api/children', cookieB, { ...VALID, code: 'B-01', initials: 'LS', gradeBand: 'high' });
    const listA = await (await call(srv, 'GET', '/api/children', cookieA)).json();
    assert.deepEqual(listA.map((c) => c.code), ['A-01']);
    const listB = await (await call(srv, 'GET', '/api/children', cookieB)).json();
    assert.deepEqual(listB.map((c) => c.code), ['B-01']);
    const listAdmin = await (await call(srv, 'GET', '/api/children', adminCookie)).json();
    // The director (role admin) sees every child, with its owner (docs/sso.md, visibility rules).
    assert.deepEqual(listAdmin.map((c) => c.code), ['A-01', 'B-01'], 'the director sees all');
    assert.ok(listAdmin.every((c) => Number.isInteger(c.teacherId)));
  });

  await t.test('consentDate is optional and null until set', async () => {
    const res = await call(srv, 'POST', '/api/children', cookieA, { code: 'A-02', initials: 'PH', gradeBand: 'middle' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.consentDate, null);
    const patched = await call(srv, 'PATCH', `/api/children/${body.id}`, cookieA, { consentDate: '2026-04-01' });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).consentDate, '2026-04-01');
  });

  await t.test('PATCH can clear consent (null or empty string) and set it again', async () => {
    const { id } = await (await call(srv, 'POST', '/api/children', cookieA, { ...VALID, code: 'CLR-1' })).json();
    const consentOf = async () => (await (await call(srv, 'GET', '/api/children', cookieA)).json()).find((c) => c.id === id).consentDate;
    for (const cleared of [null, '']) {
      const res = await call(srv, 'PATCH', `/api/children/${id}`, cookieA, { consentDate: cleared });
      assert.equal(res.status, 200, `PATCH ${JSON.stringify(cleared)}`);
      assert.equal((await res.json()).consentDate, null);
      assert.equal(await consentOf(), null);
      assert.equal(srv.db.prepare('SELECT consent_date FROM children WHERE id = ?').get(id).consent_date, '');
      const restored = await call(srv, 'PATCH', `/api/children/${id}`, cookieA, { consentDate: '2026-06-01' });
      assert.equal(restored.status, 200);
      assert.equal((await restored.json()).consentDate, '2026-06-01');
      assert.equal(await consentOf(), '2026-06-01');
    }
    assert.equal((await call(srv, 'PATCH', `/api/children/${id}`, cookieA, {})).status, 400, 'missing key still 400');
    assert.equal((await call(srv, 'PATCH', `/api/children/${id}`, cookieA, { consentDate: '2026-13-01' })).status, 400);
    assert.equal(await consentOf(), '2026-06-01', 'rejected requests change nothing');

    const foreign = await call(srv, 'PATCH', `/api/children/${id}`, cookieB, { consentDate: null });
    assert.equal(foreign.status, 404);
    assert.equal(await consentOf(), '2026-06-01', 'foreign clear leaves the row unchanged');
  });

  await t.test('validation: 400 for bad input', async () => {
    const bad = [
      { ...VALID, code: '' },
      { ...VALID, code: 5 },
      { ...VALID, code: 'x'.repeat(33) },
      { ...VALID, initials: '' },
      { ...VALID, initials: undefined },
      { ...VALID, gradeBand: 'college' },
      { ...VALID, consentDate: '2026-02-30' },
      { ...VALID, consentDate: '03/02/2026' },
      { ...VALID, consentDate: 20260302 },
    ];
    for (const [i, body] of bad.entries()) {
      const res = await call(srv, 'POST', '/api/children', cookieA, { ...body, code: body.code === VALID.code ? `V-${i}` : body.code });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await call(srv, 'PATCH', `/api/children/${childId}`, cookieA, { consentDate: '2026-13-01' })).status, 400);
    assert.equal((await call(srv, 'PATCH', `/api/children/${childId}`, cookieA, {})).status, 400);
    assert.equal((await call(srv, 'PATCH', `/api/children/abc`, cookieA, { consentDate: '2026-04-01' })).status, 404);
  });

  await t.test('duplicate code: 409 for same teacher, allowed for another', async () => {
    assert.equal((await call(srv, 'POST', '/api/children', cookieA, VALID)).status, 409);
    assert.equal((await call(srv, 'POST', '/api/children', cookieB, VALID)).status, 201);
  });

  await t.test("another teacher's child (and unknown id) is 404 with identical body", async () => {
    const unknown = await call(srv, 'PATCH', '/api/children/999999', cookieB, { consentDate: '2026-04-01' });
    assert.equal(unknown.status, 404);
    const unknownBody = await unknown.text();

    const patch = await call(srv, 'PATCH', `/api/children/${childId}`, cookieB, { consentDate: '2026-05-05' });
    assert.equal(patch.status, 404);
    assert.equal(await patch.text(), unknownBody);

    const del = await call(srv, 'DELETE', `/api/children/${childId}`, cookieB);
    assert.equal(del.status, 404);
    assert.equal(await del.text(), unknownBody);

    const adminGet = await call(srv, 'GET', `/api/children/${childId}`, adminCookie);
    assert.equal(adminGet.status, 200, 'the director sees every child');

    const row = srv.db.prepare('SELECT consent_date FROM children WHERE id = ?').get(childId);
    assert.equal(row.consent_date, '2026-03-02', 'untouched by the other teacher');
  });

  await t.test('DELETE cascades to read_sessions and share_links', async () => {
    const { id } = await (await call(srv, 'POST', '/api/children', cookieA, { ...VALID, code: 'DEL-1' })).json();
    const sessionId = srv.db.prepare(
      `INSERT INTO read_sessions (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json)
       VALUES (?, 'p', 'new', 1, 1280, 720, '[]', '[]', '{}')`,
    ).run(id).lastInsertRowid;
    srv.db.prepare('INSERT INTO share_links (token, session_id, expires_at) VALUES (?, ?, ?)')
      .run('tok-del-1', sessionId, srv.clock.t + 1000);

    const res = await call(srv, 'DELETE', `/api/children/${id}`, cookieA);
    assert.equal(res.status, 204);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM children WHERE id = ?').get(id).n, 0);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM read_sessions WHERE child_id = ?').get(id).n, 0);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM share_links WHERE token = ?').get('tok-del-1').n, 0);
    assert.equal((await call(srv, 'DELETE', `/api/children/${id}`, cookieA)).status, 404);
  });
});
