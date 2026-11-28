'use strict';
// Camera guard. Load it BEFORE webgazer.js.
//  1. Remembers every stream the page opens through getUserMedia, so a failed start (WebGazer can
//     fail after it already holds the stream, before the stream is attached to a <video>) cannot
//     leave the camera light on: releaseCamera() stops all of them.
//  2. Turns a start error into a message that names the cause instead of one generic sentence.
(function (root) {
  const streams = new Set();

  function install(nav) {
    const md = nav && nav.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function' || md.getUserMedia.__guarded) return false;
    const original = md.getUserMedia.bind(md);
    const wrapped = async function (constraints) {
      const stream = await original(constraints);
      streams.add(stream);
      return stream;
    };
    wrapped.__guarded = true;
    md.getUserMedia = wrapped;
    return true;
  }

  // Stops every live track of every remembered stream, plus any stream still attached to a <video>.
  // Returns how many live tracks it stopped. Safe to call at any time, any number of times.
  function releaseCamera(doc) {
    let stopped = 0;
    const stopStream = (s) => {
      if (!s || typeof s.getTracks !== 'function') return;
      for (const t of s.getTracks()) {
        if (t.readyState !== 'ended') { t.stop(); stopped += 1; }
      }
    };
    for (const s of streams) stopStream(s);
    streams.clear();
    if (doc && typeof doc.querySelectorAll === 'function') {
      for (const v of doc.querySelectorAll('video')) {
        stopStream(v.srcObject);
        v.srcObject = null;
      }
    }
    return stopped;
  }

  function cameraErrorMessage(err) {
    const name = err && err.name ? String(err.name) : 'Error';
    const msg = err && err.message ? String(err.message).slice(0, 120) : '';
    const detail = ` [${name}${msg ? ': ' + msg : ''}]`;
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return '카메라 사용이 허용되지 않았습니다. 주소창의 카메라 아이콘에서 허용해 주세요.' + detail;
      case 'NotFoundError':
      case 'OverconstrainedError':
        return '이 기기에서 카메라를 찾지 못했습니다. 카메라가 있는 기기인지, 연결되어 있는지 확인해 주세요.' + detail;
      case 'NotReadableError':
      case 'AbortError':
        return '다른 앱이나 다른 탭이 카메라를 쓰고 있습니다. 카메라를 쓰는 다른 창을 닫고 이 페이지를 새로고침한 뒤 다시 시도해 주세요.' + detail;
      default:
        return '카메라나 얼굴 인식 부품을 시작하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도하고, 계속 같으면 아래 오류 문구를 알려 주세요.' + detail;
    }
  }

  const exported = { install, releaseCamera, cameraErrorMessage };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) {
    root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
    install(root.navigator);
  }
})(typeof window !== 'undefined' ? window : undefined);
