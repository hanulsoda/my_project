'use strict';
// Gaze capture: only {t,x,y} (and the page number) leaves this module; the camera frames never do.
(function (root) {
  // Stays under the server's per-upload sample limit (100000).
  const MAX_SAMPLES = 100000;

  // webgazer: anything with setGazeListener(fn). `now` is injectable for tests.
  // t is milliseconds since startCapture(); no gaze (face lost, blink) is stored as x:null,y:null.
  // With {paged: true} every sample also carries `page`, the page shown (setPage(n), starts at 0).
  function startCapture(webgazer, now = () => performance.now(), { paged = false } = {}) {
    const t0 = now();
    const samples = [];
    let open = true;
    let page = 0;

    webgazer.setGazeListener((data) => {
      if (!open || samples.length >= MAX_SAMPLES) return;
      const ok = data && Number.isFinite(data.x) && Number.isFinite(data.y);
      const s = { t: Math.round(now() - t0), x: ok ? data.x : null, y: ok ? data.y : null };
      if (paged) s.page = page;
      samples.push(s);
    });

    return {
      setPage(n) { page = n; },
      stop() {
        if (open) {
          open = false;
          webgazer.setGazeListener(() => {});
        }
        return samples;
      },
    };
  }

  const exported = { startCapture, MAX_SAMPLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
