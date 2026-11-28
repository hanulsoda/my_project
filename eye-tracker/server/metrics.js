'use strict';

// Pure gaze-metrics functions. Input is {t,x,y} samples and word boxes only.

const QUALITY_WORD_THRESHOLD = 0.6;
const LONG_DWELL_MIN_MS = 400;
const LONG_DWELL_SD_FACTOR = 2;
const REGRESSION_WORDS = 2;
// Reading frontier: a fixation more than one line below the furthest line reached counts for
// progress only after this many consecutive fixations land on that same later line.
const JUMP_ACCEPT_FIXATIONS = 3;
// A fixation starting in the last stretch of the stream that would open a new line is most
// likely the gaze travelling to the "done" button, not reading.
const TAIL_IGNORE_MS = 500;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const hasPoint = (s) => isNum(s.x) && isNum(s.y);

// Dispersion-threshold (I-DT) fixation detection. A null sample ends the
// current fixation. Dispersion = x-range + y-range of the samples in a group.
function detectFixations(samples, opts = {}) {
  const maxDispersionPx = opts.maxDispersionPx ?? 40;
  const minDurationMs = opts.minDurationMs ?? 100;
  const fixations = [];
  let group = [];
  let minX, maxX, minY, maxY;

  const flush = () => {
    if (group.length > 0) {
      const tStart = group[0].t;
      const tEnd = group[group.length - 1].t;
      if (tEnd - tStart >= minDurationMs) {
        let sx = 0;
        let sy = 0;
        for (const s of group) { sx += s.x; sy += s.y; }
        fixations.push({ tStart, tEnd, x: sx / group.length, y: sy / group.length });
      }
    }
    group = [];
  };
  const start = (s) => {
    group = [s];
    minX = maxX = s.x;
    minY = maxY = s.y;
  };

  for (const s of samples) {
    if (!hasPoint(s)) { flush(); continue; }
    if (group.length === 0) { start(s); continue; }
    const nMinX = Math.min(minX, s.x);
    const nMaxX = Math.max(maxX, s.x);
    const nMinY = Math.min(minY, s.y);
    const nMaxY = Math.max(maxY, s.y);
    if ((nMaxX - nMinX) + (nMaxY - nMinY) > maxDispersionPx) {
      flush();
      start(s);
    } else {
      group.push(s);
      minX = nMinX; maxX = nMaxX; minY = nMinY; maxY = nMaxY;
    }
  }
  flush();
  return fixations;
}

// Nearest word box (distance 0 inside the box) within tolerance, else null.
function assignToWords(fixations, words, tolerancePx = 30) {
  return fixations.map((f) => {
    let best = null;
    let bestDist = Infinity;
    for (const w of words) {
      const dx = Math.max(w.x - f.x, f.x - (w.x + w.w), 0);
      const dy = Math.max(w.y - f.y, f.y - (w.y + w.h), 0);
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) { bestDist = dist; best = w; }
    }
    return best && bestDist <= tolerancePx ? { wordIndex: best.i, line: best.line } : null;
  });
}

function emptyMetrics(wordCount) {
  return {
    wpm: 0,
    wordsRead: 0,
    completed: false,
    durationSec: 0,
    regressions: 0,
    skippedLines: 0,
    dwellMsByWord: new Array(wordCount).fill(0),
    longDwellWords: [],
    quality: 0,
    detail: 'line',
  };
}

function longDwellIndexes(dwell) {
  const read = dwell.filter((d) => d > 0);
  if (read.length === 0) return [];
  const mean = read.reduce((a, b) => a + b, 0) / read.length;
  const variance = read.reduce((a, d) => a + (d - mean) ** 2, 0) / read.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) return []; // perfectly even dwell: nothing stands out
  const cutoff = Math.max(mean + LONG_DWELL_SD_FACTOR * sd, LONG_DWELL_MIN_MS);
  const out = [];
  dwell.forEach((d, i) => { if (d > 0 && d >= cutoff) out.push(i); });
  return out;
}

