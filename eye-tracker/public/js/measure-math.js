'use strict';
// Pure math for the accuracy check page (measure.html). No DOM, no network: testable in Node.
(function (root) {
  const GRID_INSET = 0.1;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const isPositive = (v) => isNum(v) && v > 0;

  // 3x3 grid, inset 10% from every edge, row-major (left to right, top to bottom).
  function targetPositions(w, h) {
    const xs = [GRID_INSET, 0.5, 1 - GRID_INSET].map((f) => f * w);
    const ys = [GRID_INSET, 0.5, 1 - GRID_INSET].map((f) => f * h);
    const out = [];
    ys.forEach((y, row) => xs.forEach((x, col) => out.push({ x, y, row, col })));
    return out;
  }

  // Mean distance (px) from the target to the valid gaze samples. Samples without a finite
  // x and y (blink, face lost) are ignored. No valid sample -> status 'no data', errorPx null.
  function targetError(target, samples) {
    const list = Array.isArray(samples) ? samples : [];
    let sum = 0;
    let n = 0;
    for (const s of list) {
      if (!s || !isNum(s.x) || !isNum(s.y)) continue;
      sum += Math.hypot(s.x - target.x, s.y - target.y);
      n++;
    }
    if (n === 0) return { status: 'no data', errorPx: null, n: 0, total: list.length };
    return { status: 'ok', errorPx: sum / n, n, total: list.length };
  }

  function percentOfDiagonal(px, w, h) {
    const diag = Math.hypot(w, h);
    if (!isNum(px) || !isPositive(diag)) return null;
    return (px / diag) * 100;
  }

  // Visual angle of a px-sized error. cm per px comes from the physical screen diagonal and the
  // screen size in CSS px, so it does not depend on the browser window size. Null unless the
  // teacher supplied a positive diagonal (inches) and distance (cm).
  function degreesFromPx(px, { screenW, screenH, diagonalInches, distanceCm } = {}) {
    const diagPx = Math.hypot(screenW, screenH);
    if (!isNum(px) || !isPositive(diagonalInches) || !isPositive(distanceCm) || !isPositive(diagPx)) return null;
    const sizeCm = px * ((diagonalInches * 2.54) / diagPx);
    return (2 * Math.atan(sizeCm / 2 / distanceCm) * 180) / Math.PI;
  }

  // errors: targetError results. Mean over the targets that have data (each target weighs the same).
  function summarize(errors, viewport, degreeInputs) {
    const used = errors.filter((e) => e && e.status === 'ok' && isNum(e.errorPx));
    const noDataTargets = errors.length - used.length;
    if (used.length === 0) {
      return { status: 'no data', meanErrorPx: null, percentOfDiagonal: null, degrees: null, usedTargets: 0, noDataTargets };
    }
    const meanErrorPx = used.reduce((a, e) => a + e.errorPx, 0) / used.length;
    return {
      status: 'ok',
      meanErrorPx,
      percentOfDiagonal: percentOfDiagonal(meanErrorPx, viewport.w, viewport.h),
      degrees: degreesFromPx(meanErrorPx, degreeInputs),
      usedTargets: used.length,
      noDataTargets,
    };
  }

  // Proposed verdict levels (handoff D4, not yet a product decision): mean error as a share of the
  // screen diagonal. <= 3% good, <= 5% caution, above that poor. Shown on the page as "참고 기준".
  const VERDICT_GOOD_MAX = 3;
  const VERDICT_CAUTION_MAX = 5;
  function accuracyVerdict(percent) {
    if (!isNum(percent)) return null;
    if (percent <= VERDICT_GOOD_MAX) return 'good';
    if (percent <= VERDICT_CAUTION_MAX) return 'caution';
    return 'poor';
  }
  // One target row is marked "기준 초과" above the good level.
  const overThreshold = (percent) => isNum(percent) && percent > VERDICT_GOOD_MAX;

  const POSITION_NAMES = [
    ['왼쪽 위', '위 가운데', '오른쪽 위'],
    ['왼쪽 가운데', '가운데', '오른쪽 가운데'],
    ['왼쪽 아래', '아래 가운데', '오른쪽 아래'],
  ];
  const targetName = (t) => (POSITION_NAMES[t.row] && POSITION_NAMES[t.row][t.col]) || '';

  // Step screen: every target is 'done', 'current' or 'upcoming' while target `current` is shown.
  function targetStates(current, count) {
    return Array.from({ length: count }, (_, i) => (i < current ? 'done' : i === current ? 'current' : 'upcoming'));
  }

  const fmt = (v, d = 1) => v.toFixed(d);

  // Plain text for copy/paste. Degrees are printed only when they were computed.
  function formatResult({ deviceNote, viewport, targets, errors, summary, inputs, when }) {
    const out = ['읽기 시선 정확도 점검 (선별 지표 점검용)'];
    out.push(`기기: ${deviceNote && deviceNote.trim() ? deviceNote.trim() : '(입력 없음)'}`);
    out.push(`측정 시각: ${when}`);
    out.push(`화면(브라우저 창): ${viewport.w}x${viewport.h} px`);
    if (summary.degrees !== null && inputs) {
      out.push(`화면 대각선 ${inputs.diagonalInches} 인치, 눈-화면 거리 ${inputs.distanceCm} cm`);
    }
    if (summary.status === 'ok') {
      out.push(`평균 오차: ${Math.round(summary.meanErrorPx)} px (화면 대각선의 ${fmt(summary.percentOfDiagonal)}%)`);
      if (summary.degrees !== null) out.push(`평균 오차(각도): ${fmt(summary.degrees)}°`);
      out.push(`평균에 쓴 지점: ${summary.usedTargets}/${errors.length}`);
    } else {
      out.push('평균 오차: 데이터 없음 (no data) - 시선 좌표를 받지 못했습니다');
    }
    out.push('지점별 오차:');
    errors.forEach((e, i) => {
      const t = targets[i];
      const where = t ? `(${Math.round(t.x)}, ${Math.round(t.y)})` : '';
      const val = e.status === 'ok' ? `${Math.round(e.errorPx)} px` : '데이터 없음 (no data)';
      out.push(`  ${i + 1}. ${where} ${val} [유효 샘플 ${e.n}/${e.total}]`);
    });
    return out.join('\n');
  }

  const exported = {
    targetPositions, targetError, percentOfDiagonal, degreesFromPx, summarize, formatResult,
    accuracyVerdict, overThreshold, targetName, targetStates, VERDICT_GOOD_MAX, VERDICT_CAUTION_MAX,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
