'use strict';
const { startTestServer } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');

const DAY = 86400000;
const SCREEN = { w: 1280, h: 720 };
const STEP = 10;
const REF = 'el-ref-sparrow'; // kind: reference
const NEW = 'el-new-snail'; // kind: new
const DISCLAIMER = '선별 지표이며 진단이 아닙니다.';

function call(srv, method, path, cookie, body) {
  return fetch(srv.url + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const WORDS = Array.from({ length: 5 }, (_, k) => ({ i: k, line: 0, x: 100 + k * 110, y: 100, w: 100, h: 30 }));
function readAll(words, ms = 250) {
  const samples = [];
  let t = 0;
  for (const w of words) {
    for (let e = 0; e < ms; e += STEP) {
      samples.push({ t, x: w.x + w.w / 2, y: w.y + w.h / 2 });
      t += STEP;
    }
  }
  return samples;
}
const payload = (over = {}) => ({ passageId: REF, screen: SCREEN, words: WORDS, samples: readAll(WORDS), ...over });

test('trend, share links, parent report', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const cookieA = await srv.loginAs('teacher');
  const cookieB = await srv.loginAs('teacher');
  const emailA = srv.db.prepare("SELECT email FROM users WHERE role = 'teacher' ORDER BY id").get().email;

  const childRes = await call(srv, 'POST', '/api/children', cookieA, {
    code: 'R-1', initials: 'KJ', gradeBand: 'elementary', consentDate: '2026-03-02',
  });
  const child = (await childRes.json()).id;
  const upload = async (over) => {
    srv.clock.advance(1000);
    const res = await call(srv, 'POST', `/api/children/${child}/sessions`, cookieA, payload(over));
    assert.equal(res.status, 201);
    return (await res.json()).id;
  };

  const ref1 = await upload();
  const ref2 = await upload();
  await upload({ passageId: NEW });
  const lowQuality = await upload({ samples: [] });

  await t.test('trend: reference sessions only, ordered, no word-level arrays', async () => {
    const res = await call(srv, 'GET', `/api/children/${child}/trend`, cookieA);
    assert.equal(res.status, 200);
    const trend = await res.json();
    assert.equal(trend.length, 3, 'ref1, ref2 and the zero-sample reference session; the new-kind one is excluded');
    for (let k = 1; k < trend.length; k++) assert.ok(trend[k].startedAt >= trend[k - 1].startedAt);
    assert.deepEqual(Object.keys(trend[0]).sort(), ['quality', 'regressions', 'skippedLines', 'startedAt', 'wpm']);
    assert.equal(trend[2].quality, 0);
  });

  await t.test('trend: 2 reference + 1 new session gives 2 entries', async () => {
    const c2 = (await (await call(srv, 'POST', '/api/children', cookieA, {
      code: 'R-2', initials: 'AB', gradeBand: 'elementary', consentDate: '2026-03-02',
    })).json()).id;
    for (const passageId of [REF, NEW, REF]) {
      const r = await call(srv, 'POST', `/api/children/${c2}/sessions`, cookieA, payload({ passageId }));
      assert.equal(r.status, 201);
      srv.clock.advance(1000);
    }
    const trend = await (await call(srv, 'GET', `/api/children/${c2}/trend`, cookieA)).json();
    assert.equal(trend.length, 2);
    assert.ok(trend[0].startedAt < trend[1].startedAt);
  });

  await t.test('trend: login required, foreign teacher and unknown child get 404', async () => {
    assert.equal((await call(srv, 'GET', `/api/children/${child}/trend`)).status, 401);
    assert.equal((await call(srv, 'GET', `/api/children/${child}/trend`, cookieB)).status, 404);
    assert.equal((await call(srv, 'GET', '/api/children/99999/trend', cookieA)).status, 404);
  });

  await t.test('share create: validates days', async () => {
    for (const days of [0, 91, 1.5, 'x', null, -3]) {
      const res = await call(srv, 'POST', `/api/sessions/${ref1}/share`, cookieA, { days });
      assert.equal(res.status, 400, `days=${JSON.stringify(days)}`);
    }
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM share_links').get().n, 0);
  });

  await t.test('share create: login required', async () => {
    assert.equal((await call(srv, 'POST', `/api/sessions/${ref1}/share`, null, {})).status, 401);
  });

  await t.test('share create: defaults to 30 days, returns relative url', async () => {
    const res = await call(srv, 'POST', `/api/sessions/${ref1}/share`, cookieA, {});
    assert.equal(res.status, 201);
    const { token, url, expiresAt } = await res.json();
    assert.match(token, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(url, `/report.html?token=${token}`);
    assert.equal(expiresAt, srv.clock.t + 30 * DAY);
    const row = srv.db.prepare('SELECT * FROM share_links WHERE token = ?').get(token);
    assert.equal(row.session_id, ref1);
    assert.equal(row.expires_at, expiresAt);
    assert.equal(row.revoked_at, null);
  });

  await t.test('share create: body is optional and days is honoured', async () => {
    const res = await call(srv, 'POST', `/api/sessions/${ref1}/share`, cookieA);
    assert.equal(res.status, 201);
    const res7 = await call(srv, 'POST', `/api/sessions/${ref1}/share`, cookieA, { days: 7 });
    assert.equal((await res7.json()).expiresAt, srv.clock.t + 7 * DAY);
    const res90 = await call(srv, 'POST', `/api/sessions/${ref1}/share`, cookieA, { days: 90 });
    assert.equal(res90.status, 201);
  });

  await t.test('foreign teacher POST share: 404, no row created', async () => {
    const before = srv.db.prepare('SELECT COUNT(*) AS n FROM share_links').get().n;
    const res = await call(srv, 'POST', `/api/sessions/${ref1}/share`, cookieB, {});
    assert.equal(res.status, 404);
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM share_links').get().n, before);
    assert.equal((await call(srv, 'POST', '/api/sessions/99999/share', cookieA, {})).status, 404);
    assert.equal((await call(srv, 'POST', '/api/sessions/abc/share', cookieA, {})).status, 404);
  });

  // Time-travel tests outlive the 7-day login cookies; push their expiry out so later tests can still call guarded routes.
  const keepLoggedIn = () => srv.db.prepare('UPDATE auth_sessions SET expires_at = ?').run(srv.clock.t + 7 * DAY);

  async function share(sessionId, days) {
    const res = await call(srv, 'POST', `/api/sessions/${sessionId}/share`, cookieA, days === undefined ? {} : { days });
    assert.equal(res.status, 201);
    return res.json();
  }

  await t.test('report: public, 200, disclaimer, no identifying data, security headers', async () => {
    const { token } = await share(ref2);
    const res = await call(srv, 'GET', `/api/report/${token}`); // no cookie
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.disclaimer, DISCLAIMER);
    assert.deepEqual(body.child, { code: 'R-1', initials: 'KJ', gradeBand: 'elementary' });
    assert.equal(body.session.startedAt, srv.db.prepare('SELECT started_at FROM read_sessions WHERE id = ?').get(ref2).started_at);
    assert.equal(body.session.metrics.wordsRead, 5);
    assert.equal(body.trend.length, 3);
    assert.deepEqual(Object.keys(body).sort(), ['child', 'disclaimer', 'session', 'trend']);
    assert.deepEqual(Object.keys(body.session).sort(), ['metrics', 'startedAt']);
    assert.ok(!text.includes(emailA), 'no teacher email');
    assert.ok(!text.includes('teacher_id') && !text.includes('teacherId'));
    assert.ok(!text.includes(token), 'token is not echoed');
    for (const key of ['"id"', 'sessionId', 'childId', 'samples', '"words"']) assert.ok(!text.includes(key), key);
  });

  await t.test('report for a 0-sample low-quality session has empty word-level arrays', async () => {
    const { token } = await share(lowQuality);
    const body = await (await call(srv, 'GET', `/api/report/${token}`)).json();
    assert.equal(body.session.metrics.detail, 'line');
    assert.deepEqual(body.session.metrics.dwellMsByWord, []);
    assert.deepEqual(body.session.metrics.longDwellWords, []);
  });

  await t.test('report: random token 404, malformed token 404', async () => {
    const res = await call(srv, 'GET', '/api/report/not-a-real-token');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
    assert.equal((await call(srv, 'GET', '/api/report/' + 'a'.repeat(5000))).status, 404);
  });

  await t.test('report: expiry boundary and 31 days later gives 410', async () => {
    const { token } = await share(ref1, 30);
    assert.equal((await call(srv, 'GET', `/api/report/${token}`)).status, 200);
    srv.clock.advance(30 * DAY - 1);
    assert.equal((await call(srv, 'GET', `/api/report/${token}`)).status, 200);
    srv.clock.advance(1); // now >= expires_at
    const res = await call(srv, 'GET', `/api/report/${token}`);
    assert.equal(res.status, 410);
    assert.deepEqual(await res.json(), { error: 'gone' });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    keepLoggedIn();
  });

  await t.test('report: 31 days later gives 410', async () => {
    const { token } = await share(ref1);
    srv.clock.advance(31 * DAY);
    assert.equal((await call(srv, 'GET', `/api/report/${token}`)).status, 410);
    keepLoggedIn();
  });

  await t.test('foreign teacher DELETE: 404 and the link still works', async () => {
    const { token } = await share(ref1);
    assert.equal((await call(srv, 'DELETE', `/api/share/${token}`, cookieB)).status, 404);
    assert.equal(srv.db.prepare('SELECT revoked_at FROM share_links WHERE token = ?').get(token).revoked_at, null);
    assert.equal((await call(srv, 'GET', `/api/report/${token}`)).status, 200);
    assert.equal((await call(srv, 'DELETE', '/api/share/unknown-token', cookieA)).status, 404);
  });

  await t.test('DELETE requires login', async () => {
    const { token } = await share(ref1);
    assert.equal((await call(srv, 'DELETE', `/api/share/${token}`)).status, 401);
    assert.equal((await call(srv, 'GET', `/api/report/${token}`)).status, 200);
  });

  await t.test('owner DELETE: 204 empty body, then report is 410', async () => {
    const { token } = await share(ref1);
    const res = await call(srv, 'DELETE', `/api/share/${token}`, cookieA);
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
    assert.equal(srv.db.prepare('SELECT revoked_at FROM share_links WHERE token = ?').get(token).revoked_at, srv.clock.t);
    const gone = await call(srv, 'GET', `/api/report/${token}`);
    assert.equal(gone.status, 410);
    assert.deepEqual(await gone.json(), { error: 'gone' });
  });

  await t.test('list shares: newest first, revokedAt null, then set to the clock time after DELETE', async () => {
    const c = (await (await call(srv, 'POST', '/api/children', cookieA, {
      code: 'R-4', initials: 'LS', gradeBand: 'elementary', consentDate: '2026-03-02',
    })).json()).id;
    const sid = (await (await call(srv, 'POST', `/api/children/${c}/sessions`, cookieA, payload())).json()).id;
    const first = await share(sid, 5);
    const second = await share(sid, 10);
    const res = await call(srv, 'GET', `/api/sessions/${sid}/shares`, cookieA);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [
      { token: second.token, expiresAt: second.expiresAt, revokedAt: null },
      { token: first.token, expiresAt: first.expiresAt, revokedAt: null },
    ]);
    srv.clock.advance(1234);
    assert.equal((await call(srv, 'DELETE', `/api/share/${first.token}`, cookieA)).status, 204);
    const after = await (await call(srv, 'GET', `/api/sessions/${sid}/shares`, cookieA)).json();
    assert.deepEqual(after.map((l) => l.token), [second.token, first.token]);
    assert.equal(after[0].revokedAt, null);
    assert.equal(after[1].revokedAt, srv.clock.t);
  });

  await t.test('list shares: only that session, and [] when it has no links', async () => {
    const c = (await (await call(srv, 'POST', '/api/children', cookieA, {
      code: 'R-5', initials: 'EM', gradeBand: 'elementary', consentDate: '2026-03-02',
    })).json()).id;
    const sid = (await (await call(srv, 'POST', `/api/children/${c}/sessions`, cookieA, payload())).json()).id;
    const res = await call(srv, 'GET', `/api/sessions/${sid}/shares`, cookieA);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  await t.test('list shares: login required; foreign teacher and missing session get 404 with no tokens', async () => {
    const { token } = await share(ref1);
    assert.equal((await call(srv, 'GET', `/api/sessions/${ref1}/shares`)).status, 401);
    const foreign = await call(srv, 'GET', `/api/sessions/${ref1}/shares`, cookieB);
    assert.equal(foreign.status, 404);
    const text = await foreign.text();
    assert.ok(!text.includes(token));
    assert.deepEqual(JSON.parse(text), { error: 'not found' });
    assert.equal((await call(srv, 'GET', '/api/sessions/99999/shares', cookieA)).status, 404);
    assert.equal((await call(srv, 'GET', '/api/sessions/abc/shares', cookieA)).status, 404);
  });

  await t.test('lost token: list -> DELETE -> public report 410, without the POST response', async () => {
    const c = (await (await call(srv, 'POST', '/api/children', cookieA, {
      code: 'R-6', initials: 'LT', gradeBand: 'elementary', consentDate: '2026-03-02',
    })).json()).id;
    const sid = (await (await call(srv, 'POST', `/api/children/${c}/sessions`, cookieA, payload())).json()).id;
    const { token: forgotten } = await share(sid);
    const [{ token }] = await (await call(srv, 'GET', `/api/sessions/${sid}/shares`, cookieA)).json();
    assert.equal((await call(srv, 'GET', `/api/report/${token}`)).status, 200);
    assert.equal((await call(srv, 'DELETE', `/api/share/${token}`, cookieA)).status, 204);
    assert.equal((await call(srv, 'GET', `/api/report/${forgotten}`)).status, 410);
  });

  await t.test('report stays viewable after consent is cleared while the link is valid', async () => {
    const { token } = await share(ref1);
    assert.equal((await call(srv, 'PATCH', `/api/children/${child}`, cookieA, { consentDate: null })).status, 200);
    assert.equal((await call(srv, 'GET', `/api/report/${token}`)).status, 200);
  });

  await t.test('deleting the child removes the link (404)', async () => {
    const c3 = (await (await call(srv, 'POST', '/api/children', cookieA, {
      code: 'R-3', initials: 'ZZ', gradeBand: 'elementary', consentDate: '2026-03-02',
    })).json()).id;
    const sid = (await (await call(srv, 'POST', `/api/children/${c3}/sessions`, cookieA, payload())).json()).id;
    const { token } = await share(sid);
    assert.equal((await call(srv, 'DELETE', `/api/children/${c3}`, cookieA)).status, 204);
    assert.equal((await call(srv, 'GET', `/api/report/${token}`)).status, 404);
  });
});