// Which word-assigned fixations count toward progress (wordsRead, duration, dwell, regressions,
// skipped lines). Time order, with a reading frontier (the furthest line reached):
//  - a fixation on the frontier line, the next one, or any earlier line counts;
//  - one further ahead is held back, and only counts (together with the held ones before it) once
//    JUMP_ACCEPT_FIXATIONS consecutive fixations land on that same line, so a stray glance or a
//    webcam error of a few line pitches cannot finish the passage, while a real skip still can;
//  - one that would open the next line within the last TAIL_IGNORE_MS of the stream is dropped
//    (fixations further ahead already go through the hold rule above, tail or not).
// Ignored fixations still count as assigned in the quality ratio (computed by the caller).
function countedHits(hits, samples) {
  let lastT = -Infinity;
  for (const s of samples) if (isNum(s.t) && s.t > lastT) lastT = s.t;
  const tailStart = lastT - TAIL_IGNORE_MS;

  const counted = [];
  let frontier = -1;
  let held = []; // consecutive fixations on one line beyond frontier + 1
  for (const h of hits) {
    if (frontier >= 0 && h.fix.tStart >= tailStart && h.line === frontier + 1) continue;
    if (h.line <= frontier + 1) {
      counted.push(h);
      frontier = Math.max(frontier, h.line);
      held = [];
      continue;
    }
    if (held.length > 0 && held[0].line !== h.line) held = [];
    held.push(h);
    if (held.length >= JUMP_ACCEPT_FIXATIONS) {
      counted.push(...held);
      frontier = h.line;
      held = [];
    }
  }
  return counted;
}

// `words[k].i` is expected to equal `k` (word position in reading order).
function computeMetrics(samples, words, screen) {
  const metrics = emptyMetrics(words.length);
  if (!samples || samples.length === 0) return metrics;

  const onScreen = (s) => hasPoint(s) && s.x >= 0 && s.x <= screen.w && s.y >= 0 && s.y <= screen.h;
  let validCount = 0;
  const cleaned = samples.map((s) => {
    if (onScreen(s)) { validCount++; return s; }
    return { t: s.t, x: null, y: null };
  });
  const validRatio = validCount / samples.length;

  const fixations = detectFixations(cleaned);
  const assigned = assignToWords(fixations, words);
  const hits = [];
  assigned.forEach((a, k) => { if (a) hits.push({ ...a, fix: fixations[k] }); });
  const assignedRatio = fixations.length === 0 ? 0 : hits.length / fixations.length;

  metrics.quality = validRatio * assignedRatio;
  metrics.detail = metrics.quality >= QUALITY_WORD_THRESHOLD ? 'word' : 'line';
  if (hits.length === 0) return metrics;

  const counted = countedHits(hits, samples);
  if (counted.length === 0) return metrics;

  for (const h of counted) metrics.dwellMsByWord[h.wordIndex] += h.fix.tEnd - h.fix.tStart;
  metrics.longDwellWords = longDwellIndexes(metrics.dwellMsByWord);

  const maxIndex = Math.max(...counted.map((h) => h.wordIndex));
  metrics.wordsRead = maxIndex + 1;
  metrics.completed = metrics.wordsRead === words.length;

  metrics.durationSec = (counted[counted.length - 1].fix.tEnd - counted[0].fix.tStart) / 1000;
  metrics.wpm = metrics.durationSec > 0 ? (metrics.wordsRead / metrics.durationSec) * 60 : 0;

  for (let k = 1; k < counted.length; k++) {
    const prev = counted[k - 1];
    const cur = counted[k];
    if (cur.line < prev.line || (cur.line === prev.line && cur.wordIndex <= prev.wordIndex - REGRESSION_WORDS)) {
      metrics.regressions++;
    }
  }

  const visited = new Set(counted.map((h) => h.line));
  const lo = Math.min(...visited);
  const hi = Math.max(...visited);
  const lineIds = new Set(words.map((w) => w.line));
  for (const line of lineIds) {
    if (line > lo && line < hi && !visited.has(line)) metrics.skippedLines++;
  }

  return metrics;
}

// Below the word-level quality threshold only line-level figures are trustworthy, so word-level
// arrays are withheld. Returns a copy; the stored metrics are never altered.
function applyQualityRule(metrics) {
  if (metrics.detail !== 'line') return metrics;
  return { ...metrics, dwellMsByWord: [], longDwellWords: [] };
}

module.exports = { detectFixations, assignToWords, computeMetrics, applyQualityRule };
