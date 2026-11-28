'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startTestServer } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
const jsFiles = () => fs.readdirSync(path.join(PUBLIC, 'js')).filter((f) => f.endsWith('.js'));

const { groupLines, fitFontPx } = require('../public/js/layout.js');
const { ballPosition } = require('../public/js/calibrate.js');
const { startCapture, MAX_SAMPLES } = require('../public/js/capture.js');

// Raw GET that keeps the path exactly as given (fetch would normalise "/../").
function rawGet(baseUrl, rawPath) {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    http.get({ host: u.hostname, port: u.port, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('groupLines', async (t) => {
  await t.test('clean 3-line input: lines 0,1,2 and reading-order i', () => {
    const boxes = [];
    for (let line = 0; line < 3; line++) {
      for (let k = 0; k < 4; k++) boxes.push({ x: 40 + k * 90, y: 100 + line * 64, w: 80, h: 32 });
    }
    const out = groupLines(boxes);
    assert.equal(out.length, 12);
    out.forEach((b, idx) => {
      assert.equal(b.i, idx);
      assert.equal(b.line, Math.floor(idx / 4));
    });
  });

  await t.test('shuffled and jittered input still groups by line and orders by x within a line', () => {
    const jitter = [0, 3, -2, 4, -3, 1, 2, -4, 0, 3, -1, 2];
    const boxes = [];
    let n = 0;
    for (let line = 0; line < 3; line++) {
      for (let k = 0; k < 4; k++) {
        boxes.push({ x: 40 + k * 90, y: 100 + line * 64 + jitter[n], w: 80, h: 32, tag: `${line}-${k}` });
        n++;
      }
    }
    const shuffled = [5, 11, 0, 7, 2, 9, 4, 1, 10, 6, 3, 8].map((k) => boxes[k]);
    const out = groupLines(shuffled);
    assert.deepEqual(out.map((b) => b.tag), boxes.map((b) => b.tag));
    out.forEach((b, idx) => {
      assert.equal(b.i, idx);
      assert.equal(b.line, Math.floor(idx / 4));
    });
  });

  await t.test('a short box (punctuation-like) stays on its line; other fields are kept', () => {
    const out = groupLines([
      { x: 0, y: 100, w: 80, h: 32 },
      { x: 90, y: 108, w: 10, h: 16 }, // centre 116 vs 116
      { x: 0, y: 164, w: 80, h: 32 },
    ]);
    assert.deepEqual(out.map((b) => b.line), [0, 0, 1]);
    assert.equal(out[1].w, 10);
  });

  await t.test('does not mutate its input; empty and single inputs are fine', () => {
    const input = [{ x: 5, y: 5, w: 10, h: 10 }];
    const out = groupLines(input);
    assert.deepEqual(input, [{ x: 5, y: 5, w: 10, h: 10 }]);
    assert.deepEqual(out, [{ x: 5, y: 5, w: 10, h: 10, line: 0, i: 0 }]);
    assert.deepEqual(groupLines([]), []);
  });
});

test('fitFontPx', async (t) => {
  // Synthetic layout: one box whose bottom edge is 20x the font size.
  const measureWith = (calls) => (f) => { calls.push(f); return [{ x: 0, y: 0, w: 100, h: f * 20 }]; };

  await t.test('fits at full size: unchanged, measured once', () => {
    const calls = [];
    const r = fitFontPx({ passageFontPx: 32, usableW: 800, usableH: 700, measure: measureWith(calls) });
    assert.deepEqual(r, { ok: true, fontPx: 32 });
    assert.deepEqual(calls, [32]);
  });

  await t.test('does not fit at full size but fits after shrinking: largest size that fits, at least the floor', () => {
    const r = fitFontPx({ passageFontPx: 32, usableW: 800, usableH: 600, measure: measureWith([]) });
    assert.equal(r.ok, true);
    assert.equal(r.fontPx, 30); // 30 * 20 = 600 fits, 31 does not
    assert.ok(r.fontPx < 32 && r.fontPx >= 0.85 * 32 - 1);
  });

  await t.test('cannot fit even at the floor: failure result, never shrinks below the floor', () => {
    const calls = [];
    const r = fitFontPx({ passageFontPx: 32, usableW: 800, usableH: 400, measure: measureWith(calls) });
    assert.equal(r.ok, false);
    assert.equal(Math.min(...calls), 28, 'floor is 85% of 32, rounded up');
    assert.equal(r.fontPx, 28);
  });

  await t.test('floor is never below 16px', () => {
    const calls = [];
    const r = fitFontPx({ passageFontPx: 18, usableW: 800, usableH: 10, measure: measureWith(calls) });
    assert.equal(r.ok, false);
    assert.equal(Math.min(...calls), 16);
    const small = [];
    fitFontPx({ passageFontPx: 14, usableW: 800, usableH: 10, measure: measureWith(small) });
    assert.ok(Math.min(...small) >= 14, 'a passage already below 16px is never shrunk further');
  });

  await t.test('width overflow and off-screen (negative) boxes also count as not fitting', () => {
    assert.equal(fitFontPx({ passageFontPx: 20, usableW: 50, usableH: 9999, measure: measureWith([]) }).ok, false);
    assert.equal(fitFontPx({ passageFontPx: 20, usableW: 800, usableH: 9999, measure: () => [{ x: -3, y: 0, w: 10, h: 10 }] }).ok, false);
  });
});

test('ballPosition stays on screen and sweeps the whole screen', () => {
  const w = 1000;
  const h = 600;
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (let k = 0; k <= 200; k++) {
    const p = ballPosition(k / 200, w, h);
    assert.ok(p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h, `in bounds at ${k}`);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  assert.ok(minX < w * 0.2 && maxX > w * 0.8, 'covers horizontally');
  assert.ok(minY < h * 0.25 && maxY > h * 0.75, 'covers vertically');
  assert.deepEqual(ballPosition(-1, w, h), ballPosition(0, w, h));
  assert.deepEqual(ballPosition(2, w, h), ballPosition(1, w, h));
});

test('startCapture records {t,x,y} relative to start and null for no gaze', () => {
  let listener = null;
  const fake = { setGazeListener(fn) { listener = fn; return this; } };
  let clock = 5000;
  const cap = startCapture(fake, () => clock);
  clock = 5016; listener({ x: 100.5, y: 200.5 }, 16);
  clock = 5033; listener(null, 33);
  clock = 5050; listener({ x: NaN, y: 10 }, 50);
  const original = listener;
  const samples = cap.stop();
  assert.deepEqual(samples, [
    { t: 16, x: 100.5, y: 200.5 },
    { t: 33, x: null, y: null },
    { t: 50, x: null, y: null },
  ]);
  // After stop() the listener is detached: late callbacks are ignored.
  clock = 6000; original({ x: 1, y: 1 });
  assert.equal(cap.stop().length, 3, 'stop is idempotent and recording is closed');
  assert.ok(MAX_SAMPLES <= 100000, 'never exceeds the server upload limit');
});

test('static serving', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);

  await t.test('pages and vendored WebGazer are served', async () => {
    for (const p of ['/read.html', '/children.html', '/report.html', '/invite.html', '/login.html', '/index.html', '/vendor/webgazer.js', '/css/app.css', '/js/layout.js']) {
      const res = await fetch(srv.url + p);
      assert.equal(res.status, 200, p);
      await res.arrayBuffer();
    }
    const root = await fetch(srv.url + '/');
    assert.equal(root.status, 200);
    assert.match(await root.text(), /href="\/academy"/, 'the front page sends people to the academy site');
  });

  await t.test('face-mesh assets resolve under /vendor/mediapipe', async () => {
    const res = await fetch(srv.url + '/vendor/mediapipe/face_mesh/face_mesh.js');
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  });

  await t.test('static does not shadow /api: unknown API path is not the index page, guards still apply', async () => {
    const bad = await fetch(srv.url + '/api/definitely-not-a-route');
    assert.equal(bad.status, 404);
    assert.doesNotMatch(await bad.text(), /<form|로그인/, 'must not fall through to index.html');
    const guarded = await fetch(srv.url + '/api/children');
    assert.equal(guarded.status, 401);
    assert.equal((await guarded.json()).error, 'login required');
  });

  await t.test('dotfiles and traversal are not served; no directory listing', async () => {
    const dot = path.join(PUBLIC, '.frontend-test-secret');
    fs.writeFileSync(dot, 'TOP-SECRET');
    try {
      const res = await fetch(srv.url + '/.frontend-test-secret');
      assert.equal(res.status, 404);
      assert.doesNotMatch(await res.text(), /TOP-SECRET/);
    } finally {
      fs.rmSync(dot, { force: true });
    }
    for (const raw of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/js/../../package.json', '/%2e%2e%2f%2e%2e%2fserver/app.js']) {
      const r = await rawGet(srv.url, raw);
      assert.ok(r.status >= 400, `${raw} -> ${r.status}`);
      assert.doesNotMatch(r.body, /"name": "eye-tracker"|createApp/, raw);
    }
    const listing = await rawGet(srv.url, '/js/');
    assert.doesNotMatch(listing.body, /layout\.js/);
    const vendor = await rawGet(srv.url, '/vendor/');
    assert.doesNotMatch(vendor.body, /webgazer\.js/);
  });
});

test('GET /api/me', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);

  await t.test('401 when not logged in', async () => {
    const res = await fetch(srv.url + '/api/me');
    assert.equal(res.status, 401);
  });

  await t.test('returns email, role and the password-login flag only', async () => {
    for (const role of ['teacher', 'admin']) {
      const cookie = await srv.loginAs(role);
      const res = await fetch(srv.url + '/api/me', { headers: { cookie } });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.role, role);
      assert.match(body.email, new RegExp(`^${role}-\\d+@example\\.test$`));
      assert.deepEqual(Object.keys(body).sort(), ['email', 'launchStudentId', 'passwordLogin', 'role']);
      assert.equal(body.launchStudentId, null, 'no academy launch for a password login');
      assert.equal(body.passwordLogin, true, 'the test harness turns the break-glass flag on');
    }
  });
});

