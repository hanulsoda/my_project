'use strict';
// What to show for one session's metrics. Pure (no DOM) so the "참고용" rule is testable:
// reference-only or failed measurements never present figures as if they were reliable.
//
// Current metrics are line-level (server/line-metrics.js): detail is always 'line' and
// `reliable === false` means 참고용. Legacy stored metrics have no `reliable`; for them
// detail === 'line' still means 참고용, and word-level ones keep their old cards.
(function (root) {
  const FAILED_BANNER = '측정이 제대로 되지 않았어요. 다시 측정해 주세요.';
  const NO_FIGURE = '—';
  const NO_FIGURE_CAPTION = '참고 수치 없음';

  const isFailed = (m) => m.quality === 0 || m.wordsRead === 0;
  const isReferenceOnly = (m) => (typeof m.reliable === 'boolean' ? !m.reliable : m.detail === 'line');
  const isLineFormat = (m) => typeof m.reliable === 'boolean';
  const lineNumbers = (lines) => (lines || []).map((l) => l + 1).join(', ');

  // -> { referenceOnly, banner, cards: [{label, value, caption?}] }
  function reportDisplay(m) {
    const referenceOnly = isReferenceOnly(m) || isFailed(m);
    if (isFailed(m)) return { referenceOnly, banner: FAILED_BANNER, cards: [] };
    if (isReferenceOnly(m)) {
      return {
        referenceOnly,
        banner: null,
        cards: [
          { label: '분당 읽은 어절 수 (WPM)', value: NO_FIGURE, caption: NO_FIGURE_CAPTION },
          { label: '끝까지 읽음', value: '판단 불가' },
          { label: '되돌아 읽은 횟수', value: NO_FIGURE },
          // skipped lines depend on the line assignment just as much: not shown either
          { label: '건너뛴 줄', value: NO_FIGURE },
        ],
      };
    }
    if (isLineFormat(m)) {
      const long = lineNumbers(m.longDwellLines);
      return {
        referenceOnly,
        banner: null,
        cards: [
          { label: '분당 읽은 어절 수 (WPM)', value: Math.round(m.wpm) },
          { label: '읽은 시간', value: `${Math.round(m.durationSec)}초` },
          { label: '읽은 줄 수 / 전체 줄 수', value: `${m.linesRead} / ${m.totalLines}` },
          { label: '끝까지 읽음', value: m.completed ? '예' : '일부만 읽음' },
          { label: '앞 줄로 되돌아간 횟수', value: m.regressions },
          { label: '건너뛴 줄', value: m.skippedLines },
          { label: '오래 머문 줄', value: long ? `${long}번째 줄` : '없음' },
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
    if (isReferenceOnly(m)) return { badge: true, text: `${NO_FIGURE_CAPTION} · ${q}` };
    const done = m.completed ? '끝까지 읽음' : '일부만 읽음';
    if (!isLineFormat(m)) return { badge: false, text: `${Math.round(m.wpm)} WPM · ${done} · ${q}` };
    const long = lineNumbers(m.longDwellLines);
    const parts = [
      `${Math.round(m.wpm)} WPM`,
      `읽은 줄 ${m.linesRead}/${m.totalLines}`,
      done,
      `앞 줄로 되돌아감 ${m.regressions}회`,
      `건너뛴 줄 ${m.skippedLines}`,
      long ? `오래 머문 줄 ${long}` : null,
      q,
    ];
    return { badge: false, text: parts.filter(Boolean).join(' · ') };
  }

  const exported = { reportDisplay, sessionSummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
