'use strict';
// Multi-page passages: the upload contract (optional `page` on words and samples) and the
// line-level analysis per page (server/line-metrics.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeLineMetrics } = require('../server/line-metrics');
const sim = require('./gaze-sim');
const { startTestServer } = require('./helpers');

const SCREEN = { w: 1280, h: 1100 };
const LINES_PER_PAGE = 6;

// Page-local layout (same y on every page), global line ids continuing across pages.
function pagedWords(nPages, nLines = LINES_PER_PAGE) {
  const L = sim.simLayout({ nLines });
  const words = [];
  for (let p = 0; p < nPages; p++) {
    for (const w of L.words) words.push({ ...w, i: words.length, line: w.line + p * nLines, page: p });
  }
  return { L, words };
}

// A reader that reads `orders[p]` (page-local line ids) on page p, one page after the other.
function pagedReading(L, orders, { seed = 1, offsets = [] } = {}) {
  const samples = [];
  const truth = new Map(); // tStart -> global line
  let t = 0;
  orders.forEach((order, p) => {
    const rng = sim.makeRng(seed + p * 101);
    const normal = sim.makeNormal(rng);
    const plan = sim.planLines(L, order, rng, normal);
    const off = offsets[p] ?? 0;
    const r = sim.renderPlan(plan, { offset: () => off, seed: seed + 7 + p });
    for (const [ts, line] of r.truth) truth.set(ts + t, line + p * LINES_PER_PAGE);
    for (const s of r.samples) samples.push({ ...s, t: s.t + t, page: p });
    t += r.end;
    // the gaze goes to the "다음" button and the page turns: a short gap
    for (let e = 0; e < 600; e += sim.STEP) { samples.push({ t, x: null, y: null, page: p }); t += sim.STEP; }
  });
  return { samples, truth };
}

const all = (n) => Array.from({ length: n }, (_, k) => k);
const strip = (arr) => arr.map(({ page, ...rest }) => rest);

