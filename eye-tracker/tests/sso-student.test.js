'use strict';
// A student session (academy student menu -> /sso) may do exactly one thing: its own child's
// measurement. Every other route answers 401/403/404 with no data.
const { startTestServer } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

function call(srv, method, path, cookie, body) {
  return fetch(srv.url + path, {
    method,
    redirect: 'manual',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const WORDS = Array.from({ length: 5 }, (_, k) => ({ i: k, line: 0, x: 100 + k * 110, y: 100, w: 100, h: 30 }));
const SAMPLES = WORDS.flatMap((w, k) => Array.from({ length: 25 }, (_, j) => ({ t: k * 250 + j * 10, x: w.x + 50, y: w.y + 15 })));
const UPLOAD = { passageId: 'el-ref-sparrow', screen: { w: 1280, h: 720 }, words: WORDS, samples: SAMPLES };

test('student session: the route matrix', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const teacher = await srv.ssoAs('teacher', '12');
  const mk = async (body) => (await call(srv, 'POST', '/api/children', teacher, body)).json();
  const own = await mk({ code: 'S1', initials: 'KJ', gradeBand: 'elementary', consentDate: '2026-03-01', externalStudentId: '0123' });
  const other = await mk({ code: 'S2', initials: 'LS', gradeBand: 'elementary', consentDate: '2026-03-01', externalStudentId: '0456' });
  const noConsent = await mk({ code: 'S3', initials: 'PH', gradeBand: 'middle', externalStudentId: '0789' });
  // A stored session (and share link) on the student's own child, made by the teacher.
  const ownSession = await (await call(srv, 'POST', `/api/children/${own.id}/sessions`, teacher, UPLOAD)).json();
  const share = await (await call(srv, 'POST', `/api/sessions/${ownSession.id}/share`, teacher, {})).json();
  const student = await srv.ssoAs('student', '0123');

  await t.test('allowed: /api/me, own-band passages, own upload (id only, no scores), logout', async () => {
    const me = await call(srv, 'GET', '/api/me', student);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).role, 'student');
    const passages = await call(srv, 'GET', '/api/passages?gradeBand=elementary', student);
    assert.equal(passages.status, 200);
    assert.ok((await passages.json()).length > 0);
    const up = await call(srv, 'POST', `/api/children/${own.id}/sessions`, student, UPLOAD);
    assert.equal(up.status, 201);
    const body = await up.json();
    assert.deepEqual(Object.keys(body), ['id'], 'a student sees no scores');
    assert.equal(srv.db.prepare('SELECT child_id FROM read_sessions WHERE id = ?').get(body.id).child_id, own.id);
  });

  const denied = [
    ['GET', '/api/children'],
    ['GET', '/api/children?group=x'],
    ['GET', '/api/children/export.csv'],
    ['POST', '/api/children', { code: 'X', initials: 'X', gradeBand: 'elementary' }],
    ['GET', `/api/children/${own.id}`],
    ['PATCH', `/api/children/${own.id}`, { note: 'x' }],
    ['DELETE', `/api/children/${own.id}`],
    ['GET', `/api/children/${own.id}/sessions`],
    ['GET', `/api/children/${own.id}/trend`],
    ['POST', `/api/children/${other.id}/sessions`, UPLOAD],
    ['POST', '/api/children/999999/sessions', UPLOAD],
    ['GET', `/api/sessions/${ownSession.id}`],
    ['PATCH', `/api/sessions/${ownSession.id}`, { note: 'x' }],
    ['POST', `/api/sessions/${ownSession.id}/reanalyze`],
    ['POST', `/api/sessions/${ownSession.id}/share`, {}],
    ['GET', `/api/sessions/${ownSession.id}/shares`],
    ['DELETE', `/api/share/${share.token}`],
    ['GET', '/api/passages?gradeBand=middle'],
    ['GET', '/api/passages?gradeBand=high'],
    ['GET', '/api/passages'],
    ['GET', '/api/admin/teachers'],
    ['POST', '/api/admin/teachers/1/disable'],
    ['POST', '/api/admin/teachers/1/enable'],
    ['POST', '/api/admin/teachers/1/reset-link'],
    ['GET', '/api/admin/invites'],
    ['POST', '/api/admin/invites', { email: 'x@example.test' }],
    ['DELETE', '/api/admin/invites/1'],
    ['GET', '/api/admin/audit'],
  ];
  for (const [method, path, body] of denied) {
    await t.test(`denied: ${method} ${path}`, async () => {
      const res = await call(srv, method, path, student, body);
      assert.ok([401, 403, 404].includes(res.status), `${res.status}`);
      const text = await res.text();
      const json = JSON.parse(text);
      assert.deepEqual(Object.keys(json), ['error'], 'an error and nothing else');
      for (const leak of ['S1', 'S2', 'KJ', 'LS', 'wpm', 'metrics', share.token]) assert.ok(!text.includes(leak), `leaked ${leak}`);
    });
  }

  await t.test('nothing was changed by the denied calls', async () => {
    const row = srv.db.prepare('SELECT note FROM children WHERE id = ?').get(own.id);
    assert.equal(row.note, null);
    assert.equal(srv.db.prepare('SELECT revoked_at FROM share_links WHERE token = ?').get(share.token).revoked_at, null);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM read_sessions WHERE child_id = ?').get(other.id).n, 0);
  });

  await t.test('staff pages send the student back to their measurement; read.html is served', async () => {
    for (const page of ['/children.html', '/measure.html', '/CHILDREN.HTML', '/children%2ehtml']) {
      const res = await call(srv, 'GET', page, student);
      assert.equal(res.status, 302, page);
      assert.equal(res.headers.get('location'), `/read.html?child=${own.id}`);
    }
    assert.equal((await call(srv, 'GET', '/read.html', student)).status, 200);
    assert.equal((await call(srv, 'GET', '/js/read.js', student)).status, 200);
  });

  await t.test('without consent the upload is refused with the consent screen error (403)', async () => {
    const s3 = await srv.ssoAs('student', '0789');
    const me = await (await call(srv, 'GET', '/api/me', s3)).json();
    assert.equal(me.child.id, noConsent.id);
    assert.equal(me.child.consentDate, null);
    const res = await call(srv, 'POST', `/api/children/${noConsent.id}/sessions`, s3, UPLOAD);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'consent_required' });
  });

  await t.test('unlinking the child ends the student session at once', async () => {
    const s2 = await srv.ssoAs('student', '0456');
    assert.equal((await call(srv, 'GET', '/api/me', s2)).status, 200);
    assert.equal((await call(srv, 'PATCH', `/api/children/${other.id}`, teacher, { externalStudentId: null })).status, 200);
    assert.equal((await call(srv, 'GET', '/api/me', s2)).status, 401);
    assert.equal((await call(srv, 'POST', `/api/children/${other.id}/sessions`, s2, UPLOAD)).status, 401);
  });

  await t.test('the student session expires after 2 hours', async () => {
    const s = await srv.ssoAs('student', '0123');
    srv.clock.advance(2 * 60 * 60 * 1000 + 1);
    assert.equal((await call(srv, 'GET', '/api/me', s)).status, 401);
  });

  await t.test('logout ends the student session', async () => {
    const s = await srv.ssoAs('student', '0123');
    const out = await call(srv, 'POST', '/api/logout', s, {});
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { ok: true, next: '/academy' });
    assert.match(out.headers.getSetCookie()[0], /^sid=; .*Max-Age=0/);
    assert.equal((await call(srv, 'GET', '/api/me', s)).status, 401);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM student_sessions WHERE expires_at > ?').get(srv.clock.t).n, 0);
  });

  await t.test('a student cookie is never accepted as a staff session (separate table)', async () => {
    const s = await srv.ssoAs('student', '0123');
    const value = s.split('=')[1];
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE token = ?').get(value).n, 0);
  });
});
