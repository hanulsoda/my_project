'use strict';
// Line-level analysis with automatic drift correction (server/line-metrics.js).
// Synthetic readers with a seeded RNG: results are deterministic, never flaky.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeLineMetrics, LINE_RELIABLE_MIN } = require('../server/line-metrics');
const { applyQualityRule } = require('../server/metrics');
const sim = require('./gaze-sim');

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

// ---- realistic conditions (independent review): several seeds, scenarios where pass order alone
// fails, and the product rule "never reliable and wrong" ----------------------------------------

const LAPTOP = { w: 1280, h: 1100 };
const range = (n) => Array.from({ length: n }, (_, k) => k);

// Runs `build(seed)` -> {L, plan | samples, render, screen, post, expect} over seeds 1..n.
// Wrong = line accuracy < 80% or linesRead / completed / skippedLines differ from expect
// (scenarios without `expect` are not readings at all: any reliable result is wrong).
function runScenario(build, n) {
  const out = { n, reliable: 0, reliableWrong: 0, ok: 0, total: 0, trivialOk: 0, okReliable: 0, totalReliable: 0, right: { linesRead: 0, completed: 0, skippedLines: 0, regressions: 0 } };
  for (let seed = 1; seed <= n; seed++) {
    const b = build(seed);
    let samples = b.samples;
    let truth = null;
    if (!samples) {
      const r = sim.renderPlan(b.plan, { ...(b.render || {}), seed: seed + 1000 });
      samples = b.post ? b.post(r) : sim.nullTail(r);
      truth = r.truth;
    }
    const m = computeLineMetrics(samples, b.L.words, b.screen || LAPTOP, { debug: true });
    let acc = 1;
    if (truth) {
      let ok = 0; let tot = 0; let triv = 0;
      for (const f of m.debug.fixations) {
        if (!truth.has(f.tStart)) continue;
        tot++;
        const want = truth.get(f.tStart);
        if (f.line === (want === -1 ? null : want)) ok++; // -1: the reader was off the text
        if (f.pass === truth.get(f.tStart)) triv++; // the trivial rule "pass j is line j"
      }
      acc = tot ? ok / tot : 0;
      out.ok += ok; out.total += tot; out.trivialOk += triv;
      if (m.reliable) { out.okReliable += ok; out.totalReliable += tot; }
    }
    let wrong = true;
    if (b.expect) {
      const e = b.expect;
      for (const k of ['linesRead', 'completed', 'skippedLines', 'regressions']) if (k in e && m[k] === e[k]) out.right[k]++;
      wrong = acc < 0.8 || m.linesRead !== e.linesRead || m.completed !== e.completed || m.skippedLines !== e.skippedLines
        || ('regressions' in e && m.regressions !== e.regressions);
    }
    if (m.reliable) { out.reliable++; if (wrong) out.reliableWrong++; }
  }
  out.acc = out.total ? out.ok / out.total : null;
  out.trivial = out.total ? out.trivialOk / out.total : null;
  out.accReliable = out.totalReliable ? out.okReliable / out.totalReliable : null;
  return out;
}