test('line metrics, multi-page', async (t) => {
  await t.test('single page: page:0 fields change nothing (same result as without pages)', () => {
    const L = sim.simLayout({ nLines: 8 });
    const rng = sim.makeRng(5);
    const r = sim.renderPlan(sim.planLines(L, all(8), rng, sim.makeNormal(rng)), { seed: 9 });
    const plain = computeLineMetrics(r.samples, L.words, SCREEN);
    const tagged = computeLineMetrics(r.samples.map((s) => ({ ...s, page: 0 })), L.words.map((w) => ({ ...w, page: 0 })), SCREEN);
    assert.deepEqual(tagged, plain);
    const dbgPlain = computeLineMetrics(r.samples, L.words, SCREEN, { debug: true });
    const dbgTagged = computeLineMetrics(r.samples, L.words.map((w) => ({ ...w, page: 0 })), SCREEN, { debug: true });
    assert.deepEqual(dbgTagged, dbgPlain);
  });

  await t.test('two pages read in full: all lines read, completed, reliable, figures add up', () => {
    const { L, words } = pagedWords(2);
    let reliable = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const { samples } = pagedReading(L, [all(6), all(6)], { seed });
      const m = computeLineMetrics(samples, words, SCREEN);
      assert.equal(m.totalLines, 12);
      assert.equal(m.lineDwellMs.length, 12);
      assert.equal(m.linesRead, 12, `seed ${seed}`);
      assert.equal(m.completed, true, `seed ${seed}`);
      assert.equal(m.skippedLines, 0);
      assert.ok(m.lineDwellMs.every((d) => d > 0), 'every line has dwell');
      // the combination is the per-page analysis added up
      const per = [0, 1].map((p) => computeLineMetrics(
        strip(samples.filter((s) => s.page === p)), strip(words.filter((w) => w.page === p)), SCREEN,
      ));
      assert.deepEqual(m.lineDwellMs, [...per[0].lineDwellMs, ...per[1].lineDwellMs]);
      assert.equal(m.wordsRead, per[0].wordsRead + per[1].wordsRead);
      assert.equal(m.regressions, per[0].regressions + per[1].regressions);
      // reading time is wall-clock from the first to the last counted fixation, page turn included
      const dbg = computeLineMetrics(samples, words, SCREEN, { debug: true });
      const counted = dbg.debug.fixations.filter((f) => f.line !== null && dbg.debug.passes[f.pass].counted);
      const wall = (Math.max(...counted.map((f) => f.tEnd)) - Math.min(...counted.map((f) => f.tStart))) / 1000;
      assert.ok(Math.abs(m.durationSec - wall) < 1e-9, `${m.durationSec} vs ${wall}`);
      assert.ok(m.durationSec > per[0].durationSec + per[1].durationSec + 0.5, 'includes the ~0.6 s page turn');
      assert.ok(Math.abs(m.wpm - (m.wordsRead / m.durationSec) * 60) < 1e-9);
      assert.equal(m.reliable, per[0].reliable && per[1].reliable);
      if (m.reliable) reliable++;
      for (const v of Object.values(m)) if (typeof v === 'number') assert.ok(Number.isFinite(v));
    }
    assert.ok(reliable >= 4, `clean two-page readings should be reliable (${reliable}/5)`);
  });

  await t.test('a different gaze offset on each page is corrected per page', () => {
    const { L, words } = pagedWords(2);
    const { samples, truth } = pagedReading(L, [all(6), all(6)], { seed: 11, offsets: [150, 40] });
    const m = computeLineMetrics(samples, words, SCREEN, { debug: true });
    assert.equal(m.linesRead, 12);
    assert.equal(m.completed, true);
    let ok = 0; let tot = 0;
    for (const f of m.debug.fixations) {
      if (!truth.has(f.tStart)) continue;
      tot++;
      if (f.line === truth.get(f.tStart)) ok++;
    }
    assert.ok(tot > 50 && ok / tot >= 0.95, `accuracy ${ok}/${tot}`);
    assert.equal(m.debug.pages.length, 2);
  });

  await t.test('second page never looked at: not completed, half the lines, 참고용', () => {
    const { L, words } = pagedWords(2);
    const { samples } = pagedReading(L, [all(6)], { seed: 3 });
    const m = computeLineMetrics(samples, words, SCREEN);
    assert.equal(m.totalLines, 12);
    assert.equal(m.linesRead, 6);
    assert.equal(m.completed, false);
    assert.equal(m.reliable, false);
    assert.deepEqual(m.lineDwellMs.slice(6), [0, 0, 0, 0, 0, 0]);
  });

  await t.test('stopping early on page 2 counts as not completed', () => {
    const { L, words } = pagedWords(2);
    const { samples } = pagedReading(L, [all(6), [0, 1, 2]], { seed: 4 });
    const m = computeLineMetrics(samples, words, SCREEN);
    assert.equal(m.linesRead, 9);
    assert.equal(m.completed, false);
  });

  await t.test('three pages, deterministic, garbage page values never throw', () => {
    const { L, words } = pagedWords(3);
    const { samples } = pagedReading(L, [all(6), all(6), all(6)], { seed: 21 });
    const a = computeLineMetrics(samples, words, SCREEN);
    const b = computeLineMetrics(samples, words, SCREEN);
    assert.deepEqual(a, b);
    assert.equal(a.totalLines, 18);
    assert.equal(a.linesRead, 18);
    const junk = samples.map((s, k) => ({ ...s, page: [undefined, -1, 'x', 1.5, 99][k % 5] }));
    const m = computeLineMetrics(junk, words.map((w, k) => (k === 3 ? { ...w, page: 'q' } : w)), SCREEN);
    for (const v of Object.values(m)) if (typeof v === 'number') assert.ok(Number.isFinite(v));
  });
});

// ---- upload contract -----------------------------------------------------------------------

