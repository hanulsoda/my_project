'use strict';
// The academy header copied into this app (public/js/site-header.js): role-based menu from
// admin_header.php, the tool's own menu entry, pins, quick-move search, no names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sh = require('../public/js/site-header.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const labels = (groups) => groups.map((g) => g.label);

test('six menus after 홈, with the site\'s labels; every entry goes back to dahim.kr except the tool', () => {
  for (const role of ['admin', 'teacher']) {
    const nav = sh.navFor(role);
    assert.deepEqual(labels(nav), ['홈', '입학·진단', '학생·운영', '수업·평가', '학습관리', '콘텐츠·교재', '소통·알림']);
    for (const g of nav) {
      for (const c of g.cols) {
        for (const it of c.items) {
          if (it.tool) assert.equal(it.href, '/children.html');
          else assert.match(it.href, /^https:\/\/dahim\.kr\//, `${g.label} › ${it.label}`);
        }
      }
    }
  }
});

test('학습관리 › 독법·읽기 ends with "읽기 시선 기록" (this tool), for both roles', () => {
  for (const role of ['admin', 'teacher']) {
    const col = sh.navFor(role).find((g) => g.key === 'learning').cols.find((c) => c.title === '독법·읽기');
    const last = col.items[col.items.length - 1];
    assert.deepEqual([last.label, last.tool], ['읽기 시선 기록', true]);
    assert.ok(col.items.some((i) => i.label === '읽기 대시보드' && i.href === 'https://dahim.kr/reading/admin_dashboard.php'));
  }
});

test('director-only entries are hidden from teachers, teacher-only ones from the director', () => {
  const flat = (role) => sh.navFor(role).flatMap((g) => g.cols.flatMap((c) => c.items.map((i) => i.label)));
  const admin = flat('admin');
  const teacher = flat('teacher');
  assert.ok(admin.includes('원장 대시보드') && !teacher.includes('원장 대시보드'));
  assert.ok(admin.includes('수납') && !teacher.includes('수납'));
  assert.ok(teacher.includes('문장 중심축 수업') && !admin.includes('문장 중심축 수업'));
  assert.ok(admin.includes('동영상 강좌 관리') && !admin.includes('동영상 강좌 보기'));
  assert.ok(teacher.includes('동영상 강좌 보기') && !teacher.includes('동영상 강좌 관리'));
});

test('pins and role wording follow admin_header.php; the role is shown, never a name', () => {
  assert.deepEqual(sh.pinsFor('admin').map((p) => p.label), ['원장 대시보드', '반 운영 콘솔', '학생 관리', '출결', '수납', '발송 통제센터']);
  assert.deepEqual(sh.pinsFor('teacher').map((p) => p.label), ['내 수업', '출결', '반 운영 콘솔', '과제 배정', '성적 리포트', '빠른 발송']);
  assert.equal(sh.pinsFor('admin')[0].href, 'https://dahim.kr/admin/dashboard.php');
  assert.deepEqual([sh.ROLE_VIEW.admin.sub, sh.ROLE_VIEW.admin.who, sh.ROLE_VIEW.admin.badge], ['DIRECTOR CONSOLE', '원장님', '원장']);
  assert.deepEqual([sh.ROLE_VIEW.teacher.sub, sh.ROLE_VIEW.teacher.who, sh.ROLE_VIEW.teacher.badge], ['TEACHER STUDIO', '선생님', '강사']);
  const src = read('js/site-header.js');
  assert.doesNotMatch(src, /\.email|admin_name|\.(?:inner|outer)HTML|insertAdjacentHTML/);
});

test('빠른 이동 finds menu entries by label words, within the role and without duplicates', () => {
  assert.deepEqual(sh.searchMenu('admin', ''), []);
  const found = sh.searchMenu('admin', '시선');
  assert.deepEqual(found.map((f) => f.label), ['읽기 시선 기록']);
  assert.equal(found[0].group, '학습관리');
  assert.ok(sh.searchMenu('teacher', '수납').length === 0, 'director-only entries are not offered to teachers');
  assert.ok(sh.searchMenu('admin', '출결 관리').some((f) => f.label === '출결 관리'));
  assert.ok(sh.searchMenu('admin', '읽기', 3).length === 3, 'limit');
  const hrefs = sh.searchMenu('admin', '기출').map((f) => f.href);
  assert.equal(new Set(hrefs).size, hrefs.length);
});

test('every teacher / director page uses the header with the site font; out-of-scope pages are untouched', () => {
  const FONT = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css';
  for (const page of ['children.html', 'measure.html', 'index.html']) {
    const html = read(page);
    assert.ok(html.includes(`href="${FONT}"`), `${page} loads Pretendard like the site`);
    assert.match(html, /href="\/css\/dahim-skin\.css"/, page);
    assert.match(html, /class="dh-skin/, page);
  }
  for (const page of ['children.html', 'measure.html']) assert.match(read(page), /src="\/js\/site-header\.js"/, page);
  for (const page of ['read.html', 'report.html']) {
    assert.doesNotMatch(read(page), /dahim-skin|site-header|pretendard/i, `${page} keeps its own look`);
  }
  const css = read('css/dahim-skin.css');
  assert.match(css, /'Pretendard Variable', Pretendard,[^;]*'Noto Sans KR'[^;]*sans-serif/, 'fallback stack when the font is blocked');
  assert.match(css, /--header-height: 64px/);
  assert.match(css, /:focus-visible \{ outline: 3px solid #1d4ed8; outline-offset: 2px/);
});
