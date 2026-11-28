'use strict';
// "색으로 보기" rehearsal (public/js/practice.js), paged capture, and the read.html wiring for
// fill mode, pages and the rehearsal.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSmoother, nearestWord, startPractice, PRACTICE_TEXT, HIT_CLASS } = require('../public/js/practice.js');
const { startCapture } = require('../public/js/capture.js');
const { startTestServer } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

test('createSmoother: moving average of the last 5 valid points', () => {
  const s = createSmoother();
  assert.equal(s.push(null), null);
  assert.deepEqual(s.push({ x: 10, y: 20 }), { x: 10, y: 20 });
  assert.deepEqual(s.push({ x: NaN, y: 0 }), { x: 10, y: 20 }, 'invalid points are ignored');
  for (const x of [20, 30, 40, 50]) s.push({ x, y: 20 });
  assert.deepEqual(s.push({ x: 60, y: 20 }), { x: 40, y: 20 }, 'only the last 5: 20..60');
  s.reset();
  assert.equal(s.push(undefined), null);
});

test('nearestWord: inside a box, nearest box, nothing beyond maxDist', () => {
  const boxes = [{ x: 0, y: 0, w: 100, h: 40 }, { x: 150, y: 0, w: 100, h: 40 }, { x: 0, y: 120, w: 100, h: 40 }];
  assert.equal(nearestWord(boxes, 50, 20), 0);
  assert.equal(nearestWord(boxes, 140, 20), 1);
  assert.equal(nearestWord(boxes, 50, 100), 2);
  assert.equal(nearestWord(boxes, 2000, 2000, 100), -1);
  assert.equal(nearestWord([], 1, 1), -1);
});

test('startPractice highlights via classList only and stores nothing; stop clears it', () => {
  let listener = null;
  const fake = { setGazeListener(fn) { listener = fn; return this; } };
  const mkSpan = () => {
    const set = new Set();
    return { classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), has: (c) => set.has(c) } };
  };
  const spans = [mkSpan(), mkSpan()];
  const boxes = [{ x: 0, y: 0, w: 100, h: 40 }, { x: 300, y: 0, w: 100, h: 40 }];
  const pr = startPractice(fake, spans, boxes, { maxDist: 80 });
  listener({ x: 50, y: 20 });
  assert.ok(spans[0].classList.has(HIT_CLASS));
  for (let k = 0; k < 6; k++) listener({ x: 350, y: 20 });
  assert.ok(!spans[0].classList.has(HIT_CLASS) && spans[1].classList.has(HIT_CLASS), 'moves with the smoothed gaze');
  for (let k = 0; k < 6; k++) listener({ x: 350, y: 900 });
  assert.ok(!spans[1].classList.has(HIT_CLASS), 'gaze far from the text: nothing lit');
  listener({ x: 350, y: 20 });
  const live = listener;
  pr.stop();
  assert.ok(!spans[0].classList.has(HIT_CLASS) && !spans[1].classList.has(HIT_CLASS));
  live({ x: 50, y: 20 });
  assert.ok(!spans[0].classList.has(HIT_CLASS), 'detached after stop');
  assert.notEqual(listener, live, 'listener replaced by a no-op');
  assert.ok(PRACTICE_TEXT.length > 20);
});

test('startPractice: face lost for >= 400 ms clears the highlight; a short blink does not', () => {
  let listener = null;
  const fake = { setGazeListener(fn) { listener = fn; return this; } };
  const set = new Set();
  const span = { classList: { add: (c) => set.add(c), remove: (c) => set.delete(c) } };
  let clock = 0;
  startPractice(fake, [span], [{ x: 0, y: 0, w: 100, h: 40 }], { now: () => clock });
  clock = 10; listener({ x: 50, y: 20 });
  assert.ok(set.has(HIT_CLASS));
  for (clock = 50; clock <= 300; clock += 50) listener(null);
  assert.ok(set.has(HIT_CLASS), 'a 290 ms blink keeps the word lit');
  clock = 330; listener({ x: 50, y: 20 });
  for (clock = 360; clock <= 740; clock += 40) listener(null);
  assert.ok(set.has(HIT_CLASS), '< 400 ms since the last valid point');
  clock = 760; listener({ x: NaN, y: 1 });
  assert.ok(!set.has(HIT_CLASS), '430 ms without gaze: cleared');
  clock = 800; listener({ x: 50, y: 20 });
  assert.ok(set.has(HIT_CLASS), 'lights again when the face is back (smoother was reset)');
  for (let k = 0; k < 11; k++) listener(null);
  assert.ok(set.has(HIT_CLASS), '11 empty predictions at once: not yet');
  listener(null);
  assert.ok(!set.has(HIT_CLASS), '12 empty predictions in a row (~400 ms at 30/s): cleared');
});

