'use strict';
// "Fill" layout: the passage fills the screen with the largest text and line spacing that fit, and
// is split into pages when it does not fit on one screen. Pure (Node-testable); the DOM side lives
// in read.js, which supplies `measure`.
//
// Why: webcam gaze error (~150 px) is larger than a normal line pitch (49-64 px); a larger pitch
// lets the same error confuse fewer lines. The analysis (server/line-metrics.js) also marks a
// session 참고용 when a line's expected gaze height comes within 0.75 pitch of the top or bottom
// screen edge (WebGazer pins estimates there), counting the child's gaze offset. So every line
// centre here stays at least EDGE_PITCH (1) pitch plus edgeSlackPx inside the viewport; read.js
// passes EDGE_SLACK_PX (100 px, room for a typical gaze offset). A synthetic check showed that a
// block filling the screen edge to edge is flagged 참고용 for almost any offset, while a block with
// this margin keeps the larger pitch's accuracy gain (see the bigtext report).
//
// API
//   planFill({ measure, viewportW, viewportH, bottomReserve, right, minPx, maxPx, minLH, maxLH,
//              minPitchPx, edgeSlackPx })
//     measure(fontPx, lineHeight) -> word boxes [{x, y, w, h, line}] of the WHOLE passage laid out
//       in one column at that size (word-spacing included), in reading order with 0-based `line`
//       (layout.js groupLines). x is in viewport coordinates, y relative to the text element's top.
//     viewportW/viewportH: window.innerWidth/innerHeight. bottomReserve: px at the bottom kept free
//       for the 다음 / 다 읽었어요 button (word boxes stay above it). right: largest allowed x + w.
//     minPx: smallest font allowed (FLOOR_PX by grade band); maxPx (96), minLH (1.6), maxLH (2.6).
//     minPitchPx (default 0): smallest line pitch (fontPx x lineHeight) accepted. A passage that fits
//       on one screen only below this pitch is split into pages instead (read.js asks for
//       PITCH_GAIN x the passage's own pitch, so fill never separates lines less than before).
//   Returns { ok: true, fontPx, lineHeight, top, pages: [{ firstWord, endWord, firstLine, endLine }] }
//     (endWord/endLine exclusive; `top` = viewport y at which the text element's top goes, the same
//     for every page) — one page when the passage fits at some font >= minPx, else the fewest pages
//     of whole, contiguous lines (balanced: line counts differ by at most one), then the largest
//     font and line height at which every page fits. Font is maximised first, then line height.
//     Every page of a multi-page plan holds at least MIN_LINES_PER_PAGE (4) lines.
//   or { ok: false, reason: 'word-too-wide' | 'too-small' } when a word is wider than the screen or
//     not even MIN_LINES_PER_PAGE lines per page fit at minPx (read.js then shows the existing
//     "화면이 작아…" message).
//   Deterministic: the same measure gives the same plan.
//   balancedPages(nLines, nPages) -> [[firstLine, endLine), ...]
(function (root) {
  const MAX_FONT_PX = 96;
  const MIN_LH = 1.6;
  const MAX_LH = 2.6;
  const LH_STEP = 0.05;
  const WORD_SPACING_EM = 0.5;
  const EDGE_PITCH = 1;
  const EDGE_SLACK_PX = 100;
  const MAX_PAGES = 50;
  const FLOOR_PX = { elementary: 24, middle: 24, high: 20 };
  const PITCH_GAIN = 1.25;
  const MIN_LINES_PER_PAGE = 4;

  function balancedPages(nLines, nPages) {
    const out = [];
    const base = Math.floor(nLines / nPages);
    const extra = nLines % nPages;
    let a = 0;
    for (let p = 0; p < nPages; p++) {
      const n = base + (p < extra ? 1 : 0);
      out.push([a, a + n]);
      a += n;
    }
    return out;
  }

  // Per-line geometry of a measured layout.
  function linesOf(boxes) {
    const lines = [];
    for (const b of boxes) {
      let ln = lines[b.line];
      if (!ln) { ln = { top: Infinity, bottom: -Infinity, sum: 0, n: 0, firstWord: Infinity, endWord: -Infinity }; lines[b.line] = ln; }
      ln.top = Math.min(ln.top, b.y);
      ln.bottom = Math.max(ln.bottom, b.y + b.h);
      ln.sum += b.y + b.h / 2;
      ln.n++;
      ln.firstWord = Math.min(ln.firstWord, b.i ?? Infinity);
      ln.endWord = Math.max(ln.endWord, (b.i ?? -Infinity) + 1);
    }
    return lines.map((ln) => ({ ...ln, centre: ln.sum / ln.n }));
  }

  // Tries one (font, line height, page count). Returns a plan or a failure reason.
  function tryLayout(o, fontPx, lineHeight, nPages) {
    const boxes = o.measure(fontPx, lineHeight);
    if (!boxes.length) return { ok: false, reason: 'too-small' };
    if (boxes.some((b) => b.x < 0 || b.x + b.w > o.right + 0.5)) return { ok: false, reason: 'word-too-wide' };
    const withIdx = boxes.map((b, k) => ({ ...b, i: k }));
    const lines = linesOf(withIdx);
    if (lines.length < nPages) return { ok: false, reason: 'too-small' };
    // The per-page analysis needs a few lines on every page (one-line pages carry no vertical structure).
    if (nPages > 1 && Math.floor(lines.length / nPages) < MIN_LINES_PER_PAGE) return { ok: false, reason: 'too-small' };
    const margin = EDGE_PITCH * fontPx * lineHeight + o.edgeSlackPx;
    const H = o.viewportH;
    const ranges = balancedPages(lines.length, nPages);
    // For each page rendered alone its first line sits where line 0 sits: shift = centre[a] - centre[0].
    const bounds = ranges.map(([a, b]) => {
      const shift = lines[a].centre - lines[0].centre;
      const lo = Math.max(margin - (lines[a].centre - shift), -(lines[a].top - shift));
      const hi = Math.min(H - margin - (lines[b - 1].centre - shift), H - o.bottomReserve - (lines[b - 1].bottom - shift));
      return { lo, hi };
    });
    // One `top` for all pages: centred for the fullest page, then checked on every page.
    const fullest = bounds[0]; // balanced: the first page has the most lines
    if (fullest.lo > fullest.hi) return { ok: false, reason: 'too-small' };
    const top = Math.round((fullest.lo + fullest.hi) / 2);
    if (!bounds.every((bd) => top >= bd.lo - 1e-9 && top <= bd.hi + 1e-9)) return { ok: false, reason: 'too-small' };
    const pages = ranges.map(([a, b]) => ({
      firstWord: lines[a].firstWord, endWord: lines[b - 1].endWord, firstLine: a, endLine: b,
    }));
    return { ok: true, fontPx, lineHeight, top, pages };
  }

  // Largest value in the ascending list `vals` for which test(v) succeeds, assuming success is
  // (nearly) monotone; the returned plan is always one that was tested and fits.
  function largest(vals, test) {
    let lo = 0;
    let hi = vals.length - 1;
    let best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = test(vals[mid]);
      if (r.ok) { best = r; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  const round2 = (v) => Math.round(v * 100) / 100;
  const range = (a, b, step = 1) => {
    const out = [];
    for (let k = 0; a + k * step <= b + 1e-9; k++) out.push(Math.round((a + k * step) * 100) / 100);
    return out;
  };

  function planFill(opts) {
    const o = {
      maxPx: MAX_FONT_PX, minLH: MIN_LH, maxLH: MAX_LH, bottomReserve: 0, right: opts.viewportW, minPitchPx: 0, edgeSlackPx: 0, ...opts,
    };
    // Smallest line height (on the LH_STEP grid) giving at least minPitchPx at this font.
    const lhFor = (px) => Math.max(o.minLH, Math.ceil((o.minPitchPx / px - 1e-9) / LH_STEP) * LH_STEP);
    const minPx = Math.min(o.minPx, o.maxPx);
    const fonts = range(minPx, o.maxPx).filter((px) => lhFor(px) <= o.maxLH + 1e-9);
    if (fonts.length === 0) return { ok: false, reason: 'too-small' };
    const best = (nPages) => {
      const f = largest(fonts, (px) => tryLayout(o, px, round2(lhFor(px)), nPages));
      if (!f) return null;
      const lhs = range(f.lineHeight, o.maxLH, LH_STEP);
      return largest(lhs, (lh) => tryLayout(o, f.fontPx, lh, nPages)) || f;
    };

    const one = best(1);
    if (one) return one;
    // Fewest pages at the smallest usable font, then the largest font and spacing for that count.
    const fewest = (n) => tryLayout(o, fonts[0], round2(lhFor(fonts[0])), n);
    if (fewest(1).reason === 'word-too-wide') return { ok: false, reason: 'word-too-wide' };
    for (let n = 2; n <= MAX_PAGES; n++) {
      if (fewest(n).ok) return best(n);
    }
    return { ok: false, reason: 'too-small' };
  }

  const exported = { planFill, balancedPages, FILL: { MAX_FONT_PX, MIN_LH, MAX_LH, WORD_SPACING_EM, EDGE_PITCH, EDGE_SLACK_PX, MAX_PAGES, FLOOR_PX, PITCH_GAIN, MIN_LINES_PER_PAGE } };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