function call(srv, method, path, cookie, body) {
  return fetch(srv.url + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test('upload with pages', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  const cookie = await srv.loginAs('teacher');
  const res = await call(srv, 'POST', '/api/children', cookie, { code: 'P-1', initials: 'PG', gradeBand: 'elementary', consentDate: '2026-03-02' });
  const childId = (await res.json()).id;
  const upload = (body) => call(srv, 'POST', `/api/children/${childId}/sessions`, cookie, body);

  const { L, words } = pagedWords(2);
  const { samples } = pagedReading(L, [all(6), all(6)], { seed: 2 });
  const body = (over = {}) => ({ passageId: 'el-ref-sparrow', screen: SCREEN, words, samples, ...over });

  await t.test('accepted; page kept on stored words and samples; metrics are the multi-page ones', async () => {
    const r = await upload(body());
    assert.equal(r.status, 201);
    const { id, metrics } = await r.json();
    assert.equal(metrics.totalLines, 12);
    const d = await (await call(srv, 'GET', `/api/sessions/${id}`, cookie)).json();
    assert.deepEqual(d.words.map((w) => w.page), words.map((w) => w.page));
    assert.equal(d.samples.filter((s) => s.page === 1).length, samples.filter((s) => s.page === 1).length);
    const again = await (await call(srv, 'POST', `/api/sessions/${id}/reanalyze`, cookie)).json();
    assert.deepEqual(again.metrics, metrics, 'reanalysis of the stored session gives the same figures');
  });

  await t.test('no page fields: stored exactly as before (no page key added)', async () => {
    const r = await upload(body({ words: strip(words.slice(0, 30)), samples: strip(samples.slice(0, 50)) }));
    assert.equal(r.status, 201);
    const d = await (await call(srv, 'GET', `/api/sessions/${(await r.json()).id}`, cookie)).json();
    assert.ok(d.words.every((w) => !('page' in w)));
    assert.ok(d.samples.every((s) => !('page' in s)));
  });

  await t.test('bad page values are rejected with 400', async () => {
    const bad = {
      'word page negative': body({ words: words.map((w, k) => (k === 0 ? { ...w, page: -1 } : w)) }),
      'word page fraction': body({ words: words.map((w, k) => (k === 70 ? { ...w, page: 1.5 } : w)) }),
      'word page string': body({ words: words.map((w, k) => (k === 70 ? { ...w, page: '1' } : w)) }),
      'word page huge': body({ words: words.map((w, k) => (k === 70 ? { ...w, page: 51 } : w)) }),
      'word pages out of order': body({ words: words.map((w, k) => (k === 70 ? { ...w, page: 0 } : w)) }),
      'later page reuses an earlier line': body({ words: words.map((w) => (w.page === 1 ? { ...w, line: w.line - 6 } : w)) }),
      'sample page negative': body({ samples: samples.map((s, k) => (k === 5 ? { ...s, page: -2 } : s)) }),
      'sample page fraction': body({ samples: samples.map((s, k) => (k === 5 ? { ...s, page: 0.5 } : s)) }),
      'sample page huge': body({ samples: samples.map((s, k) => (k === 5 ? { ...s, page: 1e9 } : s)) }),
      'sample page without such a page': body({ samples: samples.map((s, k) => (k === 5 ? { ...s, page: 2 } : s)) }),
    };
    for (const [name, b] of Object.entries(bad)) {
      const r = await upload(b);
      assert.equal(r.status, 400, name);
      assert.match((await r.json()).error, /page/, name);
    }
  });

  await t.test('word boxes outside the screen by more than 4 px are rejected (impossible geometry)', async () => {
    const at = (k, over) => body({ words: words.map((w, j) => (j === k ? { ...w, ...over } : w)) });
    for (const [name, b] of Object.entries({
      'below the screen': at(70, { y: SCREEN.h - 10, h: 32 }),
      'right of the screen': at(3, { x: SCREEN.w - 50, w: 60 }),
      'above the screen': at(0, { y: -6 }),
      'left of the screen': at(0, { x: -5 }),
    })) {
      const r = await upload(b);
      assert.equal(r.status, 400, name);
      assert.match((await r.json()).error, /outside the screen/, name);
    }
    for (const [name, b] of Object.entries({
      'rounding at the edge (4 px) is fine': at(0, { x: -4, y: -4 }),
      'touching the bottom right is fine': at(3, { x: SCREEN.w - 60, w: 64, y: SCREEN.h - 32, h: 36 }),
    })) {
      const r = await upload(b);
      assert.equal(r.status, 201, name);
    }
  });

  await t.test('page 50 is the largest allowed', async () => {
    const w = [{ i: 0, line: 0, x: 100, y: 100, w: 80, h: 30, page: 50 }];
    const r = await upload(body({ words: w, samples: [{ t: 0, x: 100, y: 100, page: 50 }] }));
    assert.equal(r.status, 201);
  });
});
