'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
const M = require('../public/js/measure-math.js');

const near = (actual, expected, eps) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} not within ${eps} of ${expected}`);

test('targetPositions: 3x3 grid inset 10% from every edge, row-major', () => {
  const pts = M.targetPositions(1000, 500);
  assert.equal(pts.length, 9);
  assert.deepEqual(pts.map((p) => [p.x, p.y]), [
    [100, 50], [500, 50], [900, 50],
    [100, 250], [500, 250], [900, 250],
    [100, 450], [500, 450], [900, 450],
  ]);
});

test('targetError: mean distance of the valid samples to the target', () => {
  const r = M.targetError({ x: 100, y: 100 }, [{ x: 103, y: 104 }, { x: 100, y: 100 }]);
  assert.equal(r.status, 'ok');
  assert.equal(r.errorPx, 2.5); // (5 + 0) / 2
  assert.equal(r.n, 2);
  assert.equal(r.total, 2);
});

test('targetError: null and non-finite samples are ignored, not counted as zero', () => {
  const r = M.targetError({ x: 0, y: 0 }, [
    { x: 3, y: 4 }, { x: null, y: null }, { x: undefined, y: 1 }, { x: NaN, y: 2 }, null, { x: 6, y: 8 },
  ]);
  assert.equal(r.status, 'ok');
  assert.equal(r.errorPx, 7.5); // (5 + 10) / 2
  assert.equal(r.n, 2);
  assert.equal(r.total, 6);
});

test('targetError: all-null or empty target is "no data", never NaN', () => {
  for (const samples of [[{ x: null, y: null }, { x: null, y: null }], [], undefined]) {
    const r = M.targetError({ x: 10, y: 10 }, samples);
    assert.equal(r.status, 'no data');
    assert.equal(r.errorPx, null);
    assert.equal(r.n, 0);
  }
});

test('percentOfDiagonal: error px over the viewport diagonal', () => {
  assert.equal(M.percentOfDiagonal(500, 1200, 1600), 25); // diagonal is exactly 2000 px
  assert.equal(M.percentOfDiagonal(0, 1200, 1600), 0);
  assert.equal(M.percentOfDiagonal(10, 0, 0), null);
});

test('degreesFromPx: visual angle from px size, screen diagonal and distance', () => {
  // 1200x1600 CSS px screen, 20 inch diagonal -> 0.0254 cm per px; 100 px = 2.54 cm.
  const screen = { screenW: 1200, screenH: 1600, diagonalInches: 20 };
  // Hand check: viewed from 1.27 cm, 2.54 cm subtends 2*atan(1.27/1.27) = 90 degrees.
  near(M.degreesFromPx(100, { ...screen, distanceCm: 1.27 }), 90, 1e-9);
  // Hand check at 50 cm: 2*atan(1.27/50) = 2*(0.0254 - 0.0254^3/3) rad = 0.050789 rad = 2.9100 deg.
  near(M.degreesFromPx(100, { ...screen, distanceCm: 50 }), 2.91, 0.001);
});

test('degreesFromPx: null unless diagonal and distance are both positive numbers', () => {
  const ok = { screenW: 1200, screenH: 1600, diagonalInches: 20, distanceCm: 50 };
  assert.notEqual(M.degreesFromPx(100, ok), null);
  for (const bad of [{ diagonalInches: 0 }, { diagonalInches: NaN }, { diagonalInches: '' }, { diagonalInches: undefined },
    { distanceCm: 0 }, { distanceCm: -5 }, { distanceCm: null }, { screenW: 0, screenH: 0 }, { screenW: undefined }]) {
    assert.equal(M.degreesFromPx(100, { ...ok, ...bad }), null, JSON.stringify(bad));
  }
  assert.equal(M.degreesFromPx(null, ok), null);
});

test('summarize: mean over targets that have data, no-data targets counted and excluded', () => {
  const errors = [
    { status: 'ok', errorPx: 5, n: 10, total: 10 },
    { status: 'ok', errorPx: 10, n: 10, total: 12 },
    { status: 'no data', errorPx: null, n: 0, total: 5 },
    { status: 'ok', errorPx: 15, n: 8, total: 10 },
  ];
  const s = M.summarize(errors, { w: 1200, h: 1600 });
  assert.equal(s.status, 'ok');
  assert.equal(s.meanErrorPx, 10);
  assert.equal(s.percentOfDiagonal, 0.5);
  assert.equal(s.usedTargets, 3);
  assert.equal(s.noDataTargets, 1);
  assert.equal(s.degrees, null, 'no diagonal/distance entered -> no degrees');
});

test('summarize: degrees only when diagonal and distance are given', () => {
  const errors = [{ status: 'ok', errorPx: 10, n: 1, total: 1 }];
  const s = M.summarize(errors, { w: 1200, h: 1600 }, { screenW: 1200, screenH: 1600, diagonalInches: 20, distanceCm: 50 });
  near(s.degrees, 0.2911, 0.0005); // 10 px = 0.254 cm; 2*atan(0.127/50)
  assert.equal(M.summarize(errors, { w: 1200, h: 1600 }, { diagonalInches: 20 }).degrees, null);
});

test('summarize: every target without data -> "no data", all figures null (no NaN)', () => {
  const s = M.summarize([{ status: 'no data', errorPx: null, n: 0, total: 3 }, { status: 'no data', errorPx: null, n: 0, total: 0 }],
    { w: 800, h: 600 }, { screenW: 800, screenH: 600, diagonalInches: 10, distanceCm: 40 });
  assert.equal(s.status, 'no data');
  assert.equal(s.meanErrorPx, null);
  assert.equal(s.percentOfDiagonal, null);
  assert.equal(s.degrees, null);
  assert.equal(s.usedTargets, 0);
  assert.equal(s.noDataTargets, 2);
  assert.equal(M.summarize([], { w: 800, h: 600 }).status, 'no data');
});

test('formatResult: copyable plain text with device note; degrees line only when computed', () => {
  const errors = [{ status: 'ok', errorPx: 120.4, n: 28, total: 30 }, { status: 'no data', errorPx: null, n: 0, total: 30 }];
  const base = { deviceNote: 'iPad 10th gen, Safari', viewport: { w: 1180, h: 820 }, targets: M.targetPositions(1180, 820).slice(0, 2), when: '2026-11-28 10:00' };
  const withoutDeg = M.formatResult({ ...base, errors, summary: M.summarize(errors, base.viewport) });
  assert.match(withoutDeg, /iPad 10th gen, Safari/);
  assert.match(withoutDeg, /1180x820/);
  assert.match(withoutDeg, /평균 오차: 120 px/);
  assert.match(withoutDeg, /화면 대각선의 8\.\d%/);
  assert.match(withoutDeg, /데이터 없음/);
  assert.doesNotMatch(withoutDeg, /NaN|undefined|null/);
  assert.doesNotMatch(withoutDeg, /°|도\)/, 'degrees must be omitted when not computed');

  const opts = { screenW: 1180, screenH: 820, diagonalInches: 10.9, distanceCm: 40 };
  const withDeg = M.formatResult({ ...base, errors, summary: M.summarize(errors, base.viewport, opts), inputs: opts });
  assert.match(withDeg, /°/);
  assert.match(withDeg, /10\.9/);
  assert.match(withDeg, /40 cm/);
});

test('formatResult: all-no-data run says so instead of printing numbers', () => {
  const errors = [{ status: 'no data', errorPx: null, n: 0, total: 0 }];
  const viewport = { w: 800, h: 600 };
  const text = M.formatResult({ deviceNote: '', viewport, targets: M.targetPositions(800, 600).slice(0, 1), when: 'x', errors, summary: M.summarize(errors, viewport) });
  assert.match(text, /데이터 없음/);
  assert.doesNotMatch(text, /NaN|undefined|null/);
});

test('measure.html and measure.js: stay on the origin and keep the same page rules', () => {
  const html = read('measure.html');
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /src="\/vendor\/webgazer\.js"/);
  assert.match(html, /src="\/js\/measure-math\.js"/);
  assert.match(html, /src="\/js\/measure\.js"/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[^<]/, 'inline script');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handler');
  const src = read('js/measure.js');
  assert.match(src, /\/api\/me/, 'login check');
  assert.match(src, /saveDataAcrossSessions\(false\)/);
  assert.match(src, /faceMeshSolutionPath/);
  assert.match(src, /pagehide/);
  // The only request is GET /api/me through api.js; nothing is uploaded.
  assert.doesNotMatch(src, /api\.(post|patch|del)|fetch\(|sendBeacon|XMLHttpRequest|WebSocket|\.innerHTML|toDataURL|captureStream|MediaRecorder|drawImage/);
});

test('accuracyVerdict: proposed levels <=3% good, <=5% caution, above poor; no data -> null', () => {
  assert.equal(M.accuracyVerdict(0), 'good');
  assert.equal(M.accuracyVerdict(3), 'good', '3% is inclusive');
  assert.equal(M.accuracyVerdict(3.01), 'caution');
  assert.equal(M.accuracyVerdict(5), 'caution', '5% is inclusive');
  assert.equal(M.accuracyVerdict(5.1), 'poor');
  for (const v of [null, undefined, NaN, Infinity]) assert.equal(M.accuracyVerdict(v), null);
  assert.equal(M.VERDICT_GOOD_MAX, 3);
  assert.equal(M.VERDICT_CAUTION_MAX, 5);
});

test('overThreshold: a target row is "기준 초과" only above 3% and only with data', () => {
  assert.equal(M.overThreshold(3), false);
  assert.equal(M.overThreshold(3.2), true);
  assert.equal(M.overThreshold(null), false);
});

test('targetName: row-major 3x3 names; targetStates: done / current / upcoming', () => {
  const names = M.targetPositions(1000, 800).map(M.targetName);
  assert.deepEqual(names, ['왼쪽 위', '위 가운데', '오른쪽 위', '왼쪽 가운데', '가운데', '오른쪽 가운데', '왼쪽 아래', '아래 가운데', '오른쪽 아래']);
  assert.deepEqual(M.targetStates(3, 9), ['done', 'done', 'done', 'current', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  assert.deepEqual(M.targetStates(0, 2), ['current', 'upcoming']);
});

test('measure page shows the proposed thresholds as "참고 기준" and the step/verdict UI', () => {
  const src = read('js/measure.js');
  assert.match(src, /참고 기준/);
  assert.match(src, /현재 결과/);
  assert.match(src, /번째 점/);
  assert.match(src, /점검 중단/);
  assert.match(read('measure.html'), /href="\/css\/measure\.css"/);
});
