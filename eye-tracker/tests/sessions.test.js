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

const SCREEN = { w: 1280, h: 720 };
const STEP = 10;
const PASSAGE_ID = 'el-ref-sparrow'; // kind: reference
const NEW_PASSAGE_ID = 'el-new-snail'; // kind: new

// One line of `n` words, each 100x30 px, 110 px apart.
function makeWords(n) {
  return Array.from({ length: n }, (_, k) => ({ i: k, line: 0, x: 100 + k * 110, y: 100, w: 100, h: 30 }));
}

// Samples dwelling `ms` on every word in order.
function readAll(words, ms = 250, t0 = 0) {
  const samples = [];
  let t = t0;
  for (const w of words) {
    for (let e = 0; e < ms; e += STEP) {
      samples.push({ t, x: w.x + w.w / 2, y: w.y + w.h / 2 });
      t += STEP;
    }
  }
  return samples;
}

const WORDS = makeWords(5);
const payload = (over = {}) => ({ passageId: PASSAGE_ID, screen: SCREEN, words: WORDS, samples: readAll(WORDS), ...over });

test('reading sessions', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const cookieA = await srv.loginAs('teacher');
  const cookieB = await srv.loginAs('teacher');
  const adminCookie = await srv.loginAs('admin');

  async function makeChild(cookie, over = {}) {
    const res = await call(srv, 'POST', '/api/children', cookie, {
      code: `C-${Math.random().toString(36).slice(2, 8)}`, initials: 'KJ', gradeBand: 'elementary', consentDate: '2026-03-02', ...over,
    });
    assert.equal(res.status, 201);
    return (await res.json()).id;
  }
  const upload = (cookie, childId, body) => call(srv, 'POST', `/api/children/${childId}/sessions`, cookie, body);

  const child = await makeChild(cookieA);

  await t.test('requires login', async () => {
    assert.equal((await upload(null, child, payload())).status, 401);
    assert.equal((await call(srv, 'GET', `/api/children/${child}/sessions`)).status, 401);
    assert.equal((await call(srv, 'GET', '/api/sessions/1')).status, 401);
  });

  await t.test('no consent date (stored as empty string): 403 consent_required', async () => {
    // creating without consentDate stores ''
    const res0 = await call(srv, 'POST', '/api/children', cookieA, { code: 'NC-1', initials: 'XX', gradeBand: 'elementary' });
    const id = (await res0.json()).id;
    assert.equal(srv.db.prepare('SELECT consent_date FROM children WHERE id = ?').get(id).consent_date, '');
    const res = await upload(cookieA, id, payload());
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'consent_required' });
    assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM read_sessions WHERE child_id = ?').get(id).n, 0);
  });

  await t.test('consent is checked before body validation', async () => {
    const res0 = await call(srv, 'POST', '/api/children', cookieA, { code: 'NC-2', initials: 'XX', gradeBand: 'elementary' });
    const id = (await res0.json()).id;
    assert.equal((await upload(cookieA, id, { nonsense: true })).status, 403);
  });

  let sessionId;
  await t.test('consented child: 201 with server-computed metrics', async () => {
    const res = await upload(cookieA, child, payload());
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(typeof body.id, 'number');
    assert.equal(body.metrics.wordsRead, 5);
    assert.equal(body.metrics.completed, true);
    assert.equal(body.metrics.detail, 'word');
    assert.ok(body.metrics.quality >= 0.6);
    assert.equal(body.metrics.dwellMsByWord.length, 5, 'high quality keeps word-level dwell in the POST body');
    assert.ok(body.metrics.dwellMsByWord.every((v) => v > 0));
    sessionId = body.id;
  });

  await t.test('kind comes from the passage and client-supplied kind/title are ignored; metrics are persisted', async () => {
    const res = await upload(cookieA, child, payload({ passageId: NEW_PASSAGE_ID, kind: 'reference', title: 'forged' }));
    assert.equal(res.status, 201);
    const { id, metrics } = await res.json();
    const row = srv.db.prepare('SELECT * FROM read_sessions WHERE id = ?').get(id);
    assert.equal(row.kind, 'new');
    assert.equal(row.passage_id, NEW_PASSAGE_ID);
    assert.deepEqual(JSON.parse(row.metrics_json), metrics);
    assert.equal(row.screen_w, 1280);
    assert.equal(row.screen_h, 720);
  });

  await t.test('started_at uses the injected clock', async () => {
    srv.clock.advance(5000);
    const { id } = await (await upload(cookieA, child, payload())).json();
    assert.equal(srv.db.prepare('SELECT started_at FROM read_sessions WHERE id = ?').get(id).started_at, srv.clock.t);
  });

  await t.test('samples are sorted by t before metrics are computed and stored', async () => {
    const shuffled = readAll(WORDS).reverse();
    const res = await upload(cookieA, child, payload({ samples: shuffled }));
    assert.equal(res.status, 201);
    const { id, metrics } = await res.json();
    assert.equal(metrics.wordsRead, 5);
    assert.equal(metrics.regressions, 0);
    const stored = JSON.parse(srv.db.prepare('SELECT samples_json FROM read_sessions WHERE id = ?').get(id).samples_json);
    for (let k = 1; k < stored.length; k++) assert.ok(stored[k].t >= stored[k - 1].t);
    assert.equal(stored.length, shuffled.length);
  });

  await t.test('clearing consent via PATCH re-blocks uploads', async () => {
    const c = await makeChild(cookieA);
    assert.equal((await upload(cookieA, c, payload())).status, 201);
    assert.equal((await call(srv, 'PATCH', `/api/children/${c}`, cookieA, { consentDate: null })).status, 200);
    const res = await upload(cookieA, c, payload());
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'consent_required' });
    assert.equal((await call(srv, 'PATCH', `/api/children/${c}`, cookieA, { consentDate: '2026-04-01' })).status, 200);
    assert.equal((await upload(cookieA, c, payload())).status, 201);
  });

  await t.test('zero samples: 201, quality 0, detail view returns empty dwell array', async () => {
    const res = await upload(cookieA, child, payload({ samples: [] }));
    assert.equal(res.status, 201);
    const { id, metrics } = await res.json();
    assert.equal(metrics.quality, 0);
    assert.equal(metrics.wordsRead, 0);
    assert.deepEqual(metrics.dwellMsByWord, [], 'POST body applies the quality rule');
    assert.deepEqual(metrics.longDwellWords, []);
    const detail = await (await call(srv, 'GET', `/api/sessions/${id}`, cookieA)).json();
    assert.deepEqual(detail.metrics.dwellMsByWord, []);
    assert.deepEqual(detail.metrics.longDwellWords, []);
    assert.equal(detail.metrics.quality, 0);
  });

  await t.test('GET /api/sessions/:id: full detail; word-level data kept when quality is high', async () => {
    const res = await call(srv, 'GET', `/api/sessions/${sessionId}`, cookieA);
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.id, sessionId);
    assert.equal(d.childId, child);
    assert.equal(d.passageId, PASSAGE_ID);
    assert.equal(d.kind, 'reference');
    assert.equal(typeof d.title, 'string');
    assert.deepEqual(d.screen, SCREEN);
    assert.equal(d.words.length, 5);
    assert.equal(d.samples.length, readAll(WORDS).length);
    assert.equal(d.metrics.detail, 'word');
    assert.equal(d.metrics.dwellMsByWord.length, 5);
    assert.ok(d.metrics.dwellMsByWord.every((v) => v > 0));
  });

  await t.test('low-quality session: detail hides word-level arrays but keeps the rest', async () => {
    // One fixation on a word, then three fixations on empty screen: 1/4 assigned => quality 0.25.
    const stray = [];
    for (let k = 0; k < 75; k++) stray.push({ t: 1000 + k * STEP, x: 300 + 200 * Math.floor(k / 25), y: 600 });
    const samples = [...readAll(WORDS.slice(0, 1)), ...stray];
    const posted = await (await upload(cookieA, child, payload({ samples }))).json();
    assert.equal(posted.metrics.detail, 'line');
    assert.deepEqual(posted.metrics.dwellMsByWord, [], 'POST body applies the quality rule');
    assert.deepEqual(posted.metrics.longDwellWords, []);
    const { id } = posted;
    const d = await (await call(srv, 'GET', `/api/sessions/${id}`, cookieA)).json();
    assert.equal(d.metrics.detail, 'line');
    assert.deepEqual(d.metrics.dwellMsByWord, []);
    assert.deepEqual(d.metrics.longDwellWords, []);
    assert.ok(d.metrics.quality < 0.6);
  });

  await t.test('list is chronological, omits samples/words, and applies the quality rule', async () => {
    const c = await makeChild(cookieA);
    const first = await (await upload(cookieA, c, payload())).json();
    srv.clock.advance(1000);
    const second = await (await upload(cookieA, c, payload({ passageId: NEW_PASSAGE_ID, samples: [] }))).json();
    srv.clock.advance(1000);
    const third = await (await upload(cookieA, c, payload())).json();

    const res = await call(srv, 'GET', `/api/children/${c}/sessions`, cookieA);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.deepEqual(list.map((s) => s.id), [first.id, second.id, third.id]);
    for (const s of list) assert.deepEqual(Object.keys(s).sort(), ['id', 'kind', 'metrics', 'passageId', 'startedAt']);
    assert.ok(list[0].startedAt < list[1].startedAt && list[1].startedAt < list[2].startedAt);
    assert.equal(list[1].kind, 'new');
    assert.equal(list[0].metrics.dwellMsByWord.length, 5);
    assert.deepEqual(list[1].metrics.dwellMsByWord, []);
  });

  await t.test('list is ordered by started_at even when ids are not', async () => {
    const c = await makeChild(cookieA);
    const a = await (await upload(cookieA, c, payload())).json();
    const b = await (await upload(cookieA, c, payload())).json();
    srv.db.prepare('UPDATE read_sessions SET started_at = started_at + 100000 WHERE id = ?').run(a.id);
    const list = await (await call(srv, 'GET', `/api/children/${c}/sessions`, cookieA)).json();
    assert.deepEqual(list.map((s) => s.id), [b.id, a.id]);
  });

  await t.test('another teacher (and admin) get 404 everywhere, with one shared body', async () => {
    const bodies = [];
    for (const cookie of [cookieB, adminCookie]) {
      const attempts = [
        upload(cookie, child, payload()),
        call(srv, 'GET', `/api/children/${child}/sessions`, cookie),
        call(srv, 'GET', `/api/sessions/${sessionId}`, cookie),
        call(srv, 'GET', '/api/sessions/999999', cookie),
        call(srv, 'GET', '/api/children/999999/sessions', cookie),
      ];
      for (const p of attempts) {
        const res = await p;
        assert.equal(res.status, 404);
        bodies.push(JSON.stringify(await res.json()));
      }
    }
    assert.equal(new Set(bodies).size, 1);
  });

  await t.test('ownership is checked before consent (foreign child without consent: 404, not 403)', async () => {
    const res0 = await call(srv, 'POST', '/api/children', cookieA, { code: 'NC-3', initials: 'XX', gradeBand: 'elementary' });
    const id = (await res0.json()).id;
    assert.equal((await upload(cookieB, id, payload())).status, 404);
  });

  await t.test('non-numeric ids: 404', async () => {
    assert.equal((await upload(cookieA, 'abc', payload())).status, 404);
    assert.equal((await call(srv, 'GET', '/api/sessions/abc', cookieA)).status, 404);
    assert.equal((await call(srv, 'GET', '/api/children/abc/sessions', cookieA)).status, 404);
  });

  await t.test('deleting the child cascades to its sessions', async () => {
    const c = await makeChild(cookieA);
    const { id } = await (await upload(cookieA, c, payload())).json();
    assert.equal((await call(srv, 'DELETE', `/api/children/${c}`, cookieA)).status, 204);
    assert.equal((await call(srv, 'GET', `/api/sessions/${id}`, cookieA)).status, 404);
  });

  await t.test('malformed input: 400, never a crash', async () => {
    const cases = {
      'unknown passage': payload({ passageId: 'nope' }),
      'passageId not a string': payload({ passageId: 7 }),
      'passageId missing': (() => { const p = payload(); delete p.passageId; return p; })(),
      'screen missing': payload({ screen: undefined }),
      'screen.w zero': payload({ screen: { w: 0, h: 720 } }),
      'screen.h negative': payload({ screen: { w: 1280, h: -1 } }),
      'screen.w string': payload({ screen: { w: '1280', h: 720 } }),
      'words empty': payload({ words: [] }),
      'words not array': payload({ words: {} }),
      'words > 2000': payload({ words: makeWords(2001), samples: [] }),
      'word not object': payload({ words: [null] }),
      'word i mismatch': payload({ words: WORDS.map((w, k) => (k === 2 ? { ...w, i: 7 } : w)) }),
      'word field string': payload({ words: WORDS.map((w, k) => (k === 1 ? { ...w, x: '10' } : w)) }),
      'word field missing': payload({ words: WORDS.map((w, k) => { if (k === 1) { const c = { ...w }; delete c.h; return c; } return w; }) }),
      'samples missing': (() => { const p = payload(); delete p.samples; return p; })(),
      'samples not array': payload({ samples: 'abc' }),
      'sample null': payload({ samples: [{ t: 0, x: 1, y: 1 }, null] }),
      'sample number': payload({ samples: [5] }),
      'sample array': payload({ samples: [[0, 1, 1]] }),
      't missing': payload({ samples: [{ x: 1, y: 1 }] }),
      't string': payload({ samples: [{ t: '0', x: 1, y: 1 }] }),
      'x string': payload({ samples: [{ t: 0, x: '1', y: 1 }] }),
      'x missing': payload({ samples: [{ t: 0, y: 1 }] }),
      'y undefined-ish object': payload({ samples: [{ t: 0, x: 1, y: {} }] }),
    };
    for (const [name, body] of Object.entries(cases)) {
      const res = await upload(cookieA, child, body);
      assert.equal(res.status, 400, name);
      assert.equal(typeof (await res.json()).error, 'string', name);
    }
    for (const raw of [null, [], 'str', 5]) {
      assert.equal((await upload(cookieA, child, raw)).status, 400, JSON.stringify(raw));
    }
    const bad = await fetch(`${srv.url}/api/children/${child}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieA }, body: '{"passageId":',
    });
    assert.equal(bad.status, 400);
  });

  await t.test('null x/y samples are accepted (lost gaze)', async () => {
    const samples = [...readAll(WORDS), { t: 99999, x: null, y: null }];
    assert.equal((await upload(cookieA, child, payload({ samples }))).status, 201);
  });

  await t.test('100,000 samples are accepted; 100,001 get 413', async () => {
    const mk = (n) => Array.from({ length: n }, (_, k) => ({ t: k, x: null, y: null }));
    const ok = await upload(cookieA, child, payload({ samples: mk(100000) }));
    assert.equal(ok.status, 201);
    const tooMany = await upload(cookieA, child, payload({ samples: mk(100001) }));
    assert.equal(tooMany.status, 413);
  });

  await t.test('upload route has a 10mb cap; the global 1mb cap is unchanged', async () => {
    const huge = await upload(cookieA, child, payload({ samples: [], pad: 'x'.repeat(11 * 1024 * 1024) }));
    assert.equal(huge.status, 413);
    const overOneMb = await call(srv, 'POST', '/api/children', cookieA, {
      code: 'BIG-1', initials: 'XX', gradeBand: 'elementary', pad: 'x'.repeat(1.5 * 1024 * 1024),
    });
    assert.equal(overOneMb.status, 413);
  });
});