// A reader visiting `order` on a simLayout; opts: lo (layout), po (planLines), render, screen, post, map.
const reading = ({ order, lo = {}, po = {}, render = {}, screen, post, map, expect }) => (seed) => {
  const rng = sim.makeRng(seed);
  const normal = sim.makeNormal(rng);
  const L = sim.simLayout({ nLines: 8, ...lo });
  const ord = order || range(L.nLines);
  let plan = sim.planLines(L, ord, rng, normal, po);
  if (map) plan = map(plan, rng, normal, L);
  return { L, plan, render, screen, post, expect: expect || sim.expectFor(ord, L.nLines) };
};
// Lines 0-3, then something, then lines 4-7 (gaze offset +150 throughout unless shifted).
const interrupted = (middle, shiftAfter = 0) => (seed) => {
  const rng = sim.makeRng(seed);
  const normal = sim.makeNormal(rng);
  const L = sim.simLayout({ nLines: 8 });
  const a = sim.planLines(L, [0, 1, 2, 3], rng, normal);
  const b = sim.planLines(L, [4, 5, 6, 7], rng, normal).map((p) => ({ ...p, y: p.y + shiftAfter }));
  return { L, plan: [...a, ...middle(rng, normal), ...b], render: { offset: () => 150 }, expect: sim.expectFor(range(8), 8) };
};
const PORTRAIT = { nLines: 15, perLine: 4, width: 600, left: 80, top: 80 };
const TABLET = { w: 768, h: 1024 };
const SMALL_LAPTOP = { w: 1280, h: 760 };
const shortLastLine = (buttonMs) => (seed) => {
  const rng = sim.makeRng(seed);
  const normal = sim.makeNormal(rng);
  const L = sim.simLayout({ nLines: 8, lastLineWords: 2 });
  const plan = sim.planLines(L, range(7), rng, normal);
  plan.push({ line: 7, x: 150 + normal() * 25, y: L.centre(7) + normal() * 40, ms: 220 }, { line: 7, x: 260 + normal() * 25, y: L.centre(7) + normal() * 40, ms: 220 });
  const post = (r) => [...r.samples, ...Array.from({ length: buttonMs / sim.STEP }, (_, k) => ({ t: r.end + k * sim.STEP, x: 640, y: 1060 }))];
  return { L, plan, render: { offset: () => 120 }, post, expect: { completed: true, linesRead: 8, skippedLines: 0 } };
};
// Gaze that is not reading: 30 s generated by fn(t, rng, normal).
const notReading = (fn, nLines) => (seed) => {
  const rng = sim.makeRng(seed);
  const normal = sim.makeNormal(rng);
  const samples = [];
  for (let t = 0; t < 30000; t += sim.STEP) samples.push({ t, ...fn(t, rng, normal) });
  return { L: sim.simLayout({ nLines }), samples };
};
function sweepsAtOneHeight() {
  let cx = 150;
  return (t, rng, normal) => {
    if (t % 200 === 0) { cx += 110; if (cx > 1100) cx = 150 + normal() * 20; }
    return { x: cx + normal() * 3, y: 500 + normal() * 3 };
  };
}
function blob() {
  let cx = 640; let cy = 400;
  return (t, rng, normal) => {
    if (t % 200 === 0) { cx = 640 + normal() * 75; cy = 400 + normal() * 75; }
    return { x: cx, y: cy };
  };
}

