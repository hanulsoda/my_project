'use strict';

// Line-level reading metrics with automatic gaze-offset (drift) correction. Pure functions.
//
// Webcam gaze is too coarse for words (a real check gave a 154 px mean error against a 49-64 px
// line pitch), and the error is mostly a per-child offset that drifts while reading. So the text
// structure itself calibrates: fixations are split into passes at return sweeps, each pass is one
// line read, and a robust fit of "pass height minus its line's height" over time gives the offset
// (b0) and its drift (b1). Lines are then assigned from the corrected heights.
//
// Input is the same as computeMetrics in ./metrics.js. Garbage input never throws; every number in
// the output is finite.

const { detectFixations } = require('./metrics');

// Minimum quality for "reliable" (otherwise the session is shown as 참고용). Chosen from synthetic
// data only (a reader with 40 px vertical noise per fixation scores about 0.65); to be tuned from
// real sessions, see docs/accuracy-protocol.md.
const LINE_RELIABLE_MIN = 0.5;

const MIN_FIXATIONS = 2; // fewer than this: nothing to analyse
const RETURN_SWEEP_FRACTION = 0.35; // a leftward jump wider than this share of the text width starts a new pass
const MAIN_PASS_FIXATIONS = 3; // passes with fewer fixations are not used for the fit and are assigned fixation by fixation
const TAIL_IGNORE_MS = 500; // a pass opening a new line this close to the end is the gaze going to the "done" button
const INLIER_PITCH = 0.6; // a fixation within this many pitches of its line centre is an inlier (quality)
const OFF_TEXT_PITCH = 1; // a short-pass fixation further than this from every line is off the text
const LONG_DWELL_MIN_LINES = 4;
const MAX_COORD = 1e7; // anything larger is garbage, not a screen position
const MAX_T = 1e15;

// Costs (negative log-likelihood units) of the reading model used to pick the offset and the line
// of every pass. Reading the next line is free; anything else must be paid for by a better fit.
const COST_REPEAT = 5; // the same line again
const COST_REGRESS = 3; // going back one line (+1 per further line)
const COST_REGRESS_PER_LINE = 1;
const COST_SKIP = 3; // skipping one line (+2 per further line); also starting below line 0
const COST_SKIP_PER_LINE = 2;
const COST_OFF = 6; // a pass that matches no line (looking away, at the button)
const COST_END_EARLY = 2; // the last pass is not on the last line (stopping early is allowed, just less likely)
const DRIFT_MAX_PITCH = 4; // largest total drift over a session considered
const DRIFT_PRIOR = 0.5; // cost per (drift in pitches)^2: prefers a steady offset when in doubt
const GRID_BUDGET = 3e6; // pass evaluations allowed for the coarse search
const CANDIDATES = 4;
const REFINE_ITERATIONS = 3;
const MAX_PAIRS = 40000; // Theil-Sen pair cap

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const finite = (v) => (isNum(v) ? v : 0);
const sane = (v) => isNum(v) && Math.abs(v) <= MAX_COORD;

function median(nums) {
  if (nums.length === 0) return 0;
  const s = Float64Array.from(nums).sort();
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Mean of the middle 60%: nearly as precise as the mean on clean data, robust to a stray fixation.
function trimmedMean(nums) {
  const s = Float64Array.from(nums).sort();
  const cut = Math.floor(s.length * 0.2);
  let sum = 0;
  for (let k = cut; k < s.length - cut; k++) sum += s[k];
  return sum / (s.length - 2 * cut);
}

function emptyLineMetrics(totalLines) {
  return {
    wpm: 0,
    wordsRead: 0,
    completed: false,
    durationSec: 0,
    regressions: 0,
    skippedLines: 0,
    quality: 0,
    reliable: false,
    detail: 'line',
    linesRead: 0,
    totalLines,
    lineDwellMs: new Array(totalLines).fill(0),
    longDwellLines: [],
    driftPx: 0,
    dwellMsByWord: [],
    longDwellWords: [],
  };
}

// Lines in order of their `line` id: centre y, word left edges, pitch, text extent.
function buildLayout(words) {
  if (!Array.isArray(words)) return null;
  const byLine = new Map();
  let left = Infinity;
  let right = -Infinity;
  const heights = [];
  for (const w of words) {
    if (!w || typeof w !== 'object') continue;
    if (!isNum(w.line) || ![w.x, w.y, w.w, w.h].every(sane)) continue;
    let ln = byLine.get(w.line);
    if (!ln) { ln = { id: w.line, sum: 0, xs: [] }; byLine.set(w.line, ln); }
    ln.sum += w.y + w.h / 2;
    ln.xs.push(w.x);
    left = Math.min(left, w.x);
    right = Math.max(right, w.x + w.w);
    heights.push(Math.abs(w.h));
  }
  if (byLine.size === 0) return null;
  const lines = [...byLine.values()].sort((a, b) => a.id - b.id)
    .map((ln) => ({ centre: ln.sum / ln.xs.length, xs: ln.xs.sort((a, b) => a - b) }));
  const centres = lines.map((ln) => ln.centre);
  let pitch = median(centres.slice(1).map((c, k) => Math.abs(c - centres[k])).filter((d) => d > 0));
  if (!(pitch > 0)) pitch = 2 * median(heights);
  if (!(pitch > 0)) pitch = 1;
  // Nearest line by binary search over the centres sorted by height (garbage layouts may not be monotonic).
  const order = centres.map((c, k) => k).sort((a, b) => centres[a] - centres[b]);
  const sorted = order.map((k) => centres[k]);
  return { lines, centres, pitch, left, width: Math.max(right - left, 0), order, sorted };
}

function nearestLine(layout, y) {
  const { sorted, order } = layout;
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < y) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - y) <= Math.abs(sorted[lo] - y)) lo--;
  return order[lo];
}

