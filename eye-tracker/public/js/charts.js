'use strict';
// SVG charts built with createElementNS + textContent; no HTML strings.
(function (root) {
  const NS = 'http://www.w3.org/2000/svg';
  const LOW_QUALITY = 0.6;

  function svgEl(tag, attrs, text) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
    if (text !== undefined) el.textContent = text;
    return el;
  }

  const fmtDate = (ms) => new Date(ms).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });

  // Trend rows carry `reliable` (the server's 참고용 rule). Points without it (older servers) fall
  // back to the old rule: word-level detail and quality >= 0.6.
  const isReliable = (p) => (typeof p.reliable === 'boolean' ? p.reliable : p.detail !== 'line' && p.quality >= LOW_QUALITY);

  // Splits trend points (oldest first) for drawing. `k` is the index in the input, which fixes the
  // x position. segments: runs of reliable points to connect (a reference-only point ends a run);
  // hollow: reference-only points, drawn but never connected; maxWpm: y-axis scale from reliable
  // points only, so a bogus value from a poor measurement cannot stretch the chart.
  function splitTrend(points) {
    const segments = [];
    const hollow = [];
    let current = [];
    let maxWpm = 0;
    points.forEach((p, k) => {
      if (isReliable(p)) {
        current.push({ p, k });
        maxWpm = Math.max(maxWpm, p.wpm);
      } else {
        hollow.push({ p, k });
        if (current.length) segments.push(current);
        current = [];
      }
    });
    if (current.length) segments.push(current);
    return { segments, hollow, maxWpm };
  }

  // Parent report: the session the link belongs to is not plotted when it is 참고용 (the trend then
  // shows the earlier records only). A reliable session stays in, as the last point.
  function reportTrend(points, { startedAt, referenceOnly }) {
    return referenceOnly ? points.filter((p) => p.startedAt !== startedAt) : points.slice();
  }

  // WPM of the latest reliable record before `startedAt`, or null when there is none.
  function previousReliableWpm(points, startedAt) {
    const before = points.filter((p) => p.startedAt < startedAt && isReliable(p));
    return before.length ? before[before.length - 1].wpm : null;
  }

  // Korean particle 로/으로 after a number read aloud (영/삼/육/십/백/천 take 으로).
  const ro = (n) => ([0, 3, 6].includes(Math.abs(Math.round(n)) % 10) ? '으로' : '로');

  // One-sentence text alternative under the report chart. points: what the chart draws.
  function trendSentence(points, { referenceOnly }) {
    const reliable = points.filter(isReliable);
    if (referenceOnly) {
      return reliable.length
        ? `이번 측정은 참고용이라 추이에 넣지 않았습니다. 이전 신뢰 측정 ${reliable.length}건만 표시합니다.`
        : '이번 측정은 참고용이라 추이에 넣지 않았습니다. 이전 신뢰 측정 기록이 없습니다.';
    }
    if (points.length <= 1) return '이전 기록이 없어 점 하나만 표시합니다. 같은 기준 지문을 다시 읽으면 변화를 볼 수 있습니다.';
    let text = `기록 ${points.length}회 중 ${reliable.length}회가 신뢰 측정입니다.`;
    if (reliable.length >= 2) {
      const a = Math.round(reliable[0].wpm);
      const b = Math.round(reliable[reliable.length - 1].wpm);
      text += b === a
        ? ` 분당 읽은 어절 수는 처음과 같은 ${a}입니다.`
        : ` 분당 읽은 어절 수는 ${a}에서 ${b}${ro(b)} ${b > a ? '늘었습니다' : '줄었습니다'}.`;
    }
    return text;
  }

  // points: [{startedAt, wpm, quality, reliable?}] (reference sessions, oldest first). Returns an <svg>.
  // Filled dots are reliable sessions. Hollow dots are reference-only ("참고용"): they sit on the
  // baseline with no value, are not joined to the line and do not scale the axis.
  // opts: width/height (viewBox), gridSteps, valueLabels (number above each filled dot),
  // legend (in-chart note about hollow dots; the report draws its own legend below the chart).
  function trendChart(points, opts = {}) {
    const W = opts.width || 520;
    const H = opts.height || 220;
    const steps = opts.gridSteps || 4;
    const legend = opts.legend !== false;
    const m = { l: opts.valueLabels ? 36 : 44, r: 16, t: opts.valueLabels ? 22 : 16, b: 30 };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': '분당 읽은 어절 수(WPM) 추이' });
    if (points.length === 0) {
      svg.append(svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' }, '기준 지문 기록이 아직 없습니다'));
      return svg;
    }
    const split = splitTrend(points);
    const maxWpm = Math.max(10, split.maxWpm);
    const step = Math.ceil((maxWpm * 1.1) / steps / 10) * 10;
    const yMax = step * steps;
    const pad = opts.valueLabels ? 16 : 0; // room for the first/last value label
    const xAt = (k) => (points.length === 1 ? (m.l + W - m.r) / 2 : m.l + pad + (k * (W - m.l - m.r - 2 * pad)) / (points.length - 1));
    const yAt = (v) => H - m.b - (v / yMax) * (H - m.t - m.b);

    for (let g = 0; g <= steps; g++) {
      const v = step * g;
      svg.append(
        svgEl('line', { x1: m.l, x2: W - m.r, y1: yAt(v), y2: yAt(v), class: 'chart-grid' }),
        svgEl('text', { x: m.l - 6, y: yAt(v) + 4, 'text-anchor': 'end', class: 'chart-label' }, Math.round(v)),
      );
    }
    for (const seg of split.segments) {
      if (seg.length < 2) continue;
      svg.append(svgEl('polyline', {
        points: seg.map(({ p, k }) => `${xAt(k)},${yAt(p.wpm)}`).join(' '),
        class: 'chart-line',
      }));
    }
    points.forEach((p, k) => {
      const low = !isReliable(p);
      const cy = yAt(low ? 0 : p.wpm);
      const dot = svgEl('circle', { cx: xAt(k), cy, r: opts.valueLabels ? 6 : 5, class: low ? 'chart-dot low' : 'chart-dot' });
      dot.append(svgEl('title', {}, low ? `${fmtDate(p.startedAt)} · 참고용 (수치 없음)` : `${fmtDate(p.startedAt)} · ${Math.round(p.wpm)} WPM`));
      svg.append(dot, svgEl('text', { x: xAt(k), y: H - m.b + 18, 'text-anchor': 'middle', class: 'chart-label' }, fmtDate(p.startedAt)));
      if (opts.valueLabels && !low) {
        svg.append(svgEl('text', { x: xAt(k), y: cy - 11, 'text-anchor': 'middle', class: 'chart-value' }, Math.round(p.wpm)));
      }
    });
    if (legend && split.hollow.length > 0) {
      svg.append(svgEl('text', { x: W - m.r, y: m.t - 4, 'text-anchor': 'end', class: 'chart-label' }, '○ 속이 빈 점: 참고용(수치 없음)'));
    }
    return svg;
  }

  const exported = { trendChart, splitTrend, reportTrend, previousReliableWpm, trendSentence };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
