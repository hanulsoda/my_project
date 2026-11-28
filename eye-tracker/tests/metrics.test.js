'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectFixations, assignToWords, computeMetrics, applyQualityRule } = require('../server/metrics');

const SCREEN = { w: 1280, h: 720 };
const STEP = 10; // ms between samples

// `perLine` words per line, each 100x30 px, 110 px apart, 60 px between lines.
function makeWords(lines, perLine) {
  const words = [];
  for (let l = 0; l < lines; l++) {
    for (let k = 0; k < perLine; k++) {
      words.push({ i: l * perLine + k, line: l, x: 100 + k * 110, y: 100 + l * 60, w: 100, h: 30 });
    }
  }
  return words;
}

const center = (w) => ({ x: w.x + w.w / 2, y: w.y + w.h / 2 });

// Samples dwelling on each [wordIndex, ms] stop, in order, starting at t0.
function gazeOver(words, stops, t0 = 0) {
  const samples = [];
  let t = t0;
  for (const [idx, ms] of stops) {
    const c = center(words[idx]);
    for (let e = 0; e < ms; e += STEP) {
      samples.push({ t, x: c.x, y: c.y });
      t += STEP;
    }
  }
  return samples;
}

test('detectFixations: 150ms within 40px gives one fixation', () => {
  const samples = [];
  for (let t = 0; t <= 150; t += STEP) samples.push({ t, x: 200 + (t % 20) / 2, y: 300 });
  const fx = detectFixations(samples);
  assert.equal(fx.length, 1);
  assert.equal(fx[0].tStart, 0);
  assert.equal(fx[0].tEnd, 150);
  assert.ok(Math.abs(fx[0].x - 200) < 10);
  assert.equal(fx[0].y, 300);
});

test('detectFixations: a null sample splits the fixation in two', () => {
  const samples = [];
  for (let t = 0; t <= 150; t += STEP) samples.push({ t, x: 200, y: 300 });
  samples.push({ t: 160, x: null, y: null });
  for (let t = 170; t <= 320; t += STEP) samples.push({ t, x: 200, y: 300 });
  assert.equal(detectFixations(samples).length, 2);
});

test('detectFixations: dwell shorter than minDurationMs or wider than maxDispersionPx is not a fixation', () => {
  const brief = [];
  for (let t = 0; t <= 60; t += STEP) brief.push({ t, x: 200, y: 300 });
  assert.equal(detectFixations(brief).length, 0);

  const drifting = [];
  for (let t = 0; t <= 300; t += STEP) drifting.push({ t, x: 200 + t, y: 300 });
  assert.equal(detectFixations(drifting).length, 0);

  const jump = gazeOver(makeWords(1, 2), [[0, 150], [1, 150]]);
  assert.equal(detectFixations(jump).length, 2);
  assert.equal(detectFixations(jump, { maxDispersionPx: 500 }).length, 1);
});

test('assignToWords: nearest box within tolerance, otherwise null', () => {
  const words = makeWords(1, 3);
  const c1 = center(words[1]);
  const fx = [
    { tStart: 0, tEnd: 200, x: c1.x, y: c1.y },       // inside word 1
    { tStart: 0, tEnd: 200, x: 100 - 20, y: 115 },    // 20px left of word 0 -> within 30
    { tStart: 0, tEnd: 200, x: 100 - 50, y: 115 },    // 50px left of word 0 -> outside
    { tStart: 0, tEnd: 200, x: c1.x, y: 600 },        // far below
  ];
  assert.deepEqual(assignToWords(fx, words), [
    { wordIndex: 1, line: 0 },
    { wordIndex: 0, line: 0 },
    null,
    null,
  ]);
  assert.deepEqual(assignToWords([fx[2]], words, 60), [{ wordIndex: 0, line: 0 }]);
});

