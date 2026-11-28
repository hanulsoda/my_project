'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { install, releaseCamera, cameraErrorMessage } = require('../public/js/camera-guard.js');

function fakeTrack() {
  return { readyState: 'live', stop() { this.readyState = 'ended'; } };
}
function fakeStream(n = 1) {
  const tracks = Array.from({ length: n }, fakeTrack);
  return { tracks, getTracks: () => tracks };
}
function fakeNav(streamsToReturn) {
  let i = 0;
  return { mediaDevices: { getUserMedia: async () => streamsToReturn[i++] } };
}

test('install wraps getUserMedia once and remembers the streams it hands out', async () => {
  const s1 = fakeStream(2);
  const nav = fakeNav([s1]);
  assert.equal(install(nav), true);
  assert.equal(install(nav), false, 'second install is a no-op');
  const got = await nav.mediaDevices.getUserMedia({ video: true });
  assert.equal(got, s1, 'the caller still receives the real stream');
  assert.equal(releaseCamera(), 2, 'both live tracks stopped');
  assert.ok(s1.tracks.every((t) => t.readyState === 'ended'));
});

test('a stream WebGazer holds without a <video> is still released (the light-stays-on case)', async () => {
  const s = fakeStream(1);
  const nav = fakeNav([s]);
  install(nav);
  await nav.mediaDevices.getUserMedia({ video: true });
  // Nothing was ever attached to a <video>: only the guard knows about this stream.
  const doc = { querySelectorAll: () => [] };
  assert.equal(releaseCamera(doc), 1);
  assert.equal(s.tracks[0].readyState, 'ended');
});

test('releaseCamera also stops a stream attached to a <video> and detaches it', () => {
  const s = fakeStream(1);
  const video = { srcObject: s };
  assert.equal(releaseCamera({ querySelectorAll: () => [video] }), 1);
  assert.equal(video.srcObject, null);
});

test('releaseCamera is idempotent and counts only live tracks', async () => {
  const s = fakeStream(1);
  const nav = fakeNav([s]);
  install(nav);
  await nav.mediaDevices.getUserMedia({});
  assert.equal(releaseCamera(), 1);
  assert.equal(releaseCamera(), 0);
});

test('install does nothing without mediaDevices', () => {
  assert.equal(install({}), false);
  assert.equal(install(undefined), false);
});

test('error messages name the cause and keep the technical detail', () => {
  const denied = cameraErrorMessage({ name: 'NotAllowedError', message: 'Permission denied' });
  assert.match(denied, /허용/);
  assert.match(denied, /\[NotAllowedError: Permission denied\]/);
  assert.match(cameraErrorMessage({ name: 'NotFoundError' }), /카메라를 찾지 못했습니다/);
  assert.match(cameraErrorMessage({ name: 'NotReadableError' }), /다른 앱이나 다른 탭/);
  const other = cameraErrorMessage(new TypeError('failed to fetch face_mesh.js'));
  assert.match(other, /얼굴 인식 부품/);
  assert.match(other, /\[TypeError: failed to fetch face_mesh\.js\]/);
  assert.match(cameraErrorMessage(null), /\[Error\]/);
  assert.ok(cameraErrorMessage({ name: 'X', message: 'a'.repeat(500) }).length < 400, 'long messages are cut');
});

test('both camera pages load the guard before WebGazer so it sees every stream', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const page of ['read.html', 'measure.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
    const guard = html.indexOf('/js/camera-guard.js');
    const gaze = html.indexOf('/vendor/webgazer.js');
    assert.ok(guard !== -1, `${page} loads camera-guard.js`);
    assert.ok(gaze !== -1 && guard < gaze, `${page}: camera-guard.js comes before webgazer.js`);
  }
});
