'use strict';
// Pure helpers behind the teacher / director screens (public/js/teacher-view.js) and the page
// wiring that must not regress: code + initials only, the delete warning, the director-only tabs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tv = require('../public/js/teacher-view.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const kid = (id, code, initials, extra = {}) => ({ id, code, initials, gradeBand: 'elementary', consentDate: '2026-09-12', group: null, ...extra });
const ok = { reliable: true, quality: 0.9, wordsRead: 40, wpm: 86.4, linesRead: 14, totalLines: 14, completed: true, regressions: 2, skippedLines: 0, longDwellLines: [2, 6] };

test('sessionState: failed, 참고용, legacy word-level and reliable', () => {
  assert.equal(tv.sessionState({ ...ok, quality: 0 }), 'failed');
  assert.equal(tv.sessionState({ ...ok, wordsRead: 0 }), 'failed');
  assert.equal(tv.sessionState({ ...ok, reliable: false }), 'reference');
  const { reliable, ...legacy } = ok;
  assert.equal(tv.sessionState({ ...legacy, detail: 'line' }), 'reference');
  assert.equal(tv.sessionState({ ...legacy, detail: 'word' }), 'legacy');
  assert.equal(tv.sessionState(ok), 'reliable');
});

test('sessionStats: six figures for reliable sessions, none for 참고용', () => {
  const st = tv.sessionStats(ok);
  assert.deepEqual(st.map((s) => s.label), ['분당 읽은 어절 수', '읽은 줄 / 전체 줄', '끝까지 읽음', '앞 줄로 되돌아간 횟수', '건너뛴 줄', '오래 머문 줄']);
  assert.deepEqual(st.map((s) => s.value), ['86', '14 / 14', '✓ 예', '2', '0', '3 · 7']);
  assert.equal(st[5].unit, '번째 줄');
  assert.equal(tv.sessionStats({ ...ok, longDwellLines: [] })[5].value, '없음');
  assert.equal(tv.sessionStats({ ...ok, reliable: false }), null);
  assert.equal(tv.sessionStats({ ...ok, quality: 0 }), null);
});

test('latestSummary: newest session, numbers only when reliable', () => {
  assert.equal(tv.latestSummary([]), null);
  const sum = tv.latestSummary([
    { id: 1, startedAt: 100, metrics: { ...ok, reliable: false } },
    { id: 2, startedAt: 300, metrics: ok },
    { id: 3, startedAt: 200, metrics: { ...ok, reliable: false } },
  ]);
  assert.deepEqual(sum, { startedAt: 300, state: 'reliable', text: '분당 86어절 · 14/14줄 · 끝까지 읽음' });
  const ref = tv.latestSummary([{ id: 1, startedAt: 1, metrics: { ...ok, reliable: false } }]);
  assert.equal(ref.state, 'reference');
  assert.doesNotMatch(ref.text, /\d/, '참고용 shows no figures');
});

test('groupChips, filterChildren and childStats', () => {
  const kids = [
    kid(1, 'E-0312', 'ㄱㅁ', { group: '3학년 읽기반' }),
    kid(2, 'E-0408', 'ㅈㅎ', { group: '4학년 읽기반', consentDate: null }),
    kid(3, 'M-0105', 'ㅇㅈ', { group: '3학년 읽기반' }),
    kid(4, 'H-0021', 'ㄴㅅ'),
  ];
  assert.deepEqual(tv.childStats(kids), { total: 4, missing: 1 });
  assert.deepEqual(tv.groupChips(kids).map((c) => [c.key, c.label, c.count]), [
    [null, '전체', 4], ['3학년 읽기반', '3학년 읽기반', 2], ['4학년 읽기반', '4학년 읽기반', 1], ['', '그룹 없음', 1]]);
  assert.deepEqual(tv.groupChips([kid(9, 'A', 'B')]).map((c) => c.label), ['전체'], 'no "그룹 없음" chip when nobody has a group');
  const ids = (f) => tv.filterChildren(kids, f).map((c) => c.id);
  assert.deepEqual(ids({}), [1, 2, 3, 4]);
  assert.deepEqual(ids({ query: 'e-0' }), [1, 2]);
  assert.deepEqual(ids({ query: ' ㅇㅈ ' }), [3]);
  assert.deepEqual(ids({ group: '3학년 읽기반' }), [1, 3]);
  assert.deepEqual(ids({ group: '' }), [4]);
  assert.deepEqual(ids({ missingOnly: true }), [2]);
});