// Passes: a new one starts when x jumps left by more than RETURN_SWEEP_FRACTION of the text width.
function splitPasses(fixations, layout, t0) {
  const jump = RETURN_SWEEP_FRACTION * layout.width;
  const passes = [];
  let cur = null;
  fixations.forEach((f, k) => {
    if (!cur || (layout.width > 0 && fixations[k - 1].x - f.x > jump)) {
      cur = { fix: [] };
      passes.push(cur);
    }
    cur.fix.push(k);
  });
  for (const p of passes) {
    const fs = p.fix.map((k) => fixations[k]);
    p.n = fs.length;
    p.tStart = fs[0].tStart;
    p.m = trimmedMean(fs.map((f) => f.y));
    p.tau = (fs[0].tStart + fs[fs.length - 1].tEnd) / 2 - t0;
  }
  return passes;
}

// Transition cost from line v (-1: before the first line) to line l.
function transCost(v, l) {
  const d = l - v;
  if (d === 1) return 0;
  if (d === 0) return COST_REPEAT;
  if (d < 0) return COST_REGRESS + COST_REGRESS_PER_LINE * (-d - 1);
  return COST_SKIP + COST_SKIP_PER_LINE * (d - 2);
}

const driftCost = (model, span, pitch) => DRIFT_PRIOR * ((model.b1 * span) / pitch) ** 2;
const offsetAt = (model, tau) => model.b0 + model.b1 * tau;

// Cheap score for the coarse search: every pass on its nearest line (or off the text), plus the
// reading-model costs of that sequence.
function quickCost(main, layout, model) {
  let cost = 0;
  let prev = -1;
  for (const p of main) {
    const y = p.m - offsetAt(model, p.tau);
    const l = nearestLine(layout, y);
    const r = (y - layout.centres[l]) / p.sigma;
    const res = (r * r) / 2;
    if (res >= COST_OFF) { cost += COST_OFF; continue; }
    cost += res + transCost(prev, l);
    prev = l;
  }
  return cost + (prev === layout.centres.length - 1 ? 0 : COST_END_EARLY);
}

