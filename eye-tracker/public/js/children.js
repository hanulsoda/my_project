'use strict';
// Teacher / director screens (design D2 v2, "다힘 스킨"): child list with the four summary tiles,
// child detail (trend + records on the left, share links on the right), and for the director the
// account list and the activity log. Views are chosen by the address hash: "" list,
// "#child/<id>[/trend|/share]", "#teachers", "#audit". The site header comes from site-header.js.
// All server data reaches the page through h()/textContent, never as HTML.
(function () {
  const {
    api, h, copyText, sessionSummary, GRADE_LABEL, icon, siteHeader,
    sessionState, sessionStats, latestSummary, groupChips, filterChildren, paginate, pageCaption,
    shareStatus, maskToken, accountLabel, ROLE_LABEL, actionLabel, ACTION_LABEL, filterAudit, fmtKst,
    summaryTiles, lastMeasuredAt, fmtWeekStart, agoLabel, isStale, trendPlot,
  } = window.ReadingApp;
  const $ = (id) => document.getElementById(id);
  const KIND_LABEL = { reference: '기준 지문', new: '새 지문' };
  const PAGE_SIZE = 20;
  const AUDIT_PAGE = 20;
  const RECORDS_FIRST = 3;
  const SUB = {
    list: '아이가 글을 읽는 동안 눈이 어디를 따라가는지 기록해요. 선별 지표이며 진단이 아니에요.',
    teachers: '아이가 글을 읽는 동안 눈이 어디를 따라가는지 기록해요. 선별 지표이며 진단이 아니에요.',
    audit: '최근 활동을 500건까지 보여요. 시각은 한국 표준시예요.',
  };

  let me = null;
  let children = [];
  const sessionsCache = new Map(); // child id -> Promise<sessions>, for "최근 측정" and the tiles
  const lastBy = new Map(); // child id -> newest startedAt (null = none), filled as the lists arrive
  let lastFailed = false;
  const list = { query: '', group: null, missingOnly: false, staleOnly: false, page: 0 };
  // ?student=0123: opened from the academy's student page ("측정" button). Shows that student's
  // child, or the form to register them. A teacher may register only the student number its
  // session was launched for (me.launchStudentId, from the signed token), which then wins over
  // the address bar; the director may use the address bar's number. Digits only, as on the server.
  const studentParam = new URLSearchParams(location.search).get('student');
  let studentId = /^\d{4,12}$/.test(studentParam || '') ? studentParam : null;
  let canLink = false;
  let studentOpened = false;

  siteHeader.mount('site-header', { crumb: '아이 목록' });

  // ---- small shared pieces ----------------------------------------------------------------
  function showMsg(text) {
    $('msg-text').textContent = text || '';
    $('msg').hidden = !text;
  }
  const fail = (err) => showMsg(err.message || '문제가 생겼어요.');
  const reportUrl = (token) => `${location.origin}/report.html?token=${encodeURIComponent(token)}`;

  let toastTimer = null;
  function toast(text, kind = 'success') {
    const t = $('toast');
    t.className = `toast ${kind}`;
    t.replaceChildren(h('span', { class: 'toast-icon', 'aria-hidden': 'true' }, kind === 'danger' ? '!' : '✓'), h('span', {}, text));
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  // Confirm dialog (focus starts on 취소, Esc closes, focus returns to the button that opened it).
  // items: what goes away, shown in the "지워지는 것" box. Resolves true only for the confirming button.
  function confirmDialog({ title, body, ok, items }) {
    const dlg = $('confirm');
    const opener = document.activeElement;
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('confirm-ok').textContent = ok;
    $('confirm-items').textContent = items || '';
    $('confirm-list').hidden = !items;
    return new Promise((resolve) => {
      const done = (value) => {
        $('confirm-ok').removeEventListener('click', yes);
        $('confirm-cancel').removeEventListener('click', no);
        dlg.removeEventListener('close', no);
        if (dlg.open) dlg.close();
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
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

  const chip = (kind, text) => h('span', { class: kind ? `dh-status-chip is-${kind}` : 'dh-status-chip' }, text);
  const tag = (kind, text) => h('span', { class: kind ? `cd-tag is-${kind}` : 'cd-tag' }, text);
  const consentChip = (c) => (c.consentDate ? chip('ok', '동의 기록됨') : chip('danger', '동의 기록 필요'));
  const stateTag = (state) => (state === 'reliable' ? tag('ok', '신뢰') : state === 'legacy' ? null : tag('warn', '참고용'));
  const btn = (cls, text, attrs = {}) => h('button', { type: 'button', class: `cd-btn ${cls}`.trim(), ...attrs }, text);

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
      if (ok) return toast('링크를 복사했어요');
      if (input) input.select();
      toast('자동 복사가 막혀 있어요. 주소를 직접 복사해 주세요.', 'danger');
    });
  }

  // ---- child list: summary tiles ----------------------------------------------------------
  // The list API has no measurement dates, so every child's session list is read once per load
  // (the same requests the "최근 측정" column needs) and the tiles are counted here.
  function loadLastMeasured() {
    lastBy.clear();
    lastFailed = false;
    const token = loadToken;
    return Promise.all(children.map((c) => getSessions(c.id).then((s) => {
      if (token === loadToken) lastBy.set(c.id, lastMeasuredAt(s));
    }, () => { lastFailed = true; }))).then(() => { if (token === loadToken && !$('view-list').hidden) renderList(); });
  }

  function tile({ label, value, caption, warn, link }) {
    const n = value === null ? (lastFailed ? '—' : '…') : value;
    return h('div', { class: warn ? 't-tile is-warn' : 't-tile' },
      h('p', { class: 't-tile-label' }, warn ? icon('warn', 14) : null, label),
      h('p', { class: 't-tile-value' }, h('b', {}, n), h('span', {}, '명')),
      h('p', { class: 't-tile-cap' }, caption),
      link || null);
  }

  function renderTiles() {
    const t = summaryTiles(children, lastBy, Date.now());
    const groupsText = t.groups ? `그룹 ${t.groups}개${t.noGroup ? ` · 그룹 없음 ${t.noGroup}명` : ''}` : '그룹 없음';
    const needN = t.needConsent.length;
    const staleN = t.stale === null ? null : t.stale.length;
    const seeLink = (n, on, onClick) => {
      const b = h('button', { type: 'button', class: 't-tile-link', 'aria-pressed': on ? 'true' : 'false' },
        on ? '모두 보기' : n === 1 ? '이 아이만 보기' : '이 아이들만 보기');
      b.addEventListener('click', onClick);
      return b;
    };
    $('tiles').replaceChildren(
      tile({ label: '등록 아이', value: t.total, caption: groupsText }),
      tile({ label: '이번 주 측정한 아이', value: t.measuredThisWeek, caption: fmtWeekStart(t.weekStart) }),
      tile({
        label: '동의 기록이 필요한 아이', value: needN, warn: needN > 0,
        caption: needN ? '동의일을 적어야 측정할 수 있어요' : '모든 아이의 동의가 기록돼 있어요',
        link: needN ? seeLink(needN, list.missingOnly, () => {
          list.missingOnly = !list.missingOnly; $('missing-only').checked = list.missingOnly; list.page = 0; renderList();
        }) : null,
      }),
      tile({
        label: '오래 측정 안 한 아이', value: staleN, warn: Boolean(staleN),
        caption: lastFailed ? '측정 기록을 다 불러오지 못했어요' : '30일 넘게 측정이 없거나 아직 측정 전',
        link: staleN ? seeLink(staleN, list.staleOnly, () => { list.staleOnly = !list.staleOnly; list.page = 0; renderList(); }) : null,
      }));
    return t;
  }

  // ---- child list: table --------------------------------------------------------------------
  function recentCell(child, cell) {
    if (!child.consentDate) {
      cell.replaceChildren(h('span', { class: 't-warn-text' }, '동의일을 적으면 측정할 수 있어요'));
      return;
    }
    cell.replaceChildren(h('span', { class: 'skeleton-line w60', 'aria-label': '불러오는 중' }));
    getSessions(child.id).then((sessions) => {
      const now = Date.now();
      const sum = latestSummary(sessions);
      if (!sum) {
        return cell.replaceChildren(h('div', { class: 't-recent-line' }, h('span', { class: 'cd-muted-2' }, '아직 측정 전이에요')),
          h('div', { class: 't-recent-line' }, tag('warn', '오래됨')));
      }
      const old = isStale(sum.startedAt, now);
      cell.replaceChildren(
        h('div', { class: 't-recent-line' }, h('span', { class: 't-recent-date' }, fmtKst(sum.startedAt, false)), h('span', { class: 't-ago' }, agoLabel(sum.startedAt, now))),
        h('div', { class: 't-recent-line' }, old ? tag('warn', '오래됨') : stateTag(sum.state), h('span', {}, sum.text)));
    }, () => cell.replaceChildren(h('span', { class: 'cd-muted-2' }, '불러오지 못했어요')));
  }

  function childRow(child) {
    const recent = h('td', { class: 'cell-recent' });
    recentCell(child, recent);
    const consent = h('td', { class: 'cell-consent' }, consentChip(child));
    if (!child.consentDate) {
      const enter = btn('is-soft', '동의일 입력', { 'aria-label': `${child.code} 동의일 입력` });
      enter.addEventListener('click', () => openChild(child.id, { focusConsent: true }));
      consent.append(enter);
    }
    const view = btn('', '열기', { 'aria-label': `${child.code} 열기` });
    view.addEventListener('click', () => openChild(child.id));
    const del = btn('is-text danger', '삭제', { 'aria-label': `${child.code} 삭제` });
    del.addEventListener('click', () => deleteChild(child));
    const band = GRADE_LABEL[child.gradeBand] || child.gradeBand;
    return h('tr', { class: child.consentDate ? null : 'row-warn' },
      h('th', { scope: 'row', class: 'cell-code' }, h('span', { class: 'cd-who' }, child.code), h('span', { class: 't-inline-initials' }, child.initials)),
      h('td', { class: 'cell-initials col-wide' }, child.initials),
      h('td', { class: 'cell-band' }, band, h('span', { class: child.group ? 't-inline-group' : 't-inline-group cd-muted-2' }, child.group || '그룹 없음')),
      h('td', { class: child.group ? 'col-wide' : 'col-wide cd-muted-2' }, child.group || '그룹 없음'),
      consent, recent,
      h('td', {}, h('div', { class: 'cell-actions' }, view, del)));
  }

  async function deleteChild(child) {
    let count = null;
    try { count = (await getSessions(child.id)).length; } catch { /* the warning below still applies */ }
    const what = count === null ? '모든 측정 기록과' : `측정 기록 ${count}건과`;
    const ok = await confirmDialog({
      title: `${child.code} 아이를 삭제할까요?`,
      body: `이 아이(${child.code} · ${child.initials})의 ${what} 보호자 보고서 링크가 모두 영구 삭제되며 되돌릴 수 없어요.`,
      items: `${count === null ? '측정 기록 전부' : `측정 기록 ${count}건`} · 보고서 링크 전부 · 메모`,
      ok: '삭제',
    });
    if (!ok) return;
    showMsg('');
    try {
      await api.del(`/api/children/${child.id}`);
      toast(`${child.code}을(를) 삭제했어요`);
      if (location.hash.startsWith('#child/')) location.hash = '';
      await load();
    } catch (err) { fail(err); }
  }

  function renderChips() {
    const chips = groupChips(children);
    if (!chips.some((c) => c.key === list.group)) list.group = null;
    $('chips').replaceChildren(...chips.map((c) => {
      const on = c.key === list.group;
      const b = h('button', { type: 'button', class: on ? 't-chip on' : 't-chip', 'aria-pressed': on ? 'true' : 'false' },
        on ? icon('check', 14) : null, h('span', { class: 'chip-label' }, c.label), h('span', { class: 'chip-count' }, c.count));
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
    const none = children.length === 0;
    const starting = none && !studentId;
    $('start').hidden = !starting;
    $('list-actions').hidden = none;
    for (const id of ['tiles', 'filters', 'table-box']) $(id).hidden = starting;
    if (starting) { $('stale-note').hidden = true; return; }

    const t = renderTiles();
    renderChips();
    if (list.staleOnly && t.stale === null) list.staleOnly = false;
    const onlyIds = list.staleOnly ? new Set(t.stale) : null;
    $('stale-note').hidden = !list.staleOnly;
    if (list.staleOnly) $('stale-note-text').textContent = `오래 측정 안 한 아이 ${t.stale.length}명만 보고 있어요.`;

    const shown = filterChildren(source, { ...list, onlyIds });
    const pg = paginate(shown, list.page, PAGE_SIZE);
    list.page = pg.page;
    $('children').replaceChildren(...pg.items.map(childRow));
    const empty = shown.length === 0;
    $('empty').hidden = !empty;
    $('child-table').hidden = empty;
    $('empty-title').textContent = studentId && source.length === 0 ? '이 학생은 아직 측정 대상으로 등록되지 않았어요' : '조건에 맞는 아이가 없어요';
    $('empty-body').textContent = studentId && source.length === 0 ? '위 "다힘 학생" 칸에서 등록하거나 "전체 아이 보기"를 눌러 주세요.'
      : '찾는 말이나 그룹, "동의 기록이 필요한 아이만"을 바꿔 보세요.';
    $('page-caption').textContent = pageCaption(pg);
    $('prev').disabled = pg.page === 0;
    $('next').disabled = pg.page >= pg.pages - 1;
    $('table-foot').hidden = empty;
  }

  function renderLoadingRows() {
    $('children').replaceChildren(...Array.from({ length: 5 }, () => h('tr', { class: 'row-skeleton', 'aria-hidden': 'true' },
      ...Array.from({ length: 7 }, (_, k) => h('td', { class: k === 1 || k === 3 ? 'col-wide' : null }, h('span', { class: 'skeleton-line' }))))));
    $('tiles').replaceChildren(h('div', { class: 't-tile' }, h('span', { class: 'skeleton-line w60' })));
    $('page-caption').textContent = '불러오는 중…';
    $('prev').disabled = true;
    $('next').disabled = true;
    show('list');
  }

  let loadToken = 0;
  async function load() {
    sessionsCache.clear();
    loadToken += 1;
    try { children = await api.get('/api/children'); } catch (err) { return fail(err); }
    loadLastMeasured();
    route();
  }

  // ---- child detail -----------------------------------------------------------------------
  function openChild(id, opts = {}) {
    detailOpts = opts;
    if (location.hash === `#child/${id}`) route();
    else location.hash = `child/${id}`;
  }
  let detailOpts = {};
  let detailCtx = null; // passage titles and the share-panel opener of the child on screen
  let detailToken = 0;

  function infoItem(label, ...content) {
    return h('div', { class: 't-info-item' }, h('span', { class: 't-info-label' }, label), h('div', { class: 't-info-value' }, ...content));
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

  // An inline editor: shows the value with an edit button, or an input with 저장/취소.
  function editable({ label, value, input, editLabel, save }) {
    const box = h('div', { class: 't-info-edit' });
    const showView = () => {
      const edit = btn('is-text', editLabel);
      edit.addEventListener('click', showEdit);
      box.replaceChildren(h('span', { class: value ? 't-info-text' : 't-info-text cd-muted-2' }, value || '없음'), edit);
    };
    function showEdit() {
      const el = input();
      const ok = btn('is-primary', '저장');
      const cancel = btn('is-text', '취소');
      ok.addEventListener('click', () => save(el.value));
      cancel.addEventListener('click', showView);
      box.replaceChildren(el, ok, cancel);
      el.focus();
    }
    showView();
    return infoItem(label, box);
  }

  function consentEditor(child, focus) {
    const box = h('div', { class: 't-info-edit' });
    const dateInput = () => h('input', { type: 'date', class: 'cd-input t-date', value: child.consentDate || '', 'aria-label': '보호자 서면 동의일' });
    const save = async (v) => {
      if (!v) return showMsg('동의일을 입력해 주세요.');
      await patchChild(child, { consentDate: v }, '동의일을 저장했어요');
    };
    if (!child.consentDate) {
      const input = dateInput();
      const ok = btn('is-primary', '동의일 저장');
      ok.addEventListener('click', () => save(input.value));
      box.append(consentChip(child), input, ok);
      if (focus) setTimeout(() => input.focus(), 0);
    } else {
      const edit = btn('is-text', '수정');
      const clear = btn('is-text danger', '지우기');
      edit.addEventListener('click', () => {
        const input = dateInput();
        const ok = btn('is-primary', '저장');
        ok.addEventListener('click', () => save(input.value));
        box.replaceChildren(input, ok);
        input.focus();
      });
      clear.addEventListener('click', async () => {
        const yes = await confirmDialog({
          title: '동의 기록을 지울까요?',
          body: '동의 기록을 지우면 다시 입력하기 전까지 이 아이는 측정할 수 없어요. 지난 기록은 그대로 남아요.',
          ok: '지우기',
        });
        if (yes) await patchChild(child, { consentDate: null }, '동의 기록을 지웠어요');
      });
      box.append(chip('ok', `동의 기록됨 · ${child.consentDate}`), edit, clear);
    }
    return infoItem('보호자 서면 동의', box);
  }

  // ---- one record ---------------------------------------------------------------------------
  function noteRow(s) {
    const row = h('div', { class: 't-note-row' });
    const show = () => {
      const edit = btn('is-text', s.note ? '메모 수정' : '메모 추가');
      edit.addEventListener('click', () => {
        const input = h('input', { value: s.note || '', maxlength: 500, 'aria-label': '측정 메모', class: 'cd-input' });
        const ok = btn('is-primary', '저장');
        const cancel = btn('is-text', '취소');
        ok.addEventListener('click', async () => {
          try {
            const res = await api.patch(`/api/sessions/${s.id}`, { note: input.value });
            s.note = res.note;
            toast('메모를 저장했어요');
            show();
          } catch (err) { fail(err); }
        });
        cancel.addEventListener('click', show);
        row.replaceChildren(h('span', { class: 't-note-label' }, '메모'), input, ok, cancel);
        input.focus();
      });
      row.replaceChildren(h('span', { class: 't-note-label' }, '메모'),
        h('span', { class: s.note ? 't-note-text' : 't-note-text cd-muted-2' }, s.note || '메모가 없어요.'), edit);
    };
    show();
    return row;
  }

  function sessionBody(m) {
    const state = sessionState(m);
    if (state === 'reliable') {
      return h('div', { class: 't-stat-row' }, sessionStats(m).map((st) => h('div', { class: 't-stat' },
        h('span', { class: 't-stat-label' }, st.label),
        h('span', { class: 't-stat-value' }, st.value, st.unit ? h('span', { class: 't-stat-unit' }, st.unit) : null))));
    }
    if (state === 'legacy') return h('p', { class: 't-legacy' }, sessionSummary(m).text);
    const text = state === 'failed'
      ? '측정이 제대로 되지 않아 수치가 없어요. 같은 지문으로 다시 측정해 보세요.'
      : '측정 상태가 안정적이지 않아 수치를 보여 주지 않아요. 같은 지문으로 다시 측정해 보세요.';
    return h('div', { class: 'cd-note' }, icon('warn', 15), h('span', {}, text));
  }

  const recordTags = (s) => h('span', { class: 't-record-tags' }, tag('info', KIND_LABEL[s.kind] || s.kind), stateTag(sessionState(s.metrics)));

  // onReanalyzed: called after a successful "다시 분석" (the child's trend is rebuilt).
  function sessionRow(s, onReanalyzed) {
    const ctx = detailCtx;
    let body = sessionBody(s.metrics);
    let badges = recordTags(s);
    const redo = btn('', '다시 분석', { title: '저장된 시선 기록을 지금의 분석 방법으로 다시 계산해요' });
    const report = btn('is-soft', '보고서 링크');
    report.addEventListener('click', () => ctx.showShare(s.id));
    redo.addEventListener('click', async () => {
      showMsg('');
      redo.disabled = true;
      redo.textContent = '분석 중…';
      const waiting = h('div', { class: 'analyzing' }, h('p', { class: 'dh-ph-sub' }, '줄 단위 지표를 다시 계산하고 있어요. 잠시만 기다려 주세요.'),
        h('span', { class: 'skeleton-line w60' }), h('span', { class: 'skeleton-line w50' }), h('span', { class: 'skeleton-line w40' }));
      body.replaceWith(waiting);
      body = waiting;
      try {
        const res = await api.post(`/api/sessions/${s.id}/reanalyze`);
        s.metrics = res.metrics;
        if (onReanalyzed) await onReanalyzed();
        redo.textContent = '다시 분석됨';
        toast('다시 분석했어요');
      } catch (err) {
        redo.textContent = '다시 분석';
        fail(err);
      } finally {
        const fresh = sessionBody(s.metrics);
        body.replaceWith(fresh);
        body = fresh;
        const freshBadges = recordTags(s);
        badges.replaceWith(freshBadges);
        badges = freshBadges;
        redo.disabled = false;
      }
    });
    const title = ctx.titles.get(s.passageId);
    return h('article', { class: 't-record' },
      h('div', { class: 't-record-head' },
        h('div', { class: 't-record-title' },
          h('h3', { class: 't-record-time' }, fmtKst(s.startedAt)),
          h('span', { class: 't-record-passage' }, title ? `지문 『${title}』` : '지문'), badges),
        h('div', { class: 't-record-actions' }, redo, report)),
      body,
      noteRow(s));
  }

  // ---- share links ------------------------------------------------------------------------
  const untilText = (ms) => { const [, m, d] = fmtKst(ms, false).split('-'); return `${Number(m)}월 ${Number(d)}일까지`; };

  async function renderShares(session, box) {
    let shares;
    box.replaceChildren(h('span', { class: 'skeleton-line w60' }));
    try { shares = await api.get(`/api/sessions/${session.id}/shares`); } catch (err) { return fail(err); }
    const now = Date.now();
    if (!shares.length) {
      box.replaceChildren(h('p', { class: 't-share-none' }, '이 측정으로 만든 링크가 아직 없어요.'));
      return;
    }
    box.replaceChildren(...shares.map((s) => {
      const st = shareStatus(s, now);
      const active = st.key === 'active';
      const head = h('div', { class: 't-link-head' },
        chip(active ? 'ok' : null, st.label),
        h('span', { class: 't-link-when' }, active ? untilText(s.expiresAt) : st.key === 'revoked' ? '취소한 링크' : `${fmtKst(s.expiresAt, false)} 만료`));
      const url = h('p', { class: active ? 't-link-url' : 't-link-url struck' }, maskToken(s.token));
      if (!active) return h('div', { class: 't-link is-off' }, head, url);
      const copy = btn('', '복사');
      copy.prepend(icon('copy', 14));
      copy.addEventListener('click', () => copyLink(reportUrl(s.token)));
      const revoke = btn('is-text danger', '링크 취소');
      revoke.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: '이 링크를 취소할까요?',
          body: '받은 사람은 더 이상 보고서를 볼 수 없어요. 되돌릴 수 없어요.',
          ok: '링크 취소',
        });
        if (!ok) return;
        try {
          await api.del(`/api/share/${encodeURIComponent(s.token)}`);
          toast('링크를 취소했어요');
          await renderShares(session, box);
        } catch (err) { fail(err); }
      });
      return h('div', { class: 't-link' }, head, url, h('div', { class: 't-link-actions' }, copy, revoke));
    }));
  }

  function sharePanel(sessions, ctx) {
    const panel = h('section', { class: 'cd-panel t-share', id: 'share-panel', 'aria-labelledby': 'share-title' },
      h('h2', { id: 'share-title' }, '보호자 공유 링크'));
    if (!sessions.length) {
      panel.append(h('p', { class: 't-share-none' }, '측정 기록이 생기면 보호자 보고서 링크를 만들 수 있어요.'));
      return { panel, select() {} };
    }
    const label = (s) => {
      const st = sessionState(s.metrics);
      const title = ctx.titles.get(s.passageId);
      return `${fmtKst(s.startedAt)} · ${title || KIND_LABEL[s.kind] || s.kind} (${st === 'reliable' ? '신뢰' : st === 'legacy' ? '이전 분석' : '참고용'})`;
    };
    const newest = sessions.slice().reverse();
    const pick = h('select', { id: 'share-session', class: 'cd-input' }, newest.map((s) => h('option', { value: s.id }, label(s))));
    const listBox = h('div', { class: 't-links' });
    const daysName = 'share-days';
    const days = [7, 30, 90].map((d) => h('label', { class: 't-chip t-radio' },
      h('input', { type: 'radio', name: daysName, value: d, checked: d === 30 }), icon('check', 14), `${d}일`));
    const create = btn('is-primary lg t-create', '새 링크 만들기');
    create.prepend(icon('plus', 15));
    const current = () => sessions.find((s) => String(s.id) === pick.value);
    pick.addEventListener('change', () => renderShares(current(), listBox));
    create.addEventListener('click', async () => {
      showMsg('');
      const d = Number(panel.querySelector(`input[name="${daysName}"]:checked`).value);
      try {
        const made = await api.post(`/api/sessions/${current().id}/share`, { days: d });
        await renderShares(current(), listBox);
        if (await copyText(reportUrl(made.token))) toast('링크를 만들고 복사했어요');
        else toast('링크를 만들었어요. "복사"를 눌러 주세요.');
      } catch (err) { fail(err); }
    });
    panel.append(
      h('label', { class: 'cd-label t-share-label', for: 'share-session' }, '보낼 측정 기록'), pick,
      listBox,
      h('div', { class: 't-share-new' },
        h('p', { class: 'cd-label', id: 'share-days-label' }, '새 링크 · 열 수 있는 기간'),
        h('div', { class: 't-days', role: 'radiogroup', 'aria-labelledby': 'share-days-label' }, days),
        create,
        h('p', { class: 't-help' }, '보고서에는 아이 이니셜만 나오고 선생님 정보는 나오지 않아요. 기간이 지나면 열리지 않고, 언제든 취소할 수 있어요.')));
    let loaded = false;
    return {
      panel,
      select(id) {
        if (id !== undefined && id !== null) pick.value = String(id);
        else if (loaded) return;
        loaded = true;
        renderShares(current(), listBox);
      },
      focus() { pick.focus(); },
    };
  }

  // ---- trend ------------------------------------------------------------------------------
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // Reliable records only make the line; 참고용 records keep their date slot and say "참고용".
  function trendChart(points) {
    if (!points.length) return h('p', { class: 't-share-none' }, '기준 지문 기록이 아직 없어요. 기준 지문을 읽으면 여기에 추이가 보여요.');
    const p = trendPlot(points);
    const md = (ms) => fmtKst(ms, false).slice(5);
    const label = p.reliableCount
      ? `분당 읽은 어절 수 추이: 신뢰 기록 ${p.reliableCount}건, 처음 ${p.first}에서 최근 ${p.last}. 참고용 ${p.referenceCount}건은 수치 없음.`
      : `분당 읽은 어절 수 추이: 신뢰 기록이 없고 참고용 ${p.referenceCount}건이에요.`;
    const g = svg('svg', { viewBox: `0 0 ${p.width} ${p.height}`, class: 't-chart', role: 'img', 'aria-label': label });
    for (const t of p.ticks) {
      g.append(svg('line', { x1: p.left, x2: p.width - p.right + 10, y1: t.y, y2: t.y, class: 't-grid' }),
        svg('text', { x: p.left - 12, y: t.y + 4, 'text-anchor': 'end', class: 't-axis' }, t.v));
    }
    if (p.base) g.append(svg('line', { x1: p.left, x2: p.width - p.right + 10, y1: p.base.y, y2: p.base.y, class: 't-base' }));
    for (const it of p.items) {
      if (it.reliable) continue;
      g.append(svg('line', { x1: it.x, x2: it.x, y1: p.top - 6, y2: p.height - p.bottom, class: 't-ref-col' }),
        svg('text', { x: it.x, y: p.top - 10, 'text-anchor': 'middle', class: 't-ref-label' }, '참고용'));
    }
    if (p.line.includes(' ')) g.append(svg('polyline', { points: p.line, class: 't-line' }));
    const rel = p.items.filter((i) => i.reliable);
    for (const it of p.items) {
      g.append(svg('text', { x: it.x, y: p.height - 8, 'text-anchor': 'middle', class: it.reliable ? 't-axis t-axis-strong' : 't-axis' }, md(it.startedAt)));
      if (!it.reliable) continue;
      const lastDot = it === rel[rel.length - 1];
      const dot = svg('circle', { cx: it.x, cy: it.y, r: 4.5, class: lastDot ? 't-dot last' : 't-dot' });
      dot.append(svg('title', {}, `${md(it.startedAt)} · 분당 ${it.wpm}어절`));
      g.append(dot, svg('text', { x: it.x, y: it.y - 12, 'text-anchor': 'middle', class: 't-val' }, it.wpm));
    }
    return g;
  }

  function trendPanel(chartBox, trend) {
    const summary = h('div', { class: 't-trend-sum' });
    const foot = h('p', { class: 't-trend-foot' });
    const fill = (points) => {
      const p = trendPlot(points);
      summary.replaceChildren(...(p.reliableCount
        ? [h('span', {}, `처음 ${p.first} → 최근 ${p.last}어절`), tag('ok', `신뢰 기록 ${p.reliableCount}건`)]
        : points.length ? [tag('warn', '신뢰 기록 없음')] : []));
      const parts = [];
      if (p.referenceCount) parts.push(`참고용 기록 ${p.referenceCount}건은 수치가 없어 선에서 뺐어요.`);
      if (p.base) parts.push(`진한 점선은 처음 측정값(${p.base.v})이에요.`);
      foot.replaceChildren(icon('info', 14), h('span', {}, parts.join(' ') || '기준 지문을 읽을 때마다 점이 하나씩 늘어나요.'));
      foot.hidden = points.length === 0;
    };
    fill(trend);
    const panel = h('section', { class: 'cd-panel t-trend', id: 'trend-panel', 'aria-labelledby': 'trend-title' },
      h('div', { class: 't-panel-head' }, h('h2', { id: 'trend-title' }, '추이 · 분당 읽은 어절 수'), summary),
      chartBox, foot);
    return { panel, fill };
  }

  // rows: the record articles, newest first. The first three show; the rest open on request.
  function recordsPanel(rows, sessions, child) {
    const panel = h('section', { class: 'cd-panel t-records', 'aria-labelledby': 'records-title' },
      h('div', { class: 't-panel-head' }, h('h2', { id: 'records-title' }, `측정 기록 ${sessions.length}건`), sessions.length ? h('span', { class: 't-muted-sm' }, '최근 순') : null));
    if (!rows.length) {
      panel.append(h('div', { class: 't-records-empty' }, h('p', { class: 'cd-empty-title' }, '아직 측정 기록이 없어요'),
        h('p', { class: 'dh-ph-sub' }, child.consentDate ? '"측정 시작"을 눌러 첫 측정을 해 보세요.' : '보호자 서면 동의일을 적으면 측정할 수 있어요.')));
      return panel;
    }
    rows.forEach((r, k) => { r.hidden = k >= RECORDS_FIRST; });
    panel.append(...rows);
    if (rows.length > RECORDS_FIRST) {
      const more = btn('t-more', `이전 기록 ${rows.length - RECORDS_FIRST}건 더 보기`);
      more.prepend(icon('chevron', 14));
      more.addEventListener('click', () => {
        for (const r of rows) r.hidden = false;
        const next = rows[RECORDS_FIRST].querySelector('button');
        more.remove();
        if (next) next.focus();
      });
      panel.append(h('div', { class: 't-more-row' }, more));
    }
    return panel;
  }

  async function renderDetail(child, tab) {
    const box = $('view-detail');
    const ticket = ++detailToken;
    const opts = detailOpts;
    detailOpts = {};
    let sessions; let trend; let passages = [];
    box.replaceChildren(h('p', { class: 'dh-ph-sub' }, '불러오는 중…'));
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
    const chartBox = h('div', { class: 't-chart-box' }, trendChart(trend));
    const trendView = trendPanel(chartBox, trend);
    // Two reanalyses close together can answer out of order: only the latest request redraws.
    let trendTicket = 0;
    async function refreshTrend() {
      const ticket = ++trendTicket;
      try {
        const fresh = await api.get(`/api/children/${child.id}/trend`);
        if (ticket !== trendTicket) return;
        chartBox.replaceChildren(trendChart(fresh));
        trendView.fill(fresh);
      } catch (err) { if (ticket === trendTicket) fail(err); }
    }

    const ctx = {
      titles,
      showShare: (id) => {
        share.select(id);
        share.panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
        share.focus();
      },
    };
    detailCtx = ctx;
    const share = sharePanel(sessions, ctx);
    const rows = sessions.slice().reverse().map((s) => sessionRow(s, refreshTrend));
    const records = recordsPanel(rows, sessions, child);
    const band = GRADE_LABEL[child.gradeBand] || child.gradeBand;

    const note = h('span', { id: 'consent-note', class: 't-help' }, '보호자 서면 동의일을 먼저 적어야 측정할 수 있어요.');
    const start = child.consentDate
      ? h('a', { class: 'cd-btn is-primary lg', href: `/read.html?child=${child.id}` }, icon('eye', 16), '측정 시작')
      : h('button', { type: 'button', class: 'cd-btn is-primary lg', disabled: true, 'aria-describedby': note.id }, icon('eye', 16), '측정 시작');
    const back = h('a', { class: 't-back', href: '#' }, icon('back', 16), '아이 목록');
    const del = btn('is-danger lg', '아이 삭제');
    del.addEventListener('click', () => deleteChild(child));
    const last = sessions.length ? fmtKst(sessions[sessions.length - 1].startedAt, false) : null;
    const sub = [band, child.group || '그룹 없음', `측정 기록 ${sessions.length}건`, last ? `마지막 측정 ${last}` : '아직 측정 전'].join(' · ');

    const info = h('section', { class: 'cd-panel t-info', 'aria-label': '아이 정보' },
      infoItem('학년대', h('span', { class: 't-info-text' }, band)),
      editable({
        label: '그룹', value: child.group, editLabel: '바꾸기',
        input: () => h('input', { value: child.group || '', maxlength: 32, list: 'group-list', 'aria-label': '그룹', class: 'cd-input' }),
        save: (v) => patchChild(child, { group: v.trim() || null }, '그룹을 저장했어요'),
      }),
      consentEditor(child, opts.focusConsent),
      editable({
        label: '메모', value: child.note, editLabel: '메모 수정',
        input: () => h('input', { value: child.note || '', maxlength: 500, 'aria-label': '메모', class: 'cd-input' }),
        save: (v) => patchChild(child, { note: v }, '메모를 저장했어요'),
      }));

    box.replaceChildren(...[
      back,
      h('div', { class: 't-detail-head' },
        h('div', {}, h('h1', { class: 't-child-title' }, child.code, h('span', { class: 't-child-initials' }, child.initials)), h('p', { class: 'dh-ph-sub' }, sub)),
        h('div', { class: 'dh-ph-actions' }, del, start)),
      child.consentDate ? null : h('div', { class: 'cd-note t-banner' }, icon('warn', 15),
        h('div', {}, h('strong', {}, '보호자 서면 동의일이 없어 측정할 수 없어요. '),
          h('span', {}, '종이 동의서를 받은 날짜를 아래 "보호자 서면 동의"에 적으면 "측정 시작"을 누를 수 있어요. 지난 기록은 그대로 볼 수 있어요. '), note)),
      info,
      h('div', { class: 't-detail-grid' },
        h('div', { class: 't-detail-main' }, trendView.panel, records),
        h('aside', { class: 't-detail-side', 'aria-label': '보호자 공유' }, share.panel,
          h('div', { class: 'cd-msg' }, icon('info', 15),
            h('span', {}, '보호자 보고서에도 ‘선별 지표이며 진단이 아닙니다’가 함께 나가요. 수치만 보고 결론 내리지 않도록 상담 때 같이 설명해 주세요.'))))].filter(Boolean));
    back.addEventListener('click', (e) => { e.preventDefault(); location.hash = ''; });
    siteHeader.setCrumb(child.code);
    share.select();
    if (tab === 'share') ctx.showShare(null);
    else if (tab === 'trend') trendView.panel.scrollIntoView({ block: 'start' });
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
    $('teachers-status').replaceChildren(chip('ok', `활성 ${active}명`), chip(null, `비활성 ${teachers.length - active}명`));
    $('teachers').replaceChildren(...teachers.map((t) => {
      const self = t.email === me.email;
      let action;
      if (self && !t.disabled) action = h('span', { class: 'cd-muted-2' }, '본인 계정은 바꿀 수 없어요');
      else {
        action = btn(t.disabled ? '' : 'is-danger', t.disabled ? '다시 활성화' : '비활성화', { 'aria-label': `${accountLabel(t)} ${t.disabled ? '다시 활성화' : '비활성화'}` });
        action.addEventListener('click', () => toggleTeacher(t));
      }
      return h('tr', { class: t.disabled ? 'row-dim' : null },
        h('th', { scope: 'row', class: 't-account' }, accountLabel(t), self ? ' (나)' : null),
        h('td', {}, tag(t.role === 'admin' ? 'info' : null, ROLE_LABEL[t.role] || t.role)),
        h('td', {}, t.disabled ? chip(null, '비활성') : chip('ok', '활성')),
        h('td', {}, `${t.childCount}명`),
        h('td', { class: 'nowrap' }, t.lastLoginAt ? fmtKst(t.lastLoginAt) : '—'),
        h('td', {}, action));
    }));
  }

  async function toggleTeacher(t) {
    $('teachers-msg').hidden = true;
    if (!t.disabled) {
      const ok = await confirmDialog({
        title: `${accountLabel(t)} 계정을 비활성화할까요?`,
        body: '비활성화하면 다힘 사이트에서도 읽기 시선 기록에 들어올 수 없어요. 아이와 기록은 그대로 남고, 언제든 다시 활성화할 수 있어요.',
        ok: '비활성화',
      });
      if (!ok) return;
    }
    try {
      await api.post(`/api/admin/teachers/${t.id}/${t.disabled ? 'enable' : 'disable'}`);
      toast(t.disabled ? '계정을 다시 활성화했어요' : '계정을 비활성화했어요');
      await renderTeachers();
    } catch (err) {
      $('teachers-msg-body').textContent = err.message;
      $('teachers-msg').hidden = false;
    }
  }

  // ---- director: activity log -------------------------------------------------------------
  const audit = { rows: [], page: 0 };
  const ACTION_TONE = {
    'teacher.disable': 'warn', 'child.reassign': 'warn', 'director.cross_write': 'warn',
    'share.revoke': 'danger', 'child.delete': 'danger', 'invite.revoke': 'danger',
    'share.create': 'info', 'teacher.enable': 'info', 'invite.create': 'info',
  };
  function auditTarget(target) {
    const m = /^(child|user|session|invite):(\d+)$/.exec(target || '');
    if (!m) return target || '—';
    const id = Number(m[2]);
    if (m[1] === 'child') { const c = children.find((x) => x.id === id); return c ? c.code : `아이 #${id} (삭제됨)`; }
    if (m[1] === 'user') return accountLabel(teachers.find((x) => x.id === id));
    if (m[1] === 'session') return `측정 #${id}`;
    return `초대 #${id}`;
  }
  // "update owner=user:3" -> "update · 담당: …"; other details as stored (never personal data).
  const auditDetail = (d) => (d ? d.replace(/owner=user:(\d+)/, (_, id) => `담당: ${accountLabel(teachers.find((x) => x.id === Number(id)))}`)
    .replace(/\bdays=(\d+)\b/, '$1일') : null);

  function renderAuditRows() {
    const f = { actor: $('f-actor').value, action: $('f-action').value, from: $('f-from').value, to: $('f-to').value };
    const shown = filterAudit(audit.rows, f);
    const pg = paginate(shown, audit.page, AUDIT_PAGE);
    audit.page = pg.page;
    $('audit').replaceChildren(...pg.items.map((r) => h('tr', {},
      h('td', { class: 'nowrap' }, fmtKst(r.at)),
      h('td', { class: 't-account' }, r.actorUserId === null ? '시스템' : accountLabel(teachers.find((t) => t.id === r.actorUserId))),
      h('td', {}, tag(ACTION_TONE[r.action] || null, actionLabel(r.action))),
      h('td', {}, auditTarget(r.target), r.detail ? h('span', { class: 'cd-muted-2' }, ` · ${auditDetail(r.detail)}`) : null))));
    $('audit-empty').hidden = shown.length > 0;
    $('audit-table').hidden = shown.length === 0;
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
  const TITLES = { list: '아이 목록', detail: '아이 상세', teachers: '선생님 관리', audit: '활동 기록' };
  function show(view) {
    for (const v of ['list', 'detail', 'teachers', 'audit']) $(`view-${v}`).hidden = v !== view;
    $('page-head').hidden = view === 'detail';
    $('list-actions').hidden = view !== 'list' || children.length === 0;
    if (SUB[view]) $('page-sub').textContent = SUB[view];
    for (const a of document.querySelectorAll('.dh-ph-tabs .tab[data-view]')) {
      const on = a.dataset.view === view;
      a.classList.toggle('on', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    siteHeader.setCrumb(TITLES[view]);
    document.title = `${TITLES[view]} - 읽기 시선 기록`;
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
    if (!code) return setAddError('아이 코드를 입력해 주세요.');
    if (!initials) { setAddError(''); $('add-initials').focus(); return showMsg('이니셜을 입력해 주세요.'); }
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
      toast(`${code}을(를) 추가했어요`);
      await load();
    } catch (err) {
      if (err.status === 409) { setAddError('이미 쓰고 있는 코드예요. 다른 코드를 입력해 주세요.'); $('add-code').focus(); } else showMsg(err.message);
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
      showMsg(err.message === 'code already in use' ? '이미 쓰고 있는 코드예요.' : err.message); // 409 may also be "이미 등록된 학생입니다"
    }
  });
  $('student-all').addEventListener('click', () => { studentId = null; renderList(); });

  $('search').addEventListener('input', () => { list.query = $('search').value; list.page = 0; renderList(); });
  $('missing-only').addEventListener('change', () => { list.missingOnly = $('missing-only').checked; list.page = 0; renderList(); });
  $('stale-clear').addEventListener('click', () => { list.staleOnly = false; list.page = 0; renderList(); });
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
      showMsg(err.status === 409 ? '이미 계정이 있는 이메일이에요.' : err.message);
    }
  });
  $('invite-copy').addEventListener('click', () => copyLink($('invite-link').value, $('invite-link')));

  window.addEventListener('hashchange', () => { showMsg(''); route(); });

  (async function init() {
    renderLoadingRows();
    try { me = await api.get('/api/me'); } catch { return; } // 401 already redirected to the front page
    if (me.role === 'student') { location.replace(`/read.html?child=${me.child.id}`); return; }
    siteHeader.setRole(me.role);
    if (me.role !== 'admin' && me.launchStudentId) studentId = me.launchStudentId;
    canLink = studentId !== null && (me.role === 'admin' || me.launchStudentId === studentId);
    for (const a of document.querySelectorAll('.dh-ph-tabs .tab[data-view="teachers"], .dh-ph-tabs .tab[data-view="audit"]')) a.hidden = me.role !== 'admin';
    // Invites are a legacy password flow (ALLOW_PASSWORD_LOGIN=1 only).
    $('admin-card').hidden = !(me.role === 'admin' && me.passwordLogin);
    await load();
  })();
})();
