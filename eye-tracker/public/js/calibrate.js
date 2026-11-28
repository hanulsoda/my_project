'use strict';
// Ball-follow calibration: the child watches a ball sweep the screen while WebGazer is told where
// the ball is, so its regression learns eye appearance -> screen position.
(function (root) {
  // Waypoints as fractions of the screen; a zig-zag that visits every row and column band.
  const PATH = [
    [0.1, 0.15], [0.5, 0.15], [0.9, 0.15],
    [0.9, 0.5], [0.5, 0.5], [0.1, 0.5],
    [0.1, 0.9], [0.5, 0.9], [0.9, 0.9],
    [0.5, 0.5], [0.1, 0.15],
  ];

  // progress 0..1 (clamped) -> {x,y} in px, piecewise linear along PATH.
  function ballPosition(progress, w, h) {
    const p = Math.min(1, Math.max(0, progress)) * (PATH.length - 1);
    const k = Math.min(Math.floor(p), PATH.length - 2);
    const f = p - k;
    const [ax, ay] = PATH[k];
    const [bx, by] = PATH[k + 1];
    return { x: (ax + (bx - ax) * f) * w, y: (ay + (by - ay) * f) * h };
  }

  const SECONDS = { elementary: 12, middle: 10, high: 8 };
  const TRAIN_EVERY_MS = 60;

  // webgazer: the global WebGazer object. Resolves when the ball has finished its path.
  function runBallCalibration(webgazer, { seconds }) {
    return new Promise((resolve) => {
      const doc = document;
      const overlay = doc.createElement('div');
      overlay.className = 'calib-overlay';
      const ball = doc.createElement('div');
      ball.className = 'calib-ball';
      const note = doc.createElement('p');
      note.className = 'calib-note';
      note.textContent = '공을 눈으로 따라가 보세요!';
      overlay.append(note, ball);
      doc.body.appendChild(overlay);

      const start = performance.now();
      const total = seconds * 1000;
      let lastTrain = -Infinity;

      function frame(nowMs) {
        const elapsed = nowMs - start;
        const progress = elapsed / total;
        const pos = ballPosition(progress, window.innerWidth, window.innerHeight);
        ball.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
        if (nowMs - lastTrain >= TRAIN_EVERY_MS) {
          lastTrain = nowMs;
          webgazer.recordScreenPosition(pos.x, pos.y, 'click');
        }
        if (progress >= 1) {
          overlay.remove();
          resolve();
        } else {
          requestAnimationFrame(frame);
        }
      }
      requestAnimationFrame(frame);
    });
  }

  const exported = { ballPosition, runBallCalibration, CALIBRATION_SECONDS: SECONDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