const N = 50; // sessions per scenario; "<= 2% reliable and wrong" allows 1 of 50
const MAX_RELIABLE_WRONG = 1;
const SCENARIOS = {
  'clean, offset 0': reading({ render: { offset: () => 0 } }),
  'clean, offset +150': reading({ render: { offset: () => 150 } }),
  'clean, offset -120': reading({ render: { offset: () => -120 } }),
  'clean, drift 80 -> 220': reading({ render: { offset: (f) => 80 + 140 * f } }),
  'small backtracks': reading({ po: { backtracks: 0.4 }, render: { offset: () => 150 } }),
  're-reading 30% of lines from their start': reading({ po: { reread: 0.3 }, render: { offset: () => 150 } }),
  're-reading every line from its start': reading({ po: { reread: 1 }, render: { offset: () => 150 } }),
  'skipping line 4': reading({ order: [0, 1, 2, 3, 5, 6, 7], render: { offset: () => 150 } }),
  'skipping lines 2 and 5': reading({ order: [0, 1, 3, 4, 6, 7], render: { offset: () => 0 } }),
  'going back one line': reading({ order: [0, 1, 2, 1, 2, 3, 4, 5, 6, 7], render: { offset: () => 150 }, expect: { completed: true, linesRead: 8, skippedLines: 0, regressions: 1 } }),
  'going back two lines': reading({ order: [0, 1, 2, 3, 4, 2, 3, 4, 5, 6, 7], render: { offset: () => -120 }, expect: { completed: true, linesRead: 8, skippedLines: 0, regressions: 2 } }),
  'stopping after 4 of 8 lines': reading({ order: [0, 1, 2, 3], render: { offset: () => 150 } }),
  'short last line (2 words), 0 ms on the button': shortLastLine(0),
  'short last line (2 words), 1 s on the button': shortLastLine(1000),
  '2 fixations per line': reading({ po: { nMin: 2, nMax: 2 }, render: { offset: () => 150 } }),
  'portrait tablet, 15 lines x 4 words, offset 0': reading({ lo: PORTRAIT, po: { nMin: 3, nMax: 4 }, screen: TABLET }),
  'portrait tablet, offset +150, clamped': reading({ lo: PORTRAIT, po: { nMin: 3, nMax: 4 }, screen: TABLET, render: { offset: () => 150, clampW: 768, clampH: 1024 } }),
  'per-line vertical error (sd 30)': reading({ map: (plan, rng, normal) => { const e = range(8).map(() => normal() * 30); return plan.map((p) => ({ ...p, y: p.y + e[p.line] + 150 })); } }),
  'vertical noise sd 60': reading({ po: { sy: 60 }, render: { offset: () => 150 } }),
  'small laptop, offset +150, clamped': reading({ screen: SMALL_LAPTOP, render: { offset: () => 150, clampW: 1280, clampH: 760 } }),
  'small laptop, offset +200, clamped': reading({ screen: SMALL_LAPTOP, render: { offset: () => 200, clampW: 1280, clampH: 760 } }),
  'small laptop, offset +250, clamped': reading({ screen: SMALL_LAPTOP, render: { offset: () => 250, clampW: 1280, clampH: 760 } }),
  'small laptop, offset -300, clamped': reading({ screen: SMALL_LAPTOP, render: { offset: () => -300, clampW: 1280, clampH: 760 } }),
  'look-away 4 s, offset +150 -> +20': interrupted(() => [{ gap: 4000 }], -130),
  'look-away 1 s, offset +150 -> +20': interrupted(() => [{ gap: 1000 }], -130),
  'look-away 4 s, offset +150 -> +280': interrupted(() => [{ gap: 4000 }], 130),
  'look-away 3 s, back to line 2': (seed) => {
    const rng = sim.makeRng(seed);
    const normal = sim.makeNormal(rng);
    const L = sim.simLayout({ nLines: 8 });
    const plan = [...sim.planLines(L, [0, 1, 2, 3, 4], rng, normal), { gap: 3000 }, ...sim.planLines(L, [2, 3, 4, 5, 6, 7], rng, normal)];
    // lines 2 and 3 are re-read below the furthest line reached (4): two regressions
    return { L, plan, render: { offset: () => 150 }, expect: { completed: true, linesRead: 8, skippedLines: 0, regressions: 2 } };
  },
  '3 s glance at the top right between lines 3 and 4': interrupted((rng, normal) => Array.from({ length: 12 }, () => ({ line: -1, x: 1200 + normal() * 30, y: 60 + normal() * 30 - 150, ms: 250 }))),
  'stare with sweeps at one height (8 lines)': notReading(sweepsAtOneHeight(), 8),
  'stare with sweeps at one height (1 line)': notReading(sweepsAtOneHeight(), 1),
  'wandering blob (8 lines)': notReading(blob(), 8),
  'wandering blob (1 line)': notReading(blob(), 1),
  'frozen point (8 lines)': notReading(() => ({ x: 640, y: 400 }), 8),
};

const results = new Map();
const resultOf = (name) => {
  if (!results.has(name)) results.set(name, runScenario(SCENARIOS[name], N));
  return results.get(name);
};

for (const name of Object.keys(SCENARIOS)) {
  test(`never reliable and wrong (<= ${MAX_RELIABLE_WRONG} of ${N}): ${name}`, () => {
    const r = resultOf(name);
    assert.ok(r.reliableWrong <= MAX_RELIABLE_WRONG, `${r.reliableWrong} of ${N} reliable but wrong (reliable ${r.reliable})`);
  });
}

test('clean laptop sessions stay reliable (>= 90% at offsets 0, +150, -120 and drift)', () => {
  for (const name of ['clean, offset 0', 'clean, offset +150', 'clean, offset -120', 'clean, drift 80 -> 220']) {
    const r = resultOf(name);
    assert.ok(r.reliable >= 0.9 * N, `${name}: reliable ${r.reliable} of ${N}`);
  }
});

test('accuracy where pass order alone fails: skips, re-reads, a glance off the text (trivial rule < 85%)', () => {
  // Two skips in six passes is partly indistinguishable from a gaze drift of about one line, so
  // its bar is lower; those sessions come out 참고용 (see the reliable-and-wrong tests).
  const bars = {
    'skipping line 4': 0.9,
    'skipping lines 2 and 5': 0.85,
    're-reading 30% of lines from their start': 0.9,
    'going back two lines': 0.9,
    '3 s glance at the top right between lines 3 and 4': 0.9,
  };
  for (const [name, bar] of Object.entries(bars)) {
    const r = resultOf(name);
    assert.ok(r.acc >= bar, `${name}: accuracy ${r.acc}`);
    assert.ok(r.trivial < 0.85, `${name}: the trivial rule scores ${r.trivial}`);
  }
});