// Best line (or null: off the text) for every main pass under `model`, by dynamic programming over
// "last line read" states. O(passes x lines): the transition minimum uses prefix/suffix minima.
function decode(main, layout, model) {
  const L = layout.centres.length;
  const S = L + 1; // state s = last line read + 1 (s = 0: none yet)
  let prev = new Float64Array(S).fill(Infinity);
  prev[0] = 0;
  const from = [];
  const offs = [];
  const pre = new Float64Array(S);
  const preArg = new Int32Array(S);
  const suf = new Float64Array(S + 1);
  const sufArg = new Int32Array(S + 1);
  for (const p of main) {
    const y = p.m - offsetAt(model, p.tau);
    // pre[s] = min over s' <= s of prev[s'] - SKIP_PER * (s' - 1)   (lines v = s' - 1)
    for (let s = 0; s < S; s++) {
      const v = prev[s] - COST_SKIP_PER_LINE * (s - 1);
      if (s === 0 || v < pre[s - 1]) { pre[s] = v; preArg[s] = s; } else { pre[s] = pre[s - 1]; preArg[s] = preArg[s - 1]; }
    }
    suf[S] = Infinity; sufArg[S] = -1;
    for (let s = S - 1; s >= 0; s--) {
      const v = prev[s] + COST_REGRESS_PER_LINE * (s - 1);
      if (v < suf[s + 1]) { suf[s] = v; sufArg[s] = s; } else { suf[s] = suf[s + 1]; sufArg[s] = sufArg[s + 1]; }
    }
    const next = new Float64Array(S);
    const fr = new Int32Array(S);
    const off = new Uint8Array(S);
    for (let s = 0; s < S; s++) { next[s] = prev[s] + COST_OFF; fr[s] = s; off[s] = 1; }
    for (let l = 0; l < L; l++) {
      const s = l + 1;
      const r = (y - layout.centres[l]) / p.sigma;
      const res = (r * r) / 2;
      let best = prev[l] + 0; // from line l - 1
      let arg = l;
      if (prev[s] + COST_REPEAT < best) { best = prev[s] + COST_REPEAT; arg = s; }
      if (l - 1 >= 0) { // from lines v <= l - 2, i.e. states <= l - 1
        const v = pre[l - 1] + COST_SKIP + COST_SKIP_PER_LINE * (l - 2);
        if (v < best) { best = v; arg = preArg[l - 1]; }
      }
      if (s + 1 <= S - 1) { // from lines v >= l + 1, i.e. states >= l + 2
        const v = suf[s + 1] + COST_REGRESS - COST_REGRESS_PER_LINE * (l + 1);
        if (v < best) { best = v; arg = sufArg[s + 1]; }
      }
      if (best + res < next[s]) { next[s] = best + res; fr[s] = arg; off[s] = 0; }
    }
    from.push(fr);
    offs.push(off);
    prev = next;
  }
  prev[S - 1] -= COST_END_EARLY; // equivalent to charging every other final state
  let s = 0;
  for (let k = 1; k < S; k++) if (prev[k] < prev[s]) s = k;
  const cost = prev[s] + COST_END_EARLY;
  const lines = new Array(main.length);
  for (let j = main.length - 1; j >= 0; j--) {
    lines[j] = offs[j][s] ? null : s - 1;
    s = from[j][s];
  }
  return { cost, lines };
}

// Theil-Sen fit of (pass height - assigned line centre) against time, over the passes that are
// within half a pitch of the current model (outlier passes cannot pull it).
function theilSen(main, lines, layout, model, span) {
  const pts = [];
  main.forEach((p, j) => {
    if (lines[j] === null) return;
    const r = p.m - layout.centres[lines[j]];
    if (Math.abs(r - offsetAt(model, p.tau)) <= layout.pitch / 2) pts.push({ x: p.tau, r });
  });
  if (pts.length === 0) return null;
  let slope = 0;
  if (pts.length >= 3 && span > 0) {
    const slopes = [];
    const total = (pts.length * (pts.length - 1)) / 2;
    const every = Math.max(1, Math.ceil(total / MAX_PAIRS));
    let c = 0;
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        if (c++ % every !== 0) continue;
        const dx = pts[b].x - pts[a].x;
        if (dx > 0) slopes.push((pts[b].r - pts[a].r) / dx);
      }
    }
    slope = median(slopes);
    const lim = (DRIFT_MAX_PITCH * layout.pitch) / span;
    slope = Math.max(-lim, Math.min(lim, slope));
  }
  const b0 = median(pts.map((p) => p.r - slope * p.x));
  return isNum(b0) && isNum(slope) ? { b0, b1: slope } : null;
}