test('paginate and pageCaption clamp the page', () => {
  const items = Array.from({ length: 45 }, (_, i) => i);
  const p = tv.paginate(items, 2, 20);
  assert.deepEqual([p.page, p.pages, p.from, p.to, p.items.length], [2, 3, 41, 45, 5]);
  assert.equal(tv.pageCaption(p), '45명 중 41–45명 표시');
  assert.equal(tv.paginate(items, 9, 20).page, 2);
  assert.equal(tv.paginate(items, -1, 20).page, 0);
  const empty = tv.paginate([], 0, 20);
  assert.deepEqual([empty.pages, empty.from, empty.to], [1, 0, 0]);
  assert.equal(tv.pageCaption(empty, '건'), '0건');
});

test('trendStats: average of reliable points only; latest 참고용 point', () => {
  const pts = [
    { startedAt: 1, wpm: 80, reliable: true }, { startedAt: 2, wpm: 999, reliable: false },
    { startedAt: 3, wpm: 100, reliable: true }, { startedAt: 4, wpm: 5, reliable: false },
  ];
  const t = tv.trendStats(pts);
  assert.equal(t.avg, 90);
  assert.equal(t.n, 2);
  assert.equal(t.latestReference.startedAt, 4);
  assert.deepEqual(tv.trendStats([]), { avg: null, n: 0, latestReference: null });
  const many = Array.from({ length: 8 }, (_, i) => ({ startedAt: i, wpm: i * 10, reliable: true }));
  assert.equal(tv.trendStats(many).avg, 50, 'last five reliable points (30..70)');
});

test('shareStatus and maskToken', () => {
  assert.equal(tv.shareStatus({ revokedAt: 5, expiresAt: 1e15 }, 10).label, '취소됨');
  assert.equal(tv.shareStatus({ revokedAt: null, expiresAt: 10 }, 10).label, '만료됨');
  assert.equal(tv.shareStatus({ revokedAt: null, expiresAt: 11 }, 10).label, '사용 중');
  const masked = tv.maskToken('abcdefghijklmnopa9f2');
  assert.match(masked, /a9f2$/);
  assert.doesNotMatch(masked, /abcdef/, 'the token itself is not printed');
});

test('accountLabel shows the academy number, never a placeholder e-mail', () => {
  assert.equal(tv.accountLabel({ email: 'director@sso.invalid', externalId: 'director:admin' }), '원장');
  assert.equal(tv.accountLabel({ email: 'teacher-12@sso.invalid', externalId: 'teacher:12' }), '선생님 (다힘 번호 12)');
  assert.equal(tv.accountLabel({ email: 'old@example.test', externalId: null }), 'old@example.test');
  assert.equal(tv.accountLabel(undefined), '알 수 없음');
});

test('filterAudit: actor, action and an inclusive Korean-time day range', () => {
  const at = (s) => Date.parse(s);
  const rows = [
    { id: 1, at: at('2026-11-19T23:30:00+09:00'), actorUserId: 1, action: 'share.create' },
    { id: 2, at: at('2026-11-20T00:00:00+09:00'), actorUserId: 2, action: 'child.delete' },
    { id: 3, at: at('2026-11-28T23:59:00+09:00'), actorUserId: 1, action: 'child.delete' },
    { id: 4, at: at('2026-11-29T00:00:00+09:00'), actorUserId: null, action: 'user.provision' },
  ];
  const ids = (f) => tv.filterAudit(rows, f).map((r) => r.id);
  assert.deepEqual(ids({}), [1, 2, 3, 4]);
  assert.deepEqual(ids({ actor: '1' }), [1, 3]);
  assert.deepEqual(ids({ action: 'child.delete' }), [2, 3]);
  assert.deepEqual(ids({ from: '2026-11-20', to: '2026-11-28' }), [2, 3]);
  assert.equal(tv.actionLabel('teacher.disable'), '계정 비활성화');
  assert.equal(tv.actionLabel('something.new'), 'something.new');
});

test('fmtKst formats in Korean time', () => {
  assert.equal(tv.fmtKst(Date.parse('2026-11-28T02:02:00Z')), '2026-11-28 11:02');
  assert.equal(tv.fmtKst(Date.parse('2026-11-28T16:00:00Z'), false), '2026-11-29');
});

