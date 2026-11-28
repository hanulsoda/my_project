'use strict';
// Teacher / director screens (design D2): child list, child detail (records, trend, share links),
// and for the director the account list and the activity log. Views are chosen by the address
// hash: "" list, "#child/<id>[/trend|/share]", "#teachers", "#audit".
// All server data reaches the page through h()/textContent, never as HTML.
(function () {
  const {
    api, h, copyText, trendChart, sessionSummary, GRADE_LABEL,
    sessionState, sessionStats, latestSummary, childStats, groupChips, filterChildren, paginate, pageCaption,
    trendStats, shareStatus, maskToken, accountLabel, ROLE_LABEL, actionLabel, ACTION_LABEL, filterAudit, fmtKst,
  } = window.ReadingApp;
  const $ = (id) => document.getElementById(id);
  const KIND_LABEL = { reference: '기준 지문', new: '새 지문' };
  const PAGE_SIZE = 20;
  const AUDIT_PAGE = 20;

  let me = null;
  let children = [];
  const sessionsCache = new Map(); // child id -> Promise<sessions>, for the "최근 측정" column
  const list = { query: '', group: null, missingOnly: false, page: 0 };
  // ?student=0123: opened from the academy's student page ("측정" button). Shows that student's
  // child, or the form to register them. A teacher may register only the student number its
  // session was launched for (me.launchStudentId, from the signed token), which then wins over
  // the address bar; the director may use the address bar's number. Digits only, as on the server.
  const studentParam = new URLSearchParams(location.search).get('student');
  let studentId = /^\d{4,12}$/.test(studentParam || '') ? studentParam : null;
  let canLink = false;
  let studentOpened = false;

  // ---- small shared pieces ----------------------------------------------------------------
  function showMsg(text) {
    $('msg').textContent = text || '';
    $('msg').hidden = !text;
  }
  const fail = (err) => showMsg(err.message || '문제가 생겼습니다.');
  const reportUrl = (token) => `${location.origin}/report.html?token=${encodeURIComponent(token)}`;
  const childLabel = (c) => `${c.code} · ${c.initials}`;

  let toastTimer = null;
  function toast(text, kind = 'success') {
    const t = $('toast');
    t.className = `toast ${kind}`;
    t.replaceChildren(h('span', { class: 'toast-icon', 'aria-hidden': 'true' }, kind === 'danger' ? '!' : '✓'), h('span', {}, text));
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  // Confirm dialog (focus starts on 취소). Resolves true only for the confirming button.
  function confirmDialog({ title, body, ok }) {
    const dlg = $('confirm');
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('confirm-ok').textContent = ok;
    return new Promise((resolve) => {
      const done = (value) => {
        $('confirm-ok').removeEventListener('click', yes);
        $('confirm-cancel').removeEventListener('click', no);
        dlg.removeEventListener('close', no);
        if (dlg.open) dlg.close();
        resolve(value);
      };
      const yes = () => done(true);
      const no = () => done(false);
      $('confirm-ok').addEventListener('click', yes);
      $('confirm-cancel').addEventListener('click', no);
      dlg.addEventListener('close', no);
      dlg.showModal();
      $('confirm-cancel').focus();
    });
  }

  const badge = (kind, text) => h('span', { class: `badge dot ${kind}` }, text);
  const consentBadge = (c) => (c.consentDate ? badge('ok', '동의 완료') : badge('danger', '동의 없음'));
  const stateBadge = (state) => (state === 'reliable' ? badge('ok', '신뢰') : state === 'legacy' ? null : badge('warn', '참고용'));

  function getSessions(childId) {
    if (!sessionsCache.has(childId)) {
      const p = api.get(`/api/children/${childId}/sessions`);
      p.catch(() => sessionsCache.delete(childId));
      sessionsCache.set(childId, p);
    }
    return sessionsCache.get(childId);
  }

  // Copy button: clipboard if allowed, otherwise select the field so Ctrl+C works.
  function copyLink(url, input) {
    return copyText(url).then((ok) => {
      if (ok) return toast('링크를 복사했습니다');
      if (input) input.select();
      toast('자동 복사가 막혀 있습니다. 주소를 직접 복사해 주세요.', 'danger');
    });
  }

  // ---- child list -------------------------------------------------------------------------
  function recentCell(child, cell) {
    if (!child.consentDate) {
      cell.replaceChildren(h('span', { class: 'cell-muted' }, '동의일 입력 후 측정할 수 있습니다'));
      return;
    }
    cell.replaceChildren(h('span', { class: 'skeleton-line', 'aria-label': '불러오는 중' }));
    getSessions(child.id).then((sessions) => {
      const sum = latestSummary(sessions);
      if (!sum) return cell.replaceChildren(h('span', { class: 'cell-muted' }, '아직 측정 기록이 없습니다'));
      cell.replaceChildren(
        h('span', { class: 'cell-date' }, fmtKst(sum.startedAt, false)),
        h('span', { class: 'cell-summary' }, stateBadge(sum.state), h('span', {}, sum.text)));
    }, () => cell.replaceChildren(h('span', { class: 'cell-muted' }, '불러오지 못했습니다')));
  }

  function childRow(child) {
    const recent = h('td', { class: 'cell-recent' });
    recentCell(child, recent);
    const consent = h('td', { class: 'cell-consent' }, consentBadge(child));
    if (!child.consentDate) {
      const enter = h('button', { type: 'button', class: 'secondary' }, '동의일 입력');
      enter.addEventListener('click', () => openChild(child.id, { focusConsent: true }));
      consent.append(enter);
    }
    const view = h('button', { type: 'button', class: 'secondary', 'aria-label': `${child.code} 보기` }, '보기');
    view.addEventListener('click', () => openChild(child.id));
    const del = h('button', { type: 'button', class: 'ghost danger-text', 'aria-label': `${child.code} 삭제` }, '삭제');
    del.addEventListener('click', () => deleteChild(child));
    return h('tr', { class: child.consentDate ? null : 'row-warn' },
      h('th', { scope: 'row', class: 'cell-code' }, child.code),
      h('td', { class: 'cell-initials' }, child.initials),
      h('td', {}, GRADE_LABEL[child.gradeBand] || child.gradeBand),
      h('td', { class: child.group ? null : 'cell-muted' }, child.group || '그룹 없음'),
      consent, recent,
      h('td', {}, h('div', { class: 'cell-actions' }, view, del)));
  }

  async function deleteChild(child) {
    let count = null;
    try { count = (await getSessions(child.id)).length; } catch { /* the warning below still applies */ }
    const what = count === null ? '모든 측정 기록과' : `측정 기록 ${count}건과`;
    const ok = await confirmDialog({
      title: `${child.code} 아이를 삭제할까요?`,
      body: `이 아이(${child.code} · ${child.initials})의 ${what} 보고서 링크가 모두 영구 삭제되며 되돌릴 수 없습니다.`,
      ok: '삭제',
    });
    if (!ok) return;
    showMsg('');
    try {
      await api.del(`/api/children/${child.id}`);
      toast(`${child.code}을(를) 삭제했습니다`);
      if (location.hash.startsWith('#child/')) location.hash = '';
      await load();
    } catch (err) { fail(err); }
  }

  function renderChips() {
    const chips = groupChips(children);
    if (!chips.some((c) => c.key === list.group)) list.group = null;
    $('chips').replaceChildren(...chips.map((c) => {
      const on = c.key === list.group;
      const b = h('button', { type: 'button', class: on ? 'chip on' : 'chip', 'aria-pressed': on ? 'true' : 'false' },
        on ? h('span', { 'aria-hidden': 'true' }, '✓') : null, h('span', { class: 'chip-label' }, c.label), h('span', { class: 'chip-count' }, c.count));
      b.addEventListener('click', () => { list.group = c.key; list.page = 0; renderList(); });
      return b;
    }));
    $('group-list').replaceChildren(...chips.filter((c) => c.key).map((c) => h('option', { value: c.key })));
  }

  function renderList() {
    let source = children;
    if (studentId) {
      source = children.filter((c) => c.externalStudentId === studentId);
      $('student-card').hidden = false;
      $('student-line').textContent = `다힘 학생 번호 ${studentId}`;
      $('link-form').hidden = source.length > 0 || !canLink;
      $('link-note').hidden = source.length > 0 || canLink;
      $('link-student').value = studentId;
      if (!$('link-code').value) $('link-code').value = studentId;
    } else {
      $('student-card').hidden = true;
    }
    const stats = childStats(children);
    $('list-sub').textContent = `등록된 아이 ${stats.total}명 · 보호자 동의 없음 ${stats.missing}명`;
    $('consent-banner').hidden = stats.missing === 0;
    $('consent-banner-title').textContent = `동의 확인이 필요한 아이가 ${stats.missing}명 있습니다`;
    renderChips();

    const shown = filterChildren(source, list);
    const pg = paginate(shown, list.page, PAGE_SIZE);
    list.page = pg.page;
    $('children').replaceChildren(...pg.items.map(childRow));
    const none = shown.length === 0;
    $('empty').hidden = !none;
    $('children').closest('.table-scroll').hidden = none;
    $('empty-title').textContent = studentId && source.length === 0 ? '이 학생은 아직 측정 대상으로 등록되지 않았습니다'
      : children.length === 0 ? '아직 등록된 아이가 없습니다' : '조건에 맞는 아이가 없습니다';
    $('empty-body').textContent = studentId && source.length === 0 ? '위 "다힘 학생" 칸에서 등록하거나 "전체 아이 보기"를 누르세요.'
      : children.length === 0
      ? '"아이 추가"를 눌러 코드와 이니셜로 첫 아이를 등록하세요.'
      : '검색어나 그룹, "동의 없음만 보기"를 바꿔 보세요.';
    $('empty-add').hidden = children.length !== 0;
    $('page-caption').textContent = pageCaption(pg);
    $('prev').disabled = pg.page === 0;
    $('next').disabled = pg.page >= pg.pages - 1;
    $('prev').closest('.table-foot').hidden = none;
  }

  function renderLoadingRows() {
    $('list-sub').textContent = '불러오는 중…';
    $('children').replaceChildren(...Array.from({ length: 5 }, () => h('tr', { class: 'row-skeleton', 'aria-hidden': 'true' },
      ...Array.from({ length: 7 }, () => h('td', {}, h('span', { class: 'skeleton-line' }))))));
    $('page-caption').textContent = '불러오는 중…';
    $('prev').disabled = true;
    $('next').disabled = true;
    show('list');
  }

  async function load() {
    sessionsCache.clear();
    try { children = await api.get('/api/children'); } catch (err) { return fail(err); }
    route();
  }

  // ---- child detail -----------------------------------------------------------------------
  function openChild(id, opts = {}) {
    detailOpts = opts;
    if (location.hash === `#child/${id}`) route();
    else location.hash = `child/${id}`;
  }
  let detailOpts = {};
  let detailCtx = null; // passage titles and the share-tab opener of the child on screen
  let detailToken = 0;

  function infoItem(label, ...content) {
    return h('div', { class: 'info-item' }, h('span', { class: 'info-label' }, label), h('div', { class: 'info-value' }, ...content));
  }

  async function patchChild(child, body, okText) {
    showMsg('');
    try {
      await api.patch(`/api/children/${child.id}`, body);
      if (okText) toast(okText);
      await load();
      return true;
    } catch (err) { fail(err); return false; }
  }

  // An inline editor: shows `view` with an edit button, or an input with 저장/취소.
  function editable({ label, value, input, editLabel, save }) {
    const box = h('div', { class: 'info-edit' });
    const showView = () => {
      const edit = h('button', { type: 'button', class: 'ghost' }, editLabel);
      edit.addEventListener('click', showEdit);
      box.replaceChildren(h('span', { class: value ? null : 'cell-muted' }, value || '없음'), edit);
    };
    function showEdit() {
      const el = input();
      const ok = h('button', { type: 'button', class: 'secondary' }, '저장');
      const cancel = h('button', { type: 'button', class: 'ghost' }, '취소');
      ok.addEventListener('click', () => save(el.value));
      cancel.addEventListener('click', showView);
      box.replaceChildren(el, ok, cancel);
      el.focus();
    }
    showView();
    return infoItem(label, box);
  }

  function consentEditor(child, focus) {
    const box = h('div', { class: 'info-edit' });
    const dateInput = () => h('input', { type: 'date', value: child.consentDate || '', 'aria-label': '보호자 동의일' });
    const save = async (v) => {
      if (!v) return showMsg('동의일을 입력해 주세요.');
      await patchChild(child, { consentDate: v }, '동의일을 저장했습니다');
    };
    if (!child.consentDate) {
      const input = dateInput();
      const ok = h('button', { type: 'button', class: 'secondary' }, '동의일 저장');
      ok.addEventListener('click', () => save(input.value));
      box.append(consentBadge(child), input, ok);
      if (focus) setTimeout(() => input.focus(), 0);
    } else {
      const edit = h('button', { type: 'button', class: 'ghost' }, '수정');
      const clear = h('button', { type: 'button', class: 'ghost danger-text' }, '지우기');
      edit.addEventListener('click', () => {
        const input = dateInput();
        const ok = h('button', { type: 'button', class: 'secondary' }, '저장');
        ok.addEventListener('click', () => save(input.value));
        box.replaceChildren(input, ok);
        input.focus();
      });
      clear.addEventListener('click', async () => {
        const yes = await confirmDialog({
          title: '동의 기록을 지울까요?',
          body: '동의 기록을 지우면 다시 입력하기 전까지 이 아이는 측정할 수 없습니다.',
          ok: '지우기',
        });
        if (yes) await patchChild(child, { consentDate: null }, '동의 기록을 지웠습니다');
      });
      box.append(consentBadge(child), h('span', {}, child.consentDate), edit, clear);
    }
    return infoItem('보호자 동의일', box);
  }

  // ---- one session card -------------------------------------------------------------------
  function noteRow(s) {
    const row = h('div', { class: 'note-row' });
    const show = () => {
      const edit = h('button', { type: 'button', class: 'ghost' }, s.note ? '메모 수정' : '메모 추가');
      edit.addEventListener('click', () => {
        const input = h('input', { value: s.note || '', maxlength: 500, 'aria-label': '측정 메모', class: 'grow' });
        const ok = h('button', { type: 'button', class: 'secondary' }, '저장');
        const cancel = h('button', { type: 'button', class: 'ghost' }, '취소');
        ok.addEventListener('click', async () => {
          try {
            const res = await api.patch(`/api/sessions/${s.id}`, { note: input.value });
            s.note = res.note;
            toast('메모를 저장했습니다');
            show();
          } catch (err) { fail(err); }
        });
        cancel.addEventListener('click', show);
        row.replaceChildren(h('span', { class: 'note-label' }, '메모'), input, ok, cancel);
        input.focus();
      });
      row.replaceChildren(h('span', { class: 'note-label' }, '메모'),
        h('span', { class: s.note ? 'note-text' : 'note-text cell-muted' }, s.note || '메모가 없습니다.'), edit);
    };
    show();
    return row;
  }

  function sessionBody(m) {
    const state = sessionState(m);
    if (state === 'reliable') {
      return h('div', { class: 'stat-row' }, sessionStats(m).map((st) => h('div', { class: 'mini-stat' },
        h('span', { class: 'mini-label' }, st.label),
        h('span', { class: 'mini-value' }, st.value, st.unit ? h('span', { class: 'mini-unit' }, st.unit) : null))));
    }
    if (state === 'legacy') return h('p', { class: 'page-sub' }, sessionSummary(m).text);
    const text = state === 'failed'
      ? '측정이 제대로 되지 않아 수치가 없습니다. 다시 측정해 보세요.'
      : '측정 상태가 안정적이지 않아 수치를 표시하지 않습니다. 다시 측정해 보세요.';
    return h('div', { class: 'banner warning inline-banner' }, badge('warn', '참고용'), h('span', {}, text));
  }

  // onReanalyzed: called after a successful "다시 분석" (the child's trend is rebuilt).
  function sessionRow(s, onReanalyzed) {
    const ctx = detailCtx;
    let body = sessionBody(s.metrics);
    let badges = h('span', { class: 'badges' }, badge('info', KIND_LABEL[s.kind] || s.kind), stateBadge(sessionState(s.metrics)));
    const redo = h('button', { type: 'button', class: 'secondary', title: '저장된 시선 기록을 지금의 분석 방법으로 다시 계산합니다' }, '다시 분석');
    const report = h('button', { type: 'button', class: 'ghost' }, '보고서 링크');
    report.addEventListener('click', () => ctx.showShare(s.id));
    redo.addEventListener('click', async () => {
      showMsg('');
      redo.disabled = true;
      redo.textContent = '분석 중…';
      const waiting = h('div', { class: 'analyzing' }, h('p', { class: 'page-sub' }, '줄 단위 지표를 다시 계산하는 중입니다. 잠시만 기다려 주세요.'),
        h('span', { class: 'skeleton-line w60' }), h('span', { class: 'skeleton-line w50' }), h('span', { class: 'skeleton-line w40' }));
      body.replaceWith(waiting);
      body = waiting;
      try {
        const res = await api.post(`/api/sessions/${s.id}/reanalyze`);
        s.metrics = res.metrics;
        if (onReanalyzed) await onReanalyzed();
        redo.textContent = '다시 분석됨';
        toast('다시 분석했습니다');
      } catch (err) {
        redo.textContent = '다시 분석';
        fail(err);
      } finally {
        const fresh = sessionBody(s.metrics);
        body.replaceWith(fresh);
        body = fresh;
        const freshBadges = h('span', { class: 'badges' }, badge('info', KIND_LABEL[s.kind] || s.kind), stateBadge(sessionState(s.metrics)));
        badges.replaceWith(freshBadges);
        badges = freshBadges;
        redo.disabled = false;
      }
    });
    const title = ctx.titles.get(s.passageId);
    return h('article', { class: 'card t-card session-card' },
      h('div', { class: 'session-head' },
        h('div', {},
          h('h3', { class: 'session-time' }, fmtKst(s.startedAt)),
          h('p', { class: 'session-passage' }, title ? `지문 『${title}』` : '지문', badges)),
        h('div', { class: 'row' }, redo, report)),
      body,
      noteRow(s));
  }

  // ---- share links ------------------------------------------------------------------------
  async function renderShares(session, box) {
    let shares;
    box.replaceChildren(h('span', { class: 'skeleton-line w60' }));
    try { shares = await api.get(`/api/sessions/${session.id}/shares`); } catch (err) { return fail(err); }
    const now = Date.now();
    if (!shares.length) {
      box.replaceChildren(h('p', { class: 'page-sub' }, '이 측정으로 만든 링크가 아직 없습니다.'));
      return;
    }
    const rows = shares.map((s) => {
      const st = shareStatus(s, now);
      const active = st.key === 'active';
      const copy = h('button', { type: 'button', class: 'secondary', disabled: !active }, '복사');
      copy.addEventListener('click', () => copyLink(reportUrl(s.token)));
      const revoke = h('button', { type: 'button', class: 'ghost danger-text', disabled: !active }, '링크 취소');
      revoke.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: '이 링크를 취소할까요?',
          body: '받은 사람은 더 이상 보고서를 볼 수 없습니다. 되돌릴 수 없습니다.',
          ok: '링크 취소',
        });
        if (!ok) return;
        try {
          await api.del(`/api/share/${encodeURIComponent(s.token)}`);
          toast('링크를 취소했습니다');
          await renderShares(session, box);
        } catch (err) { fail(err); }
      });
      return h('tr', { class: active ? null : 'row-dim' },
        h('td', {}, badge(st.key === 'active' ? 'ok' : st.key === 'revoked' ? 'danger' : 'info', st.label)),
        h('td', { class: active ? 'mono' : 'mono struck' }, maskToken(s.token)),
        h('td', {}, fmtKst(s.expiresAt, false)),
        h('td', {}, h('div', { class: 'cell-actions' }, copy, revoke)));
    });
    box.replaceChildren(h('div', { class: 'table-scroll inset' }, h('table', { class: 't-table' },
      h('thead', {}, h('tr', {}, ...['상태', '링크', '만료일', '작업'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows))));
  }

  function sharePanel(sessions, ctx) {
    const panel = h('div', { class: 'stack' });
    if (!sessions.length) {
      panel.append(h('section', { class: 'card t-card' }, h('p', { class: 'page-sub' }, '측정 기록이 생기면 보고서 링크를 만들 수 있습니다.')));
      return { panel, select() {} };
    }
    const label = (s) => {
      const st = sessionState(s.metrics);
      const title = ctx.titles.get(s.passageId);
      return `${fmtKst(s.startedAt)} · ${title || KIND_LABEL[s.kind] || s.kind} (${st === 'reliable' ? '신뢰' : st === 'legacy' ? '이전 분석' : '참고용'})`;
    };
    const newest = sessions.slice().reverse();
    const pick = h('select', { id: 'share-session' }, newest.map((s) => h('option', { value: s.id }, label(s))));
    const listBox = h('div', {});
    const daysName = 'share-days';
    const days = [7, 30, 90].map((d) => h('label', { class: 'choice' },
      h('input', { type: 'radio', name: daysName, value: d, checked: d === 30 }), `${d}일`));
    const create = h('button', { type: 'button' }, '새 링크 만들기');
    const current = () => sessions.find((s) => String(s.id) === pick.value);
    pick.addEventListener('change', () => renderShares(current(), listBox));
    create.addEventListener('click', async () => {
      showMsg('');
      const d = Number(panel.querySelector(`input[name="${daysName}"]:checked`).value);
      try {
        const made = await api.post(`/api/sessions/${current().id}/share`, { days: d });
        await renderShares(current(), listBox);
        if (await copyText(reportUrl(made.token))) toast('링크를 만들고 복사했습니다');
        else toast('링크를 만들었습니다. 표의 "복사"를 눌러 주세요.');
      } catch (err) { fail(err); }
    });
    panel.append(
      h('section', { class: 'card t-card' }, h('h2', {}, '보고서를 공유할 측정'),
        h('div', { class: 'field share-pick' }, h('label', { for: 'share-session' }, '측정 기록'), pick)),
      h('section', { class: 'card t-card' }, h('h2', {}, '이 측정의 공유 링크'), listBox),
      h('section', { class: 'card t-card' }, h('h2', {}, '새 링크 만들기'),
        h('div', { class: 'row days-row', role: 'radiogroup', 'aria-label': '유효 기간' }, h('span', { class: 'field-label' }, '유효 기간'), days, create),
        h('p', { class: 'help' }, '학부모 보고서에는 아이 이니셜만 표시되고 선생님 정보는 나오지 않습니다. 링크는 기간이 지나면 만료되며 언제든 취소할 수 있습니다.')));
    let loaded = false;
    return {
      panel,
      select(id) {
        if (id !== undefined && id !== null) pick.value = String(id);
        else if (loaded) return;
        loaded = true;
        renderShares(current(), listBox);
      },
    };
  }

  // ---- trend ------------------------------------------------------------------------------
  function trendPanel(chartBox, trend) {
    const side = h('div', { class: 'stack' });
    const fill = (points) => {
      const t = trendStats(points);
      const tiles = [h('div', { class: 'stat-tile' },
        h('span', { class: 'stat-label' }, '최근 신뢰 측정 평균'),
        h('span', { class: 'stat-value' }, h('span', { class: 'stat-number' }, t.avg === null ? '—' : t.avg), h('span', { class: 'stat-unit' }, '어절/분')),
        h('span', { class: 'stat-caption' }, t.n ? `신뢰 측정 ${t.n}회 기준` : '아직 신뢰 측정이 없습니다'))];
      if (t.latestReference) {
        tiles.push(h('div', { class: 'stat-tile' },
          h('span', { class: 'stat-label' }, `${fmtKst(t.latestReference.startedAt, false)} 측정 `, badge('warn', '참고용')),
          h('span', { class: 'stat-value' }, h('span', { class: 'stat-number muted-number' }, '—')),
          h('span', { class: 'stat-caption' }, '측정 상태가 고르지 않아 수치를 표시하지 않습니다')));
      }
      tiles.push(h('div', { class: 'banner info t-banner' }, h('span', { class: 'banner-icon', 'aria-hidden': 'true' }, 'i'),
        h('div', {}, h('p', { class: 'banner-title' }, '추이 읽는 방법'),
          h('p', { class: 'banner-body' }, '채워진 점은 신뢰 측정, 속이 빈 점은 참고용 측정입니다. 참고용 측정은 수치를 표시하지 않고 평균에도 넣지 않습니다.'))));
      side.replaceChildren(...tiles);
    };
    fill(trend);
    const panel = h('div', { class: 'trend-grid' },
      h('section', { class: 'card t-card' }, h('h2', {}, '기준 지문 분당 읽은 어절 수 추이 (어절/분)'), chartBox,
        h('p', { class: 'legend' }, h('span', { class: 'legend-dot' }), '신뢰 측정', h('span', { class: 'legend-dot hollow' }), '참고용 (수치 신뢰 낮음)')),
      side);
    return { panel, fill };
  }

  async function renderDetail(child, tab) {
    const box = $('view-detail');
    const ticket = ++detailToken;
    const opts = detailOpts;
    detailOpts = {};
    let sessions; let trend; let passages = [];
    box.replaceChildren(h('p', { class: 'page-sub' }, '불러오는 중…'));
    try {
      [sessions, trend, passages] = await Promise.all([
        api.get(`/api/children/${child.id}/sessions`),
        api.get(`/api/children/${child.id}/trend`),
        api.get(`/api/passages?gradeBand=${encodeURIComponent(child.gradeBand)}`).catch(() => []),
      ]);
    } catch (err) { return fail(err); }
    if (ticket !== detailToken) return;
    const titles = new Map(passages.map((p) => [p.id, p.title]));

    // The chart sits in its own holder so a reanalysis can redraw it from the server's trend.
    const chartBox = h('div', { class: 'chart-box' }, trendChart(trend, { legend: false, width: 600, height: 240 }));
    const trendView = trendPanel(chartBox, trend);
    // Two reanalyses close together can answer out of order: only the latest request redraws.
    let trendTicket = 0;
    async function refreshTrend() {
      const ticket = ++trendTicket;
      try {
        const fresh = await api.get(`/api/children/${child.id}/trend`);
        if (ticket !== trendTicket) return;
        chartBox.replaceChildren(trendChart(fresh, { legend: false, width: 600, height: 240 }));
        trendView.fill(fresh);
      } catch (err) { if (ticket === trendTicket) fail(err); }
    }

    const panels = {};
    const tabs = {};
    const ctx = { titles, showShare: (id) => { select('share'); share.select(id); } };
    const share = sharePanel(sessions, ctx);
    detailCtx = ctx;
    const rows = sessions.slice().reverse().map((s) => sessionRow(s, refreshTrend));
    panels.records = h('div', { class: 'stack' }, rows.length ? rows
      : h('section', { class: 'card t-card empty-state' }, h('p', { class: 'empty-title' }, '아직 측정 기록이 없습니다'),
        h('p', { class: 'page-sub' }, child.consentDate ? '"측정 시작"을 눌러 첫 측정을 해 보세요.' : '보호자 동의일을 입력하면 측정할 수 있습니다.')));
    panels.trend = trendView.panel;
    panels.share = share.panel;
    function select(name) {
      for (const k of Object.keys(panels)) {
        panels[k].hidden = k !== name;
        tabs[k].setAttribute('aria-selected', k === name ? 'true' : 'false');
        tabs[k].tabIndex = k === name ? 0 : -1;
      }
      if (name === 'share') share.select();
      const want = name === 'records' ? `#child/${child.id}` : `#child/${child.id}/${name}`;
      if (location.hash !== want) history.replaceState(null, '', want);
    }
    const tabBar = h('div', { class: 'subtabs', role: 'tablist', 'aria-label': '아이 상세' },
      [['records', '기록'], ['trend', '추이'], ['share', '공유 링크']].map(([k, label]) => {
        tabs[k] = h('button', { type: 'button', role: 'tab', class: 'subtab', id: `tab-${k}` }, label);
        panels[k].setAttribute('role', 'tabpanel');
        panels[k].setAttribute('aria-labelledby', `tab-${k}`);
        tabs[k].addEventListener('click', () => select(k));
        return tabs[k];
      }));

    const note = h('span', { id: 'consent-note', class: 'help' }, '보호자 동의일을 먼저 입력해야 측정할 수 있습니다.');
    const start = child.consentDate
      ? h('a', { class: 'btn lg', href: `/read.html?child=${child.id}` }, '측정 시작')
      : h('button', { type: 'button', class: 'lg', disabled: true, 'aria-describedby': note.id }, '측정 시작');
    const back = h('button', { type: 'button', class: 'ghost back' }, '← 아이 목록');
    back.addEventListener('click', () => { location.hash = ''; });
    const del = h('button', { type: 'button', class: 'ghost danger-text' }, '아이 삭제');
    del.addEventListener('click', () => deleteChild(child));

    const sub = [GRADE_LABEL[child.gradeBand] || child.gradeBand, child.group || '그룹 없음', `측정 기록 ${sessions.length}건`].join(' · ');
    const info = h('section', { class: 'card t-card info-card' },
      infoItem('학년대', GRADE_LABEL[child.gradeBand] || child.gradeBand),
      editable({
        label: '그룹', value: child.group, editLabel: '수정',
        input: () => h('input', { value: child.group || '', maxlength: 32, list: 'group-list', 'aria-label': '그룹' }),
        save: (v) => patchChild(child, { group: v.trim() || null }, '그룹을 저장했습니다'),
      }),
      consentEditor(child, opts.focusConsent),
      editable({
        label: '메모', value: child.note, editLabel: '메모 수정',
        input: () => h('input', { value: child.note || '', maxlength: 500, 'aria-label': '메모', class: 'grow' }),
        save: (v) => patchChild(child, { note: v }, '메모를 저장했습니다'),
      }));

    box.replaceChildren(...[
      h('div', {}, back),
      h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, childLabel(child)), h('p', { class: 'page-sub' }, sub)),
        h('div', { class: 'page-actions' }, del, start)),
      child.consentDate ? null : h('div', { class: 'banner warning t-banner' }, h('span', { class: 'banner-icon', 'aria-hidden': 'true' }, '!'),
        h('div', {}, h('p', { class: 'banner-title' }, '보호자 동의일이 없어 측정할 수 없습니다'),
          h('p', { class: 'banner-body' }, '종이 동의서를 받은 날짜를 아래 "보호자 동의일"에 입력하면 "측정 시작"을 누를 수 있습니다. 지난 기록은 그대로 볼 수 있습니다.'), note)),
      info, tabBar, panels.records, panels.trend, panels.share].filter(Boolean));
    select(tab === 'trend' || tab === 'share' ? tab : 'records');
  }

  // ---- director: accounts -----------------------------------------------------------------
  let teachers = [];
  async function loadTeachers() {
    teachers = await api.get('/api/admin/teachers');
    return teachers;
  }

  async function renderTeachers() {
    $('teachers').replaceChildren(h('tr', {}, h('td', { colspan: 6 }, h('span', { class: 'skeleton-line w60' }))));
    try { await loadTeachers(); } catch (err) { return fail(err); }
    const active = teachers.filter((t) => !t.disabled).length;
    $('teachers-sub').textContent = `활성 ${active}명 · 비활성 ${teachers.length - active}명`;
    $('teachers').replaceChildren(...teachers.map((t) => {
      const self = t.email === me.email;
      const btn = h('button', { type: 'button', class: 'secondary', disabled: self && !t.disabled, title: self ? '지금 쓰고 있는 계정입니다' : null },
        t.disabled ? '활성화' : '비활성화');
      btn.addEventListener('click', () => toggleTeacher(t));
      return h('tr', { class: t.disabled ? 'row-dim' : null },
        h('th', { scope: 'row' }, accountLabel(t), self ? h('span', { class: 'cell-muted' }, ' (나)') : null),
        h('td', {}, ROLE_LABEL[t.role] || t.role),
        h('td', {}, t.disabled ? badge('info', '비활성') : badge('ok', '활성')),
        h('td', {}, t.childCount),
        h('td', {}, t.lastLoginAt ? fmtKst(t.lastLoginAt) : '—'),
        h('td', {}, btn));
    }));
  }

  async function toggleTeacher(t) {
    $('teachers-msg').hidden = true;
    if (!t.disabled) {
      const ok = await confirmDialog({
        title: `${accountLabel(t)} 계정을 비활성화할까요?`,
        body: '비활성화하면 다힘 사이트에서도 읽기 시선 기록에 들어올 수 없습니다. 아이와 기록은 그대로 남고, 언제든 다시 활성화할 수 있습니다.',
        ok: '비활성화',
      });
      if (!ok) return;
    }
    try {
      await api.post(`/api/admin/teachers/${t.id}/${t.disabled ? 'enable' : 'disable'}`);
      toast(t.disabled ? '계정을 활성화했습니다' : '계정을 비활성화했습니다');
      await renderTeachers();
    } catch (err) {
      $('teachers-msg-body').textContent = err.message;
      $('teachers-msg').hidden = false;
    }
  }

  // ---- director: activity log -------------------------------------------------------------
  const audit = { rows: [], page: 0 };
  function auditTarget(target) {
    const m = /^(child|user|session|invite):(\d+)$/.exec(target || '');
    if (!m) return target || '—';
    const id = Number(m[2]);
    if (m[1] === 'child') { const c = children.find((x) => x.id === id); return c ? c.code : `아이 #${id} (삭제됨)`; }
    if (m[1] === 'user') return accountLabel(teachers.find((x) => x.id === id));
    if (m[1] === 'session') return `측정 #${id}`;
    return `초대 #${id}`;
  }
  // "update owner=user:3" -> "update · 원래 담당 …"; other details as stored (never personal data).
  const auditDetail = (d) => (d ? d.replace(/owner=user:(\d+)/, (_, id) => `담당: ${accountLabel(teachers.find((x) => x.id === Number(id)))}`) : null);

  function renderAuditRows() {
    const f = { actor: $('f-actor').value, action: $('f-action').value, from: $('f-from').value, to: $('f-to').value };
    const shown = filterAudit(audit.rows, f);
    const pg = paginate(shown, audit.page, AUDIT_PAGE);
    audit.page = pg.page;
    $('audit').replaceChildren(...pg.items.map((r) => h('tr', {},
      h('td', { class: 'nowrap' }, fmtKst(r.at)),
      h('td', {}, r.actorUserId === null ? '시스템' : accountLabel(teachers.find((t) => t.id === r.actorUserId))),
      h('td', {}, actionLabel(r.action)),
      h('td', {}, auditTarget(r.target), r.detail ? h('span', { class: 'cell-muted detail' }, ` · ${auditDetail(r.detail)}`) : null))));
    $('audit-empty').hidden = shown.length > 0;
    $('audit-caption').textContent = `${pageCaption(pg, '건')} · 시각은 한국 표준시`;
    $('audit-prev').disabled = pg.page === 0;
    $('audit-next').disabled = pg.page >= pg.pages - 1;
  }

  async function renderAudit() {
    $('audit').replaceChildren(h('tr', {}, h('td', { colspan: 4 }, h('span', { class: 'skeleton-line w60' }))));
    try {
      [audit.rows] = await Promise.all([api.get('/api/admin/audit?limit=500'), loadTeachers()]);
    } catch (err) { return fail(err); }
    const keep = (id, opts) => {
      const sel = $(id); const was = sel.value;
      sel.replaceChildren(h('option', { value: '' }, '전체'), ...opts.map(([v, t]) => h('option', { value: v }, t)));
      sel.value = opts.some(([v]) => v === was) ? was : '';
    };
    keep('f-actor', teachers.map((t) => [String(t.id), accountLabel(t)]));
    const actions = [...new Set([...Object.keys(ACTION_LABEL), ...audit.rows.map((r) => r.action)])];
    keep('f-action', actions.map((a) => [a, actionLabel(a)]));
    audit.page = 0;
    renderAuditRows();
  }

  // ---- routing ----------------------------------------------------------------------------
  function show(view) {
    for (const v of ['list', 'detail', 'teachers', 'audit']) $(`view-${v}`).hidden = v !== view;
    for (const a of document.querySelectorAll('.tabbar .tab[data-view]')) {
      const on = a.dataset.view === (view === 'detail' ? 'list' : view);
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    const titles = { list: '아이 목록', detail: '아이 상세', teachers: '선생님 관리', audit: '활동 기록' };
    document.title = `${titles[view]} - 읽기 시선 기록`;
  }

  function route() {
    if (!me) return;
    const hash = location.hash.replace(/^#\/?/, '');
    const isAdmin = me.role === 'admin';
    const m = /^child\/(\d+)(?:\/(trend|share))?$/.exec(hash);
    if (m) {
      const child = children.find((c) => c.id === Number(m[1]));
      if (child) { show('detail'); return renderDetail(child, m[2]); }
    }
    if (hash === 'teachers' && isAdmin) { show('teachers'); return renderTeachers(); }
    if (hash === 'audit' && isAdmin) { show('audit'); return renderAudit(); }
    show('list');
    renderList();
    // Opened from the academy's student page and that child exists: go straight to its detail.
    if (studentId && !studentOpened) {
      studentOpened = true;
      const own = children.filter((c) => c.externalStudentId === studentId);
      if (own.length === 1) openChild(own[0].id);
    }
  }

  // ---- forms and page chrome --------------------------------------------------------------
  function setAddError(text) {
    const input = $('add-code');
    const help = $('add-code-help');
    input.setAttribute('aria-invalid', text ? 'true' : 'false');
    help.textContent = text ? `! ${text}` : '예: E-0312';
    help.classList.toggle('error-text', Boolean(text));
  }
  const openAdd = () => { $('add-card').hidden = false; setAddError(''); $('add-code').focus(); };
  $('add-open').addEventListener('click', openAdd);
  $('empty-add').addEventListener('click', openAdd);
  $('add-cancel').addEventListener('click', () => { $('add-form').reset(); $('add-card').hidden = true; setAddError(''); });

  $('add-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showMsg('');
    const code = $('add-code').value.trim();
    const initials = $('add-initials').value.trim();
    if (!code) return setAddError('아이 코드를 입력하세요.');
    if (!initials) { setAddError(''); $('add-initials').focus(); return showMsg('이니셜을 입력하세요.'); }
    const consent = $('add-consent').value;
    const group = $('add-group').value.trim();
    const note = $('add-note').value;
    try {
      await api.post('/api/children', {
        code,
        initials,
        gradeBand: $('add-band').value,
        ...(consent ? { consentDate: consent } : {}),
        ...(group ? { group } : {}),
        ...(note.trim() ? { note } : {}),
      });
      $('add-form').reset();
      $('add-card').hidden = true;
      setAddError('');
      toast(`${code}을(를) 추가했습니다`);
      await load();
    } catch (err) {
      if (err.status === 409) { setAddError('이미 사용 중인 코드입니다. 다른 코드를 입력하세요.'); $('add-code').focus(); } else showMsg(err.message);
    }
  });

  // Registers the academy student as a child: code, initials, grade band and consent date only
  // (never the student's real name), linked by the student number.
  $('link-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showMsg('');
    const consent = $('link-consent').value;
    try {
      await api.post('/api/children', {
        code: $('link-code').value.trim(),
        initials: $('link-initials').value.trim(),
        gradeBand: $('link-band').value,
        externalStudentId: studentId,
        ...(consent ? { consentDate: consent } : {}),
      });
      studentOpened = false;
      await load();
    } catch (err) {
      showMsg(err.message === 'code already in use' ? '이미 사용 중인 코드입니다.' : err.message); // 409 may also be "이미 등록된 학생입니다"
    }
  });
  $('student-all').addEventListener('click', () => { studentId = null; renderList(); });

  $('search').addEventListener('input', () => { list.query = $('search').value; list.page = 0; renderList(); });
  $('missing-only').addEventListener('change', () => { list.missingOnly = $('missing-only').checked; list.page = 0; renderList(); });
  $('prev').addEventListener('click', () => { list.page -= 1; renderList(); });
  $('next').addEventListener('click', () => { list.page += 1; renderList(); });

  for (const id of ['f-actor', 'f-action', 'f-from', 'f-to']) $(id).addEventListener('change', () => { audit.page = 0; renderAuditRows(); });
  $('f-reset').addEventListener('click', () => {
    for (const id of ['f-actor', 'f-action', 'f-from', 'f-to']) $(id).value = '';
    audit.page = 0;
    renderAuditRows();
  });
  $('audit-prev').addEventListener('click', () => { audit.page -= 1; renderAuditRows(); });
  $('audit-next').addEventListener('click', () => { audit.page += 1; renderAuditRows(); });

  // Legacy invites (ALLOW_PASSWORD_LOGIN=1 only).
  $('invite-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showMsg('');
    try {
      const { token } = await api.post('/api/admin/invites', { email: $('invite-email').value });
      $('invite-link').value = `${location.origin}/invite.html?token=${encodeURIComponent(token)}`;
      $('invite-result').hidden = false;
    } catch (err) {
      showMsg(err.status === 409 ? '이미 계정이 있는 이메일입니다.' : err.message);
    }
  });
  $('invite-copy').addEventListener('click', () => copyLink($('invite-link').value, $('invite-link')));

  $('logout').addEventListener('click', async () => {
    try { await api.post('/api/logout', {}, { noRedirect: true }); } catch { /* leaving anyway */ }
    location.href = '/academy';
  });

  window.addEventListener('hashchange', () => { showMsg(''); route(); });

  (async function init() {
    renderLoadingRows();
    try { me = await api.get('/api/me'); } catch { return; } // 401 already redirected to the front page
    if (me.role === 'student') { location.replace(`/read.html?child=${me.child.id}`); return; }
    $('who').textContent = me.role === 'admin' ? '원장 · 관리자' : '선생님';
    if (me.role !== 'admin' && me.launchStudentId) studentId = me.launchStudentId;
    canLink = studentId !== null && (me.role === 'admin' || me.launchStudentId === studentId);
    for (const a of document.querySelectorAll('.tabbar .tab[data-view="teachers"], .tabbar .tab[data-view="audit"]')) a.hidden = me.role !== 'admin';
    // Invites are a legacy password flow (ALLOW_PASSWORD_LOGIN=1 only).
    $('admin-card').hidden = !(me.role === 'admin' && me.passwordLogin);
    await load();
  })();
})();