// Coarse grid over (offset, total drift) scored by quickCost, then the best few distinct
// candidates are decoded and refined with Theil-Sen. Returns {model, lines}.
function fitDrift(main, layout, span) {
  const p = layout.pitch;
  const useDrift = main.length >= 3 && span > 0;
  let stepD = p / 8;
  let stepB = p / 8;
  const dMax = useDrift ? DRIFT_MAX_PITCH * p : 0;
  const cMin = layout.sorted[0];
  const cMax = layout.sorted[layout.sorted.length - 1];
  const mMin = Math.min(...main.map((q) => q.m));
  const mMax = Math.max(...main.map((q) => q.m));
  // offsets that put at least part of the data on the text, for any drift considered
  const bLo = mMin - cMax - dMax - p;
  const bHi = mMax - cMin + dMax + p;
  const nD = () => (useDrift ? Math.floor((2 * dMax) / stepD) + 1 : 1);
  const nB = () => Math.floor((bHi - bLo) / stepB) + 1;
  const load = nD() * nB() * main.length;
  if (load > GRID_BUDGET) {
    const f = Math.sqrt(load / GRID_BUDGET);
    stepD *= f;
    stepB *= f;
  }

  const cands = []; // best few, kept at least half a pitch apart
  const consider = (model, cost) => {
    for (const c of cands) {
      if (Math.abs(c.model.b0 - model.b0) < p / 2 && Math.abs((c.model.b1 - model.b1) * span) < p / 2) {
        if (cost < c.cost) { c.cost = cost; c.model = model; }
        return;
      }
    }
    cands.push({ model, cost });
    cands.sort((a, b) => a.cost - b.cost);
    if (cands.length > CANDIDATES) cands.pop();
  };
  for (let i = 0; i < nD(); i++) {
    const D = useDrift ? -dMax + i * stepD : 0;
    const b1 = useDrift ? D / span : 0;
    for (let k = 0; k < nB(); k++) {
      const model = { b0: bLo + k * stepB, b1 };
      consider(model, quickCost(main, layout, model) + driftCost(model, span, p));
    }
  }

  let best = null;
  for (const c of cands) {
    let model = c.model;
    let dec = decode(main, layout, model);
    let cost = dec.cost + driftCost(model, span, p);
    for (let it = 0; it < REFINE_ITERATIONS; it++) {
      const next = theilSen(main, dec.lines, layout, model, span);
      if (!next) break;
      const nd = decode(main, layout, next);
      const nc = nd.cost + driftCost(next, span, p);
      if (!(nc < cost - 1e-9)) break;
      model = next; dec = nd; cost = nc;
    }
    if (!best || cost < best.cost) best = { model, lines: dec.lines, cost };
  }
  return best || { model: { b0: 0, b1: 0 }, lines: main.map(() => null) };
}

// Robust long-dwell lines: dwell per word above median + 2 MAD and above 1.5x the median.
function longDwell(lineDwellMs, layout) {
  const per = [];
  lineDwellMs.forEach((d, l) => { if (d > 0) per.push({ l, v: d / layout.lines[l].xs.length }); });
  if (per.length < LONG_DWELL_MIN_LINES) return [];
  const med = median(per.map((e) => e.v));
  const mad = median(per.map((e) => Math.abs(e.v - med)));
  return per.filter((e) => e.v > med + 2 * mad && e.v > 1.5 * med).map((e) => e.l);
}

