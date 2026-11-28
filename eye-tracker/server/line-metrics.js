'use strict';

// Line-level reading metrics with automatic gaze-offset (drift) correction. Pure functions.
//
// Webcam gaze is too coarse for words (a real check gave a 154 px mean error against a 49-64 px
// line pitch). The working hypothesis (to be checked on real sessions, docs/accuracy-protocol.md)
// is that much of the error is an offset that differs per child and drifts while reading. So the
// text structure itself calibrates: fixations are split into passes (return sweeps, look-aways,
// large vertical jumps), each pass is a line read (or off the text), and a robust fit of "pass
// height minus its line's height" over time gives the offset (b0), its drift (b1) and, after a
// look-away, a per-segment change. Lines are decoded from the corrected heights with a reading
// model.
//
// Product rule: when the line assignment may be wrong the session must come out
// `reliable: false` (참고용). Several guards below exist only for that (see reliabilityIssues).
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
const GAP_SPLIT_MS = 1000; // no gaze for this long: new pass and new offset segment (child looked away / sat back)
const JUMP_SPLIT_PITCH = 2.5; // two fixations in a row this far (in pitches) from the pass: new pass
const MAIN_PASS_FIXATIONS = 3; // passes with fewer fixations do not take part in the offset fit
const TAIL_IGNORE_MS = 500; // a pass opening a new line this close to the end is the gaze going to the "done" button
const INLIER_PITCH = 0.6; // a fixation within this many pitches of its line centre is an inlier (quality)
const INSIDE_PITCH = 0.75; // corrected heights within this margin of the first/last line are "inside the text block"
const OFF_TEXT_X = 0.3; // a fixation further than this share of the text width left/right of the text is off it
const EDGE_PX = 2; // WebGazer clamps predictions to the viewport: samples this close to an edge are pinned
const LONG_DWELL_MIN_LINES = 4;
const MAX_COORD = 1e7; // anything larger is garbage, not a screen position
const MAX_T = 1e15;

// Reliability guards (each one alone makes the session 참고용).
const EDGE_MAX_SHARE = 0.1; // share of valid samples pinned to a screen edge
const AMBIGUITY_MIN = 2; // the best line decoding must beat every different one by this cost
// A skip / going back / off-text pass must beat the best plain reading (re-reads allowed) by this
// cost. 5 shows more sessions with a regression at the same measured risk, 8 is more cautious;
// to be set from real sessions.
const ANOMALY_MIN = 6;
const ANOMALY_SIGMA_PITCH = 0.35; // ... judged with at least this pass-height noise (in pitches)
const EDGE_LINE_PITCH = 0.75; // every line's expected gaze height must be this far inside the screen
const PROGRESSION_MIN_PITCH = 0.5; // raw pass height must rise by this many pitches per line read
const THIN_MAX_SHARE = 0.3; // share of counted passes with fewer than MAIN_PASS_FIXATIONS fixations
const OFF_TEXT_MAX_SHARE = 0.2; // share of fixations on no line
const PASSES_PER_LINE_MAX = 2.5; // counted passes per line read (stares and endless sweeps)
const SWEEP_MIN_CORR = 0.5; // one-line passages: x must move left to right within passes
const SWEEP_MIN_SPAN = 0.4; // ... and cover this share of the line

// Costs (negative log-likelihood units) of the reading model used to pick the offset and the line
// of every pass. Reading the next line is free; anything else must be paid for by a better fit.
const COST_REPEAT = 3; // the same line again (re-reading a line from its start is common)
const COST_REGRESS = 3; // going back one line (+1 per further line)
const COST_REGRESS_PER_LINE = 1;
const COST_SKIP = 3; // skipping one line (+2 per further line); also starting below line 0
const COST_SKIP_PER_LINE = 2;
const COST_OFF = 6; // a pass on no line: outside the text block, or a short glance
const COST_OFF_INSIDE = 15; // a full pass inside the text block cannot just be discarded
const COST_END_EARLY = 2; // the last pass is not on the last line (stopping early is allowed, just less likely)
const DRIFT_MAX_PITCH = 4; // largest total drift over a session considered
const DRIFT_PRIOR = 1; // cost per (drift in pitches)^2: prefers a steady offset when in doubt
const SEGMENT_MAX_PITCH = 5; // largest offset change after a look-away considered
const SEGMENT_PRIOR = 0.25; // cost per (offset change in pitches)^2 after a look-away
const MAX_SEGMENTS = 6; // segments beyond this keep the offset of the one before
const GRID_BUDGET = 2e6; // pass evaluations allowed for the coarse search
const SEGMENT_BUDGET = 2e7; // pass x line evaluations allowed for the per-segment search
const MARGINAL_BUDGET = 4e6; // pass x state cells allowed for the ambiguity computation
const CANDIDATES = 4;
const REFINE_ITERATIONS = 3;
const MAX_PAIRS = 40000; // Theil-Sen pair cap
const SYSTEMATIC_MAX_PITCH = 0.5; // cap of the estimated between-pass (systematic) height error

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const finite = (v) => (isNum(v) ? v : 0);
const sane = (v) => isNum(v) && Math.abs(v) <= MAX_COORD;

