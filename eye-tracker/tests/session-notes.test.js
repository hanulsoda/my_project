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

test('session notes', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const cookieA = await srv.loginAs('teacher');
  const cookieB = await srv.loginAs('teacher');
  const adminCookie = await srv.loginAs('admin');
  const child = await (await call(srv, 'POST', '/api/children', cookieA, {
    code: 'N-1', initials: 'KJ', gradeBand: 'elementary', consentDate: '2026-03-02',
  })).json();
  const sid = srv.db.prepare(
    `INSERT INTO read_sessions (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json)
     VALUES (?, 'el-ref-sparrow', 'reference', 1000, 1280, 720, '[]', '[]', '{"wpm":80,"detail":"word","reliable":true}')`,
  ).run(child.id).lastInsertRowid;
  const noteOf = () => srv.db.prepare('SELECT note FROM read_sessions WHERE id = ?').get(sid).note;
  const patch = (cookie, body, id = sid) => call(srv, 'PATCH', `/api/sessions/${id}`, cookie, body);

  await t.test('a session starts with note null in detail and list', async () => {
    assert.equal((await (await call(srv, 'GET', `/api/sessions/${sid}`, cookieA)).json()).note, null);
    const list = await (await call(srv, 'GET', `/api/children/${child.id}/sessions`, cookieA)).json();
    assert.equal(list[0].note, null);
  });

  await t.test('sets a note and returns it; detail and list show it to the owner', async () => {
    const res = await patch(cookieA, { note: '  오전, 안경 벗고 읽음  ' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { id: Number(sid), note: '  오전, 안경 벗고 읽음  ' });
    assert.equal(noteOf(), '  오전, 안경 벗고 읽음  ');
    assert.equal((await (await call(srv, 'GET', `/api/sessions/${sid}`, cookieA)).json()).note, '  오전, 안경 벗고 읽음  ');
    const list = await (await call(srv, 'GET', `/api/children/${child.id}/sessions`, cookieA)).json();
    assert.equal(list[0].note, '  오전, 안경 벗고 읽음  ');
  });

  await t.test('replacing is idempotent; null and the empty/blank string clear it', async () => {
    assert.equal((await patch(cookieA, { note: 'x' })).status, 200);
    assert.equal((await patch(cookieA, { note: 'x' })).status, 200);
    assert.equal(noteOf(), 'x');
    for (const cleared of [null, '', '   ']) {
      await patch(cookieA, { note: 'again' });
      const res = await patch(cookieA, { note: cleared });
      assert.equal(res.status, 200, JSON.stringify(cleared));
      assert.deepEqual(await res.json(), { id: Number(sid), note: null });
      assert.equal(noteOf(), null, 'stored as NULL');
    }
  });

  await t.test('500 chars is fine, 501 is 400; non-strings, a missing key and no body are 400; nothing changes', async () => {
    assert.equal((await patch(cookieA, { note: 'n'.repeat(500) })).status, 200);
    const stored = noteOf();
    for (const body of [{ note: 'n'.repeat(501) }, { note: 5 }, { note: true }, { note: ['a'] }, { note: { a: 1 } }, {}, { other: 'x' }]) {
      assert.equal((await patch(cookieA, body)).status, 400, JSON.stringify(body).slice(0, 40));
    }
    assert.equal((await fetch(`${srv.url}/api/sessions/${sid}`, { method: 'PATCH', headers: { cookie: cookieA } })).status, 400);
    assert.equal(noteOf(), stored);
  });

  await t.test('tenancy: another teacher, admin, unknown and non-numeric ids get the shared 404 and change nothing', async () => {
    await patch(cookieA, { note: 'mine' });
    for (const [cookie, id] of [[cookieB, sid], [adminCookie, sid], [cookieA, 999999], [cookieA, 'abc']]) {
      const res = await patch(cookie, { note: 'hijack' }, id);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), NOT_FOUND_BODY);
    }
    assert.equal(noteOf(), 'mine');
    assert.equal((await patch(null, { note: 'x' })).status, 401);
    // The other teacher never sees it either.
    assert.equal((await call(srv, 'GET', `/api/sessions/${sid}`, cookieB)).status, 404);
  });

  await t.test('the note is not in the public parent report', async () => {
    await patch(cookieA, { note: 'SECRET-SESSION-NOTE' });
    const share = await (await call(srv, 'POST', `/api/sessions/${sid}/share`, cookieA, {})).json();
    const res = await fetch(`${srv.url}/api/report/${share.token}`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('N-1'), 'the report itself works');
    assert.doesNotMatch(text, /SECRET-SESSION-NOTE|"note"/);
  });

  await t.test('the share-link listing does not carry it either; reanalyze keeps the note', async () => {
    const shares = await (await call(srv, 'GET', `/api/sessions/${sid}/shares`, cookieA)).text();
    assert.doesNotMatch(shares, /SECRET-SESSION-NOTE/);
    srv.db.prepare("UPDATE read_sessions SET words_json = '[{\"i\":0,\"line\":0,\"x\":0,\"y\":0,\"w\":10,\"h\":10}]' WHERE id = ?").run(sid);
    assert.equal((await call(srv, 'POST', `/api/sessions/${sid}/reanalyze`, cookieA)).status, 200);
    assert.equal(noteOf(), 'SECRET-SESSION-NOTE');
  });
});
