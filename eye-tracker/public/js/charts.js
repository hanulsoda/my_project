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

  // points: [{startedAt, wpm, quality}] (reference sessions, oldest first). Returns an <svg>.
  // Filled dots are normal sessions. Hollow dots are reference-only ("참고용"): they sit on the
  // baseline with no value, are not joined to the line and do not scale the axis.
  function trendChart(points) {
    const W = 520; const H = 220;
    const m = { l: 44, r: 16, t: 16, b: 34 };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': '분당 읽은 어절 수(WPM) 추이' });
    if (points.length === 0) {
      svg.append(svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' }, '기준 지문 기록이 아직 없습니다'));
      return svg;
    }
    const split = splitTrend(points);
    const maxWpm = Math.max(10, split.maxWpm);
    const yMax = Math.ceil((maxWpm * 1.1) / 10) * 10;
    const xAt = (k) => (points.length === 1 ? (m.l + W - m.r) / 2 : m.l + (k * (W - m.l - m.r)) / (points.length - 1));
    const yAt = (v) => H - m.b - (v / yMax) * (H - m.t - m.b);

    for (let g = 0; g <= 4; g++) {
      const v = (yMax * g) / 4;
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
      const dot = svgEl('circle', { cx: xAt(k), cy: yAt(low ? 0 : p.wpm), r: 5, class: low ? 'chart-dot low' : 'chart-dot' });
      dot.append(svgEl('title', {}, low ? `${fmtDate(p.startedAt)} · 참고용 (수치 없음)` : `${fmtDate(p.startedAt)} · ${Math.round(p.wpm)} WPM`));
      svg.append(dot, svgEl('text', { x: xAt(k), y: H - m.b + 18, 'text-anchor': 'middle', class: 'chart-label' }, fmtDate(p.startedAt)));
    });
    if (split.hollow.length > 0) {
      svg.append(svgEl('text', { x: W - m.r, y: m.t - 4, 'text-anchor': 'end', class: 'chart-label' }, '○ 속이 빈 점: 참고용(수치 없음)'));
    }
    return svg;
  }

  const exported = { trendChart, splitTrend };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