function median(nums) {
  if (nums.length === 0) return 0;
  const s = Float64Array.from(nums).sort();
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Height of a pass: median for few fixations, else the mean of the middle 60% (nearly as precise
// as the mean on clean data, robust to a stray fixation).
function passHeight(nums) {
  if (nums.length < 5) return median(nums);
  const s = Float64Array.from(nums).sort();
  const cut = Math.floor(s.length * 0.2);
  let sum = 0;
  for (let k = cut; k < s.length - cut; k++) sum += s[k];
  return sum / (s.length - 2 * cut);
}

function theilSenSlope(xs, ys) {
  const n = xs.length;
  const slopes = [];
  const every = Math.max(1, Math.ceil((n * (n - 1)) / 2 / MAX_PAIRS));
  let c = 0;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (c++ % every !== 0) continue;
      const dx = xs[b] - xs[a];
      if (dx !== 0) slopes.push((ys[b] - ys[a]) / dx);
    }
  }
  return slopes.length ? median(slopes) : 0;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let k = 0; k < n; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
    syy += (ys[k] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
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

// Lines in order of their `line` id: centre y, word left edges, right edge, pitch, text extent.
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
    if (!ln) { ln = { id: w.line, sum: 0, xs: [], right: -Infinity }; byLine.set(w.line, ln); }
    ln.sum += w.y + w.h / 2;
    ln.xs.push(w.x);
    ln.right = Math.max(ln.right, w.x + w.w);
    left = Math.min(left, w.x);
    right = Math.max(right, w.x + w.w);
    heights.push(Math.abs(w.h));
  }
  if (byLine.size === 0) return null;
  const lines = [...byLine.values()].sort((a, b) => a.id - b.id)
    .map((ln) => ({ centre: ln.sum / ln.xs.length, xs: ln.xs.sort((a, b) => a - b), right: ln.right }));
  const centres = lines.map((ln) => ln.centre);
  let pitch = median(centres.slice(1).map((c, k) => Math.abs(c - centres[k])).filter((d) => d > 0));
  if (!(pitch > 0)) pitch = 2 * median(heights);
  if (!(pitch > 0)) pitch = 1;
  // Nearest line by binary search over the centres sorted by height (garbage layouts may not be monotonic).
  const order = centres.map((c, k) => k).sort((a, b) => centres[a] - centres[b]);
  const sorted = order.map((k) => centres[k]);
  return { lines, centres, pitch, left, right, width: Math.max(right - left, 0), order, sorted };
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

const insideBlock = (layout, y) => y >= layout.sorted[0] - INSIDE_PITCH * layout.pitch
  && y <= layout.sorted[layout.sorted.length - 1] + INSIDE_PITCH * layout.pitch;

// Passes: a new one starts at a return sweep (x jumps left by more than RETURN_SWEEP_FRACTION of
// the text width), after a gaze gap of GAP_SPLIT_MS (which also starts a new offset segment), or
// where two fixations in a row sit more than JUMP_SPLIT_PITCH pitches from the pass (a glance
// away, at the button, a jump to another part of the text).
function splitPasses(fixations, layout, t0) {
  const sweep = RETURN_SWEEP_FRACTION * layout.width;
  const jump = JUMP_SPLIT_PITCH * layout.pitch;
  const passes = [];
  let cur = null;
  let segment = 0;
  const open = (k) => { cur = { fix: [k], seg: segment }; passes.push(cur); };
  fixations.forEach((f, k) => {
    if (!cur) return open(k);
    const prev = fixations[k - 1];
    if (f.tStart - prev.tEnd >= GAP_SPLIT_MS) { segment++; return open(k); }
    if (layout.width > 0 && prev.x - f.x > sweep) return open(k);
    const ref = median(cur.fix.map((j) => fixations[j].y));
    const next = fixations[k + 1];
    if (Math.abs(f.y - ref) > jump && next && next.tStart - f.tEnd < GAP_SPLIT_MS
        && Math.abs(next.y - ref) > jump && Math.abs(next.y - f.y) <= jump) return open(k);
    cur.fix.push(k);
  });
  for (const p of passes) {
    const fs = p.fix.map((k) => fixations[k]);
    p.n = fs.length;
    p.tStart = fs[0].tStart;
    p.m = passHeight(fs.map((f) => f.y));
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

// model: { b0, b1, seg: [offset change per segment] }
const offsetAt = (model, tau, seg) => model.b0 + model.b1 * tau + ((model.seg && model.seg[seg]) || 0);
const corrected = (model, p) => p.m - offsetAt(model, p.tau, p.seg);
function priorCost(model, span, pitch) {
  let c = DRIFT_PRIOR * ((model.b1 * span) / pitch) ** 2;
  if (model.seg) for (const d of model.seg) c += SEGMENT_PRIOR * (d / pitch) ** 2;
  return c;
}
function offCost(layout, p, y) {
  return p.n >= MAIN_PASS_FIXATIONS && insideBlock(layout, y) ? COST_OFF_INSIDE : COST_OFF;
}
function residualCost(layout, p, y, l) {
  const r = (y - layout.centres[l]) / p.sigma;
  return (r * r) / 2;
}

// Cheap score for the coarse search: every pass on its nearest line (or off the text), plus the
// reading-model costs of that sequence.
function quickCost(passes, layout, model) {
  let cost = 0;
  let prev = -1;
  for (const p of passes) {
    const y = corrected(model, p);
    const l = nearestLine(layout, y);
    const res = residualCost(layout, p, y, l);
    const off = offCost(layout, p, y);
    if (res >= off) { cost += off; continue; }
    cost += res + transCost(prev, l);
    prev = l;
  }
  return cost + (prev === layout.centres.length - 1 ? 0 : COST_END_EARLY);
}

// Best line (or null: off the text) for every pass under `model`, by dynamic programming over
// "last line read" states (s = line + 1, s = 0: none yet). O(passes x lines): the transition
// minimum uses prefix/suffix minima. With `keep`, the per-pass tables needed for the ambiguity
// gap are returned too.
function decode(passes, layout, model, keep) {
  const L = layout.centres.length;
  const S = L + 1;
  let prev = new Float64Array(S).fill(Infinity);
  prev[0] = 0;
  const from = [];
  const offs = [];
  const tables = keep ? { prevs: [], onCost: [], offC: [] } : null;
  const pre = new Float64Array(S);
  const preArg = new Int32Array(S);
  const suf = new Float64Array(S + 1);
  const sufArg = new Int32Array(S + 1);
  for (const p of passes) {
    const y = corrected(model, p);
    const oc = offCost(layout, p, y);
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
    const on = keep ? new Float64Array(L) : null;
    for (let s = 0; s < S; s++) { next[s] = prev[s] + oc; fr[s] = s; off[s] = 1; }
    for (let l = 0; l < L; l++) {
      const s = l + 1;
      let best = prev[l]; // from line l - 1
      let arg = l;
      if (prev[s] + COST_REPEAT < best) { best = prev[s] + COST_REPEAT; arg = s; }
      if (l >= 1) { // from lines v <= l - 2, i.e. states <= l - 1
        const v = pre[l - 1] + COST_SKIP + COST_SKIP_PER_LINE * (l - 2);
        if (v < best) { best = v; arg = preArg[l - 1]; }
      }
      if (s + 1 <= S - 1) { // from lines v >= l + 1, i.e. states >= l + 2
        const v = suf[s + 1] + COST_REGRESS - COST_REGRESS_PER_LINE * (l + 1);
        if (v < best) { best = v; arg = sufArg[s + 1]; }
      }
      const total = best + residualCost(layout, p, y, l);
      if (on) on[l] = total;
      if (total < next[s]) { next[s] = total; fr[s] = arg; off[s] = 0; }
    }
    if (tables) { tables.prevs.push(prev); tables.onCost.push(on); tables.offC.push(oc); }
    from.push(fr);
    offs.push(off);
    prev = next;
  }
  const final = Float64Array.from(prev, (v, s) => v + (s === S - 1 ? 0 : COST_END_EARLY));
  let s = 0;
  for (let k = 1; k < S; k++) if (final[k] < final[s]) s = k;
  const cost = final[s];
  const lines = new Array(passes.length);
  for (let j = passes.length - 1; j >= 0; j--) {
    lines[j] = offs[j][s] ? null : s - 1;
    s = from[j][s];
  }
  return { cost, lines, tables };
}

// decode(...).cost without backtracking (no per-pass allocation): for the per-segment search.
function decodeCost(passes, layout, model) {
  const L = layout.centres.length;
  const S = L + 1;
  let prev = new Float64Array(S).fill(Infinity);
  let next = new Float64Array(S);
  prev[0] = 0;
  const pre = new Float64Array(S);
  const suf = new Float64Array(S + 1);
  for (const p of passes) {
    const y = corrected(model, p);
    const oc = offCost(layout, p, y);
    for (let s = 0; s < S; s++) {
      const v = prev[s] - COST_SKIP_PER_LINE * (s - 1);
      pre[s] = s === 0 ? v : Math.min(pre[s - 1], v);
    }
    suf[S] = Infinity;
    for (let s = S - 1; s >= 0; s--) suf[s] = Math.min(suf[s + 1], prev[s] + COST_REGRESS_PER_LINE * (s - 1));
    for (let s = 0; s < S; s++) next[s] = prev[s] + oc;
    for (let l = 0; l < L; l++) {
      const s = l + 1;
      let best = Math.min(prev[l], prev[s] + COST_REPEAT);
      if (l >= 1) best = Math.min(best, pre[l - 1] + COST_SKIP + COST_SKIP_PER_LINE * (l - 2));
      if (s + 1 <= S - 1) best = Math.min(best, suf[s + 1] + COST_REGRESS - COST_REGRESS_PER_LINE * (l + 1));
      next[s] = Math.min(next[s], best + residualCost(layout, p, y, l));
    }
    [prev, next] = [next, prev];
  }
  let cost = Infinity;
  for (let s = 0; s < S; s++) cost = Math.min(cost, prev[s] + (s === S - 1 ? 0 : COST_END_EARLY));
  return cost;
}

// Decoding ambiguity under a fixed model: how much more the cheapest decoding that puts at least
// one main pass on a different line (or off the text) costs than the best one. Min-marginals from the
// forward tables of decode() and a backward pass with the same transition structure.
function ambiguityGap(passes, layout, model, dec) {
  const L = layout.centres.length;
  const S = L + 1;
  const P = passes.length;
  if (P === 0) return Infinity;
  const { prevs, onCost, offC } = dec.tables;
  let B = Float64Array.from({ length: S }, (_, s) => (s === S - 1 ? 0 : COST_END_EARLY)); // after the last pass
  let gap = Infinity;
  const g = new Float64Array(L);
  const preG = new Float64Array(L);
  const sufG = new Float64Array(L + 1);
  for (let j = P - 1; j >= 0; j--) {
    // marginals of pass j: on line l -> onCost[j][l] + B[l + 1]; off -> min_s prevs[j][s] + off + B[s]
    const chosen = dec.lines[j];
    const matters = passes[j].n >= MAIN_PASS_FIXATIONS; // a short pass's line hardly changes the figures
    for (let l = 0; matters && l < L; l++) {
      if (l === chosen) continue;
      gap = Math.min(gap, onCost[j][l] + B[l + 1] - dec.cost);
    }
    if (matters && chosen !== null) {
      let m = Infinity;
      for (let s = 0; s < S; s++) m = Math.min(m, prevs[j][s] + offC[j] + B[s]);
      gap = Math.min(gap, m - dec.cost);
    }
    if (j === 0) break;
    // B_{j-1}(s) = min( off_j + B_j(s), min_l trans(s-1 -> l) + res_j(l) + B_j(l + 1) )
    const y = corrected(model, passes[j]);
    for (let l = 0; l < L; l++) g[l] = residualCost(layout, passes[j], y, l) + B[l + 1];
    for (let l = 0; l < L; l++) {
      const v = g[l] - COST_REGRESS_PER_LINE * l;
      preG[l] = l === 0 ? v : Math.min(preG[l - 1], v);
    }
    sufG[L] = Infinity;
    for (let l = L - 1; l >= 0; l--) sufG[l] = Math.min(sufG[l + 1], g[l] + COST_SKIP_PER_LINE * l);
    const nb = new Float64Array(S);
    for (let s = 0; s < S; s++) {
      const v = s - 1;
      let best = offC[j] + B[s];
      if (v + 1 <= L - 1) best = Math.min(best, g[v + 1]);
      if (v >= 0) best = Math.min(best, g[v] + COST_REPEAT);
      if (v + 2 <= L - 1) best = Math.min(best, COST_SKIP - COST_SKIP_PER_LINE * (v + 2) + sufG[v + 2]);
      if (v - 1 >= 0) best = Math.min(best, COST_REGRESS + COST_REGRESS_PER_LINE * (v - 1) + preG[v - 1]);
      nb[s] = best;
    }
    B = nb;
  }
  return gap;
}

// Cost of one given line sequence (null: off) under `model`, same terms as decode().
function pathCost(passes, layout, model, lines) {
  let cost = 0;
  let prev = -1;
  passes.forEach((p, j) => {
    const y = corrected(model, p);
    if (lines[j] === null) { cost += offCost(layout, p, y); return; }
    cost += residualCost(layout, p, y, lines[j]) + transCost(prev, lines[j]);
    prev = lines[j];
  });
  return cost + (prev === layout.centres.length - 1 ? 0 : COST_END_EARLY);
}

// Best "plain" reading of the main passes: start at line 0, then each pass on the same line
// (a re-read) or the next one, never skipping or going back, never off the text.
function decodeMonotone(passes, layout, model) {
  const L = layout.centres.length;
  let prev = new Float64Array(L).fill(Infinity);
  const from = [];
  passes.forEach((p, j) => {
    const y = corrected(model, p);
    const next = new Float64Array(L).fill(Infinity);
    const fr = new Uint8Array(L); // 1: came from the previous line
    for (let l = 0; l < L; l++) {
      const res = residualCost(layout, p, y, l);
      if (j === 0) { if (l === 0) next[l] = res; continue; }
      const stay = prev[l] + COST_REPEAT;
      const step = l > 0 ? prev[l - 1] : Infinity;
      if (step <= stay) { next[l] = step + res; fr[l] = 1; } else next[l] = stay + res;
    }
    from.push(fr);
    prev = next;
  });
  let l = 0;
  for (let k = 1; k < L; k++) if (prev[k] + (k === L - 1 ? 0 : COST_END_EARLY) < prev[l] + (l === L - 1 ? 0 : COST_END_EARLY)) l = k;
  const lines = new Array(passes.length);
  for (let j = passes.length - 1; j >= 0; j--) {
    lines[j] = l;
    if (from[j][l]) l--;
  }
  return lines;
}

// Is an unusual reading (a skip, going back, a pass off the text) really supported by the data?
// Compare the best decoding of the main passes with the best plain reading (decodeMonotone, with
// its own offset and drift). If the plain reading is nearly as good, the anomaly may just be one
// noisy or systematically misplaced pass, and the line figures cannot be trusted. Judged under a
// pessimistic noise floor: real gaze has per-line errors the fixation spread inside one pass does
// not show. Infinity: nothing unusual to test.
function anomalySupport(passes, layout, best, span) {
  const mainIdx = passes.map((p, j) => j).filter((j) => passes[j].n >= MAIN_PASS_FIXATIONS);
  if (mainIdx.length < 2) return Infinity;
  const bestLines = mainIdx.map((j) => best.dec.lines[j]);
  const anomalous = bestLines.some((l, k) => {
    if (l === null) return true;
    const d = l - (k === 0 ? -1 : bestLines[k - 1]);
    return d < 0 || d > 1 || (k === 0 && l !== 0);
  });
  if (!anomalous) return Infinity;
  const floor = ANOMALY_SIGMA_PITCH * layout.pitch;
  const mp = mainIdx.map((j) => ({ ...passes[j], sigma: Math.max(passes[j].sigma, floor) }));
  const bestCost = pathCost(mp, layout, best.model, bestLines) + priorCost(best.model, span, layout.pitch);
  let model = { ...best.model };
  let lines = decodeMonotone(mp, layout, model);
  let cost = pathCost(mp, layout, model, lines) + priorCost(model, span, layout.pitch);
  for (let it = 0; it < REFINE_ITERATIONS; it++) {
    const next = theilSen(mp, lines, layout, model, span, true);
    if (!next) break;
    const nl = decodeMonotone(mp, layout, next);
    const c = pathCost(mp, layout, next, nl) + priorCost(next, span, layout.pitch);
    if (!(c < cost - 1e-9)) break;
    model = next; lines = nl; cost = c;
  }
  return cost - bestCost;
}

// Theil-Sen fit of (pass height - assigned line centre - segment change) against time, over the
// main passes within half a pitch of the current model (outlier passes cannot pull it).
function theilSen(passes, lines, layout, model, span, everyPass = false) {
  const xs = [];
  const rs = [];
  passes.forEach((p, j) => {
    if (lines[j] === null || p.n < MAIN_PASS_FIXATIONS) return;
    const r = p.m - layout.centres[lines[j]] - ((model.seg && model.seg[p.seg]) || 0);
    if (everyPass || Math.abs(r - model.b0 - model.b1 * p.tau) <= layout.pitch / 2) { xs.push(p.tau); rs.push(r); }
  });
  if (xs.length === 0) return null;
  let slope = 0;
  if (xs.length >= 3 && span > 0) {
    slope = theilSenSlope(xs, rs);
    const lim = (DRIFT_MAX_PITCH * layout.pitch) / span;
    slope = Math.max(-lim, Math.min(lim, slope));
  }
  const b0 = median(rs.map((r, k) => r - slope * xs[k]));
  return isNum(b0) && isNum(slope) ? { ...model, b0, b1: slope } : null;
}

// Offset change of every later segment (after a look-away), one at a time, by a grid over the
// full decoding cost. Segment 0 is the reference (its offset is b0).
function fitSegments(passes, layout, model, span) {
  const nSeg = Math.min(MAX_SEGMENTS, 1 + Math.max(0, ...passes.map((p) => p.seg)));
  if (nSeg <= 1) return model;
  const p = layout.pitch;
  const steps = Math.floor((2 * SEGMENT_MAX_PITCH) / 0.25) + 1;
  if (steps * (nSeg - 1) * 2 * passes.length * layout.centres.length > SEGMENT_BUDGET) return model;
  let best = { ...model, seg: (model.seg || []).slice() };
  while (best.seg.length < nSeg) best.seg.push(0);
  let bestCost = decodeCost(passes, layout, best) + priorCost(best, span, p);
  for (let round = 0; round < 2; round++) {
    for (let s = 1; s < nSeg; s++) {
      if (!passes.some((q) => q.seg === s)) continue;
      for (let k = 0; k < steps; k++) {
        const seg = best.seg.slice();
        seg[s] = (-SEGMENT_MAX_PITCH + k * 0.25) * p;
        const m = { ...best, seg };
        const c = decodeCost(passes, layout, m) + priorCost(m, span, p);
        if (c < bestCost - 1e-9) { best = m; bestCost = c; }
      }
    }
  }
  return best;
}

// Coarse grid over (offset, total drift) scored by quickCost on the main passes, then the best
// few distinct candidates are decoded over all passes, given per-segment offsets and refined with
// Theil-Sen. Returns {model, dec, cost, gap}: gap is the ambiguity (see ambiguityGap), also
// counting a candidate whose best decoding differs.
function fitDrift(passes, main, layout, span, reuse) {
  const p = layout.pitch;
  const useDrift = main.length >= 3 && span > 0;
  let stepD = p / 8;
  let stepB = p / 8;
  const dMax = useDrift ? DRIFT_MAX_PITCH * p : 0;
  const cMin = layout.sorted[0];
  const cMax = layout.sorted[layout.sorted.length - 1];
  const mMin = Math.min(...main.map((q) => q.m));
  const mMax = Math.max(...main.map((q) => q.m));
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

  const cands = reuse ? reuse.map((c) => ({ ...c })) : []; // best few, kept at least half a pitch apart
  // very long sessions on long passages: fewer candidates to decode
  const maxCands = passes.length * layout.centres.length > 2e5 ? 2 : CANDIDATES;
  const consider = (model, cost) => {
    for (const c of cands) {
      if (Math.abs(c.model.b0 - model.b0) < p / 2 && Math.abs((c.model.b1 - model.b1) * span) < p / 2) {
        if (cost < c.cost) { c.cost = cost; c.model = model; }
        return;
      }
    }
    cands.push({ model, cost });
    cands.sort((a, b) => a.cost - b.cost);
    if (cands.length > maxCands) cands.pop();
  };
  for (let i = 0; !reuse && i < nD(); i++) {
    const b1 = useDrift ? (-dMax + i * stepD) / span : 0;
    for (let k = 0; k < nB(); k++) {
      const model = { b0: bLo + k * stepB, b1 };
      consider(model, quickCost(main, layout, model) + priorCost(model, span, p));
    }
  }

  const results = [];
  // Per-segment offsets for every candidate when that is cheap; on long sessions only for the winner.
  const nSeg = 1 + Math.max(0, ...passes.map((q) => q.seg));
  const segCost = (Math.floor((2 * SEGMENT_MAX_PITCH) / 0.25) + 1) * 2 * (Math.min(nSeg, MAX_SEGMENTS) - 1)
    * passes.length * layout.centres.length;
  const segEach = segCost * cands.length <= SEGMENT_BUDGET / 4;
  for (const c of cands) {
    let model = segEach ? fitSegments(passes, layout, c.model, span) : c.model;
    let dec = decode(passes, layout, model);
    let cost = dec.cost + priorCost(model, span, p);
    for (let it = 0; it < REFINE_ITERATIONS; it++) {
      const next = theilSen(passes, dec.lines, layout, model, span);
      if (!next) break;
      const nd = decode(passes, layout, next);
      const nc = nd.cost + priorCost(next, span, p);
      if (!(nc < cost - 1e-9)) break;
      model = next; dec = nd; cost = nc;
    }
    results.push({ model, dec, cost });
  }
  if (results.length === 0) return { model: { b0: 0, b1: 0 }, dec: { lines: passes.map(() => null) }, cost: 0, gap: 0, cands };
  results.sort((a, b) => a.cost - b.cost);
  const best = results[0];
  // Segment offsets once more around the refined drift of the winner.
  const reseg = fitSegments(passes, layout, best.model, span);
  if (reseg !== best.model) {
    const rd = decode(passes, layout, reseg);
    const rc = rd.cost + priorCost(reseg, span, p);
    if (rc < best.cost - 1e-9) { best.model = reseg; best.dec = rd; best.cost = rc; }
  }
  const key = best.dec.lines.join(',');
  let gap = Infinity;
  for (const r of results.slice(1)) if (r.dec.lines.join(',') !== key) gap = Math.min(gap, r.cost - best.cost);
  if (passes.length * (layout.centres.length + 1) <= MARGINAL_BUDGET) {
    const full = decode(passes, layout, best.model, true);
    gap = Math.min(gap, ambiguityGap(passes, layout, best.model, full));
  } else {
    gap = 0; // too large to check: do not claim the decoding is unambiguous
  }
  return { ...best, gap, cands };
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

// One-line passages carry no vertical structure: progress must at least look like reading, i.e.
// a few passes with x moving left to right, covering a good part of the line.
function sweepLooksLikeReading(counted, fixations, layout) {
  // passes are cut at leftward jumps, so any gaze makes rightward runs: also require a sane number
  // of them (reading the line, maybe once more), not endless sweeps or random gaze
  if (counted.length > PASSES_PER_LINE_MAX) return false;
  const corrs = [];
  const xs = [];
  for (const q of counted) {
    const fx = q.fix.map((k) => fixations[k].x);
    xs.push(...fx);
    if (fx.length >= MAIN_PASS_FIXATIONS) corrs.push(pearson(fx.map((_, k) => k), fx));
  }
  if (corrs.length === 0) return false;
  const lineWidth = layout.lines[0].right - layout.lines[0].xs[0];
  const sorted = xs.sort((a, b) => a - b);
  const span = sorted[Math.floor(sorted.length * 0.9)] - sorted[Math.floor(sorted.length * 0.1)];
  return median(corrs) >= SWEEP_MIN_CORR && span >= SWEEP_MIN_SPAN * lineWidth;
}

// Every reason this session's line assignment may be wrong (empty: reliable).
function reliabilityIssues(ctx) {
  const { metrics, edgeShare, gap, anomaly, counted, fixations, layout, offTextShare, model, screen, passes } = ctx;
  const issues = [];
  // Lines whose gaze would land at or past a screen edge cannot be observed (WebGazer pins or
  // drops those estimates), so whether they were read is unknown.
  const margin = EDGE_LINE_PITCH * layout.pitch;
  const lo = layout.sorted[0];
  const hiC = layout.sorted[layout.sorted.length - 1];
  for (const q of passes) {
    const off = offsetAt(model, q.tau, q.seg);
    if (lo + off < margin || hiC + off > screen.h - margin) { issues.push('lines-at-screen-edge'); break; }
  }
  if (metrics.quality < LINE_RELIABLE_MIN) issues.push('quality');
  if (metrics.linesRead === 0) issues.push('nothing-read');
  if (edgeShare > EDGE_MAX_SHARE) issues.push('edge-clamped');
  if (!(gap > AMBIGUITY_MIN)) issues.push('ambiguous');
  if (!(anomaly > ANOMALY_MIN)) issues.push('unsupported-anomaly');
  if (offTextShare > OFF_TEXT_MAX_SHARE) issues.push('off-text');
  if (counted.length > 0) {
    const thin = counted.filter((q) => q.n < MAIN_PASS_FIXATIONS).length / counted.length;
    if (thin > THIN_MAX_SHARE) issues.push('thin-passes');
    if (counted.length / Math.max(1, metrics.linesRead) > PASSES_PER_LINE_MAX) issues.push('passes-per-line');
  }
  if (layout.lines.length > 1) {
    // Real vertical progression: raw pass heights (look-away steps removed, drift not) must rise
    // with the line read; a frozen or stuck vertical estimate cannot be turned into reading by the
    // drift term.
    const mainCounted = counted.filter((q) => q.n >= MAIN_PASS_FIXATIONS);
    const ls = mainCounted.map((q) => q.line);
    if (metrics.linesRead < 2 || new Set(ls).size < 2) issues.push('no-progression');
    else {
      const ys = mainCounted.map((q) => q.m - ((model.seg && model.seg[q.seg]) || 0));
      if (theilSenSlope(ls, ys) < PROGRESSION_MIN_PITCH * layout.pitch) issues.push('no-progression');
    }
  } else if (!sweepLooksLikeReading(counted, fixations, layout)) issues.push('no-sweep');
  return issues;
}

function computeLineMetrics(samples, words, screen, opts = {}) {
  const layout = buildLayout(words);
  const L = layout ? layout.lines.length : 0;
  const metrics = emptyLineMetrics(L);
  const list = Array.isArray(samples) ? samples : [];
  const screenOk = screen && typeof screen === 'object' && sane(screen.w) && sane(screen.h) && screen.w > 0 && screen.h > 0;
  if (!layout || list.length === 0 || !screenOk) return withDebug(metrics, opts);

  // Samples pinned to a screen edge are clamped estimates, not positions: they count as valid for
  // the quality ratio but take no part in the geometry, and too many of them make the session 참고용.
  let validCount = 0;
  let edgeCount = 0;
  let lastT = -Infinity;
  const cleaned = [];
  for (const s of list) {
    if (!s || typeof s !== 'object' || !isNum(s.t) || Math.abs(s.t) > MAX_T) continue;
    lastT = Math.max(lastT, s.t);
    const ok = isNum(s.x) && isNum(s.y) && s.x >= 0 && s.x <= screen.w && s.y >= 0 && s.y <= screen.h;
    if (!ok) { cleaned.push({ t: s.t, x: null, y: null }); continue; }
    validCount++;
    const edge = s.x <= EDGE_PX || s.x >= screen.w - EDGE_PX || s.y <= EDGE_PX || s.y >= screen.h - EDGE_PX;
    if (edge) { edgeCount++; cleaned.push({ t: s.t, x: null, y: null }); } else cleaned.push({ t: s.t, x: s.x, y: s.y });
  }
  const validRatio = validCount / list.length;
  const edgeShare = validCount > 0 ? edgeCount / validCount : 0;
  const fixations = detectFixations(cleaned);
  if (fixations.length < MIN_FIXATIONS) return withDebug(metrics, opts);

  const t0 = fixations[0].tStart;
  const passes = splitPasses(fixations, layout, t0);
  let main = passes.filter((q) => q.n >= MAIN_PASS_FIXATIONS);
  if (main.length === 0) main = passes;

  // Vertical noise of one fixation, from the spread inside passes; sets how much a pass's height
  // can be trusted against the reading-model costs.
  const devs = [];
  for (const q of main) for (const k of q.fix) devs.push(Math.abs(fixations[k].y - q.m));
  const pitch = layout.pitch;
  const sigmaFix = Math.min(Math.max(1.4826 * median(devs), 0.1 * pitch), 1.5 * pitch);
  for (const q of passes) q.sigma = Math.max((sigmaFix * 1.05) / Math.sqrt(q.n), 0.08 * pitch);

  const span = main.length > 1 ? main[main.length - 1].tau - main[0].tau : 0;
  let fit = fitDrift(passes, main, layout, span > 0 ? span : 0);
  // Pass heights scatter more than their own fixations explain (per-line gaze error, fit error):
  // estimate that systematic part from the residuals of the first fit and refit with it, so the
  // decoder and the ambiguity guard are not overconfident.
  const resid = [];
  passes.forEach((q, j) => {
    const l = fit.dec.lines[j];
    if (l !== null && q.n >= MAIN_PASS_FIXATIONS) resid.push(corrected(fit.model, q) - layout.centres[l]);
  });
  let sys = 0;
  if (resid.length >= 3) {
    const mid = median(resid);
    const spread = 1.4826 * median(resid.map((r) => Math.abs(r - mid)));
    const own = median(main.map((q) => q.sigma ** 2));
    sys = Math.min(Math.sqrt(Math.max(0, spread ** 2 - own)), SYSTEMATIC_MAX_PITCH * pitch);
    if (sys > 0) {
      for (const q of passes) q.sigma = Math.sqrt(q.sigma ** 2 + sys ** 2);
      fit = fitDrift(passes, main, layout, span > 0 ? span : 0, fit.cands);
    }
  }
  const { model } = fit;
  const anomaly = anomalySupport(passes, layout, fit, span > 0 ? span : 0);

  // Every pass gets its decoded line; fixations far left/right of the text are off it.
  const fixLine = new Array(fixations.length).fill(null);
  const yCorr = fixations.map((f) => f.y - offsetAt(model, (f.tStart + f.tEnd) / 2 - t0, 0));
  passes.forEach((q, j) => {
    const segShift = (model.seg && model.seg[q.seg]) || 0;
    q.line = fit.dec.lines[j];
    for (const k of q.fix) {
      yCorr[k] -= segShift;
      const x = fixations[k].x;
      const offX = x < layout.left - OFF_TEXT_X * layout.width || x > layout.right + OFF_TEXT_X * layout.width;
      fixLine[k] = offX ? null : q.line;
    }
  });

  let inliers = 0;
  let offText = 0;
  fixations.forEach((f, k) => {
    if (fixLine[k] === null) { offText++; return; }
    if (Math.abs(yCorr[k] - layout.centres[fixLine[k]]) <= INLIER_PITCH * pitch) inliers++;
  });
  metrics.quality = Math.min(1, Math.max(0, finite(validRatio * (inliers / fixations.length))));
  metrics.driftPx = finite(model.b0);

  // Reading frontier: progress only from passes that plausibly are reading.
  const tailStart = lastT - TAIL_IGNORE_MS;
  const lastLine = layout.lines[L - 1];
  const onLastLineX = (q) => q.fix.every((k) => fixations[k].x <= lastLine.right + 0.1 * layout.width);
  let frontier = -1;
  const counted = [];
  for (const q of passes) {
    if (q.line === null) continue;
    if (q.line > frontier + 1 && q.n < MAIN_PASS_FIXATIONS) continue; // stray glance far ahead
    if (frontier >= 0 && q.line > frontier && q.tStart >= tailStart) {
      // heading for the button; a short last line read at the very end still counts
      if (!(q.line === L - 1 && q.line === frontier + 1 && onLastLineX(q))) continue;
    }
    if (q.line < frontier) metrics.regressions++;
    frontier = Math.max(frontier, q.line);
    counted.push(q);
    q.counted = true;
  }

  let sweepOk = true;
  if (counted.length > 0) {
    const visited = new Set(counted.map((q) => q.line));
    const hi = frontier;
    let tFirst = Infinity;
    let tLast = -Infinity;
    let maxX = -Infinity;
    let fixOnHi = 0;
    for (const q of counted) {
      for (const k of q.fix) {
        if (fixLine[k] === null) continue;
        const f = fixations[k];
        tFirst = Math.min(tFirst, f.tStart);
        tLast = Math.max(tLast, f.tEnd);
        metrics.lineDwellMs[fixLine[k]] += f.tEnd - f.tStart;
        if (q.line === hi) { fixOnHi++; maxX = Math.max(maxX, f.x); }
      }
    }
    metrics.linesRead = visited.size;
    for (let l = 1; l < hi; l++) if (!visited.has(l)) metrics.skippedLines++;
    for (const l of visited) if (l < hi) metrics.wordsRead += layout.lines[l].xs.length;
    const hiXs = layout.lines[hi].xs;
    const extent = hiXs.filter((x) => x <= maxX).length;
    metrics.wordsRead += extent;
    // Completion needs the last line reached through progression (or, on a one-line passage, a
    // sweep that looks like reading).
    if (L === 1) sweepOk = sweepLooksLikeReading(counted, fixations, layout);
    const progressed = L === 1 ? sweepOk : visited.size >= 2;
    // A short last line (a few words ending a paragraph) gets one or two fixations at most.
    const typicalWords = median(layout.lines.map((ln) => ln.xs.length));
    const shortLine = hiXs.length <= 0.5 * typicalWords;
    const lastLineRead = extent >= 0.7 * hiXs.length || fixOnHi >= MAIN_PASS_FIXATIONS || (shortLine && fixOnHi >= 1);
    metrics.completed = hi === L - 1 && progressed && lastLineRead;
    metrics.durationSec = isNum(tFirst) && isNum(tLast) ? finite((tLast - tFirst) / 1000) : 0;
    metrics.wpm = metrics.durationSec > 0 ? finite((metrics.wordsRead / metrics.durationSec) * 60) : 0;
    metrics.lineDwellMs = metrics.lineDwellMs.map(finite);
    metrics.longDwellLines = longDwell(metrics.lineDwellMs, layout);
  }
  const issues = reliabilityIssues({
    metrics, edgeShare, gap: fit.gap, anomaly, counted, fixations, layout, offTextShare: offText / fixations.length, model, screen, passes,
  });
  metrics.reliable = issues.length === 0;

  return withDebug(metrics, opts, { fixations, fixLine, yCorr, passes, model, gap: fit.gap, anomaly, issues, edgeShare, sys: sys / pitch });
}

function withDebug(metrics, opts, extra) {
  if (!opts || !opts.debug) return metrics;
  if (!extra) {
    metrics.debug = { model: { b0: 0, b1: 0 }, fixations: [], passes: [], gap: 0, issues: ['no-data'], edgeShare: 0 };
    return metrics;
  }
  const passOf = new Array(extra.fixations.length);
  extra.passes.forEach((q, j) => { for (const k of q.fix) passOf[k] = j; });
  metrics.debug = {
    model: extra.model,
    gap: isNum(extra.gap) ? extra.gap : (extra.gap > 0 ? 1e9 : 0),
    issues: extra.issues,
    edgeShare: extra.edgeShare,
    systematicPitch: extra.sys,
    anomaly: isNum(extra.anomaly) ? extra.anomaly : 1e9,
    fixations: extra.fixations.map((f, k) => ({
      tStart: f.tStart, tEnd: f.tEnd, x: f.x, y: f.y,
      yCorrected: extra.yCorr[k], line: extra.fixLine[k], pass: passOf[k],
    })),
    passes: extra.passes.map((q) => ({
      n: q.n, tStart: q.tStart, medianY: q.m, segment: q.seg, line: q.line, counted: Boolean(q.counted),
    })),
  };
  return metrics;
}

module.exports = { computeLineMetrics, LINE_RELIABLE_MIN };
