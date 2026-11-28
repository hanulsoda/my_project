'use strict';
// Public parent report. No login, no third-party requests: one same-origin fetch that sends no
// cookies and no referrer. Every value is inserted with textContent.
(function () {
  const { h, trendChart, reportDisplay } = window.ReadingApp;
  const $ = (id) => document.getElementById(id);
  const GRADE = { elementary: '초등', middle: '중등', high: '고등' };

  function showError(title, text) {
    $('status').hidden = true;
    $('content').hidden = true;
    $('error-title').textContent = title;
    $('error-text').textContent = text;
    $('error').hidden = false;
  }

  function metric(label, value, caption) {
    return h('div', { class: 'metric' },
      h('div', { class: 'v' }, value), h('div', { class: 'k' }, label), caption ? h('div', { class: 'k' }, caption) : null);
  }

  function render(data) {
    const m = data.session.metrics;
    const date = new Date(data.session.startedAt).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

    $('who').textContent = `${data.child.initials} (${data.child.code}) · ${GRADE[data.child.gradeBand] || ''} · ${date}`;
    $('disclaimer').textContent = data.disclaimer;

    // reportDisplay decides what may be shown: reference-only (reliable === false) sessions get
    // no WPM, completion or regression figures, and a failed one a plain "measure again" banner.
    // Line-level facts (lines read, long-dwell lines) are cards too; there is no per-word view.
    const view = reportDisplay(m);
    $('ref-badge').hidden = !view.referenceOnly;
    $('ref-note').hidden = !view.referenceOnly;
    $('fail-banner').textContent = view.banner || '';
    $('fail-banner').hidden = !view.banner;
    $('metrics').replaceChildren(...view.cards.map((c) => metric(c.label, c.value, c.caption)));

    $('trend').replaceChildren(trendChart(data.trend));
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
