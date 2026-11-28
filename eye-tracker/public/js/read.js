'use strict';
// Measurement flow: consent check -> choose passage -> camera -> ball calibration -> read -> upload.
// The camera <video> is a local preview only. The only things sent are {passageId, screen,
// words (boxes), samples ({t,x,y})}.
(function () {
  const { api, h, GRADE_LABEL, layoutPassage, fitFontPx, runBallCalibration, startCapture, CALIBRATION_SECONDS } = window.ReadingApp;
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['s-loading', 's-error', 's-consent', 's-setup', 's-ready', 's-sending', 's-fail', 's-finish'];
  const DONE_BAR_PX = 64; // keep the passage clear of the "다 읽었어요" button (fixed, bottom-right)

  let child = null;
  let passages = [];
  let passage = null;
  let capture = null;
  let screenAtStart = null;
  let payload = null;
  let cameraOn = false;

  function show(id) {
    for (const s of SCREENS) $(s).hidden = s !== id;
    $('passage-wrap').hidden = true;
  }

  function showError(title, text) {
    $('error-title').textContent = title;
    $('error-text').textContent = text;
    show('s-error');
  }

  function stopCamera() {
    const wasOn = cameraOn;
    cameraOn = false;
    if (wasOn) { try { window.webgazer.end(); } catch { /* already stopped */ } }
    // Always release, even when the start failed: WebGazer can hold a stream it never attached
    // to a <video>, which would leave the camera light on.
    window.ReadingApp.releaseCamera(document);
  }
  window.addEventListener('pagehide', stopCamera);

  // ---- setup ------------------------------------------------------------------------------
  function fillPassageSelect() {
    const kind = document.querySelector('input[name="kind"]:checked').value;
    $('passage-select').replaceChildren(
      ...passages.filter((p) => p.kind === kind).map((p) => h('option', { value: p.id }, p.title)));
  }

  function setupError(text) {
    $('setup-error').textContent = text || '';
    $('setup-error').hidden = !text;
  }

  // Lays the passage out hidden and checks every word fits in the viewport without scrolling:
  // gaze coordinates are viewport coordinates, so a scrolled page would break the word boxes.
  // If it does not fit at the passage's own size, the font is stepped down (see fitFontPx) to a
  // floor of 85% (never below 16px). The uploaded word boxes always come from the final layout.
  function renderPassage() {
    const el = $('passage');
    el.style.lineHeight = String(Number(passage.lineHeight));
    $('passage-wrap').hidden = false;
    $('passage-wrap').classList.add('measuring');
    const fit = fitFontPx({
      passageFontPx: Number(passage.fontPx),
      usableW: window.innerWidth,
      usableH: window.innerHeight - DONE_BAR_PX,
      measure: (px) => {
        el.style.fontSize = `${px}px`;
        return layoutPassage(el, passage.text);
      },
    });
    el.style.fontSize = `${fit.fontPx}px`;
    if (fit.ok) layoutPassage(el, passage.text);
    return fit.ok;
  }

  async function startCamera() {
    const wg = window.webgazer;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('카메라는 https 주소 또는 localhost에서만 쓸 수 있습니다.');
    }
    wg.params.faceMeshSolutionPath = '/vendor/mediapipe/face_mesh';
    wg.saveDataAcrossSessions(false);
    wg.setGazeListener(() => {});
    cameraOn = true;
    try {
      await wg.begin();
    } catch (err) {
      stopCamera();
      throw new Error(window.ReadingApp.cameraErrorMessage(err));
    }
    wg.showVideoPreview(true).showPredictionPoints(false);
  }

  async function onStart() {
    setupError('');
    passage = passages.find((p) => p.id === $('passage-select').value);
    if (!passage) return setupError('지문을 선택해 주세요.');
    if (!renderPassage()) {
      show('s-setup');
      return setupError('화면이 작아 지문이 다 들어오지 않습니다. 기기를 가로로 돌려 보거나 더 큰 화면에서 측정해 주세요.');
    }
    show('s-setup');
    $('start').disabled = true;
    try {
      await startCamera();
    } catch (err) {
      $('start').disabled = false;
      return setupError(err.message);
    }
    show('s-ready');
  }

  // ---- calibration and reading ------------------------------------------------------------
  async function onCalibrate() {
    show(null); // the calibration overlay takes the whole screen
    await runBallCalibration(window.webgazer, { seconds: CALIBRATION_SECONDS[child.gradeBand] });
    window.webgazer.showVideoPreview(false); // no camera picture on top of the text
    $('passage-wrap').hidden = false;
    $('passage-wrap').classList.remove('measuring');
    screenAtStart = { w: window.innerWidth, h: window.innerHeight };
    capture = startCapture(window.webgazer);
  }

  async function onDone() {
    const samples = capture.stop();
    const screen = { w: window.innerWidth, h: window.innerHeight };
    if (screen.w !== screenAtStart.w || screen.h !== screenAtStart.h) {
      stopCamera();
      return showError('화면 크기가 바뀌었습니다', '측정 중에 창 크기가 바뀌어 기록을 쓸 수 없습니다. 처음부터 다시 측정해 주세요.');
    }
    const words = layoutPassage($('passage'), passage.text);
    payload = { passageId: passage.id, screen, words, samples };
    await upload();
  }

  async function upload() {
    show('s-sending');
    try {
      await api.post(`/api/children/${child.id}/sessions`, payload);
    } catch (err) {
      if (err.status === 403) { stopCamera(); return show('s-consent'); }
      $('fail-text').textContent = `${err.message} 같은 기록으로 다시 저장해 볼 수 있습니다.`;
      return show('s-fail');
    }
    payload = null;
    stopCamera();
    show('s-finish'); // deliberately no scores for the child
  }

  // ---- init -------------------------------------------------------------------------------
  async function init() {
    const id = new URLSearchParams(location.search).get('child');
    if (!/^\d{1,15}$/.test(id || '')) return showError('아이를 찾을 수 없습니다', '아이 목록에서 측정 시작을 눌러 주세요.');
    try {
      const list = await api.get('/api/children');
      child = list.find((c) => String(c.id) === id);
      if (!child) return showError('아이를 찾을 수 없습니다', '아이 목록에서 다시 선택해 주세요.');
      if (!child.consentDate) return show('s-consent');
      passages = await api.get(`/api/passages?gradeBand=${encodeURIComponent(child.gradeBand)}`);
    } catch (err) {
      return showError('불러오지 못했습니다', err.message);
    }
    $('child-line').textContent = `${child.code} · ${child.initials} · ${GRADE_LABEL[child.gradeBand] || ''} · 동의일 ${child.consentDate}`;
    fillPassageSelect();
    for (const r of document.querySelectorAll('input[name="kind"]')) r.addEventListener('change', fillPassageSelect);
    $('start').addEventListener('click', onStart);
    $('calibrate').addEventListener('click', onCalibrate);
    $('done').addEventListener('click', onDone);
    $('retry').addEventListener('click', upload);
    show('s-setup');
  }

  init();
})();
