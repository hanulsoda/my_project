'use strict';
// Teacher screen: children, consent, sessions, trend, share links.
// All server data reaches the page through h()/textContent, never as HTML.
(function () {
  const { api, h, copyText, trendChart, sessionSummary, GRADE_LABEL } = window.ReadingApp;
  const $ = (id) => document.getElementById(id);
  const KIND_LABEL = { reference: '기준 지문', new: '새 지문' };

  let children = [];
  let openChildId = null;
  // ?student=0123: opened from the academy's student page ("측정" button). Shows that student's
  // child, or the form to register them. Only digits are accepted (same rule as the server).
  const studentParam = new URLSearchParams(location.search).get('student');
  const studentId = /^\d{4,12}$/.test(studentParam || '') ? studentParam : null;

  function showMsg(text) {
    $('msg').textContent = text || '';
    $('msg').hidden = !text;
  }
  const fail = (err) => showMsg(err.message || '문제가 생겼습니다.');
  const fmtDateTime = (ms) => new Date(ms).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  const fmtDate = (ms) => new Date(ms).toLocaleDateString('ko-KR');
  const reportUrl = (token) => `${location.origin}/report.html?token=${encodeURIComponent(token)}`;

  // Copy button: clipboard if allowed, otherwise select the field so Ctrl+C works.
  function copyButton(getInput) {
    const btn = h('button', { type: 'button', class: 'secondary' }, '복사');
    btn.addEventListener('click', async () => {
      const input = getInput();
      if (await copyText(input.value)) {
        btn.textContent = '복사됨';
        setTimeout(() => { btn.textContent = '복사'; }, 1500);
      } else {
        input.select();
        showMsg('자동 복사가 막혀 있습니다. 선택된 주소를 직접 복사해 주세요.');
      }
    });
    return btn;
  }

  function linkField(url) {
    const input = h('input', { class: 'link-input', readonly: true, value: url, 'aria-label': '리포트 링크' });
    return h('div', { class: 'row' }, input, copyButton(() => input));
  }

  // ---- shares for one session -------------------------------------------------------------
  async function renderShares(session, box, keep) {
    let shares;
    try { shares = await api.get(`/api/sessions/${session.id}/shares`); } catch (err) { return fail(err); }
    const days = h('select', { 'aria-label': '유효 기간' },
      [7, 30, 90].map((d) => h('option', { value: d, selected: d === 30 }, `${d}일`)));
    const fresh = h('div', {}, keep || []);
    const create = h('button', { type: 'button' }, '링크 만들기');
    create.addEventListener('click', async () => {
      showMsg('');
      try {
        const made = await api.post(`/api/sessions/${session.id}/share`, { days: Number(days.value) });
        await renderShares(session, box, [h('p', { class: 'ok' }, '링크가 만들어졌습니다.'), linkField(reportUrl(made.token))]);
      } catch (err) { fail(err); }
    });

    const now = Date.now();
    const list = h('ul', { class: 'plain' }, shares.map((s) => {
      const active = s.revokedAt === null && s.expiresAt > now;
      const status = s.revokedAt !== null ? '폐기됨' : s.expiresAt <= now ? '만료됨' : `${fmtDate(s.expiresAt)}까지`;
      const row = h('li', { class: 'row', style: 'margin-top:4px' }, h('span', { class: active ? 'badge' : 'badge warn' }, status));
      if (active) {
        const url = reportUrl(s.token);
        const input = h('input', { class: 'link-input', readonly: true, value: url, 'aria-label': '리포트 링크' });
        const revoke = h('button', { type: 'button', class: 'danger' }, '폐기');
        revoke.addEventListener('click', async () => {
          if (!window.confirm('이 링크를 폐기할까요? 받은 사람은 더 이상 리포트를 볼 수 없습니다.')) return;
          try {
            await api.del(`/api/share/${encodeURIComponent(s.token)}`);
            await renderShares(session, box);
          } catch (err) { fail(err); }
        });
        row.append(input, copyButton(() => input), revoke);
      }
      return row;
    }));

    box.replaceChildren(
      h('div', { class: 'row' }, h('label', {}, '유효 기간', days), create),
      fresh,
      shares.length ? h('h3', {}, '만든 링크') : h('p', { class: 'muted' }, '아직 만든 링크가 없습니다.'),
      list,
    );
  }

  // ---- one session in the list ------------------------------------------------------------
  // The summary line is its own element so "다시 분석" can refresh it in place (the share box and
  // its open/closed state stay as they are).
  function sessionSummaryEl(metrics) {
    const summary = sessionSummary(metrics);
    return h('div', {},
      summary.badge ? h('span', { class: 'badge warn' }, '참고용') : null,
      h('div', { class: 'muted' }, summary.text));
  }

  // onReanalyzed: called after a successful "다시 분석" (the child's trend is rebuilt).
  function sessionRow(s, onReanalyzed) {
    let summaryEl = sessionSummaryEl(s.metrics);
    const shareBox = h('div', { class: 'share-row', hidden: true });
    const toggle = h('button', { type: 'button', class: 'secondary' }, '공유 링크');
    toggle.addEventListener('click', async () => {
      shareBox.hidden = !shareBox.hidden;
      if (!shareBox.hidden) await renderShares(s, shareBox);
    });
    const redo = h('button', { type: 'button', class: 'secondary', title: '저장된 시선 기록을 지금의 분석 방법으로 다시 계산합니다' }, '다시 분석');
    redo.addEventListener('click', async () => {
      showMsg('');
      redo.disabled = true;
      redo.textContent = '분석 중…';
      try {
        const res = await api.post(`/api/sessions/${s.id}/reanalyze`);
        s.metrics = res.metrics;
        const fresh = sessionSummaryEl(s.metrics);
        summaryEl.replaceWith(fresh);
        summaryEl = fresh;
        redo.textContent = '다시 분석됨';
        if (onReanalyzed) await onReanalyzed();
      } catch (err) {
        redo.textContent = '다시 분석';
        fail(err);
      } finally {
        redo.disabled = false;
      }
    });
    return h('li', { class: 'session' },
      h('div', { class: 'row spread' },
        h('div', {}, `${fmtDateTime(s.startedAt)} · ${KIND_LABEL[s.kind] || s.kind} `, summaryEl),
        h('div', { class: 'row' }, redo, toggle)),
      shareBox);
  }

  // ---- detail of one child ----------------------------------------------------------------
  async function renderDetail(child, box) {
    let sessions; let trend;
    try {
      [sessions, trend] = await Promise.all([
        api.get(`/api/children/${child.id}/sessions`),
        api.get(`/api/children/${child.id}/trend`),
      ]);
    } catch (err) { return fail(err); }

    // The chart sits in its own holder so a reanalysis can redraw it from the server's trend.
    const chartBox = h('div', {}, trendChart(trend));
    // Two reanalyses close together can answer out of order: only the latest request redraws.
    let trendTicket = 0;
    async function refreshTrend() {
      const ticket = ++trendTicket;
      try {
        const fresh = await api.get(`/api/children/${child.id}/trend`);
        if (ticket !== trendTicket) return;
        chartBox.replaceChildren(trendChart(fresh));
      } catch (err) { if (ticket === trendTicket) fail(err); }
    }
    const rows = sessions.slice().reverse().map((s) => sessionRow(s, refreshTrend));

    box.replaceChildren(
      h('h3', {}, '기준 지문 읽기 속도 추이 (WPM)'),
      chartBox,
      h('h3', {}, '측정 기록'),
      rows.length ? h('ul', { class: 'plain' }, rows) : h('p', { class: 'muted' }, '아직 측정 기록이 없습니다.'),
    );
  }

  // ---- child list -------------------------------------------------------------------------
  function childItem(child) {
    const hasConsent = Boolean(child.consentDate);
    const detail = h('div', { hidden: openChildId !== child.id });

    const consentInput = h('input', { type: 'date', value: child.consentDate || '', 'aria-label': '보호자 동의일' });
    const save = h('button', { type: 'button', class: 'secondary' }, hasConsent ? '동의일 수정' : '동의일 저장');
    save.addEventListener('click', async () => {
      if (!consentInput.value) return showMsg('동의일을 입력해 주세요.');
      await setConsent(child, consentInput.value);
    });
    const clear = hasConsent ? h('button', { type: 'button', class: 'secondary' }, '동의 철회') : null;
    if (clear) {
      clear.addEventListener('click', async () => {
        if (window.confirm('동의 기록을 지우면 다시 입력하기 전까지 측정할 수 없습니다. 계속할까요?')) await setConsent(child, null);
      });
    }

    const note = h('span', { id: `consent-note-${child.id}`, class: 'muted' }, '보호자 동의일을 먼저 입력해야 측정할 수 있습니다.');
    const start = hasConsent
      ? h('a', { class: 'btn', href: `/read.html?child=${child.id}` }, '측정 시작')
      : h('button', { type: 'button', disabled: true, 'aria-describedby': note.id }, '측정 시작');

    const toggle = h('button', { type: 'button', class: 'secondary' }, openChildId === child.id ? '기록 닫기' : '기록 보기');
    toggle.addEventListener('click', () => {
      openChildId = openChildId === child.id ? null : child.id;
      render(); // rebuilds the list; the open child's detail loads itself
    });

    const del = h('button', { type: 'button', class: 'danger' }, '삭제');
    del.addEventListener('click', async () => {
      const ok = window.confirm(`${child.code} (${child.initials})의 모든 측정 기록과 공유 링크가 영구 삭제됩니다. 되돌릴 수 없습니다. 삭제할까요?`);
      if (!ok) return;
      try {
        await api.del(`/api/children/${child.id}`);
        if (openChildId === child.id) openChildId = null;
        await load();
      } catch (err) { fail(err); }
    });

    const item = h('li', { class: 'child' },
      h('div', { class: 'row spread' },
        h('div', {},
          h('strong', {}, child.code), ` · ${child.initials} · ${GRADE_LABEL[child.gradeBand] || child.gradeBand} `,
          hasConsent ? h('span', { class: 'badge' }, `동의 ${child.consentDate}`) : h('span', { class: 'badge warn' }, '동의 없음')),
        h('div', { class: 'row' }, start, toggle, del)),
      hasConsent ? null : h('div', { style: 'margin-top:4px' }, note),
      h('div', { class: 'row', style: 'margin-top:8px' }, consentInput, save, clear),
      detail);
    if (openChildId === child.id) renderDetail(child, detail);
    return item;
  }

  function render() {
    let shown = children;
    if (studentId) {
      shown = children.filter((c) => c.externalStudentId === studentId);
      if (shown.length === 1 && openChildId === null) openChildId = shown[0].id;
      $('student-card').hidden = false;
      $('student-line').textContent = `다힘 학생 번호 ${studentId}`;
      $('link-form').hidden = shown.length > 0;
      $('link-student').value = studentId;
      if (!$('link-code').value) $('link-code').value = studentId;
    }
    $('children').replaceChildren(...shown.map(childItem));
    $('empty').hidden = shown.length > 0;
  }

  async function setConsent(child, date) {
    showMsg('');
    try {
      await api.patch(`/api/children/${child.id}`, { consentDate: date });
      await load();
    } catch (err) { fail(err); }
  }

  async function load() {
    try { children = await api.get('/api/children'); } catch (err) { return fail(err); }
    render();
  }

  // ---- forms and page chrome --------------------------------------------------------------
  $('add-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showMsg('');
    const consent = $('add-consent').value;
    try {
      await api.post('/api/children', {
        code: $('add-code').value.trim(),
        initials: $('add-initials').value.trim(),
        gradeBand: $('add-band').value,
        ...(consent ? { consentDate: consent } : {}),
      });
      $('add-form').reset();
      await load();
    } catch (err) {
      showMsg(err.status === 409 ? '이미 사용 중인 코드입니다.' : err.message);
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
      await load();
    } catch (err) {
      showMsg(err.message === 'code already in use' ? '이미 사용 중인 코드입니다.' : err.message); // 409 may also be "이미 등록된 학생입니다"
    }
  });

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
  $('invite-copy').addEventListener('click', async () => {
    if (!(await copyText($('invite-link').value))) $('invite-link').select();
  });

  $('logout').addEventListener('click', async () => {
    try { await api.post('/api/logout', {}, { noRedirect: true }); } catch { /* leaving anyway */ }
    location.href = '/academy';
  });

  (async function init() {
    let me;
    try { me = await api.get('/api/me'); } catch { return; } // 401 already redirected to the front page
    if (me.role === 'student') { location.replace(`/read.html?child=${me.child.id}`); return; }
    $('who').textContent = me.role === 'admin' ? '원장' : '선생님';
    // Invites are a legacy password flow (ALLOW_PASSWORD_LOGIN=1 only).
    $('admin-card').hidden = !(me.role === 'admin' && me.passwordLogin);
    await load();
  })();
})();