test('computeMetrics: reading 5 words left to right at 250ms each', () => {
  const words = makeWords(1, 5);
  const samples = gazeOver(words, [0, 1, 2, 3, 4].map((i) => [i, 250]));
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.wordsRead, 5);
  assert.equal(m.completed, true);
  assert.equal(m.regressions, 0);
  assert.equal(m.skippedLines, 0);
  assert.deepEqual(m.longDwellWords, []);
  const expected = (5 / 1.25) * 60;
  assert.ok(Math.abs(m.wpm - expected) / expected <= 0.05, `wpm ${m.wpm} vs ${expected}`);
  assert.ok(Math.abs(m.durationSec - 1.25) <= 0.05);
  assert.equal(m.dwellMsByWord.length, 5);
  assert.ok(m.dwellMsByWord.every((d) => d >= 200 && d <= 250));
  assert.equal(m.quality, 1);
  assert.equal(m.detail, 'word');
});

test('computeMetrics: going back from word 3 to word 1 is one regression', () => {
  const words = makeWords(1, 5);
  const samples = gazeOver(words, [[0, 200], [1, 200], [2, 200], [0, 200], [1, 200], [2, 200], [3, 200], [4, 200]]);
  assert.equal(computeMetrics(samples, words, SCREEN).regressions, 1);
});

test('computeMetrics: stepping back a single word is not a regression', () => {
  const words = makeWords(1, 5);
  const samples = gazeOver(words, [[0, 200], [1, 200], [2, 200], [1, 200], [2, 200], [3, 200], [4, 200]]);
  assert.equal(computeMetrics(samples, words, SCREEN).regressions, 0);
});

test('computeMetrics: returning to an earlier line is a regression', () => {
  const words = makeWords(2, 3);
  const samples = gazeOver(words, [[0, 200], [1, 200], [2, 200], [3, 200], [2, 200], [3, 200], [4, 200], [5, 200]]);
  assert.equal(computeMetrics(samples, words, SCREEN).regressions, 1);
});

test('computeMetrics: a middle line with no fixations is one skipped line', () => {
  const words = makeWords(3, 3);
  const samples = gazeOver(words, [[0, 200], [1, 200], [2, 200], [6, 200], [7, 200], [8, 200]]);
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.skippedLines, 1);
  assert.equal(m.completed, true);
});

test('computeMetrics: lines never reached are not counted as skipped', () => {
  const words = makeWords(3, 3);
  const samples = gazeOver(words, [[0, 200], [1, 200], [2, 200]]);
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.skippedLines, 0);
  assert.equal(m.completed, false);
});

test('computeMetrics: a 900ms dwell is a long-dwell word', () => {
  const words = makeWords(1, 10);
  const stops = words.map((w) => [w.i, w.i === 4 ? 900 : 250]);
  const m = computeMetrics(gazeOver(words, stops), words, SCREEN);
  assert.deepEqual(m.longDwellWords, [4]);
  assert.ok(m.dwellMsByWord[4] >= 800);
});

test('computeMetrics: a slow-but-even reader has no long-dwell words', () => {
  const words = makeWords(1, 10);
  const m = computeMetrics(gazeOver(words, words.map((w) => [w.i, 500])), words, SCREEN);
  assert.deepEqual(m.longDwellWords, []);
});

test('computeMetrics: no samples gives quality 0, line detail, and does not throw', () => {
  const words = makeWords(1, 5);
  const m = computeMetrics([], words, SCREEN);
  assert.equal(m.quality, 0);
  assert.equal(m.detail, 'line');
  assert.equal(m.wpm, 0);
  assert.equal(m.wordsRead, 0);
  assert.equal(m.completed, false);
  assert.equal(m.durationSec, 0);
  assert.deepEqual(m.dwellMsByWord, [0, 0, 0, 0, 0]);
});

test('computeMetrics: all-null or off-screen samples give quality 0', () => {
  const words = makeWords(1, 5);
  const nulls = [];
  for (let t = 0; t < 500; t += STEP) nulls.push({ t, x: null, y: null });
  const m1 = computeMetrics(nulls, words, SCREEN);
  assert.equal(m1.quality, 0);
  assert.equal(m1.detail, 'line');

  const off = [];
  for (let t = 0; t < 500; t += STEP) off.push({ t, x: SCREEN.w + 50, y: 100 });
  const m2 = computeMetrics(off, words, SCREEN);
  assert.equal(m2.quality, 0);
  assert.equal(m2.detail, 'line');
  assert.equal(m2.wordsRead, 0);
});