test('look-away with an offset change: reliable sessions are assigned right (>= 90%)', () => {
  for (const name of ['look-away 4 s, offset +150 -> +20', 'look-away 4 s, offset +150 -> +280', 'look-away 1 s, offset +150 -> +20']) {
    const r = resultOf(name);
    if (r.reliable > 0) assert.ok(r.accReliable >= 0.9, `${name}: accuracy of reliable sessions ${r.accReliable}`);
  }
});

test('skip, regression and stop figures hold over many seeds (>= 90% of sessions right)', () => {
  const cases = [
    ['skipping line 4', ['skippedLines', 'linesRead', 'completed']],
    ['going back one line', ['regressions', 'skippedLines', 'completed']],
    ['going back two lines', ['regressions', 'skippedLines', 'completed']],
    ['stopping after 4 of 8 lines', ['linesRead', 'completed', 'skippedLines']],
    ['re-reading every line from its start', ['linesRead', 'completed', 'skippedLines']],
  ];
  for (const [name, keys] of cases) {
    const r = resultOf(name);
    for (const k of keys) assert.ok(r.right[k] >= 0.9 * N, `${name}: ${k} right in ${r.right[k]} of ${N}`);
  }
});

test('a short last line read just before pressing "다 읽었어요" completes the passage (>= 90%)', () => {
  for (const name of ['short last line (2 words), 0 ms on the button', 'short last line (2 words), 1 s on the button']) {
    const r = resultOf(name);
    assert.ok(r.right.completed >= 0.9 * N, `${name}: completed right in ${r.right.completed} of ${N}`);
  }
});

test('a stray fixation on the last line while on line 2 neither completes nor inflates wpm (10 seeds)', () => {
  const words = layout(8);
  for (let seed = 1; seed <= 10; seed++) {
    for (const offset of [0, 150]) {
      const base = reader([0, 1, 2], { seed, offset: () => offset });
      const tail = nulls(base.end + 150, 1000);
      const without = computeLineMetrics([...base.samples, ...tail], words, SCREEN);
      // One fixation at the left end of the last line (a return-sweep-like jump: its own pass).
      const stray = Array.from({ length: 15 }, (_, k) => ({ t: base.end + k * STEP, x: 160, y: centreY(7) + offset }));
      const withStray = computeLineMetrics([...base.samples, ...stray, ...tail], words, SCREEN);
      assert.equal(withStray.completed, false, `seed ${seed} offset ${offset}`);
      assert.equal(withStray.linesRead, without.linesRead, `seed ${seed} offset ${offset}: the stray adds no line`);
      assert.ok(!withStray.reliable || without.reliable, `seed ${seed} offset ${offset}: a stray never makes a session reliable`);
      assert.ok(withStray.wpm <= without.wpm * 1.1, `seed ${seed}: wpm ${withStray.wpm} vs ${without.wpm}`);
    }
  }
});

test('gaze pinned to the screen edge makes the session 참고용', () => {
  const r = resultOf('small laptop, offset +250, clamped');
  assert.ok(r.reliable <= 1, `reliable ${r.reliable}`);
});

test('a stare is never a reading: not reliable, and a one-line stare is not completed', () => {
  for (const name of ['stare with sweeps at one height (8 lines)', 'wandering blob (8 lines)', 'wandering blob (1 line)', 'frozen point (8 lines)']) {
    assert.equal(resultOf(name).reliable, 0, name);
  }
  const still = notReading((t, rng, normal) => ({ x: 640 + normal() * 15, y: 400 + normal() * 15 }), 1)(1);
  assert.equal(computeLineMetrics(still.samples, still.L.words, LAPTOP).completed, false);
  // 30 s of sweeps or random gaze on a one-line passage is not "read to the end" either
  for (const build of [notReading(sweepsAtOneHeight(), 1), notReading((t, rng) => ({ x: rng() * 1280, y: rng() * 1100 }), 1)]) {
    for (let seed = 1; seed <= 5; seed++) {
      const b = build(seed);
      assert.equal(computeLineMetrics(b.samples, b.L.words, LAPTOP).completed, false, `seed ${seed}`);
    }
  }
});

test('too few fixations per line is 참고용, not a guess', () => {
  const r = resultOf('2 fixations per line');
  assert.ok(r.reliable <= 0.2 * N, `reliable ${r.reliable}`);
});
