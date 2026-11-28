'use strict';
// Visibility rules (docs/sso.md): the director (users.role 'admin') sees and manages every child;
// a teacher only their own. Every director write to another owner's child is audited.
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

const WORDS = Array.from({ length: 5 }, (_, k) => ({ i: k, line: 0, x: 100 + k * 110, y: 100, w: 100, h: 30 }));
const SAMPLES = WORDS.flatMap((w, k) => Array.from({ length: 25 }, (_, j) => ({ t: k * 250 + j * 10, x: w.x + 50, y: w.y + 15 })));
const UPLOAD = { passageId: 'el-ref-sparrow', screen: { w: 1280, h: 720 }, words: WORDS, samples: SAMPLES };

test('director sees all, teacher only own', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const director = await srv.ssoAs('director', 'admin');
  const tA = await srv.ssoAs('teacher', '1');
  const tB = await srv.ssoAs('teacher', '2');
  const idOf = (ext) => srv.db.prepare('SELECT id FROM users WHERE external_id = ?').get(ext).id;
  const [directorId, aId, bId] = ['director:admin', 'teacher:1', 'teacher:2'].map(idOf);
  const mk = async (cookie, body) => (await call(srv, 'POST', '/api/children', cookie, body)).json();
  const a1 = await mk(tA, { code: 'A1', initials: 'AA', gradeBand: 'elementary', consentDate: '2026-01-01' });
  const b1 = await mk(tB, { code: 'B1', initials: 'BB', gradeBand: 'elementary', consentDate: '2026-01-01' });
  const aSession = await (await call(srv, 'POST', `/api/children/${a1.id}/sessions`, tA, UPLOAD)).json();
  const crossRows = () => srv.db.prepare("SELECT actor_user_id, action, target, detail FROM audit_log WHERE action = 'director.cross_write' ORDER BY id").all();

  await t.test('lists: director all (with owner), teachers own (no owner field)', async () => {
    const d = await (await call(srv, 'GET', '/api/children', director)).json();
    assert.deepEqual(d.map((c) => [c.code, c.teacherId]), [['A1', aId], ['B1', bId]]);
    const a = await (await call(srv, 'GET', '/api/children', tA)).json();
    assert.deepEqual(a.map((c) => c.code), ['A1']);
    assert.ok(!('teacherId' in a[0]));
  });

  await t.test('reads: detail, sessions, trend, session, shares, CSV', async () => {
    for (const path of [`/api/children/${a1.id}`, `/api/children/${a1.id}/sessions`, `/api/children/${a1.id}/trend`,
      `/api/sessions/${aSession.id}`, `/api/sessions/${aSession.id}/shares`]) {
      assert.equal((await call(srv, 'GET', path, director)).status, 200, `director ${path}`);
      assert.equal((await call(srv, 'GET', path, tB)).status, 404, `teacher B ${path}`);
    }
    const csvD = await (await call(srv, 'GET', '/api/children/export.csv', director)).text();
    assert.match(csvD, /A1/);
    assert.match(csvD, /B1/);
    const csvB = await (await call(srv, 'GET', '/api/children/export.csv', tB)).text();
    assert.doesNotMatch(csvB, /A1/);
    assert.equal(crossRows().length, 0, 'reads are not audited as writes');
  });

  await t.test('writes by a foreign teacher: 404 and nothing changes', async () => {
    assert.equal((await call(srv, 'PATCH', `/api/sessions/${aSession.id}`, tB, { note: 'x' })).status, 404);
    assert.equal((await call(srv, 'POST', `/api/sessions/${aSession.id}/reanalyze`, tB)).status, 404);
    assert.equal((await call(srv, 'POST', `/api/sessions/${aSession.id}/share`, tB, {})).status, 404);
    assert.equal((await call(srv, 'POST', `/api/children/${a1.id}/sessions`, tB, UPLOAD)).status, 404);
    assert.equal((await call(srv, 'DELETE', `/api/children/${a1.id}`, tB)).status, 404);
    assert.equal((await call(srv, 'PATCH', `/api/children/${a1.id}`, tB, { note: 'x' })).status, 404);
  });

  await t.test('writes by the director on another owner\'s child work and are each audited', async () => {
    assert.equal((await call(srv, 'PATCH', `/api/children/${a1.id}`, director, { note: '원장 메모' })).status, 200);
    assert.equal((await call(srv, 'PATCH', `/api/sessions/${aSession.id}`, director, { note: 'n' })).status, 200);
    assert.equal((await call(srv, 'POST', `/api/sessions/${aSession.id}/reanalyze`, director)).status, 200);
    const share = await (await call(srv, 'POST', `/api/sessions/${aSession.id}/share`, director, {})).json();
    assert.equal((await call(srv, 'DELETE', `/api/share/${share.token}`, director)).status, 204);
    assert.equal((await call(srv, 'POST', `/api/children/${a1.id}/sessions`, director, UPLOAD)).status, 201);
    const rows = crossRows();
    assert.deepEqual(rows.map((r) => r.detail.split(' ')[0]),
      ['child.update', 'session.note', 'session.reanalyze', 'share.create', 'share.revoke', 'session.create']);
    assert.ok(rows.every((r) => r.actor_user_id === directorId && r.detail.endsWith(`owner=user:${aId}`)));
    assert.ok(rows.every((r) => !r.detail.includes(share.token) && !r.target.includes(share.token)), 'never a token');
  });

  await t.test('the director\'s writes on their own child are not cross-access', async () => {
    const own = await mk(director, { code: 'D1', initials: 'DD', gradeBand: 'high' });
    const before = crossRows().length;
    assert.equal((await call(srv, 'PATCH', `/api/children/${own.id}`, director, { note: 'x' })).status, 200);
    assert.equal(crossRows().length, before);
  });

  await t.test('reassigning the owner: director only, validated, audited', async () => {
    assert.equal((await call(srv, 'PATCH', `/api/children/${b1.id}`, tB, { teacherId: aId })).status, 403, 'a teacher cannot give a child away');
    const off = await srv.ssoAs('teacher', '3');
    const offId = idOf('teacher:3');
    assert.equal((await call(srv, 'POST', `/api/admin/teachers/${offId}/disable`, director)).status, 200);
    assert.ok(off);
    for (const bad of [999999, '2', null, 1.5, offId]) {
      assert.equal((await call(srv, 'PATCH', `/api/children/${b1.id}`, director, { teacherId: bad })).status, 400, String(bad));
    }
    const res = await call(srv, 'PATCH', `/api/children/${b1.id}`, director, { teacherId: aId });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).teacherId, aId);
    const a = await (await call(srv, 'GET', '/api/children', tA)).json();
    assert.deepEqual(a.map((c) => c.code).sort(), ['A1', 'B1']);
    assert.equal((await call(srv, 'GET', `/api/children/${b1.id}`, tB)).status, 404, 'the old owner no longer sees it');
    const row = srv.db.prepare("SELECT actor_user_id, target, detail FROM audit_log WHERE action = 'child.reassign'").get();
    assert.deepEqual({ ...row }, { actor_user_id: directorId, target: `child:${b1.id}`, detail: `from=user:${bId} to=user:${aId}` });
  });

  await t.test('delete: the director may delete any child (audited), a teacher only own', async () => {
    const victim = await mk(tB, { code: 'B9', initials: 'BB', gradeBand: 'middle' });
    assert.equal((await call(srv, 'DELETE', `/api/children/${victim.id}`, tA)).status, 404);
    assert.equal((await call(srv, 'DELETE', `/api/children/${victim.id}`, director)).status, 204);
    const last = crossRows().at(-1);
    assert.equal(last.target, `child:${victim.id}`);
    assert.match(last.detail, /^child\.delete owner=user:/);
  });
});