test('computeMetrics: reading only the first 3 of 5 words is not completed', () => {
  const words = makeWords(1, 5);
  const m = computeMetrics(gazeOver(words, [[0, 250], [1, 250], [2, 250]]), words, SCREEN);
  assert.equal(m.wordsRead, 3);
  assert.equal(m.completed, false);
});

test('computeMetrics: fixations away from any word lower quality below 0.6', () => {
  const words = makeWords(1, 5);
  const onWords = gazeOver(words, [[0, 250], [1, 250]]);
  const lost = [];
  for (let t = 500; t < 1500; t += STEP) lost.push({ t, x: 300 + 200 * Math.floor((t - 500) / 250), y: 600 });
  const m = computeMetrics([...onWords, ...lost], words, SCREEN);
  assert.ok(m.quality < 0.6, `quality ${m.quality}`);
  assert.equal(m.detail, 'line');
});

test('computeMetrics: invalid samples reduce quality by their share', () => {
  const words = makeWords(1, 5);
  const good = gazeOver(words, [0, 1, 2, 3, 4].map((i) => [i, 250]));
  const bad = [];
  for (let k = 0; k < good.length; k++) bad.push({ t: 5000 + k * STEP, x: null, y: null });
  const m = computeMetrics([...good, ...bad], words, SCREEN);
  assert.ok(Math.abs(m.quality - 0.5) < 1e-9, `quality ${m.quality}`);
  assert.equal(m.detail, 'line');
});

test('applyQualityRule: line detail drops word-level arrays and leaves the input untouched', () => {
  const m = {
    wpm: 90, wordsRead: 3, completed: false, durationSec: 2, regressions: 0, skippedLines: 0,
    dwellMsByWord: [200, 300, 400], longDwellWords: [2], quality: 0.4, detail: 'line',
  };
  const out = applyQualityRule(m);
  assert.deepEqual(out.dwellMsByWord, []);
  assert.deepEqual(out.longDwellWords, []);
  assert.equal(out.wpm, 90);
  assert.equal(out.quality, 0.4);
  assert.notEqual(out, m);
  assert.deepEqual(m.dwellMsByWord, [200, 300, 400], 'input must not be mutated');
  assert.deepEqual(m.longDwellWords, [2]);
});

test('applyQualityRule: word detail is returned unchanged', () => {
  const m = {
    wpm: 90, wordsRead: 3, completed: true, durationSec: 2, regressions: 0, skippedLines: 0,
    dwellMsByWord: [200, 300, 400], longDwellWords: [2], quality: 0.9, detail: 'word',
  };
  assert.equal(applyQualityRule(m), m);
});

test('applyQualityRule: a computeMetrics result with no samples loses its zero-filled dwell array', () => {
  const out = applyQualityRule(computeMetrics([], makeWords(1, 5), SCREEN));
  assert.deepEqual(out.dwellMsByWord, []);
  assert.equal(out.quality, 0);
});

// ---- reading frontier: stray fixations must not inflate progress -------------------------

// 8 lines x 3 words = 24 words. Words 0-8 are lines 0-2; word 23 is on the last line.
test('computeMetrics: one stray fixation on the last line at the end does not finish the passage', () => {
  const words = makeWords(8, 3);
  const stops = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => [i, 250]);
  const samples = gazeOver(words, [...stops, [23, 200]]);
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.completed, false);
  assert.equal(m.wordsRead, 9, 'only lines 0-2 count');
  assert.equal(m.skippedLines, 0);
  const trueWpm = (9 / 2.25) * 60; // 9 words at 250 ms each
  assert.ok(Math.abs(m.wpm - trueWpm) / trueWpm <= 0.1, `wpm ${m.wpm} vs ${trueWpm}`);
  assert.ok(Math.abs(m.durationSec - 2.24) <= 0.05, `duration ${m.durationSec}`);
});

test('computeMetrics: a stray fixation mid-stream is ignored for progress, dwell, regressions and skips', () => {
  const words = makeWords(8, 3);
  // line 0, stray on line 7 (5 words of 250ms and one 600ms stray), then back to normal reading.
  const samples = gazeOver(words, [[0, 250], [1, 250], [2, 250], [23, 600], [3, 250], [4, 250], [5, 250]]);
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.wordsRead, 6);
  assert.equal(m.completed, false);
  assert.equal(m.regressions, 0);
  assert.equal(m.skippedLines, 0);
  assert.equal(m.dwellMsByWord[23], 0, 'the ignored fixation adds no dwell');
  assert.deepEqual(m.longDwellWords, []);
});

