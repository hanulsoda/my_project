'use strict';
// Seeded synthetic readers for tests/line-metrics.test.js (not a test file itself).
// Ported from the independent review's harness so both measure the same scenarios.

const STEP = 10;

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
  return () => Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-12))) * Math.cos(2 * Math.PI * rng());
}

// Word boxes: nLines lines of perLine words (the last line may be shorter), text from `left`
// over `width` px, first line top at `top`, line pitch `pitch`.
function simLayout({ nLines = 8, perLine = 10, left = 100, width = 1000, top = 200, pitch = 64, lastLineWords } = {}) {
  const words = [];
  const count = (l) => (l === nLines - 1 && lastLineWords ? lastLineWords : perLine);
  for (let line = 0; line < nLines; line++) {
    for (let k = 0; k < count(line); k++) {
      words.push({ i: words.length, line, x: left + k * (width / perLine), y: top + line * pitch, w: width / perLine, h: 32 });
    }
  }
  return {
    words, nLines, left, width,
    centre: (l) => top + l * pitch + 16,
    lineRight: (l) => left + (count(l) * width) / perLine,
  };
}

// Fixation plan for visiting the lines in `order`: nMin..nMax fixations left to right per visit
// (x noise sx, y noise sy), optional small backtracks, and with probability `reread` a re-read of
// the line from its start after reaching its end.
function planLines(L, order, rng, normal, o = {}) {
  const { sx = 25, sy = 40, fixMs = 150, nMin = 8, nMax = 10, backtracks = 0, reread = 0 } = o;
  const plan = [];
  for (const line of order) {
    const span = L.lineRight(line) - L.left - 100;
    const n = nMin + Math.floor(rng() * (nMax - nMin + 1));
    const xs = [];
    for (let k = 0; k < n; k++) xs.push(L.left + 50 + (n > 1 ? (k * span) / (n - 1) : 0));
    const seq = [];
    xs.forEach((x, k) => {
      seq.push(x);
      if (rng() < backtracks && k > 1) { seq.push(xs[k - 1] - 40); seq.push(x + 20); }
    });
    if (reread && rng() < reread && seq.length > 4) seq.push(...seq.slice(0, Math.ceil(seq.length * 0.6)));
    for (const x of seq) plan.push({ line, x: x + normal() * sx, y: L.centre(line) + normal() * sy, ms: fixMs + Math.floor(rng() * 100) });
  }
  return plan;
}

// Samples for a plan. Entries are fixations {line, x, y, ms} (line -1: off the text) or gaps
// {gap: ms} (no gaze). offset(fraction of session) shifts y; clampW/clampH pin samples to the
// screen like WebGazer does.
function renderPlan(plan, { offset = () => 0, clampW, clampH, seed = 99 } = {}) {
  const rng = makeRng(seed);
  const total = plan.reduce((a, p) => a + (p.gap || p.ms), 0);
  const samples = [];
  const truth = new Map();
  let t = 0;
  for (const p of plan) {
    if (p.gap) { for (let e = 0; e < p.gap; e += STEP) { samples.push({ t, x: null, y: null }); t += STEP; } continue; }
    truth.set(t, p.line);
    const dy = offset(t / total);
    for (let e = 0; e < p.ms; e += STEP) {
      let x = p.x + (rng() - 0.5) * 2;
      let y = p.y + dy + (rng() - 0.5) * 2;
      if (clampH !== undefined) y = Math.min(Math.max(y, 0), clampH);
      if (clampW !== undefined) x = Math.min(Math.max(x, 0), clampW);
      samples.push({ t, x, y });
      t += STEP;
    }
  }
  return { samples, truth, end: t };
}

const nullTail = (r, ms = 800) => [...r.samples, ...Array.from({ length: ms / STEP }, (_, k) => ({ t: r.end + k * STEP, x: null, y: null }))];

// Expected line-level figures for a reader visiting `order`.
function expectFor(order, nLines) {
  const visited = new Set(order);
  const hi = Math.max(...order);
  let skippedLines = 0;
  for (let l = 1; l < hi; l++) if (!visited.has(l)) skippedLines++;
  return { completed: hi === nLines - 1, linesRead: visited.size, skippedLines };
}

module.exports = { STEP, makeRng, makeNormal, simLayout, planLines, renderPlan, nullTail, expectFor };
