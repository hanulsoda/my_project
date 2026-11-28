'use strict';
// Pure helpers for the teacher / director screens (children.html): list filters, paging, the
// "최근 측정" summary, the six session figures, trend figures, account and audit labels.
// No DOM here, so the rules are unit-tested (tests/teacher-view.test.js). Real names are never
// stored: a child is its code and initials, an account is its academy number or role.
(function (root) {
  const NO_GROUP = '';
  const ALL = null;
  const TZ = 'Asia/Seoul';

  // ---- measurement state ------------------------------------------------------------------
  // Same rule as metrics-view.js: failed (no reading), 참고용 (reliable === false, or legacy
  // line-level rows without the flag), legacy word-level figures, or reliable line-level figures.
  function sessionState(m) {
    if (!m || m.quality === 0 || m.wordsRead === 0) return 'failed';
    if (typeof m.reliable === 'boolean') return m.reliable ? 'reliable' : 'reference';
    return m.detail === 'line' ? 'reference' : 'legacy';
  }

  const lineNumbers = (lines) => (lines || []).map((l) => l + 1).join(' · ');

  // The six figures of a session card (reliable line-level only; null otherwise: 참고용 shows no numbers).
  function sessionStats(m) {
    if (sessionState(m) !== 'reliable') return null;
    const long = lineNumbers(m.longDwellLines);
    return [
      { label: '분당 읽은 어절 수', value: String(Math.round(m.wpm)), unit: '어절/분' },
      { label: '읽은 줄 / 전체 줄', value: `${m.linesRead} / ${m.totalLines}`, unit: '줄' },
      { label: '끝까지 읽음', value: m.completed ? '✓ 예' : '아니요', unit: '' },
      { label: '앞 줄로 되돌아간 횟수', value: String(m.regressions), unit: '회' },
      { label: '건너뛴 줄', value: String(m.skippedLines), unit: '줄' },
      { label: '오래 머문 줄', value: long || '없음', unit: long ? '번째 줄' : '' },
    ];
  }

  // "최근 측정" cell of the child table. sessions: the child's sessions (any order).
  // -> null (no session yet) | { startedAt, state, text }
  function latestSummary(sessions) {
    if (!sessions || sessions.length === 0) return null;
    const s = sessions.reduce((a, b) => (b.startedAt > a.startedAt || (b.startedAt === a.startedAt && b.id > a.id) ? b : a));
    const m = s.metrics;
    const state = sessionState(m);
    const done = m && m.completed ? '끝까지 읽음' : '일부만 읽음';
    let text;
    if (state === 'failed' || state === 'reference') text = '수치 없음 · 다시 측정해 보세요';
    else if (state === 'reliable') text = `분당 ${Math.round(m.wpm)}어절 · ${m.linesRead}/${m.totalLines}줄 · ${done}`;
    else text = `분당 ${Math.round(m.wpm)}어절 · ${done}`;
    return { startedAt: s.startedAt, state, text };
  }

  // ---- list: counts, group chips, filters, paging -----------------------------------------
  function childStats(children) {
    return { total: children.length, missing: children.filter((c) => !c.consentDate).length };
  }

  // [{ key, label, count }]: 전체 first, groups in Korean order, then 그룹 없음 (when any).
  function groupChips(children) {
    const counts = new Map();
    let none = 0;
    for (const c of children) {
      if (c.group) counts.set(c.group, (counts.get(c.group) || 0) + 1);
      else none += 1;
    }
    const groups = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'ko'));
    return [
      { key: ALL, label: '전체', count: children.length },
      ...groups.map((g) => ({ key: g, label: g, count: counts.get(g) })),
      ...(none > 0 && groups.length > 0 ? [{ key: NO_GROUP, label: '그룹 없음', count: none }] : []),
    ];
  }

  // query: matches code or initials (case-insensitive); group: null = all, '' = no group.
  function filterChildren(children, { query = '', group = ALL, missingOnly = false } = {}) {
    const q = query.trim().toLowerCase();
    return children.filter((c) => {
      if (q && !c.code.toLowerCase().includes(q) && !c.initials.toLowerCase().includes(q)) return false;
      if (group === NO_GROUP && c.group) return false;
      if (group !== ALL && group !== NO_GROUP && c.group !== group) return false;
      return !(missingOnly && c.consentDate);
    });
  }

  // page is 0-based and clamped. -> { items, page, pages, from, to, total }
  function paginate(items, page, size) {
    const pages = Math.max(1, Math.ceil(items.length / size));
    const p = Math.min(Math.max(0, page | 0), pages - 1);
    const slice = items.slice(p * size, p * size + size);
    return { items: slice, page: p, pages, from: slice.length ? p * size + 1 : 0, to: p * size + slice.length, total: items.length };
  }

  const pageCaption = (pg, unit = '명') => (pg.total === 0 ? `0${unit}` : `${pg.total}${unit} 중 ${pg.from}–${pg.to}${unit} 표시`);

  // ---- trend ------------------------------------------------------------------------------
  const isReliablePoint = (p) => (typeof p.reliable === 'boolean' ? p.reliable : p.detail !== 'line' && p.quality >= 0.6);

  // Average of the last `last` reliable points (참고용 never counts) and the latest 참고용 point.
  function trendStats(points, last = 5) {
    const reliable = points.filter(isReliablePoint).slice(-last);
    const refs = points.filter((p) => !isReliablePoint(p));
    const avg = reliable.length ? Math.round(reliable.reduce((a, p) => a + p.wpm, 0) / reliable.length) : null;
    return { avg, n: reliable.length, latestReference: refs.length ? refs[refs.length - 1] : null };
  }

  // ---- share links ------------------------------------------------------------------------
  function shareStatus(s, now) {
    if (s.revokedAt !== null && s.revokedAt !== undefined) return { key: 'revoked', label: '취소됨' };
    if (s.expiresAt <= now) return { key: 'expired', label: '만료됨' };
    return { key: 'active', label: '사용 중' };
  }

  // Shown in the table instead of the full link (the copy button copies the real one).
  const maskToken = (token) => `…/report.html?token=••••••${String(token).slice(-4)}`;

  // ---- accounts and audit -----------------------------------------------------------------
  // Accounts made by the academy sign-in have placeholder e-mails; show the academy number instead.
  function accountLabel(t) {
    if (!t) return '알 수 없음';
    const ext = t.externalId || '';
    if (ext.startsWith('director:')) return '원장';
    const m = /^teacher:(\d+)$/.exec(ext);
    if (m) return `선생님 (다힘 번호 ${m[1]})`;
    return t.email;
  }

  const ROLE_LABEL = { admin: '원장', teacher: '선생님' };

  const ACTION_LABEL = {
    'user.provision': '처음 들어옴 (계정 만듦)',
    'teacher.disable': '계정 비활성화',
    'teacher.enable': '계정 활성화',
    'child.delete': '아이 삭제',
    'child.reassign': '담당자 바꿈',
    'director.cross_write': '원장이 다른 담당 아이를 수정',
    'share.create': '보고서 링크 만들기',
    'share.revoke': '보고서 링크 취소',
    'invite.create': '선생님 초대',
    'invite.revoke': '초대 취소',
    'reset.create': '비밀번호 재설정 링크 만들기',
    'reset.use': '비밀번호 재설정',
  };
  const actionLabel = (a) => ACTION_LABEL[a] || a;

  // Inclusive day range in Korean time; from/to are 'YYYY-MM-DD' or ''.
  const dayStart = (d) => Date.parse(`${d}T00:00:00+09:00`);
  function filterAudit(rows, { actor = '', action = '', from = '', to = '' } = {}) {
    const lo = from ? dayStart(from) : -Infinity;
    const hi = to ? dayStart(to) + 24 * 60 * 60 * 1000 : Infinity;
    return rows.filter((r) => (actor === '' || String(r.actorUserId) === actor)
      && (action === '' || r.action === action)
      && r.at >= lo && r.at < hi);
  }

  // "2026-11-28 11:02" / "2026-11-28" in Korean time, whatever the viewer's clock zone.
  function fmtKst(ms, withTime = true) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    return withTime ? `${day} ${parts.hour}:${parts.minute}` : day;
  }

  const exported = {
    sessionState, sessionStats, latestSummary, childStats, groupChips, filterChildren, paginate, pageCaption,
    trendStats, shareStatus, maskToken, accountLabel, ROLE_LABEL, actionLabel, ACTION_LABEL, filterAudit, fmtKst, NO_GROUP,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