test('children page: design D2 v2 structure, no real-name field, delete keeps the permanent warning', () => {
  const html = read('children.html');
  assert.match(html, /<link rel="stylesheet" href="\/css\/dahim-skin\.css">\s*<link rel="stylesheet" href="\/css\/teacher\.css">/);
  assert.match(html, /<script src="\/js\/site-header\.js"><\/script>/, 'the academy header module');
  assert.match(html, /id="site-header"/);
  assert.match(html, /<script src="\/js\/teacher-view\.js"><\/script>\s*<script src="\/js\/children\.js">/);
  for (const id of ['add-form', 'add-code', 'add-initials', 'add-group', 'search', 'chips', 'missing-only', 'children', 'empty',
    'export', 'view-detail', 'view-teachers', 'teachers', 'view-audit', 'audit', 'confirm', 'toast',
    'start', 'empty-add', 'tiles', 'stale-note', 'stale-clear', 'confirm-cancel', 'confirm-ok']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /href="\/api\/children\/export\.csv"/);
  assert.match(html, /data-view="teachers" hidden/, 'director tabs start hidden');
  assert.doesNotMatch(html, /(?:실명|이름)\s*<input|id="[a-z-]*name"/);
  const js = read('js/children.js');
  assert.match(js, /영구 삭제되며 되돌릴 수 없어요/);
  assert.match(js, /summaryTiles\(children, lastBy, Date\.now\(\)\)/, 'the tiles are counted in the browser from the list data');
  assert.match(js, /confirmDialog\(\{\s*title: `\$\{child\.code\} 아이를 삭제할까요\?`/);
  assert.match(js, /me\.role !== 'admin'/, 'teacher / director tabs follow the role');
  assert.match(js, /\/api\/admin\/teachers\/\$\{t\.id\}\/\$\{t\.disabled \? 'enable' : 'disable'\}/);
  assert.doesNotMatch(js, /reset-link/, 'no legacy reset-link UI');
});

test('front page uses the academy skin and still sends people to the academy', () => {
  const html = read('index.html');
  assert.match(html, /class="dh-header"/);
  assert.match(html, /href="\/css\/dahim-skin\.css"/);
  assert.match(html, /href="\/css\/teacher\.css"/);
  assert.match(html, /다힘 사이트에서 들어오세요/);
  assert.match(html, /href="\/academy"/);
  assert.doesNotMatch(html, /<form|password/);
});

test('weekStartKst: Monday 00:00 Korean time, whatever the viewer clock zone', () => {
  const mon = Date.parse('2026-11-23T00:00:00+09:00');
  assert.equal(tv.weekStartKst(Date.parse('2026-11-28T15:00:00+09:00')), mon, 'Saturday');
  assert.equal(tv.weekStartKst(Date.parse('2026-11-29T23:59:00+09:00')), mon, 'Sunday still belongs to the week that began Monday');
  assert.equal(tv.weekStartKst(mon), mon, 'Monday midnight starts the week');
  assert.equal(tv.weekStartKst(mon - 1), Date.parse('2026-11-16T00:00:00+09:00'), 'one millisecond earlier is last week');
  // Sunday 20:00 UTC is already Monday 05:00 in Korea
  assert.equal(tv.weekStartKst(Date.parse('2026-11-29T20:00:00Z')), Date.parse('2026-11-30T00:00:00+09:00'));
  assert.equal(tv.fmtWeekStart(mon), '11월 23일(월)부터');
});

test('daysAgo / agoLabel count Korean calendar days', () => {
  const now = Date.parse('2026-11-28T10:00:00+09:00');
  assert.equal(tv.daysAgo(Date.parse('2026-11-28T00:10:00+09:00'), now), 0);
  assert.equal(tv.agoLabel(Date.parse('2026-11-28T00:10:00+09:00'), now), '오늘');
  assert.equal(tv.daysAgo(Date.parse('2026-11-27T23:50:00+09:00'), now), 1, 'yesterday evening is one day ago');
  assert.equal(tv.agoLabel(Date.parse('2026-11-26T14:05:00+09:00'), now), '2일 전');
});

test('isStale: never measured, or more than 30 days (not 30 exactly)', () => {
  const now = Date.parse('2026-11-28T10:00:00+09:00');
  assert.equal(tv.STALE_DAYS, 30);
  assert.equal(tv.isStale(null, now), true, 'never measured');
  assert.equal(tv.isStale(undefined, now), true);
  assert.equal(tv.isStale(Date.parse('2026-10-29T09:00:00+09:00'), now), false, '30 days ago is not yet stale');
  assert.equal(tv.isStale(Date.parse('2026-10-28T23:00:00+09:00'), now), true, '31 days ago is stale');
  assert.equal(tv.isStale(Date.parse('2026-11-27T09:00:00+09:00'), now), false);
  assert.equal(tv.lastMeasuredAt([]), null);
  assert.equal(tv.lastMeasuredAt([{ startedAt: 5 }, { startedAt: 9 }, { startedAt: 7 }]), 9);
});

test('summaryTiles: the four list tiles from the list and the newest measurement per child', () => {
  const now = Date.parse('2026-11-28T10:00:00+09:00');
  const at = (s) => Date.parse(`${s}+09:00`);
  const kids = [
    kid(1, 'E-0312', 'ㄱㅁ', { group: '3학년 읽기반' }),
    kid(2, 'E-0317', 'ㅅㅇ', { group: '3학년 읽기반' }),
    kid(3, 'E-0408', 'ㅈㅎ', { group: '4학년 읽기반', consentDate: null }),
    kid(4, 'M-0105', 'ㅇㅈ', { group: '중등 A반' }),
    kid(5, 'M-0113', 'ㅂㄷ', { group: '중등 A반' }),
    kid(6, 'H-0021', 'ㄴㅅ'),
  ];
  const last = new Map([[1, at('2026-11-26T14:05:00')], [2, at('2026-11-24T10:20:00')], [3, null],
    [4, at('2026-11-23T00:00:00')], [5, at('2026-10-19T10:00:00')], [6, null]]);
  const t = tv.summaryTiles(kids, last, now);
  assert.equal(t.total, 6);
  assert.equal(t.groups, 3);
  assert.equal(t.noGroup, 1);
  assert.equal(t.weekStart, at('2026-11-23T00:00:00'));
  assert.equal(t.measuredThisWeek, 3, 'Monday 00:00 counts as this week');
  assert.deepEqual(t.needConsent, [3]);
  assert.deepEqual(t.stale, [5, 6], 'no-consent children are only in the consent tile');
  // still loading one child's sessions: date-based counts are unknown, the rest is ready
  const partial = tv.summaryTiles(kids, new Map([[1, null]]), now);
  assert.equal(partial.measuredThisWeek, null);
  assert.equal(partial.stale, null);
  assert.deepEqual(partial.needConsent, [3]);
  const none = tv.summaryTiles([], new Map(), now);
  assert.deepEqual([none.total, none.groups, none.measuredThisWeek, none.stale.length], [0, 0, 0, 0]);
});

test('filterChildren: onlyIds keeps the tile\'s children and combines with the other filters', () => {
  const kids = [kid(1, 'E-1', 'A', { group: 'g' }), kid(2, 'E-2', 'B'), kid(3, 'M-3', 'C', { group: 'g' })];
  const ids = (f) => tv.filterChildren(kids, f).map((c) => c.id);
  assert.deepEqual(ids({ onlyIds: new Set([2, 3]) }), [2, 3]);
  assert.deepEqual(ids({ onlyIds: new Set([2, 3]), group: 'g' }), [3]);
  assert.deepEqual(ids({ onlyIds: null }), [1, 2, 3]);
});

test('trendPlot: one line through reliable points, 참고용 keeps a slot with no value', () => {
  const p = (d, wpm, reliable) => ({ startedAt: Date.parse(`2026-${d}T14:00:00+09:00`), wpm, reliable });
  const plot = tv.trendPlot([p('10-02', 80, true), p('10-16', 93, true), p('10-30', 40, false), p('11-24', 999, false), p('11-26', 86, true)]);
  assert.deepEqual(plot.items.map((i) => i.wpm), [80, 93, null, null, 86]);
  assert.equal(plot.items[2].y, null);
  assert.equal(plot.line.split(' ').length, 3, 'only reliable points are joined');
  assert.deepEqual([plot.first, plot.last, plot.reliableCount, plot.referenceCount], [80, 86, 3, 2]);
  assert.equal(plot.base.v, 80);
  const vs = plot.ticks.map((t) => t.v);
  assert.ok(vs[0] <= 80 && vs[vs.length - 1] >= 93 && vs.length <= 5, `ticks ${vs}`);
  assert.ok(vs[vs.length - 1] < 999, 'a 참고용 value never stretches the axis');
  const xs = plot.items.map((i) => i.x);
  assert.ok(xs.every((x, k) => k === 0 || x > xs[k - 1]), 'x grows with time order');
  const empty = tv.trendPlot([p('10-02', 50, false)]);
  assert.equal(empty.base, null);
  assert.equal(empty.line, '');
});
