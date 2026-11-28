'use strict';
// Screen-geometry guard for a measurement. Gaze samples and word boxes are viewport coordinates,
// so they are only valid for the geometry the passage was laid out for. Any resize, rotation,
// pinch zoom or visual-viewport scroll after the layout was planned (even one that is undone
// before the end) sets a sticky flag; read.js then refuses to start or upload and asks for a
// restart. Pure helpers plus a listener wrapper; Node-testable with a fake window.
(function (root) {
  const TOLERANCE_PX = 2;
  const SCALE_TOLERANCE = 0.01;

  // {w, h, vw, vh, vx, vy, scale} of a window (visualViewport when the browser has one).
  function geometryOf(win) {
    const vv = win.visualViewport;
    return {
      w: win.innerWidth,
      h: win.innerHeight,
      vw: vv ? vv.width : win.innerWidth,
      vh: vv ? vv.height : win.innerHeight,
      vx: vv ? vv.offsetLeft : 0,
      vy: vv ? vv.offsetTop : 0,
      scale: vv ? vv.scale : 1,
    };
  }

  function geometryChanged(a, b) {
    if (!a || !b) return true;
    for (const k of ['w', 'h', 'vw', 'vh', 'vx', 'vy']) {
      if (!(Math.abs(a[k] - b[k]) <= TOLERANCE_PX)) return true;
    }
    return !(Math.abs(b.scale / a.scale - 1) <= SCALE_TOLERANCE);
  }

  // Starts watching from the current geometry. changed() is sticky: true once any event showed a
  // different geometry, or when the geometry now differs. stop() removes the listeners.
  function watchGeometry(win) {
    const base = geometryOf(win);
    let flagged = false;
    const check = () => { if (geometryChanged(base, geometryOf(win))) flagged = true; };
    const targets = [[win, 'resize'], [win, 'orientationchange']];
    if (win.visualViewport) targets.push([win.visualViewport, 'resize'], [win.visualViewport, 'scroll']);
    for (const [t, ev] of targets) t.addEventListener(ev, check);
    return {
      base,
      changed() { check(); return flagged; },
      stop() { for (const [t, ev] of targets) t.removeEventListener(ev, check); },
    };
  }

  const exported = { geometryOf, geometryChanged, watchGeometry };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
