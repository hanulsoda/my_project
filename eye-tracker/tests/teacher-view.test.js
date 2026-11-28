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

test('children page: design D2 structure, no real-name field, delete keeps the permanent warning', () => {
  const html = read('children.html');
  assert.match(html, /<link rel="stylesheet" href="\/css\/app\.css">\s*<link rel="stylesheet" href="\/css\/teacher\.css">/);
  assert.match(html, /<script src="\/js\/teacher-view\.js"><\/script>\s*<script src="\/js\/children\.js">/);
  for (const id of ['add-form', 'add-code', 'add-initials', 'add-group', 'search', 'chips', 'missing-only', 'children', 'empty',
    'export', 'view-detail', 'view-teachers', 'teachers', 'view-audit', 'audit', 'confirm', 'toast']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /href="\/api\/children\/export\.csv"/);
  assert.match(html, /data-view="teachers" hidden/, 'director tabs start hidden');
  assert.doesNotMatch(html, /(?:실명|이름)\s*<input|id="[a-z-]*name"/);
  const js = read('js/children.js');
  assert.match(js, /영구 삭제되며 되돌릴 수 없습니다/);
  assert.match(js, /confirmDialog\(\{\s*title: `\$\{child\.code\} 아이를 삭제할까요\?`/);
  assert.match(js, /me\.role !== 'admin'/, 'teacher / director tabs follow the role');
  assert.match(js, /\/api\/admin\/teachers\/\$\{t\.id\}\/\$\{t\.disabled \? 'enable' : 'disable'\}/);
  assert.doesNotMatch(js, /reset-link/, 'no legacy reset-link UI');
});

test('front page uses the foundation look and still sends people to the academy', () => {
  const html = read('index.html');
  assert.match(html, /class="topbar"/);
  assert.match(html, /href="\/css\/teacher\.css"/);
  assert.match(html, /다힘 사이트에서 들어오세요/);
  assert.match(html, /href="\/academy"/);
  assert.doesNotMatch(html, /<form|password/);
});
