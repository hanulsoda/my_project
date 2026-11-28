'use strict';
// Regression tests for the independent security review of the SSO branch (F1-F3).
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startTestServer } = require('./helpers');
const { makePayload, signToken } = require('./sso-helpers');

const GENERIC = { error: '이 학생 번호로는 등록할 수 없습니다. 다힘 사이트의 학생 화면에서 "측정"으로 들어와 주세요.' };

function post(srv, cookie, body) {
  return fetch(`${srv.url}/api/children`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
}

// F1: the nonce row lives until (exp+60)*1000; verify must refuse from that same millisecond on,
// so a purged nonce can never be re-inserted by a token that still verifies.
test('F1: no replay inside the last second of the skew window', async (t) => {
  const s = await startTestServer({ config: { allowPasswordLogin: false } });
  t.after(s.close);
  const p = makePayload({}, s.clock.t);
  const token = signToken(p);
  assert.equal((await s.ssoEnter({}, { token })).res.status, 302);
  for (const at of [(p.exp + 60) * 1000 - 1, (p.exp + 60) * 1000, (p.exp + 60) * 1000 + 500]) {
    s.clock.t = at;
    assert.equal((await s.ssoEnter({}, { token })).res.status, 403, `replay at ${at}`);
  }
});

// F2: a teacher may link only the student number of the signed launch that opened their session.
test('F2: a teacher cannot claim an arbitrary academy student number', async (t) => {
  const s = await startTestServer({ config: { allowPasswordLogin: false } });
  t.after(s.close);
  const base = { initials: 'XX', gradeBand: 'elementary', consentDate: '2026-01-01' };

  const b = await s.ssoEnter({ role: 'teacher', uid: '77', sid: '' });
  const claim = await post(s, b.cookie, { ...base, code: 'X', externalStudentId: '0123' });
  assert.equal(claim.status, 403);
  assert.deepEqual(await claim.json(), GENERIC);
  const st = await s.ssoEnter({ role: 'student', uid: '0123', sid: '0123' });
  assert.equal(st.res.status, 404, 'the student is not linked to teacher 77');

  // A launch for 0456 does not let the same session link 0123 either.
  const b2 = await s.ssoEnter({ role: 'teacher', uid: '77', sid: '0456' });
  assert.equal((await post(s, b2.cookie, { ...base, code: 'X2', externalStudentId: '0123' })).status, 403);

  // The real class teacher, launched from the student's page, can.
  const a = await s.ssoEnter({ role: 'teacher', uid: '12', sid: '0123' });
  const ok = await post(s, a.cookie, { ...base, code: 'Y', externalStudentId: '0123' });
  assert.equal(ok.status, 201);
  const child = await ok.json();
  assert.equal(child.externalStudentId, '0123');

  // No oracle: "taken by someone else" looks exactly like "not allowed".
  const c = await s.ssoEnter({ role: 'teacher', uid: '13', sid: '0123' });
  const taken = await post(s, c.cookie, { ...base, code: 'Z', externalStudentId: '0123' });
  assert.equal(taken.status, 403);
  assert.deepEqual(await taken.json(), GENERIC);

  // PATCH follows the same rule; keeping or clearing one's own link is fine.
  const other = await (await post(s, b.cookie, { ...base, code: 'P' })).json();
  const patch = await fetch(`${s.url}/api/children/${other.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: b.cookie }, body: JSON.stringify({ externalStudentId: '0789' }),
  });
  assert.equal(patch.status, 403);
  assert.deepEqual(await patch.json(), GENERIC);
  const keep = await fetch(`${s.url}/api/children/${child.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', cookie: (await s.ssoEnter({ role: 'teacher', uid: '12' })).cookie },
    body: JSON.stringify({ externalStudentId: '0123', note: 'n' }),
  });
  assert.equal(keep.status, 200, 'unchanged value on own child');

  // The director may link any number, and sees the real duplicate message.
  const d = await s.ssoEnter({ role: 'director', uid: 'admin' });
  assert.equal((await post(s, d.cookie, { ...base, code: 'D1', externalStudentId: '0999' })).status, 201);
  const dup = await post(s, d.cookie, { ...base, code: 'D2', externalStudentId: '0123' });
  assert.equal(dup.status, 409);
  assert.deepEqual(await dup.json(), { error: '이미 등록된 학생입니다' });

  // /api/me tells the page which student this session was launched for.
  assert.equal((await (await fetch(`${s.url}/api/me`, { headers: { cookie: a.cookie } })).json()).launchStudentId, '0123');
  assert.equal((await (await fetch(`${s.url}/api/me`, { headers: { cookie: b.cookie } })).json()).launchStudentId, null);
});

function raw(port, reqLine) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(`${reqLine}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let d = '';
    c.on('data', (x) => { d += x; });
    c.on('end', () => resolve(d.split('\r\n')[0]));
    c.on('error', reject);
  });
}

// F3: with the flag off the legacy pages are 404 at every spelling of their path.
test('F3: legacy pages are 404 at every path spelling', async (t) => {
  const s = await startTestServer({ config: { allowPasswordLogin: false } });
  t.after(s.close);
  const port = new URL(s.url).port;
  for (const p of ['/login.html', '//login.html', '/./login.html', '/js/./login.js', '//invite.html', '/js//invite.js',
    '/x/../login.html', '/%2e/login.html', '/.%2flogin.html', '//%69nvite.html', '/JS/./LOGIN.JS', '/reset.html']) {
    assert.match(await raw(port, `GET ${p} HTTP/1.1`), / 404 /, p);
  }
  assert.match(await raw(port, 'GET //index.html HTTP/1.1'), / 200 /, 'ordinary pages still work');
});
