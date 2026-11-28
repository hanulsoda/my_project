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

  // Parent report (design D4): stat tiles for a reliable line-level session. `previousWpm` is the
  // latest earlier reliable WPM (null: this is the first record). Each tile has an `area` so the
  // page can lay them out differently on a phone and on A4. Null when the session has no tiles of
  // this kind (참고용, failed, legacy word-level).
  function reportTiles(m, previousWpm) {
    if (!isLineFormat(m) || isReferenceOnly(m) || isFailed(m)) return null;
    const wpm = Math.round(m.wpm);
    return [
      { area: 'wpm', label: '분당 읽은 어절 수', value: wpm, unit: '어절/분',
        caption: previousWpm === null || previousWpm === undefined ? '첫 번째 측정' : `지난 측정 ${Math.round(previousWpm)}` },
      { area: 'done', label: '끝까지 읽음', value: m.completed ? '예' : '아니요',
        caption: m.completed ? '마지막 줄까지 읽음' : '마지막 줄까지 읽지 않음' },
      { area: 'lines', label: '읽은 줄 수 / 전체 줄 수', value: `${m.linesRead} / ${m.totalLines}`, unit: '줄',
        caption: m.linesRead >= m.totalLines ? '모든 줄에 시선이 닿았습니다' : `${m.totalLines - m.linesRead}줄에는 시선이 닿지 않았습니다` },
      { area: 'reg', label: '앞 줄로 되돌아간 횟수', value: m.regressions, unit: '회', caption: '앞 줄을 다시 본 횟수' },
      { area: 'skip', label: '건너뛴 줄 수', value: m.skippedLines, unit: '줄', caption: '시선이 닿지 않은 줄' },
    ];
  }

  // "한눈에 보기" sentence for the same sessions as reportTiles.
  function glanceSentence(m, isFirst) {
    const read = m.completed ? `전체 ${m.totalLines}줄을 끝까지 읽었고` : `전체 ${m.totalLines}줄 중 ${m.linesRead}줄을 읽었고`;
    const speed = `1분에 약 ${Math.round(m.wpm)}어절을 읽었습니다.`;
    if (isFirst) return `첫 번째 측정에서 ${read}, ${speed} 다음 측정부터 변화를 비교해 볼 수 있습니다.`;
    return `이번에는 ${read}, ${speed} 앞 줄로 되돌아간 횟수는 ${m.regressions}번, 건너뛴 줄은 ${m.skippedLines}줄이었습니다.`;
  }

  // Line map rows (1-based numbers; `long` marks a long-dwell line). Empty when unknown.
  function lineMap(m) {
    const n = Number.isInteger(m.totalLines) ? m.totalLines : 0;
    const long = new Set(m.longDwellLines || []);
    return Array.from({ length: n }, (_, l) => ({ line: l + 1, long: long.has(l) }));
  }

  function longDwellSentence(m) {
    const lines = (m.longDwellLines || []).map((l) => `${l + 1}번째`);
    return lines.length
      ? `시선이 다른 줄보다 오래 머문 줄은 ${lines.join(', ')} 줄입니다.`
      : '다른 줄보다 특별히 오래 머문 줄은 없었습니다.';
  }

  const exported = { reportDisplay, sessionSummary, reportTiles, glanceSentence, lineMap, longDwellSentence };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