test('children: externalStudentId', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const tA = await srv.ssoAs('teacher', '1');
  const tB = await srv.ssoAs('teacher', '2');
  const post = (cookie, body) => call(srv, 'POST', '/api/children', cookie, body);
  const base = { initials: 'KJ', gradeBand: 'elementary' };

  let child;
  await t.test('POST stores it trimmed and returns it; default null', async () => {
    const res = await post(tA, { ...base, code: 'E1', externalStudentId: ' 0123 ' });
    assert.equal(res.status, 201);
    child = await res.json();
    assert.equal(child.externalStudentId, '0123');
    assert.equal((await (await post(tA, { ...base, code: 'E2' })).json()).externalStudentId, null);
  });

  await t.test('duplicate across ALL children (any teacher): 409 "이미 등록된 학생입니다"', async () => {
    const res = await post(tB, { ...base, code: 'E3', externalStudentId: '0123' });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: '이미 등록된 학생입니다' });
    const other = await (await post(tB, { ...base, code: 'E4' })).json();
    const patch = await call(srv, 'PATCH', `/api/children/${other.id}`, tB, { externalStudentId: '0123' });
    assert.equal(patch.status, 409);
    assert.deepEqual(await patch.json(), { error: '이미 등록된 학생입니다' });
  });

  await t.test('validation: a string up to 32 chars; null or blank clears', async () => {
    for (const bad of [123, 'x'.repeat(33), ['0123'], { a: 1 }]) {
      assert.equal((await post(tA, { ...base, code: `V${Math.random()}`.slice(0, 10), externalStudentId: bad })).status, 400, JSON.stringify(bad));
    }
    const keep = await call(srv, 'PATCH', `/api/children/${child.id}`, tA, { externalStudentId: '0123' });
    assert.equal(keep.status, 200, 'setting the same value on the same child is fine');
    const cleared = await (await call(srv, 'PATCH', `/api/children/${child.id}`, tA, { externalStudentId: '  ' })).json();
    assert.equal(cleared.externalStudentId, null);
    const again = await (await call(srv, 'PATCH', `/api/children/${child.id}`, tA, { externalStudentId: '0123' })).json();
    assert.equal(again.externalStudentId, '0123');
  });
});
