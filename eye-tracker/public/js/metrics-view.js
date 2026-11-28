'use strict';
// What to show for one session's metrics. Pure (no DOM) so the "참고용" rule is testable:
// line-level or failed measurements never present word-derived figures as if they were reliable.
(function (root) {
  const FAILED_BANNER = '측정이 제대로 되지 않았어요. 다시 측정해 주세요.';
  const NO_FIGURE = '—';
  const NO_FIGURE_CAPTION = '참고 수치 없음';

  const isFailed = (m) => m.quality === 0 || m.wordsRead === 0;

  // -> { referenceOnly, banner, cards: [{label, value, caption?}] }
  function reportDisplay(m) {
    const referenceOnly = m.detail === 'line' || isFailed(m);
    if (isFailed(m)) return { referenceOnly, banner: FAILED_BANNER, cards: [] };
    if (m.detail === 'line') {
      return {
        referenceOnly,
        banner: null,
        cards: [
          { label: '분당 읽은 어절 수 (WPM)', value: NO_FIGURE, caption: NO_FIGURE_CAPTION },
          { label: '끝까지 읽음', value: '판단 불가' },
          { label: '되돌아 읽은 횟수', value: NO_FIGURE },
          { label: '건너뛴 줄', value: m.skippedLines },
        ],
      };
    }
    return {
      referenceOnly,
      banner: null,
      cards: [
        { label: '분당 읽은 어절 수 (WPM)', value: Math.round(m.wpm) },
        { label: '읽은 시간', value: `${Math.round(m.durationSec)}초` },
        { label: '읽은 어절 수', value: m.wordsRead },
        { label: '끝까지 읽음', value: m.completed ? '예' : '일부만 읽음' },
        { label: '되돌아 읽은 횟수', value: m.regressions },
        { label: '건너뛴 줄', value: m.skippedLines },
      ],
    };
  }

  // One line for the teacher's session list. -> { badge, text }
  function sessionSummary(m) {
    const q = `품질 ${m.quality.toFixed(2)}`;
    if (isFailed(m)) return { badge: true, text: `측정이 제대로 되지 않았어요 · ${q}` };
    if (m.detail === 'line') return { badge: true, text: `${NO_FIGURE_CAPTION} · ${q}` };
    return { badge: false, text: `${Math.round(m.wpm)} WPM · ${m.completed ? '끝까지 읽음' : '일부만 읽음'} · ${q}` };
  }

  const exported = { reportDisplay, sessionSummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
