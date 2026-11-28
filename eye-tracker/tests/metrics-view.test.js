'use strict';
// Pure display logic for the "참고용" rule: line-mode and failed measurements must never show
// word-derived figures as if they were reliable. The DOM code in report.js/children.js stays thin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { reportDisplay, sessionSummary } = require('../public/js/metrics-view.js');
const { splitTrend } = require('../public/js/charts.js');

const word = {
  wpm: 123.4, wordsRead: 40, completed: true, durationSec: 19.5, regressions: 3, skippedLines: 1,
  dwellMsByWord: [200, 300], longDwellWords: [1], quality: 0.9, detail: 'word',
};
const line = { ...word, wpm: 310, completed: true, regressions: 7, skippedLines: 2, quality: 0.4, detail: 'line', dwellMsByWord: [], longDwellWords: [] };
const failed = { ...line, wpm: 0, wordsRead: 0, completed: false, regressions: 0, skippedLines: 0, quality: 0 };

const byLabel = (view, re) => view.cards.find((c) => re.test(c.label));

test('reportDisplay: a word-level measurement shows every figure', () => {
  const v = reportDisplay(word);
  assert.equal(v.referenceOnly, false);
  assert.equal(v.banner, null);
  assert.equal(byLabel(v, /WPM/).value, 123);
  assert.equal(byLabel(v, /^읽은 시간$/).value, '20초');
  assert.equal(byLabel(v, /^읽은 어절 수$/).value, 40);
  assert.equal(byLabel(v, /끝까지/).value, '예');
  assert.equal(byLabel(v, /되돌아/).value, 3);
  assert.equal(byLabel(v, /건너뛴/).value, 1);
});

test('reportDisplay: a partly read word-level measurement says so', () => {
  assert.equal(byLabel(reportDisplay({ ...word, completed: false }), /끝까지/).value, '일부만 읽음');
});

test('reportDisplay: line mode shows no WPM, no completion verdict, no regressions, only skipped lines', () => {
  const v = reportDisplay(line);
  assert.equal(v.referenceOnly, true);
  assert.equal(v.banner, null);
  const wpm = byLabel(v, /WPM/);
  assert.equal(wpm.value, '—');
  assert.equal(wpm.caption, '참고 수치 없음');
  assert.equal(byLabel(v, /끝까지/).value, '판단 불가');
  assert.equal(byLabel(v, /되돌아/).value, '—');
  assert.equal(byLabel(v, /건너뛴/).value, 2);
  assert.equal(byLabel(v, /^읽은 시간$/), undefined, 'reading time is word-derived: not shown');
  assert.equal(byLabel(v, /^읽은 어절 수$/), undefined);
  const text = JSON.stringify(v);
  for (const leaked of ['310', '"7"', '예']) assert.ok(!text.includes(leaked), `leaked ${leaked}`);
});

test('reportDisplay: quality 0 shows the failure banner instead of any numbers', () => {
  const v = reportDisplay(failed);
  assert.equal(v.banner, '측정이 제대로 되지 않았어요. 다시 측정해 주세요.');
  assert.deepEqual(v.cards, []);
  assert.equal(v.referenceOnly, true);
});

test('reportDisplay: zero words read is also a failed measurement, even at word detail', () => {
  const v = reportDisplay({ ...word, wordsRead: 0, wpm: 0, completed: false });
  assert.equal(v.banner, '측정이 제대로 되지 않았어요. 다시 측정해 주세요.');
  assert.deepEqual(v.cards, []);
});

test('sessionSummary: reference-only sessions in the teacher list carry the 참고용 badge and no WPM', () => {
  const s = sessionSummary(line);
  assert.equal(s.badge, true);
  assert.doesNotMatch(s.text, /\d+ WPM/);
  assert.match(s.text, /참고 수치 없음/);
  assert.doesNotMatch(s.text, /끝까지 읽음/);
  assert.match(s.text, /0\.40/);

  const w = sessionSummary(word);
  assert.equal(w.badge, false);
  assert.match(w.text, /123 WPM/);
  assert.match(w.text, /끝까지 읽음/);
  assert.match(w.text, /0\.90/);

  const f = sessionSummary(failed);
  assert.equal(f.badge, true);
  assert.match(f.text, /측정이 제대로 되지 않았어요/);
  assert.doesNotMatch(f.text, /WPM/);
});

// Line metrics (server/line-metrics.js): detail is always 'line'; `reliable` decides 참고용.
const lineOk = {
  wpm: 98.6, wordsRead: 52, completed: false, durationSec: 31.6, regressions: 2, skippedLines: 1, quality: 0.72,
  reliable: true, detail: 'line', linesRead: 6, totalLines: 8, lineDwellMs: [1, 2, 3, 4, 5, 6, 0, 0],
  longDwellLines: [1, 4], driftPx: 120, dwellMsByWord: [], longDwellWords: [],
};
const lineLow = { ...lineOk, quality: 0.31, reliable: false, lineDwellMs: [], longDwellLines: [] };