test('report.html is parent-safe', () => {
  const html = read('report.html');
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /선별 지표/);
  assert.match(html, /@media print/);
  assert.match(html, /<html lang="ko">/);
  assert.doesNotMatch(html, /https?:\/\//, 'no absolute URLs at all in the page source');
  // Every external reference is same-origin (root-relative), never protocol-relative.
  for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    assert.match(m[1], /^\/(?!\/)/, `non-local reference: ${m[1]}`);
  }
  assert.doesNotMatch(html, /@import|url\(\s*['"]?https?:/);
});

test('report script loads nothing third-party and shows the response disclaimer', () => {
  const src = read('js/report.js');
  assert.match(src, /\.disclaimer/, 'disclaimer text comes from the response');
  assert.match(src, /410[\s\S]*만료되었거나 폐기된 링크입니다/);
  assert.match(src, /404[\s\S]*존재하지 않는 링크입니다/);
  assert.doesNotMatch(src, /detail === 'line'/, 'detail is always "line" now: it cannot decide reference-only mode');
  assert.match(src, /view\.referenceOnly/, 'reference-only mode comes from reportDisplay (reliable === false)');
  assert.match(read('report.html'), /참고용/);
  assert.match(src, /no-referrer|credentials/, 'report fetch must not send the teacher cookie');
  assert.doesNotMatch(src, /import\(|new Image|createElement\('script'\)|createElement\("script"\)/);
});

test('the 참고용 note says no line figures are shown', () => {
  const html = read('report.html');
  const note = html.match(/<p id="ref-note"[^>]*>([^<]*)<\/p>/)[1];
  assert.match(note, /건너뛴 줄/);
  assert.match(note, /줄 단위 결과/);
});

test('the per-word dwell strip is gone from the report; long-dwell lines are shown instead', () => {
  const html = read('report.html');
  assert.doesNotMatch(html, /words-card|단어별 머문 시간/);
  assert.doesNotMatch(read('js/report.js'), /dwellStrip|dwellMsByWord/);
  assert.doesNotMatch(read('js/charts.js'), /dwellStrip/);
  assert.match(read('js/metrics-view.js'), /오래 머문 줄/);
});

test('teacher session list has a "다시 분석" button that calls the reanalyze endpoint', () => {
  const src = read('js/children.js');
  assert.match(src, /다시 분석/);
  assert.match(src, /api\.post\(`\/api\/sessions\/\$\{[^}]+\}\/reanalyze`/);
  // the trend on screen is rebuilt from the server after a reanalysis
  const handler = src.slice(src.indexOf('/reanalyze`'));
  assert.match(handler.slice(0, 600), /onReanalyzed\(\)/);
  assert.match(src, /sessionRow\(s, refreshTrend\)/);
  assert.match(src, /async function refreshTrend[\s\S]{0,400}\/trend`/);
  // two reanalyses close together: only the latest trend response may redraw the chart
  const fn = src.slice(src.indexOf('async function refreshTrend'), src.indexOf('async function refreshTrend') + 500);
  assert.match(fn, /const ticket = \+\+trendTicket/);
  assert.match(fn, /if \(ticket !== trendTicket\) return/);
});

test('public/js never writes HTML strings (XSS-proof by construction)', () => {
  const files = jsFiles();
  assert.ok(files.length >= 8, 'expected the front-end modules to exist');
  for (const f of files) {
    const src = read(`js/${f}`);
    assert.doesNotMatch(src, /\.(?:inner|outer)HTML\s*(?:\+?=|\))/, `${f}: innerHTML/outerHTML assignment`);
    assert.doesNotMatch(src, /insertAdjacentHTML|document\.write|\beval\(|new Function\(/, `${f}: HTML/code injection API`);
  }
  for (const page of fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'))) {
    const html = read(page);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>[^<]/, `${page}: inline script`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${page}: inline event handler`);
  }
});

test('read.html wires WebGazer locally and keeps video off the network', () => {
  const html = read('read.html');
  assert.match(html, /src="\/vendor\/webgazer\.js"/);
  assert.doesNotMatch(html, /https?:\/\//);
  const src = read('js/read.js');
  assert.match(src, /saveDataAcrossSessions\(false\)/);
  assert.match(src, /faceMeshSolutionPath/);
  assert.match(src, /pagehide/);
  assert.doesNotMatch(src, /toDataURL|captureStream|MediaRecorder|drawImage/, 'no frame grabbing in the reading flow');
});
