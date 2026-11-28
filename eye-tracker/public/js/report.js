'use strict';
// Public parent report. No login, no third-party requests: one same-origin fetch that sends no
// cookies and no referrer. Every value is inserted with textContent (through h()).
(function () {
  const RA = window.ReadingApp;
  const { h, trendChart, reportDisplay, reportTiles, glanceSentence, lineMap, longDwellSentence } = RA;
  const { reportTrend, previousReliableWpm, trendSentence } = RA;
  const $ = (id) => document.getElementById(id);
  const GRADE = { elementary: '초등', middle: '중등', high: '고등' };

  function showError(title, text) {
    $('status').hidden = true;
    $('content').hidden = true;
    $('error-title').textContent = title;
    $('error-text').textContent = text;
    $('error').hidden = false;
  }

  function tile({ area, label, value, unit, caption }) {
    return h('div', { class: area ? `stat-tile area-${area}` : 'stat-tile' },
      h('div', { class: 'stat-label' }, label),
      h('div', { class: 'stat-value' }, h('span', { class: 'stat-number' }, value), unit ? h('span', { class: 'stat-unit' }, unit) : null),
      caption ? h('div', { class: 'stat-caption' }, caption) : null);
  }

  // Shown next to the tiles on A4 only.
  const noteTile = () => h('div', { class: 'stat-note area-note print-only' },
    h('strong', {}, '숫자를 읽는 방법'),
    h('p', {}, '한 번의 측정 결과이며 컨디션과 측정 환경에 따라 달라질 수 있습니다.'));

  function renderLineMap(m) {
    $('lines-text').textContent = longDwellSentence(m);
    $('line-map').replaceChildren(...lineMap(m).map(({ line, long }) => h('li', { class: long ? 'long' : null },
      h('span', { class: 'line-no' }, line), h('span', { class: 'line-bar' }, h('span', { class: 'line-ink' })))));
  }

  function render(data) {
    const m = data.session.metrics;
    const startedAt = data.session.startedAt;
    const date = new Date(startedAt).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
    $('who').textContent = `${data.child.initials} · ${GRADE[data.child.gradeBand] || ''} · ${date} 측정`;
    $('disclaimer').textContent = data.disclaimer;

    // reportDisplay decides what may be shown: reference-only (reliable === false) sessions get
    // no figures at all, and a failed one a plain "measure again" banner.
    const view = reportDisplay(m);
    const ref = view.referenceOnly;
    $('ok-badge').hidden = ref;
    $('ref-badge').hidden = !ref;
    $('ref-banner').hidden = !ref;
    $('retry-card').hidden = !ref;
    $('fail-banner').textContent = view.banner || '';
    $('fail-banner').hidden = !view.banner;

    // 참고용: the current session is left out of the trend; reliable: it is the last point.
    const points = reportTrend(data.trend, { startedAt, referenceOnly: ref });
    const previous = previousReliableWpm(data.trend, startedAt);
    const tiles = ref ? null : reportTiles(m, previous);
    if (tiles) {
      $('glance-text').textContent = glanceSentence(m, previous === null);
      $('tiles').replaceChildren(...tiles.map(tile), noteTile());
      renderLineMap(m);
    } else if (!ref) {
      // Older word-level sessions: the plain cards, no line map.
      $('tiles').replaceChildren(...view.cards.map(tile));
    }
    $('glance').hidden = !tiles;
    $('lines-card').hidden = !tiles;
    $('measure-sec').hidden = ref;
    $('suggest').hidden = ref;

    $('trend').replaceChildren(trendChart(points, { width: 318, height: 190, gridSteps: 3, valueLabels: true, legend: false }));
    $('trend-text').textContent = trendSentence(points, { referenceOnly: ref });
    $('status').hidden = true;
    $('content').hidden = false;
  }

  async function load() {
    const token = new URLSearchParams(location.search).get('token');
    if (!token) return showError('존재하지 않는 링크입니다', '주소가 올바른지 확인해 주세요.');
    let res;
    try {
      res = await fetch(`/api/report/${encodeURIComponent(token)}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch {
      return showError('불러오지 못했습니다', '인터넷 연결을 확인하고 다시 시도해 주세요.');
    }
    if (res.status === 410) return showError('만료되었거나 폐기된 링크입니다', '새 링크가 필요하면 담당 선생님께 문의해 주세요.');
    if (res.status === 404) return showError('존재하지 않는 링크입니다', '주소가 올바른지 확인해 주세요.');
    if (!res.ok) return showError('불러오지 못했습니다', '잠시 후 다시 시도해 주세요.');
    render(await res.json());
  }

  $('print').addEventListener('click', () => window.print());
  load();
})();