test('reportDisplay: reliable line metrics show line-level facts, not reference only despite detail "line"', () => {
  const v = reportDisplay(lineOk);
  assert.equal(v.referenceOnly, false);
  assert.equal(v.banner, null);
  assert.equal(byLabel(v, /WPM/).value, 99);
  assert.equal(byLabel(v, /읽은 줄 수/).value, '6 / 8');
  assert.equal(byLabel(v, /끝까지/).value, '일부만 읽음');
  assert.equal(byLabel(v, /앞 줄로 되돌아간 횟수/).value, 2);
  assert.equal(byLabel(v, /건너뛴/).value, 1);
  assert.equal(byLabel(v, /오래 머문 줄/).value, '2, 5번째 줄', 'line numbers are 1-based');
  assert.equal(byLabel(reportDisplay({ ...lineOk, longDwellLines: [] }), /오래 머문 줄/).value, '없음');
  assert.equal(byLabel(reportDisplay({ ...lineOk, completed: true }), /끝까지/).value, '예');
});

test('reportDisplay: line metrics with reliable === false are reference only, same figures as before', () => {
  const v = reportDisplay(lineLow);
  assert.equal(v.referenceOnly, true);
  assert.equal(byLabel(v, /WPM/).value, '—');
  assert.equal(byLabel(v, /끝까지/).value, '판단 불가');
  assert.equal(byLabel(v, /되돌아/).value, '—');
  assert.equal(byLabel(v, /건너뛴/).value, 1);
  assert.equal(byLabel(v, /오래 머문 줄/), undefined);
  assert.ok(!JSON.stringify(v).includes('99'), 'no WPM leaks');
});

test('sessionSummary: reliable line metrics list the line-level facts; unreliable ones get the badge', () => {
  const s = sessionSummary(lineOk);
  assert.equal(s.badge, false);
  for (const re of [/99 WPM/, /읽은 줄 6\/8/, /일부만 읽음/, /앞 줄로 되돌아감 2회/, /건너뛴 줄 1/, /오래 머문 줄 2, 5/, /0\.72/]) {
    assert.match(s.text, re);
  }
  assert.doesNotMatch(sessionSummary({ ...lineOk, longDwellLines: [] }).text, /오래 머문/);
  const low = sessionSummary(lineLow);
  assert.equal(low.badge, true);
  assert.doesNotMatch(low.text, /WPM/);
  assert.match(low.text, /참고 수치 없음/);
});

const pt = (k, wpm, quality, extra = {}) => ({ startedAt: 1000 * k, wpm, quality, ...extra });

test('splitTrend: a `reliable` flag decides when present; points without it keep the old rule', () => {
  const s = splitTrend([pt(0, 100, 0.55, { reliable: true }), pt(1, 100, 0.9, { reliable: false }), pt(2, 90, 0.9), pt(3, 80, 0.5)]);
  assert.deepEqual(s.hollow.map((e) => e.k), [1, 3]);
  assert.deepEqual(s.segments.map((seg) => seg.map((e) => e.k)), [[0], [2]]);
});

test('splitTrend: low-quality points are hollow, break the polyline and stay out of the y scale', () => {
  const pts = [pt(0, 100, 0.9), pt(1, 110, 0.8), pt(2, 5000, 0.3), pt(3, 120, 0.9), pt(4, 130, 0.7)];
  const s = splitTrend(pts);
  assert.deepEqual(s.segments.map((seg) => seg.map((e) => e.k)), [[0, 1], [3, 4]]);
  assert.deepEqual(s.hollow.map((e) => e.k), [2]);
  assert.equal(s.maxWpm, 130, 'the 5000 outlier from a low-quality session does not stretch the axis');
});

test('splitTrend: detail === "line" is hollow even when quality is high; quality 0 points too', () => {
  const s = splitTrend([pt(0, 100, 0.9), pt(1, 100, 0.9, { detail: 'line' }), pt(2, 0, 0), pt(3, 90, 0.9)]);
  assert.deepEqual(s.hollow.map((e) => e.k), [1, 2]);
  assert.deepEqual(s.segments.map((seg) => seg.map((e) => e.k)), [[0], [3]]);
});

test('splitTrend: the quality threshold is 0.6 inclusive; empty and all-hollow inputs are fine', () => {
  assert.deepEqual(splitTrend([pt(0, 80, 0.6)]).hollow, []);
  assert.equal(splitTrend([pt(0, 80, 0.59)]).hollow.length, 1);
  const none = splitTrend([]);
  assert.deepEqual(none.segments, []);
  assert.deepEqual(none.hollow, []);
  const allLow = splitTrend([pt(0, 80, 0.2), pt(1, 90, 0.1)]);
  assert.deepEqual(allLow.segments, []);
  assert.equal(allLow.maxWpm, 0);
});

test('report.js and children.js route their figures through the view helpers', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  assert.match(read('js/report.js'), /reportDisplay\(/);
  assert.match(read('js/children.js'), /sessionSummary\(/);
  for (const page of ['report.html', 'children.html']) {
    assert.match(read(page), /<script src="\/js\/metrics-view\.js"><\/script>/, `${page} loads metrics-view.js`);
  }
});
