'use strict';
// Teacher-only accuracy check: calibrate, show 9 targets one at a time, compare the gaze
// samples with the target positions. Nothing is uploaded: the only request is GET /api/me.
(function () {
  const RA = window.ReadingApp;
  const { api, h, copyText, runBallCalibration, startCapture, targetPositions, targetError, summarize, formatResult } = RA;
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['s-loading', 's-setup', 's-ready', 's-result', 's-error'];
  const CALIBRATION_SECONDS = 10;
  const SETTLE_MS = 800; // time for the eyes to arrive at a new target before samples count
  const COLLECT_MS = 1000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let cameraOn = false;
  let running = false;

  function show(id) {
    for (const s of SCREENS) $(s).hidden = s !== id;
  }

  function showError(title, text) {
    $('error-title').textContent = title;
    $('error-text').textContent = text;
    show('s-error');
  }

  function stopCamera() {
    if (!cameraOn) return;
    cameraOn = false;
    try { window.webgazer.end(); } catch { /* already stopped */ }
    for (const v of document.querySelectorAll('video')) {
      const stream = v.srcObject;
      if (stream && stream.getTracks) stream.getTracks().forEach((t) => t.stop());
      v.srcObject = null;
    }
  }
  window.addEventListener('pagehide', stopCamera);

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
      throw new Error(err && err.name === 'NotAllowedError'
        ? '카메라 사용이 허용되지 않았습니다. 주소창의 카메라 아이콘에서 허용해 주세요.'
        : '카메라를 시작하지 못했습니다. 다른 앱이 카메라를 쓰고 있지 않은지 확인해 주세요.');
    }
    wg.showVideoPreview(true).showPredictionPoints(false);
  }

  async function onStart() {
    $('setup-error').hidden = true;
    $('start').disabled = true;
    try {
      await startCamera();
    } catch (err) {
      $('start').disabled = false;
      $('setup-error').textContent = err.message;
      $('setup-error').hidden = false;
      return;
    }
    show('s-ready');
  }

  // Shows the targets one by one; resolves to one samples array per target.
  async function collectTargets(targets) {
    const overlay = h('div', { class: 'calib-overlay' });
    const dot = h('div', { class: 'measure-dot' });
    const note = h('p', { class: 'calib-note' });
    overlay.append(dot, note);
    document.body.appendChild(overlay);
    const all = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        dot.style.transform = `translate(${targets[i].x}px, ${targets[i].y}px)`;
        note.textContent = `점의 한가운데를 계속 바라보세요 (${i + 1} / ${targets.length})`;
        await sleep(SETTLE_MS);
        const cap = startCapture(window.webgazer);
        await sleep(COLLECT_MS);
        all.push(cap.stop());
      }
    } finally {
      overlay.remove();
    }
    return all;
  }

  async function onCalibrate() {
    if (running) return;
    running = true;
    $('calibrate').disabled = true;
    try {
      for (const s of SCREENS) $(s).hidden = true;
      window.webgazer.showVideoPreview(false);
      await runBallCalibration(window.webgazer, { seconds: CALIBRATION_SECONDS });
      const viewport = { w: window.innerWidth, h: window.innerHeight };
      const targets = targetPositions(viewport.w, viewport.h);
      const samples = await collectTargets(targets);
      stopCamera();
      if (window.innerWidth !== viewport.w || window.innerHeight !== viewport.h) {
        return showError('화면 크기가 바뀌었습니다', '점검 중에 창 크기가 바뀌어 결과를 쓸 수 없습니다. 다시 점검해 주세요.');
      }
      showResult(viewport, targets, samples);
    } finally {
      running = false;
      $('calibrate').disabled = false;
    }
  }

  function numberOrNaN(id) {
    const raw = $(id).value.trim();
    return raw === '' ? NaN : Number(raw);
  }

  function showResult(viewport, targets, samples) {
    const errors = targets.map((t, i) => targetError(t, samples[i]));
    const inputs = {
      screenW: window.screen.width,
      screenH: window.screen.height,
      diagonalInches: numberOrNaN('diagonal'),
      distanceCm: numberOrNaN('distance'),
    };
    const summary = summarize(errors, viewport, inputs);
    const text = formatResult({
      deviceNote: $('device-note').value, viewport, targets, errors, summary, inputs,
      when: new Date().toLocaleString('ko-KR'),
    });

    const metric = (k, v) => h('div', { class: 'metric' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
    const cards = [];
    if (summary.status === 'ok') {
      cards.push(metric('평균 오차 (px)', `${Math.round(summary.meanErrorPx)} px`));
      cards.push(metric('화면 대각선 대비', `${summary.percentOfDiagonal.toFixed(1)}%`));
      if (summary.degrees !== null) cards.push(metric('각도', `${summary.degrees.toFixed(1)}°`));
    } else {
      cards.push(metric('평균 오차', '데이터 없음'));
    }
    $('summary').replaceChildren(...cards);
    $('summary-note').textContent = summary.status === 'ok'
      ? `${summary.usedTargets}개 지점의 평균입니다.${summary.noDataTargets ? ` 데이터가 없는 ${summary.noDataTargets}개 지점은 뺐습니다.` : ''}`
      : '시선 좌표가 한 번도 들어오지 않았습니다. 얼굴이 카메라에 보이는지, 조명이 충분한지 확인하고 다시 점검해 주세요.';

    $('per-target').replaceChildren(
      h('tr', {}, h('th', {}, '#'), h('th', {}, '위치 (px)'), h('th', {}, '오차'), h('th', {}, '유효 샘플')),
      ...errors.map((e, i) => h('tr', {},
        h('td', {}, i + 1),
        h('td', {}, `${Math.round(targets[i].x)}, ${Math.round(targets[i].y)}`),
        h('td', {}, e.status === 'ok' ? `${Math.round(e.errorPx)} px` : '데이터 없음'),
        h('td', {}, `${e.n}/${e.total}`))));
    $('result-text').value = text;
    $('copy-msg').textContent = '';
    show('s-result');
  }

  async function onCopy() {
    const ta = $('result-text');
    const ok = await copyText(ta.value);
    if (!ok) { ta.focus(); ta.select(); }
    $('copy-msg').textContent = ok ? '복사했습니다.' : '자동 복사가 막혔습니다. 선택된 글을 직접 복사해 주세요.';
  }

  // WebGazer cannot be restarted reliably after end(), so a fresh page load is the clean retry.
  function backToSetup() {
    stopCamera();
    location.reload();
  }

  async function init() {
    // Teacher-only: api.get sends a 401 to the login page.
    try {
      await api.get('/api/me');
    } catch (err) {
      if (err.status === 401) return; // redirecting
      return showError('불러오지 못했습니다', err.message);
    }
    $('start').addEventListener('click', onStart);
    $('calibrate').addEventListener('click', onCalibrate);
    $('copy').addEventListener('click', onCopy);
    $('again').addEventListener('click', backToSetup);
    $('error-back').addEventListener('click', backToSetup);
    show('s-setup');
  }

  init();
})();
