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

test('reportDisplay: line mode shows no WPM, no completion verdict, no regressions, no skipped lines', () => {
  const v = reportDisplay(line);
  assert.equal(v.referenceOnly, true);
  assert.equal(v.banner, null);
  const wpm = byLabel(v, /WPM/);
  assert.equal(wpm.value, '—');
  assert.equal(wpm.caption, '참고 수치 없음');
  assert.equal(byLabel(v, /끝까지/).value, '판단 불가');
  assert.equal(byLabel(v, /되돌아/).value, '—');
  assert.equal(byLabel(v, /건너뛴/).value, '—', 'skipped lines depend on the line assignment too');
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

test('reportDisplay: line metrics with reliable === false are reference only and show no line figures', () => {
  const v = reportDisplay(lineLow);
  assert.equal(v.referenceOnly, true);
  assert.equal(byLabel(v, /WPM/).value, '—');
  assert.equal(byLabel(v, /끝까지/).value, '판단 불가');
  assert.equal(byLabel(v, /되돌아/).value, '—');
  assert.equal(byLabel(v, /건너뛴/).value, '—');
  assert.equal(byLabel(v, /읽은 줄 수/), undefined, 'lines read is not shown either');
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

const { reportTiles, glanceSentence, lineMap, longDwellSentence } = require('../public/js/metrics-view.js');
const { reportTrend, previousReliableWpm, trendSentence } = require('../public/js/charts.js');

test('reportTiles: reliable line metrics -> five tiles with units; previous WPM or "첫 번째 측정"', () => {
  const tiles = reportTiles(lineOk, 91.6);
  assert.deepEqual(tiles.map((t) => t.area), ['wpm', 'done', 'lines', 'reg', 'skip']);
  assert.equal(tiles[0].value, 99);
  assert.equal(tiles[0].unit, '어절/분');
  assert.equal(tiles[0].caption, '지난 측정 92');
  assert.equal(tiles[1].value, '아니요');
  assert.equal(tiles[2].value, '6 / 8');
  assert.equal(tiles[3].value, 2);
  assert.equal(tiles[4].value, 1);
  assert.equal(reportTiles(lineOk, null)[0].caption, '첫 번째 측정');
});

test('reportTiles: never for 참고용, failed or legacy word-level sessions', () => {
  assert.equal(reportTiles(lineLow, 90), null);
  assert.equal(reportTiles({ ...lineOk, quality: 0 }, 90), null);
  assert.equal(reportTiles(word, 90), null);
});

test('glanceSentence / longDwellSentence / lineMap', () => {
  const done = { ...lineOk, completed: true, linesRead: 8 };
  assert.equal(glanceSentence(done, false), '이번에는 전체 8줄을 끝까지 읽었고, 1분에 약 99어절을 읽었습니다. 앞 줄로 되돌아간 횟수는 2번, 건너뛴 줄은 1줄이었습니다.');
  assert.match(glanceSentence(lineOk, true), /^첫 번째 측정에서 전체 8줄 중 6줄을 읽었고, .*다음 측정부터/);
  assert.equal(longDwellSentence(lineOk), '시선이 다른 줄보다 오래 머문 줄은 2번째, 5번째 줄입니다.');
  assert.match(longDwellSentence({ ...lineOk, longDwellLines: [] }), /없었습니다/);
  const map = lineMap(lineOk);
  assert.equal(map.length, 8);
  assert.deepEqual(map.filter((r) => r.long).map((r) => r.line), [2, 5]);
  assert.deepEqual(lineMap({ ...word }), [], 'no line count -> no map');
});

test('reportTrend: the current 참고용 session is not plotted; a reliable one stays', () => {
  const trend = [pt(1, 98, 0.8, { reliable: true }), pt(2, 300, 0.3, { reliable: false }), pt(3, 400, 0.3, { reliable: false })];
  assert.deepEqual(reportTrend(trend, { startedAt: 3000, referenceOnly: true }).map((p) => p.startedAt), [1000, 2000],
    'earlier 참고용 records stay as hollow points; only the current one is dropped');
  assert.equal(reportTrend(trend, { startedAt: 3000, referenceOnly: false }).length, 3);
});

test('previousReliableWpm: latest earlier reliable record, skipping 참고용 ones and the current session', () => {
  const trend = [pt(1, 98, 0.8, { reliable: true }), pt(2, 104, 0.8, { reliable: true }), pt(3, 300, 0.3, { reliable: false }), pt(4, 128, 0.8, { reliable: true })];
  assert.equal(previousReliableWpm(trend, 4000), 104);
  assert.equal(previousReliableWpm(trend, 1000), null);
});

test('trendSentence: text alternative for each report state', () => {
  const r = (k, w) => pt(k, w, 0.8, { reliable: true });
  assert.equal(trendSentence([r(1, 98), r(2, 104), pt(3, 9, 0.2, { reliable: false }), r(4, 117), r(5, 128)], { referenceOnly: false }),
    '기록 5회 중 4회가 신뢰 측정입니다. 분당 읽은 어절 수는 98에서 128로 늘었습니다.');
  assert.match(trendSentence([r(1, 120), r(2, 90)], { referenceOnly: false }), /120에서 90으로 줄었습니다/);
  assert.match(trendSentence([r(1, 90), r(2, 90)], { referenceOnly: false }), /처음과 같은 90입니다/);
  assert.match(trendSentence([r(1, 96)], { referenceOnly: false }), /점 하나만/);
  assert.equal(trendSentence([r(1, 98), r(2, 104), r(3, 117)], { referenceOnly: true }),
    '이번 측정은 참고용이라 추이에 넣지 않았습니다. 이전 신뢰 측정 3건만 표시합니다.');
  assert.match(trendSentence([], { referenceOnly: true }), /기록이 없습니다/);
});

test('report page: new layout keeps the parent-safety rules', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  const html = read('report.html');
  assert.match(html, /href="\/css\/report\.css"/);
  assert.match(html, /선별 지표이며 진단이 아닙니다/);
  const js = read('js/report.js');
  assert.match(js, /reportTrend\(data\.trend, \{ startedAt, referenceOnly: ref \}\)/, 'the current 참고용 session is dropped from the trend');
  assert.match(js, /const tiles = ref \? null/, '참고용 never builds stat tiles');
  assert.doesNotMatch(js, /\.name\b|passage|textContent\s*=\s*data\.session\.metrics/, 'no names, no passage text');
});
