'use strict';
// "색으로 보기" rehearsal: after the ball calibration and before the recorded reading, the word
// nearest to the (smoothed) gaze point gets a background colour, so the child sees where the
// system thinks they look. Nothing from the rehearsal is recorded or uploaded; the highlight is
// never on during the recorded reading. `createSmoother` and `nearestWord` are pure.
(function (root) {
  const SMOOTH_N = 5;
  const HIT_CLASS = 'gaze-hit';

  // Moving average of the last n valid points. push({x,y}) -> {x,y} or null (no valid point yet).
  function createSmoother(n = SMOOTH_N) {
    const buf = [];
    return {
      push(p) {
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          buf.push({ x: p.x, y: p.y });
          if (buf.length > n) buf.shift();
        }
        if (buf.length === 0) return null;
        let sx = 0;
        let sy = 0;
        for (const q of buf) { sx += q.x; sy += q.y; }
        return { x: sx / buf.length, y: sy / buf.length };
      },
      reset() { buf.length = 0; },
    };
  }

  // Index of the box nearest to (x,y) (distance 0 inside a box), or -1 when there is none within
  // maxDist px.
  function nearestWord(boxes, x, y, maxDist = Infinity) {
    let best = -1;
    let bestD = Infinity;
    boxes.forEach((b, k) => {
      const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
      const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = k; }
    });
    return bestD <= maxDist ? best : -1;
  }

  // DOM: spans are the word <span>s laid out by layoutPassage, boxes their boxes (same order).
  // Returns {stop()}, which detaches the listener and clears the highlight.
  function startPractice(webgazer, spans, boxes, { maxDist = Infinity } = {}) {
    const smooth = createSmoother();
    let lit = -1;
    let open = true;
    const light = (k) => {
      if (k === lit) return;
      if (lit >= 0 && spans[lit]) spans[lit].classList.remove(HIT_CLASS);
      if (k >= 0 && spans[k]) spans[k].classList.add(HIT_CLASS);
      lit = k;
    };
    webgazer.setGazeListener((data) => {
      if (!open) return;
      const p = smooth.push(data);
      light(p ? nearestWord(boxes, p.x, p.y, maxDist) : -1);
    });
    return {
      stop() {
        if (!open) return;
        open = false;
        webgazer.setGazeListener(() => {});
        light(-1);
      },
    };
  }

  const PRACTICE_TEXT = '연습해 볼까요? 글을 눈으로 따라 읽으면 보고 있는 낱말에 색이 칠해져요. '
    + '색이 다른 곳에 있으면 머리를 움직이지 말고 눈으로 천천히 다시 읽어 보세요.';

  const exported = { createSmoother, nearestWord, startPractice, PRACTICE_TEXT, HIT_CLASS };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
