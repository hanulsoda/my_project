'use strict';
const { startTestServer } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { listPassages, getPassage } = require('../server/passages');

const WORD_RANGES = { elementary: [60, 100], middle: [100, 160], high: [150, 220] };
const MIN_FONT = { elementary: 32, middle: 28, high: 26 };
const wordCount = (text) => text.trim().split(/\s+/).length;

test('passages per grade band', async (t) => {
  for (const [band, [min, max]] of Object.entries(WORD_RANGES)) {
    await t.test(band, () => {
      const list = listPassages(band);
      assert.equal(list.filter((p) => p.kind === 'reference').length, 1, 'exactly one reference');
      assert.ok(list.filter((p) => p.kind === 'new').length >= 2, 'at least two new');
      for (const p of list) {
        assert.deepEqual(Object.keys(p).sort(), ['fontPx', 'id', 'kind', 'lineHeight', 'text', 'title']);
        assert.ok(['reference', 'new'].includes(p.kind));
        assert.ok(p.title && /[가-힣]/.test(p.text), `${p.id} is Korean`);
        const n = wordCount(p.text);
        assert.ok(n >= min && n <= max, `${p.id}: ${n} words not in ${min}-${max}`);
        assert.ok(p.fontPx >= MIN_FONT[band], `${p.id} fontPx ${p.fontPx}`);
        assert.ok(p.lineHeight >= 1.8, `${p.id} lineHeight ${p.lineHeight}`);
      }
    });
  }

  await t.test('font size shrinks as the grade band grows', () => {
    const px = (b) => listPassages(b)[0].fontPx;
    assert.ok(px('elementary') > px('middle') && px('middle') > px('high'));
  });

  await t.test('ids are unique and getPassage round-trips', () => {
    const all = Object.keys(WORD_RANGES).flatMap(listPassages);
    assert.equal(new Set(all.map((p) => p.id)).size, all.length);
    for (const p of all) assert.deepEqual(getPassage(p.id), p);
    assert.equal(getPassage('nope'), null);
    assert.equal(getPassage(undefined), null);
    assert.equal(getPassage('__proto__'), null);
  });

  await t.test('unknown grade band yields an empty list', () => {
    assert.deepEqual(listPassages('college'), []);
  });
});

test('GET /api/passages', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const cookie = await srv.loginAs('teacher');

  await t.test('requires login', async () => {
    assert.equal((await fetch(`${srv.url}/api/passages?gradeBand=middle`)).status, 401);
  });
  await t.test('returns the band list', async () => {
    const res = await fetch(`${srv.url}/api/passages?gradeBand=middle`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), listPassages('middle'));
  });
  await t.test('400 for missing or unknown gradeBand', async () => {
    assert.equal((await fetch(`${srv.url}/api/passages`, { headers: { cookie } })).status, 400);
    assert.equal((await fetch(`${srv.url}/api/passages?gradeBand=college`, { headers: { cookie } })).status, 400);
  });
});
