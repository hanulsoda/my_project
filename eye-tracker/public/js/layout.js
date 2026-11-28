'use strict';
// Word-box layout. `groupLines` is pure (Node-testable); `layoutPassage` needs a DOM.
(function (root) {
  const median = (nums) => {
    const s = [...nums].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  // boxes: [{x,y,w,h,...}] in any order. Returns new objects (input untouched), in reading order,
  // each with `line` (0-based, top to bottom) and `i` (position in reading order).
  // Boxes share a line when their vertical centres are less than half the median box height apart
  // from the line's running mean centre.
  function groupLines(boxes) {
    if (boxes.length === 0) return [];
    const threshold = Math.max(median(boxes.map((b) => b.h)) / 2, 1);
    const items = boxes.map((b) => ({ box: b, cy: b.y + b.h / 2 })).sort((a, b) => a.cy - b.cy);

    const lines = [];
    for (const it of items) {
      const cur = lines[lines.length - 1];
      if (cur && Math.abs(it.cy - cur.sum / cur.members.length) < threshold) {
        cur.members.push(it);
        cur.sum += it.cy;
      } else {
        lines.push({ members: [it], sum: it.cy });
      }
    }

    const out = [];
    lines.forEach((ln, lineIdx) => {
      ln.members.sort((a, b) => a.box.x - b.box.x);
      for (const m of ln.members) out.push({ ...m.box, line: lineIdx, i: out.length });
    });
    return out;
  }

  // Wraps each whitespace-separated word of `text` in a <span> inside `el` (replacing its content)
  // and returns the word boxes in viewport coordinates, the same space WebGazer reports gaze in.
  // Text goes in via textContent only.
  function layoutPassage(el, text) {
    el.replaceChildren();
    const words = String(text).split(/\s+/).filter(Boolean);
    const spans = [];
    words.forEach((word, k) => {
      const span = el.ownerDocument.createElement('span');
      span.className = 'w';
      span.textContent = word;
      el.appendChild(span);
      spans.push(span);
      if (k < words.length - 1) el.appendChild(el.ownerDocument.createTextNode(' '));
    });
    const boxes = spans.map((span) => {
      const r = span.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return groupLines(boxes).map(({ x, y, w, h, line, i }) => ({ i, line, x, y, w, h }));
  }

  const MIN_FONT_PX = 16;
  const FLOOR_RATIO = 0.85;

  // Picks the largest font size (passageFontPx, then 1px steps down) at which every word box lies
  // inside [0,usableW] x [0,usableH]. Never goes below max(16px, 85% of passageFontPx) (a passage
  // already smaller than 16px is not shrunk at all). measure(fontPx) must lay the passage out at
  // that size and return its boxes [{x,y,w,h}]. Returns {ok:true, fontPx} or {ok:false, fontPx: floor}.
  function fitFontPx({ passageFontPx, usableW, usableH, measure }) {
    const floor = Math.min(passageFontPx, Math.max(MIN_FONT_PX, Math.ceil(passageFontPx * FLOOR_RATIO)));
    const fits = (boxes) => boxes.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= usableW && b.y + b.h <= usableH);
    for (let f = passageFontPx; f >= floor; f--) {
      if (fits(measure(f))) return { ok: true, fontPx: f };
    }
    return { ok: false, fontPx: floor };
  }

  // DOM: a `measure(fontPx, lineHeight)` for fill.js planFill. Lays `text` out once in `el` and
  // re-reads the word boxes at each size: x in viewport coordinates, y relative to el's top.
  function makeMeasure(el, text) {
    layoutPassage(el, text);
    const spans = [...el.querySelectorAll('span.w')];
    return (fontPx, lineHeight) => {
      el.style.fontSize = `${fontPx}px`;
      el.style.lineHeight = String(lineHeight);
      const top = el.getBoundingClientRect().top;
      return groupLines(spans.map((span) => {
        const r = span.getBoundingClientRect();
        return { x: r.left, y: r.top - top, w: r.width, h: r.height };
      }));
    };
  }

  const exported = { groupLines, layoutPassage, fitFontPx, makeMeasure, MIN_FONT_PX };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
