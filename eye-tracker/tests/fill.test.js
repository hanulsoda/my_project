'use strict';
// public/js/fill.js: big text that fills the screen, split into pages when needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { planFill, balancedPages, safeMargins, FILL } = require('../public/js/fill.js');
const { groupLines } = require('../public/js/layout.js');
const passages = require('../data/passages.json');

// A fake text engine close to a Korean web font: every character 1em wide, a space 0.3em plus the
// fill word-spacing, greedy wrapping, glyph box 1.2em high centred in a line box of lineHeight em.
function fakeMeasure(text, { left, right }) {
  const words = text.split(/\s+/).filter(Boolean);
  let calls = 0;
  const measure = (fontPx, lineHeight) => {
    calls++;
    const space = (0.3 + FILL.WORD_SPACING_EM) * fontPx;
    const pitch = fontPx * lineHeight;
    const gh = 1.2 * fontPx;
    const boxes = [];
    let x = left;
    let line = 0;
    for (const w of words) {
      const ww = [...w].length * fontPx;
      if (x > left && x + ww > right) { line++; x = left; }
      boxes.push({ x, y: line * pitch + (pitch - gh) / 2, w: ww, h: gh });
      x += ww + space;
    }
    return groupLines(boxes);
  };
  return { measure, words, calls: () => calls };
}

function viewport(W, H) {
  const side = Math.max(24, Math.round(0.04 * W));
  return { viewportW: W, viewportH: H, bottomReserve: 72, right: W - side, left: side };
}

function plan(text, W, H, minPx, minPitchPx = 0, extra = {}) {
  const vp = viewport(W, H);
  const fm = fakeMeasure(text, vp);
  const p = planFill({ measure: fm.measure, ...vp, minPx, minPitchPx, ...extra });
  return { p, fm, vp };
}

// Every page laid out alone (as read.js does) must lie inside the viewport, above the button, with
// every line centre at least one pitch from the top and bottom edges.
function checkPages(p, fm, vp, zone = null) {
  const boxes = fm.measure(p.fontPx, p.lineHeight);
  const pitch = p.fontPx * p.lineHeight;
  let next = 0;
  let nextLine = 0;
  for (const pg of p.pages) {
    assert.equal(pg.firstWord, next, 'pages are contiguous and in order');
    assert.equal(pg.firstLine, nextLine, 'whole lines, contiguous');
    assert.ok(pg.endWord > pg.firstWord, 'no empty page');
    next = pg.endWord;
    nextLine = pg.endLine;
    const mine = boxes.slice(pg.firstWord, pg.endWord);
    assert.ok(mine.every((b) => b.line >= pg.firstLine && b.line < pg.endLine));
    const shift = mine[0].y - boxes[0].y;
    for (const b of mine) {
      const y = b.y - shift + p.top;
      assert.ok(b.x >= 0 && b.x + b.w <= vp.viewportW, 'inside horizontally');
      assert.ok(y >= 0 && y + b.h <= vp.viewportH - vp.bottomReserve + 1e-6, `inside vertically (${y})`);
      const c = y + b.h / 2;
      assert.ok(c >= pitch - 1e-6 && c <= vp.viewportH - pitch + 1e-6, 'line centre a pitch inside the screen');
      if (zone) assert.ok(y >= zone.top - 1e-6 && y + b.h <= vp.viewportH - zone.bottom + 1e-6, `inside the safe zone (${y})`);
    }
  }
  assert.equal(next, fm.words.length, 'every word exactly once');
  const sizes = p.pages.map((pg) => pg.endLine - pg.firstLine);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `balanced pages ${sizes}`);
  if (p.pages.length > 1) assert.ok(Math.min(...sizes) >= FILL.MIN_LINES_PER_PAGE, `at least 4 lines per page ${sizes}`);
}

// The parameters read.js passes in fill mode.
function realPlan(ps, band, W, H) {
  const sm = safeMargins(H);
  return plan(ps.text, W, H, FILL.FLOOR_PX[band], FILL.PITCH_GAIN * ps.fontPx * ps.lineHeight,
    { topMarginPx: sm.top, bottomMarginPx: sm.bottom, minViewportW: FILL.MIN_VIEWPORT_W });
}

const shortest = (band) => passages[band].reduce((a, b) => (b.text.length < a.text.length ? b : a));
const longest = (band) => passages[band].reduce((a, b) => (b.text.length > a.text.length ? b : a));

test('balancedPages', () => {
  assert.deepEqual(balancedPages(7, 2), [[0, 4], [4, 7]]);
  assert.deepEqual(balancedPages(6, 3), [[0, 2], [2, 4], [4, 6]]);
  assert.deepEqual(balancedPages(1, 1), [[0, 1]]);
});

test('short passage on 1280x720: one page, larger than the passage font, line height >= 1.6', () => {
  const ps = shortest('elementary');
  const { p, fm, vp } = plan(ps.text, 1280, 720, FILL.FLOOR_PX.elementary);
  assert.equal(p.ok, true);
  assert.equal(p.pages.length, 1);
  assert.ok(p.fontPx > ps.fontPx, `font ${p.fontPx} > ${ps.fontPx}`);
  assert.ok(p.fontPx <= FILL.MAX_FONT_PX);
  assert.ok(p.lineHeight >= 1.6 && p.lineHeight <= 2.6);
  checkPages(p, fm, vp);
  assert.ok(fm.calls() < 60, `measure calls ${fm.calls()}`);
});

