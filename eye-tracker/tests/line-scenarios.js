'use strict';
// Seeded scenario suite for server/line-metrics.js (shared by tests/line-scenarios-*.test.js).
//
// Seed discipline: thresholds were tuned on seeds 1-200 and validated on 1000-1199; these tests
// use 3000-3199, a range never looked at while tuning. Product rule: a session offered as reliable
// must be right; at most 2% of sessions per scenario may be reliable and wrong.
const { computeLineMetrics } = require('../server/line-metrics');
const sim = require('./gaze-sim');

const SEED0 = 3000;
const N = 200;
const MAX_RELIABLE_WRONG = Math.floor(0.02 * N);
const LAPTOP = { w: 1280, h: 1100 };
const range = (n) => Array.from({ length: n }, (_, k) => k);

// Runs `build(seed)` -> {L, plan | samples, render, screen, post, expect} over the seed range.
// Wrong = line accuracy < 80%, or linesRead / completed / skippedLines differ from expect, or the
// regression count is off by more than one (scenarios without `expect` are not readings at all:
// any reliable result is wrong).
function runScenario(build) {
  const out = { n: N, reliable: 0, reliableWrong: 0, ok: 0, total: 0, trivialOk: 0, okReliable: 0, totalReliable: 0, right: { linesRead: 0, completed: 0, skippedLines: 0, regressions: 0 } };
  for (let seed = SEED0; seed < SEED0 + N; seed++) {
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
        if (f.pass === want) triv++; // the trivial rule "pass j is line j"
      }
      acc = tot ? ok / tot : 0;
      out.ok += ok; out.total += tot; out.trivialOk += triv;
      if (m.reliable) { out.okReliable += ok; out.totalReliable += tot; }
    }
    let wrong = true;
    if (b.expect) {
      const e = b.expect;
      for (const k of Object.keys(out.right)) if (k in e && m[k] === e[k]) out.right[k]++;
      wrong = acc < 0.8 || m.linesRead !== e.linesRead || m.completed !== e.completed || m.skippedLines !== e.skippedLines
        || ('regressions' in e && Math.abs(m.regressions - e.regressions) > 1);
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
// A natural reader (variable durations, word skips, pauses...) reading every line of a simLayout2.
const natural = (lo, po, render = {}, screen = LAPTOP) => (seed) => {
  const rng = sim.makeRng(seed);
  const normal = sim.makeNormal(rng);
  const L = sim.simLayout2(lo);
  return { L, plan: sim.planNatural(L, range(L.nLines), rng, normal, po), render, screen, expect: sim.expectFor(range(L.nLines), L.nLines) };
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
  return { L, plan, render: { offset: () => 120 }, post, expect: { completed: true, linesRead: 8, skippedLines: 0, regressions: 0 } };
};
// Gaze that is not reading: 30 s generated by fn(t, rng, normal).
const notReading = (fnFactory, nLines) => (seed) => {
  const rng = sim.makeRng(seed);
  const normal = sim.makeNormal(rng);
  const fn = fnFactory();
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
const MIX = { sx: 60, skip2: 0.15 };

const GROUPS = {
  reading: {
    'clean, offset 0': reading({ render: { offset: () => 0 } }),
    'clean, offset +150': reading({ render: { offset: () => 150 } }),
    'clean, offset -120': reading({ render: { offset: () => -120 } }),
    'clean, drift 80 -> 220': reading({ render: { offset: (f) => 80 + 140 * f } }),
    'small backtracks': reading({ po: { backtracks: 0.4 }, render: { offset: () => 150 } }),
    're-reading 30% of lines from their start': reading({ po: { reread: 0.3 }, render: { offset: () => 150 } }),
    're-reading every line from its start': reading({ po: { reread: 1 }, render: { offset: () => 150 } }),
    'skipping line 4': reading({ order: [0, 1, 2, 3, 5, 6, 7], render: { offset: () => 150 } }),
    'skipping lines 2 and 5': reading({ order: [0, 1, 3, 4, 6, 7], render: { offset: () => 0 } }),
    'going back one line': reading({ order: [0, 1, 2, 1, 2, 3, 4, 5, 6, 7], render: { offset: () => 150 } }),
    'going back two lines': reading({ order: [0, 1, 2, 3, 4, 2, 3, 4, 5, 6, 7], render: { offset: () => -120 } }),
    'stopping after 4 of 8 lines': reading({ order: [0, 1, 2, 3], render: { offset: () => 150 } }),
    'short last line (2 words), 0 ms on the button': shortLastLine(0),
    'short last line (2 words), 1 s on the button': shortLastLine(1000),
  },
  gaze: {
    '2 fixations per line': reading({ po: { nMin: 2, nMax: 2 }, render: { offset: () => 150 } }),
    'portrait tablet, 15 lines x 4 words, offset 0': reading({ lo: PORTRAIT, po: { nMin: 3, nMax: 4 }, screen: TABLET }),
    'portrait tablet, offset +150, clamped': reading({ lo: PORTRAIT, po: { nMin: 3, nMax: 4 }, screen: TABLET, render: { offset: () => 150, clampW: 768, clampH: 1024 } }),
    'per-line vertical error (sd 30)': reading({ map: (plan, rng, normal) => { const e = range(8).map(() => normal() * 30); return plan.map((p) => ({ ...p, y: p.y + e[p.line] + 150 })); } }),
    'vertical noise sd 60': reading({ po: { sy: 60 }, render: { offset: () => 150 } }),
    'small laptop, offset +150, clamped': reading({ screen: SMALL_LAPTOP, render: { offset: () => 150, clampW: 1280, clampH: 760 } }),
    'small laptop, offset +250, clamped': reading({ screen: SMALL_LAPTOP, render: { offset: () => 250, clampW: 1280, clampH: 760 } }),
    'small laptop, offset -300, clamped': reading({ screen: SMALL_LAPTOP, render: { offset: () => -300, clampW: 1280, clampH: 760 } }),
    'stare with sweeps at one height (8 lines)': notReading(sweepsAtOneHeight, 8),
    'stare with sweeps at one height (1 line)': notReading(sweepsAtOneHeight, 1),
    'wandering blob (8 lines)': notReading(blob, 8),
    'wandering blob (1 line)': notReading(blob, 1),
    'frozen point (8 lines)': notReading(() => () => ({ x: 640, y: 400 }), 8),
  },
  offsets: {
    'look-away 4 s, offset +150 -> +20': interrupted(() => [{ gap: 4000 }], -130),
    'look-away 1 s, offset +150 -> +20': interrupted(() => [{ gap: 1000 }], -130),
    'look-away 4 s, offset +150 -> +280': interrupted(() => [{ gap: 4000 }], 130),
    'look-away 4 s, same offset': interrupted(() => [{ gap: 4000 }], 0),
    'look-away 3 s, back to line 2': (seed) => {
      const rng = sim.makeRng(seed);
      const normal = sim.makeNormal(rng);
      const L = sim.simLayout({ nLines: 8 });
      const order = [0, 1, 2, 3, 4, 2, 3, 4, 5, 6, 7];
      const plan = [...sim.planLines(L, order.slice(0, 5), rng, normal), { gap: 3000 }, ...sim.planLines(L, order.slice(5), rng, normal)];
      return { L, plan, render: { offset: () => 150 }, expect: sim.expectFor(order, 8) };
    },
    '3 s glance at the top right between lines 3 and 4': interrupted((rng, normal) => Array.from({ length: 12 }, () => ({ line: -1, x: 1200 + normal() * 30, y: 60 + normal() * 30 - 150, ms: 250 }))),
    'drift up 200 -> 20 (180 px)': reading({ render: { offset: (f) => 200 - 180 * f } }),
    'drift up 200 -> -20 (220 px)': reading({ render: { offset: (f) => 200 - 220 * f } }),
    'drift down 80 -> 300 (220 px)': reading({ render: { offset: (f) => 80 + 220 * f } }),
    'offset changing sign, +100 -> -100 smoothly': natural({}, {}, { offset: (f) => 100 - 200 * f }),
    'offset step +90 -> -90 mid-session, no gap': natural({}, {}, { offset: (f) => (f < 0.5 ? 90 : -90) }),
    'offset step +40 -> -40 mid-session, no gap': natural({}, {}, { offset: (f) => (f < 0.5 ? 40 : -40) }),
  },
  natural: {
    'natural reader (x noise 60, word skips), offset +120': natural({}, MIX, { offset: () => 120 }),
    'natural reader, offset 0': natural({}, MIX, { offset: () => 0 }),
    'natural reader, offset -100': natural({}, MIX, { offset: () => -100 }),
    '600 ms gaze pause between lines': natural({}, { pauseMs: 600 }, { offset: () => 150 }),
    '600 ms dwell at each line end': natural({}, { pauseMs: 600, pauseValid: true }, { offset: () => 150 }),
    '1.2 s gaze pause between lines': natural({}, { pauseMs: 1200 }, { offset: () => 150 }),
    'indented first line, centred 3-word last line': natural({ indent: 200, centredLast: 3 }, {}, { offset: () => 120 }),
    'indented, centred last line, natural reader': natural({ indent: 200, centredLast: 3 }, MIX, { offset: () => 120 }),
    'everything at once (indent, mix, pauses, sign change)': natural({ indent: 200, centredLast: 3 }, { ...MIX, pauseMs: 600 }, { offset: (f) => 100 - 200 * f }),
    'noisy: y sd 60, offset +100, some pinned samples': natural({}, { sy: 60, pinnedPerLine: 0.4 }, { offset: () => 100, clampH: 1100, clampW: 1280 }),
    'noisy: y sd 60, offset +100': natural({}, { sy: 60 }, { offset: () => 100 }),
    'noisy: y sd 50, offset +100, some pinned samples': natural({}, { sy: 50, pinnedPerLine: 0.4 }, { offset: () => 100, clampH: 1100, clampW: 1280 }),
    'per-line error sd 20, offset +100': natural({}, { lineErr: 20 }, { offset: () => 100 }),
    'laptop 1280x800, offset +80': natural({}, { sx: 40 }, { offset: () => 80, clampH: 800, clampW: 1280 }, { w: 1280, h: 800 }),
  },
};

const cache = new Map();
function resultOf(group, name) {
  const key = `${group}/${name}`;
  if (!cache.has(key)) cache.set(key, runScenario(GROUPS[group][name]));
  return cache.get(key);
}

module.exports = { GROUPS, resultOf, runScenario, N, SEED0, MAX_RELIABLE_WRONG, LAPTOP, notReading, sweepsAtOneHeight };