function computeLineMetrics(samples, words, screen, opts = {}) {
  const layout = buildLayout(words);
  const L = layout ? layout.lines.length : 0;
  const metrics = emptyLineMetrics(L);
  const list = Array.isArray(samples) ? samples : [];
  const screenOk = screen && typeof screen === 'object' && sane(screen.w) && sane(screen.h) && screen.w > 0 && screen.h > 0;
  if (!layout || list.length === 0 || !screenOk) return withDebug(metrics, opts, []);

  let validCount = 0;
  let lastT = -Infinity;
  const cleaned = [];
  for (const s of list) {
    if (!s || typeof s !== 'object' || !isNum(s.t) || Math.abs(s.t) > MAX_T) continue;
    lastT = Math.max(lastT, s.t);
    const ok = isNum(s.x) && isNum(s.y) && s.x >= 0 && s.x <= screen.w && s.y >= 0 && s.y <= screen.h;
    if (ok) { validCount++; cleaned.push({ t: s.t, x: s.x, y: s.y }); } else cleaned.push({ t: s.t, x: null, y: null });
  }
  const validRatio = validCount / list.length;
  const fixations = detectFixations(cleaned);
  if (fixations.length < MIN_FIXATIONS) return withDebug(metrics, opts, []);

  const t0 = fixations[0].tStart;
  const passes = splitPasses(fixations, layout, t0);
  let main = passes.filter((q) => q.n >= MAIN_PASS_FIXATIONS);
  if (main.length === 0) main = passes;

  // Vertical noise of one fixation, from the spread inside passes; sets how much a pass's median
  // can be trusted against the reading-model costs.
  const devs = [];
  for (const q of main) for (const k of q.fix) devs.push(Math.abs(fixations[k].y - q.m));
  const pitch = layout.pitch;
  const sigmaFix = Math.min(Math.max(1.4826 * median(devs), 0.1 * pitch), 1.5 * pitch);
  for (const q of passes) q.sigma = Math.max((sigmaFix * 1.05) / Math.sqrt(q.n), 0.08 * pitch);

  const span = main.length > 1 ? main[main.length - 1].tau - main[0].tau : 0;
  const fit = fitDrift(main, layout, span > 0 ? span : 0);
  const model = fit.model;

  // Lines: main passes from the decoder, short passes and their fixations by corrected height.
  const fixLine = new Array(fixations.length).fill(null);
  const yCorr = fixations.map((f) => f.y - offsetAt(model, (f.tStart + f.tEnd) / 2 - t0));
  const nearestOnText = (y) => {
    const l = nearestLine(layout, y);
    return Math.abs(y - layout.centres[l]) <= OFF_TEXT_PITCH * pitch ? l : null;
  };
  const mainIndex = new Map(main.map((q, j) => [q, j]));
  for (const q of passes) {
    if (mainIndex.has(q)) {
      q.line = fit.lines[mainIndex.get(q)];
      for (const k of q.fix) fixLine[k] = q.line;
    } else {
      q.line = nearestOnText(q.m - offsetAt(model, q.tau));
      for (const k of q.fix) fixLine[k] = nearestOnText(yCorr[k]);
    }
  }

  let inliers = 0;
  fixations.forEach((f, k) => {
    if (fixLine[k] !== null && Math.abs(yCorr[k] - layout.centres[fixLine[k]]) <= INLIER_PITCH * pitch) inliers++;
  });
  metrics.quality = Math.min(1, Math.max(0, finite(validRatio * (inliers / fixations.length))));
  metrics.driftPx = finite(model.b0);

  // Reading frontier: progress only from passes that plausibly are reading.
  const tailStart = lastT - TAIL_IGNORE_MS;
  let frontier = -1;
  const counted = [];
  for (const q of passes) {
    if (q.line === null) continue;
    if (q.line > frontier + 1 && q.n < MAIN_PASS_FIXATIONS) continue; // stray glance far ahead
    if (frontier >= 0 && q.line > frontier && q.tStart >= tailStart) continue; // heading for the button
    if (q.line < frontier) metrics.regressions++;
    frontier = Math.max(frontier, q.line);
    counted.push(q);
    q.counted = true;
  }

  if (counted.length > 0) {
    const visited = new Set(counted.map((q) => q.line));
    const hi = frontier;
    let tFirst = Infinity;
    let tLast = -Infinity;
    let maxX = -Infinity;
    let fixOnHi = 0;
    for (const q of counted) {
      for (const k of q.fix) {
        const f = fixations[k];
        tFirst = Math.min(tFirst, f.tStart);
        tLast = Math.max(tLast, f.tEnd);
        if (fixLine[k] !== null) metrics.lineDwellMs[fixLine[k]] += f.tEnd - f.tStart;
        if (q.line === hi) { fixOnHi++; maxX = Math.max(maxX, f.x); }
      }
    }
    metrics.linesRead = visited.size;
    for (let l = 1; l < hi; l++) if (!visited.has(l)) metrics.skippedLines++;
    for (const l of visited) if (l < hi) metrics.wordsRead += layout.lines[l].xs.length;
    const hiXs = layout.lines[hi].xs;
    const extent = hiXs.filter((x) => x <= maxX).length;
    metrics.wordsRead += extent;
    metrics.completed = hi === L - 1 && (extent >= 0.7 * hiXs.length || fixOnHi >= MAIN_PASS_FIXATIONS);
    metrics.durationSec = finite((tLast - tFirst) / 1000);
    metrics.wpm = metrics.durationSec > 0 ? finite((metrics.wordsRead / metrics.durationSec) * 60) : 0;
    metrics.lineDwellMs = metrics.lineDwellMs.map(finite);
    metrics.longDwellLines = longDwell(metrics.lineDwellMs, layout);
  }
  metrics.reliable = metrics.quality >= LINE_RELIABLE_MIN && metrics.linesRead > 0;

  return withDebug(metrics, opts, fixations, { fixLine, yCorr, passes, model });
}

function withDebug(metrics, opts, fixations, extra) {
  if (!opts || !opts.debug) return metrics;
  const passOf = new Array(fixations.length);
  if (extra) extra.passes.forEach((q, j) => { for (const k of q.fix) passOf[k] = j; });
  metrics.debug = {
    model: extra ? extra.model : { b0: 0, b1: 0 },
    fixations: fixations.map((f, k) => ({
      tStart: f.tStart, tEnd: f.tEnd, x: f.x, y: f.y,
      yCorrected: extra.yCorr[k], line: extra.fixLine[k], pass: passOf[k],
    })),
    passes: extra ? extra.passes.map((q) => ({ n: q.n, tStart: q.tStart, medianY: q.m, line: q.line, counted: Boolean(q.counted) })) : [],
  };
  return metrics;
}

module.exports = { computeLineMetrics, LINE_RELIABLE_MIN };