test('computeMetrics: a single fixation two lines ahead is ignored until the reader catches up', () => {
  const words = makeWords(4, 3);
  // line 0, one fixation on line 2 (frontier is line 0, so 2 > 0+1), then the reader does line 1.
  const samples = gazeOver(words, [[0, 250], [1, 250], [2, 250], [7, 250], [3, 250], [4, 250], [5, 250]]);
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.wordsRead, 6);
  assert.equal(m.skippedLines, 0);
  assert.equal(m.regressions, 0);
});

test('computeMetrics: two fixations on a later line are still not enough to jump the frontier', () => {
  const words = makeWords(4, 3);
  const samples = gazeOver(words, [[0, 250], [1, 250], [2, 250], [6, 250], [7, 250]]);
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.wordsRead, 3);
  assert.equal(m.skippedLines, 0);
});

test('computeMetrics: a sustained jump (3 fixations on the same later line) is accepted and the skipped line counted', () => {
  const words = makeWords(4, 3);
  // Reads line 0, never looks at line 1, then reads lines 2 and 3.
  const samples = gazeOver(words, [[0, 250], [1, 250], [2, 250], [6, 250], [7, 250], [8, 250], [9, 250], [10, 250], [11, 250]]);
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.wordsRead, 12);
  assert.equal(m.completed, true);
  assert.equal(m.skippedLines, 1);
  const trueWpm = (12 / 2.25) * 60;
  assert.ok(Math.abs(m.wpm - trueWpm) / trueWpm <= 0.1, `wpm ${m.wpm}`);
});

test('computeMetrics: an interrupted run on a later line restarts the count of consecutive fixations', () => {
  const words = makeWords(4, 3);
  // two on line 2, one back on line 0 (counted, resets the run), two on line 2 again: still no jump.
  const samples = gazeOver(words, [[0, 250], [6, 250], [7, 250], [1, 250], [6, 250], [7, 250]]);
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.wordsRead, 2);
  assert.equal(m.skippedLines, 0);
});

test('computeMetrics: a fixation that opens a new line in the last 500 ms is ignored for progress', () => {
  const words = makeWords(3, 3);
  // Reads lines 0-1, then the last word (line 2, allowed by the frontier rule) only in the final 200 ms.
  const samples = gazeOver(words, [[0, 250], [1, 250], [2, 250], [3, 250], [4, 250], [8, 200]]);
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.wordsRead, 5);
  assert.equal(m.completed, false);
});

test('computeMetrics: the same fixation earlier in the stream does count (the tail rule is about the last 500 ms)', () => {
  const words = makeWords(3, 3);
  const samples = gazeOver(words, [[0, 250], [1, 250], [2, 250], [3, 250], [4, 250], [8, 200], [7, 600]]);
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.wordsRead, 9);
  assert.equal(m.completed, true);
});

test('computeMetrics: a fixation on the current line in the last 500 ms still counts (finishing the last word)', () => {
  const words = makeWords(2, 3);
  const samples = gazeOver(words, [[0, 250], [1, 250], [2, 250], [3, 250], [4, 250], [5, 250]]);
  const m = computeMetrics(samples, words, SCREEN);
  assert.equal(m.wordsRead, 6);
  assert.equal(m.completed, true);
});

test('computeMetrics: ignored fixations still count as assigned for the quality ratio', () => {
  const words = makeWords(8, 3);
  const samples = gazeOver(words, [[0, 250], [1, 250], [2, 250], [23, 600], [3, 250]]);
  assert.equal(computeMetrics(samples, words, SCREEN).quality, 1);
});

test('computeMetrics: a recording shorter than the tail window still counts its first line', () => {
  const words = makeWords(1, 5);
  const m = computeMetrics(gazeOver(words, [[0, 200], [1, 200]]), words, SCREEN);
  assert.equal(m.wordsRead, 2);
});
