'use strict';
// Line-level analysis with automatic drift correction (server/line-metrics.js).
// Synthetic readers with a seeded RNG: results are deterministic, never flaky.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeLineMetrics, LINE_RELIABLE_MIN } = require('../server/line-metrics');
const { applyQualityRule } = require('../server/metrics');

const SCREEN = { w: 1280, h: 1100 };
const PITCH = 64;
const TOP = 200;
const STEP = 10;
const centreY = (line) => TOP + line * PITCH + 16;

// N lines of `perLine` words, x from 100 to 1100 (text width 1000), line pitch 64 px.
function layout(nLines, perLine = 10) {
  const words = [];
  for (let line = 0; line < nLines; line++) {
    for (let k = 0; k < perLine; k++) {
      words.push({ i: words.length, line, x: 100 + k * (1000 / perLine), y: TOP + line * PITCH, w: 1000 / perLine, h: 32 });
    }
  }
  return words;
}

// mulberry32
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeNormal(rng) {
  return () => {
    const u = Math.max(rng(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
}

// A reader that visits `order` (line indexes, in time order). Per line 8-10 fixations left to
// right; each fixation's position gets noise (x sigma 25, y sigma 40) and the whole gaze is
// shifted by offset(fraction of session elapsed). Return sweep to the next line's start.
// Returns samples plus the true line of every planned fixation keyed by its start time.
function reader(order, opts = {}) {
  const {
    seed = 1, offset = () => 0, fixMs = 150, sx = 25, sy = 40, lastLineFraction = 1, fixMsForLine = {},
  } = opts;
  const rng = makeRng(seed);
  const normal = makeNormal(rng);
  const plan = [];
  order.forEach((line, idx) => {
    const n = 8 + Math.floor(rng() * 3);
    const upto = idx === order.length - 1 ? Math.max(1, Math.round(n * lastLineFraction)) : n;
    for (let k = 0; k < upto; k++) {
      plan.push({
        line,
        x: 150 + (k * 900) / (n - 1) + normal() * sx,
        y: centreY(line) + normal() * sy,
        ms: fixMsForLine[line] ?? fixMs,
      });
    }
  });
  const total = plan.reduce((a, p) => a + p.ms, 0);
  const samples = [];
  const truth = new Map();
  let t = opts.t0 ?? 0;
  const start = t;
  for (const p of plan) {
    truth.set(t, p.line);
    const dy = offset((t - start) / total);
    for (let e = 0; e < p.ms; e += STEP) {
      samples.push({ t, x: p.x + (rng() - 0.5) * 2, y: p.y + dy + (rng() - 0.5) * 2 });
      t += STEP;
    }
  }
  return { samples, truth, firstStart: start, lastEnd: t - STEP, end: t };
}

const all = (n) => Array.from({ length: n }, (_, k) => k);
const nulls = (t0, ms) => Array.from({ length: ms / STEP }, (_, k) => ({ t: t0 + k * STEP, x: null, y: null }));

// Fraction of detected fixations assigned to the line the synthetic reader was really on, pooled
// over a fixed set of seeded sessions (one session has only 8 passes, so a single misread pass
// would swing it by 12%; the pooled figure is the stable measure). `naive` is the same fraction
// for plain nearest-line assignment of the uncorrected gaze, to show what the correction buys.
const SEEDS = Array.from({ length: 20 }, (_, k) => k + 1);
function pooledAccuracy(offset) {
  const words = layout(8);
  const centres = all(8).map(centreY);
  let ok = 0;
  let naive = 0;
  let total = 0;
  for (const seed of SEEDS) {
    const run = reader(all(8), { seed, offset });
    const m = computeLineMetrics(run.samples, words, SCREEN, { debug: true });
    for (const f of m.debug.fixations) {
      const truth = run.truth.get(f.tStart);
      if (f.line === truth) ok++;
      const near = centres.reduce((b, c, l) => (Math.abs(c - f.y) < Math.abs(centres[b] - f.y) ? l : b), 0);
      if (near === truth) naive++;
      total++;
    }
  }
  return { acc: ok / total, naive: naive / total };
}

test('line assignment accuracy, offset 0 baseline: >= 98%', () => {
  const { acc } = pooledAccuracy(() => 0);
  assert.ok(acc >= 0.98, `accuracy ${acc}`);
});

test('line assignment accuracy, constant offset +150 px (naive nearest line is 2-3 lines off): >= 95%', () => {
  const { acc, naive } = pooledAccuracy(() => 150);
  assert.ok(acc >= 0.95, `accuracy ${acc}`);
  assert.ok(naive < 0.2, `naive ${naive}`);
});

test('line assignment accuracy, constant offset -120 px: >= 95%', () => {
  const { acc, naive } = pooledAccuracy(() => -120);
  assert.ok(acc >= 0.95, `accuracy ${acc}`);
  assert.ok(naive < 0.2, `naive ${naive}`);
});

test('line assignment accuracy, linear drift 80 -> 220 px over the session: >= 90%', () => {
  const { acc, naive } = pooledAccuracy((f) => 80 + 140 * f);
  assert.ok(acc >= 0.9, `accuracy ${acc}`);
  assert.ok(naive < 0.2, `naive ${naive}`);
});

test('driftPx estimates the starting offset', () => {
  const words = layout(8);
  const m = computeLineMetrics(reader(all(8), { seed: 7, offset: () => 150 }).samples, words, SCREEN);
  assert.ok(Math.abs(m.driftPx - 150) < 25, `driftPx ${m.driftPx}`);
});

test('a skipped line (3 -> 5) is one skipped line', () => {
  const words = layout(8);
  const m = computeLineMetrics(reader([0, 1, 2, 3, 5, 6, 7], { seed: 11, offset: () => 100 }).samples, words, SCREEN);
  assert.equal(m.skippedLines, 1);
  assert.equal(m.linesRead, 7);
  assert.equal(m.regressions, 0);
});

test('re-reading the previous line once is one regression', () => {
  const words = layout(8);
  const m = computeLineMetrics(reader([0, 1, 2, 1, 2, 3, 4, 5, 6, 7], { seed: 12, offset: () => 100 }).samples, words, SCREEN);
  assert.equal(m.regressions, 1);
  assert.equal(m.skippedLines, 0);
  assert.equal(m.completed, true);
});

test('stopping after 4 of 8 lines: not completed, 4 lines read, wordsRead within one line', () => {
  const words = layout(8);
  const run = reader([0, 1, 2, 3], { seed: 13, offset: () => 150 });
  const m = computeLineMetrics([...run.samples, ...nulls(run.end, 1000)], words, SCREEN);
  assert.equal(m.completed, false);
  assert.equal(m.linesRead, 4);
  assert.equal(m.totalLines, 8);
  assert.ok(Math.abs(m.wordsRead - 40) <= 10, `wordsRead ${m.wordsRead}`);
  assert.equal(m.skippedLines, 0);
});

test('reading all lines: completed, every line read, every word read', () => {
  const words = layout(8);
  const m = computeLineMetrics(reader(all(8), { seed: 14, offset: () => -120 }).samples, words, SCREEN);
  assert.equal(m.completed, true);
  assert.equal(m.linesRead, 8);
  assert.equal(m.totalLines, 8);
  assert.ok(m.wordsRead >= 70, `wordsRead ${m.wordsRead}`);
  assert.equal(m.lineDwellMs.length, 8);
  assert.ok(m.lineDwellMs.every((d) => d > 0));
  assert.equal(m.reliable, true);
  // 40 px noise per fixation against a 0.6 x 64 px inlier band: about two thirds are inliers.
  assert.ok(m.quality >= LINE_RELIABLE_MIN, `quality ${m.quality}`);
});

test('a stray single fixation on the last line while on line 2 neither completes nor inflates wpm', () => {
  const words = layout(8);
  for (const offset of [0, 150]) {
    const base = reader([0, 1, 2], { seed: 15, offset: () => offset });
    const tail = nulls(base.end + 150, 1000);
    const without = computeLineMetrics([...base.samples, ...tail], words, SCREEN);
    // One fixation at the left end of the last line (a return-sweep-like jump: its own pass).
    const stray = Array.from({ length: 15 }, (_, k) => ({ t: base.end + k * STEP, x: 160, y: centreY(7) + offset }));
    const withStray = computeLineMetrics([...base.samples, ...stray, ...tail], words, SCREEN);
    assert.equal(withStray.completed, false, `offset ${offset}`);
    assert.equal(withStray.linesRead, 3, `offset ${offset}`);
    assert.ok(without.wpm > 0);
    assert.ok(withStray.wpm <= without.wpm * 1.1, `wpm ${withStray.wpm} vs ${without.wpm}`);
  }
});

test('a new line opened in the last 500 ms of the stream is ignored for progress; earlier it counts', () => {
  const words = layout(8);
  const base = reader([0, 1, 2], { seed: 16 });
  const late = [];
  for (let f = 0; f < 3; f++) {
    for (let e = 0; e < 150; e += STEP) late.push({ t: base.end + f * 150 + e, x: 150 + f * 100, y: centreY(3) });
  }
  const m = computeLineMetrics([...base.samples, ...late], words, SCREEN);
  assert.equal(m.linesRead, 3);
  const later = computeLineMetrics([...base.samples, ...late, ...nulls(base.end + 450, 1000)], words, SCREEN);
  assert.equal(later.linesRead, 4);
});

test('wpm matches a known synthetic reading rate within 10%', () => {
  const words = layout(8);
  const run = reader(all(8), { seed: 17, fixMs: 250, offset: () => 60 });
  const m = computeLineMetrics(run.samples, words, SCREEN);
  const expected = (80 / ((run.lastEnd - run.firstStart) / 1000)) * 60;
  assert.ok(Math.abs(m.wpm - expected) / expected <= 0.1, `wpm ${m.wpm} vs ${expected}`);
  assert.ok(Math.abs(m.durationSec - (run.lastEnd - run.firstStart) / 1000) < 0.5);
});

test('a line read much more slowly is a long-dwell line; fewer than 4 lines never are', () => {
  const words = layout(8);
  const m = computeLineMetrics(reader(all(8), { seed: 18, fixMsForLine: { 4: 600 } }).samples, words, SCREEN);
  assert.deepEqual(m.longDwellLines, [4]);
  assert.ok(m.lineDwellMs[4] > 2 * m.lineDwellMs[3]);

  const even = computeLineMetrics(reader(all(8), { seed: 18 }).samples, words, SCREEN);
  assert.deepEqual(even.longDwellLines, []);

  const short = layout(3);
  const few = computeLineMetrics(reader(all(3), { seed: 19, fixMsForLine: { 1: 900 } }).samples, short, SCREEN);
  assert.deepEqual(few.longDwellLines, []);
});

test('single-line passage works', () => {
  const words = layout(1);
  const m = computeLineMetrics(reader([0], { seed: 20, offset: () => 90 }).samples, words, SCREEN);
  assert.equal(m.totalLines, 1);
  assert.equal(m.linesRead, 1);
  assert.equal(m.completed, true);
  assert.equal(m.wordsRead, 10);
  assert.ok(m.wpm > 0);
  assert.equal(m.regressions, 0);
  assert.equal(m.skippedLines, 0);
  assert.equal(m.reliable, true);
});

const KEYS = [
  'completed', 'detail', 'driftPx', 'durationSec', 'dwellMsByWord', 'lineDwellMs', 'linesRead', 'longDwellLines',
  'longDwellWords', 'quality', 'regressions', 'reliable', 'skippedLines', 'totalLines', 'wordsRead', 'wpm',
];

test('output contract: exact keys, line detail, word arrays always empty', () => {
  const m = computeLineMetrics(reader(all(4), { seed: 21 }).samples, layout(4), SCREEN);
  assert.deepEqual(Object.keys(m).sort(), KEYS);
  assert.equal(m.detail, 'line');
  assert.deepEqual(m.dwellMsByWord, []);
  assert.deepEqual(m.longDwellWords, []);
  assert.equal(LINE_RELIABLE_MIN, 0.5);
});

function assertEmpty(m, totalLines) {
  assert.deepEqual(Object.keys(m).sort(), KEYS);
  for (const k of ['wpm', 'wordsRead', 'durationSec', 'regressions', 'skippedLines', 'quality', 'linesRead', 'driftPx']) {
    assert.equal(m[k], 0, k);
  }
  assert.equal(m.completed, false);
  assert.equal(m.reliable, false);
  assert.equal(m.detail, 'line');
  assert.equal(m.totalLines, totalLines);
  assert.equal(m.lineDwellMs.length, totalLines);
  assert.ok(m.lineDwellMs.every((d) => d === 0));
  assert.deepEqual(m.longDwellLines, []);
  assert.deepEqual(m.dwellMsByWord, []);
  assert.deepEqual(m.longDwellWords, []);
}

test('0 samples, all-null samples and off-screen samples give zeros and reliable false', () => {
  const words = layout(3);
  assertEmpty(computeLineMetrics([], words, SCREEN), 3);
  assertEmpty(computeLineMetrics(nulls(0, 2000), words, SCREEN), 3);
  const off = Array.from({ length: 200 }, (_, k) => ({ t: k * STEP, x: -50, y: 300 }));
  assertEmpty(computeLineMetrics(off, words, SCREEN), 3);
  const below = Array.from({ length: 200 }, (_, k) => ({ t: k * STEP, x: 300, y: SCREEN.h + 10 }));
  assertEmpty(computeLineMetrics(below, words, SCREEN), 3);
});

test('a single short fixation is too little to analyse', () => {
  const one = Array.from({ length: 15 }, (_, k) => ({ t: k * STEP, x: 300, y: centreY(0) }));
  assertEmpty(computeLineMetrics(one, layout(3), SCREEN), 3);
});

test('invalid samples lower quality by their share', () => {
  const words = layout(4);
  const run = reader(all(4), { seed: 22 });
  const full = computeLineMetrics(run.samples, words, SCREEN);
  const half = computeLineMetrics([...run.samples, ...nulls(run.end, run.samples.length * STEP)], words, SCREEN);
  assert.ok(Math.abs(half.quality - full.quality / 2) < 0.02, `${half.quality} vs ${full.quality}`);
  assert.equal(half.reliable, half.quality >= LINE_RELIABLE_MIN);
});

test('garbage arguments and unsorted input do not throw', () => {
  const words = layout(3);
  const run = reader(all(3), { seed: 23 });
  for (const args of [
    [null, words, SCREEN], [undefined, undefined, undefined], ['x', 5, 'y'], [run.samples, null, SCREEN],
    [run.samples, [], SCREEN], [run.samples, [{}], SCREEN], [run.samples, words, null], [run.samples, words, { w: 0, h: -1 }],
    [[null, 5, 'a', [1, 2], { t: 'x' }], words, SCREEN], [run.samples.slice().reverse(), words, SCREEN],
  ]) {
    const m = computeLineMetrics(...args);
    assert.deepEqual(Object.keys(m).sort(), KEYS);
    assert.deepEqual(JSON.parse(JSON.stringify(m)), m);
  }
});

function assertFiniteDeep(v, where) {
  if (typeof v === 'number') return assert.ok(Number.isFinite(v), `${where} = ${v}`);
  if (Array.isArray(v)) return v.forEach((x, k) => assertFiniteDeep(x, `${where}[${k}]`));
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertFiniteDeep(x, `${where}.${k}`);
}

test('fuzz: 200 seeded garbage inputs give finite, JSON-safe output', () => {
  const rng = makeRng(424242);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const weird = () => pick([NaN, Infinity, -Infinity, null, undefined, 'x', {}, [], 1e308, -1e308, 0, -1]);
  const num = (scale) => (rng() < 0.08 ? weird() : (rng() - 0.3) * scale);
  for (let c = 0; c < 200; c++) {
    const nWords = Math.floor(rng() * 40);
    const words = Array.from({ length: nWords }, (_, k) => (rng() < 0.03 ? weird() : {
      i: k, line: rng() < 0.05 ? weird() : Math.floor(rng() * 6), x: num(1500), y: num(1200), w: num(200), h: num(80),
    }));
    let t = rng() < 0.05 ? weird() : rng() * 1e6;
    const samples = Array.from({ length: Math.floor(rng() * 600) }, () => {
      if (rng() < 0.03) return weird();
      t += rng() < 0.02 ? (rng() - 0.5) * 1e4 : STEP;
      const s = { t: rng() < 0.01 ? weird() : t, x: num(1600), y: num(1300) };
      if (rng() < 0.2) { s.x = null; s.y = null; }
      return s;
    });
    const screen = rng() < 0.1 ? weird() : { w: rng() < 0.05 ? weird() : 1280, h: rng() < 0.05 ? weird() : 900 };
    const m = computeLineMetrics(samples, words, screen);
    assert.deepEqual(Object.keys(m).sort(), KEYS, `case ${c}`);
    assertFiniteDeep(m, `case ${c}`);
    assert.deepEqual(JSON.parse(JSON.stringify(m)), m, `case ${c}`);
    assert.ok(m.quality >= 0 && m.quality <= 1, `case ${c}: quality ${m.quality}`);
    assert.equal(m.lineDwellMs.length, m.totalLines, `case ${c}`);
  }
});

// ---- the "참고용" rule on line metrics --------------------------------------------------------

test('applyQualityRule: reliable === false blanks line and word arrays, input untouched', () => {
  const m = { wpm: 100, reliable: false, detail: 'line', quality: 0.3, lineDwellMs: [100, 200], longDwellLines: [1], dwellMsByWord: [], longDwellWords: [] };
  const out = applyQualityRule(m);
  assert.deepEqual(out.lineDwellMs, []);
  assert.deepEqual(out.longDwellLines, []);
  assert.deepEqual(out.dwellMsByWord, []);
  assert.equal(out.wpm, 100);
  assert.deepEqual(m.lineDwellMs, [100, 200], 'input must not be mutated');
});

test('applyQualityRule: reliable === true keeps line arrays although detail is "line"', () => {
  const m = { wpm: 100, reliable: true, detail: 'line', quality: 0.8, lineDwellMs: [100, 200], longDwellLines: [1], dwellMsByWord: [], longDwellWords: [] };
  assert.equal(applyQualityRule(m), m);
});

test('applyQualityRule: legacy metrics without `reliable` keep the old detail rule', () => {
  const legacyWord = { detail: 'word', quality: 0.9, dwellMsByWord: [1, 2], longDwellWords: [1] };
  assert.equal(applyQualityRule(legacyWord), legacyWord);
  const legacyLine = { detail: 'line', quality: 0.4, dwellMsByWord: [1, 2], longDwellWords: [1] };
  const out = applyQualityRule(legacyLine);
  assert.deepEqual(out.dwellMsByWord, []);
  assert.deepEqual(out.longDwellWords, []);
  assert.ok(!('lineDwellMs' in out), 'legacy rows keep their shape');
});