test('paged capture tags every sample with the page shown; unpaged stays {t,x,y}', () => {
  let listener = null;
  const fake = { setGazeListener(fn) { listener = fn; return this; } };
  let clock = 0;
  const cap = startCapture(fake, () => clock, { paged: true });
  clock = 10; listener({ x: 1, y: 2 });
  cap.setPage(1);
  clock = 20; listener(null);
  assert.deepEqual(cap.stop(), [{ t: 10, x: 1, y: 2, page: 0 }, { t: 20, x: null, y: null, page: 1 }]);
  const plain = startCapture(fake, () => clock);
  listener({ x: 1, y: 2 });
  assert.deepEqual(plain.stop(), [{ t: 0, x: 1, y: 2 }]);
});

test('read.html: size choice (fill default), practice checkbox off, page buttons, scripts in order', () => {
  const html = read('read.html');
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /name="size" value="fill" checked> 꽉 채우기 \(권장\)/);
  assert.match(html, /name="size" value="base"> 지문 기본 크기/);
  assert.match(html, /<input type="checkbox" id="practice">/, 'rehearsal is off by default');
  assert.match(html, /<button id="next" type="button" hidden>다음<\/button>/);
  assert.match(html, /<button id="begin" type="button" hidden>이제 시작<\/button>/);
  assert.match(html, /<button id="done" type="button">다 읽었어요<\/button>/);
  const order = ['layout.js', 'fill.js', 'geometry.js', 'practice.js', 'capture.js', 'read.js'].map((f) => html.indexOf(`/js/${f}`));
  assert.ok(order.every((v, k) => v > 0 && (k === 0 || v > order[k - 1])), `script order ${order}`);
  const css = read('css/app.css');
  assert.match(css, /#done-bar button \{[^}]*min-height: 48px/);
  assert.match(css, /#done-bar button \{[^}]*touch-action: manipulation/);
  const src = read('js/read.js');
  assert.match(src, /화면이 작아 지문이 다 들어오지 않습니다/);
  assert.match(src, /startCapture\(window\.webgazer, undefined, \{ paged: fillMode \}\)/);
  // geometry guard: watched from planning, checked before reading, at page turns and at the end
  assert.match(src, /geometry = watchGeometry\(window\)/);
  for (const fn of ['function beginReading', 'function onNext', 'async function onDone']) {
    const body = src.slice(src.indexOf(fn), src.indexOf('\n  }\n', src.indexOf(fn)));
    assert.match(body, /geometryBroken\(\)/, `${fn} checks the geometry`);
  }
  assert.match(src, /화면이 바뀌었어요/);
  assert.match(src, /if \(!renderPassage\(\)\) return abortChangedScreen\(\)/, '지문 기본 크기: layout failure is not ignored');
  // double tap guard and focus
  assert.match(src, /TAP_GUARD_MS = 500/);
  assert.match(src, /DONE_MIN_SHOWN_MS = 1000/);
  assert.match(src, /focus\(\{ preventScroll: true \}\)/);
  // the rehearsal never touches the recorded capture or the upload
  const practiceFn = src.slice(src.indexOf('function showPractice'), src.indexOf('function onBegin'));
  assert.doesNotMatch(practiceFn, /startCapture|payload|api\./);
});

test('new scripts are served', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  for (const p of ['/js/fill.js', '/js/practice.js', '/js/geometry.js', '/read.html']) {
    const res = await fetch(srv.url + p);
    assert.equal(res.status, 200, p);
    await res.arrayBuffer();
  }
});