test('a taller screen never gives smaller text; caps hold', () => {
  const ps = shortest('middle');
  let prev = 0;
  for (const H of [600, 768, 900, 1100, 1400]) {
    const { p } = plan(ps.text, 1024, H, 24);
    assert.equal(p.pages.length, 1);
    assert.ok(p.fontPx >= prev, `H ${H}: ${p.fontPx} < ${prev}`);
    assert.ok(p.fontPx <= 96 && p.lineHeight <= 2.6);
    prev = p.fontPx;
  }
  const tiny = plan('하나 둘', 1920, 1080, 24).p;
  assert.equal(tiny.fontPx, 96, 'font capped at 96 px');
  assert.equal(tiny.lineHeight, 2.6, 'line height capped at 2.6');
});

test('long text: several pages, all inside the viewport, every word once, no page empty', () => {
  const text = [longest('high').text, longest('high').text, longest('middle').text].join(' ');
  for (const [W, H] of [[1280, 720], [768, 1024], [390, 844]]) {
    const { p, fm, vp } = plan(text, W, H, FILL.FLOOR_PX.high);
    assert.equal(p.ok, true, `${W}x${H}`);
    assert.ok(p.pages.length >= 2, `${W}x${H} pages ${p.pages.length}`);
    assert.ok(p.fontPx >= FILL.FLOOR_PX.high);
    assert.ok(p.lineHeight >= 1.6);
    checkPages(p, fm, vp);
  }
});

test('every real passage on every target viewport: larger pitch, text inside the safe zone', () => {
  for (const band of Object.keys(passages)) {
    for (const ps of passages[band]) {
      const oldPitch = ps.fontPx * ps.lineHeight;
      for (const [W, H] of [[1280, 720], [1024, 768], [768, 1024], [820, 1180], [600, 960]]) {
        const { p, fm, vp } = realPlan(ps, band, W, H);
        assert.equal(p.ok, true, `${ps.id} ${W}x${H}`);
        assert.ok(p.fontPx >= FILL.FLOOR_PX[band]);
        assert.ok(p.fontPx * p.lineHeight >= FILL.PITCH_GAIN * oldPitch - 1e-6, `${ps.id} ${W}x${H}: pitch`);
        assert.ok(p.pages.length <= 10, `${ps.id} ${W}x${H}: ${p.pages.length} pages`);
        checkPages(p, fm, vp, safeMargins(H));
      }
    }
  }
});

test('minPitchPx: a passage that fits one screen only with tight lines gets pages instead', () => {
  const ps = shortest('elementary');
  const loose = plan(ps.text, 1280, 720, 24).p;
  const wide = plan(ps.text, 1280, 720, 24, 90).p;
  assert.equal(loose.pages.length, 1);
  assert.ok(loose.fontPx * loose.lineHeight < 90);
  assert.ok(wide.pages.length >= 2);
  assert.ok(wide.fontPx * wide.lineHeight >= 90);
  assert.equal(plan('짧은 글 하나', 1280, 720, 24, 90).p.pages.length, 1, 'a short text stays on one page');
  assert.deepEqual(plan(ps.text, 1280, 720, 24, 96 * 2.6 + 1).p, { ok: false, reason: 'too-small' }, 'unreachable pitch is refused');
});

test('safeMargins: max(80 px, 12%) on top, max(140 px, 25%) at the bottom', () => {
  assert.deepEqual(safeMargins(720), { top: 86, bottom: 180 });
  assert.deepEqual(safeMargins(480), { top: 80, bottom: 140 });
  assert.deepEqual(safeMargins(1180), { top: 142, bottom: 295 });
});

test('phones in portrait (390x844, 320x480) are refused in fill mode with the real settings (화면이 작아…)', () => {
  for (const band of Object.keys(passages)) {
    for (const ps of passages[band]) {
      for (const [W, H] of [[390, 844], [320, 480], [599, 960]]) {
        assert.deepEqual(realPlan(ps, band, W, H).p, { ok: false, reason: 'too-narrow' }, `${ps.id} ${W}x${H}`);
      }
      assert.equal(realPlan(ps, band, 600, 960).p.ok, true, `${ps.id} 600x960`);
    }
  }
});

test('without the safe zone and pitch rule a 320x480 screen still gets pages; impossible words or screens are refused', () => {
  const ps = longest('elementary');
  const { p, fm, vp } = plan(ps.text, 320, 480, FILL.FLOOR_PX.elementary);
  assert.equal(p.ok, true);
  assert.ok(p.pages.length >= 2);
  checkPages(p, fm, vp);
  assert.deepEqual(plan('가'.repeat(20), 320, 480, 24).p, { ok: false, reason: 'word-too-wide' });
  assert.deepEqual(plan(ps.text, 1280, 90, 24).p, { ok: false, reason: 'too-small' });
  // one line per screen would fit, but pages need 4 lines each: refused instead of 20 one-line pages
  assert.deepEqual(plan(longest('high').text, 700, 150, 20, 62).p, { ok: false, reason: 'too-small' });
});

test('deterministic', () => {
  const text = longest('high').text;
  assert.deepEqual(plan(text, 768, 1024, 20).p, plan(text, 768, 1024, 20).p);
});
