'use strict';
// Teacher-only accuracy check: calibrate, show 9 targets one at a time, compare the gaze
// samples with the target positions. Nothing is uploaded: the only request is GET /api/me.
(function () {
  const RA = window.ReadingApp;
  const { api, h, copyText, runBallCalibration, startCapture, targetPositions, targetError, summarize, formatResult } = RA;
  const { percentOfDiagonal, accuracyVerdict, overThreshold, targetName, targetStates } = RA;
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['s-loading', 's-setup', 's-ready', 's-result', 's-error'];
  const CALIBRATION_SECONDS = 10;
  const SETTLE_MS = 800; // time for the eyes to arrive at a new target before samples count
  const COLLECT_MS = 1000;
  // Proposed levels (see accuracyVerdict in measure-math.js); labelled "참고 기준" on the page.
  const VERDICTS = [
    { key: 'good', title: '쓸 수 있는 수준', rule: '대각선의 3% 이하', text: '어느 줄을 읽는지 구분할 수 있습니다.' },
    { key: 'caution', title: '조심해서 사용', rule: '3% 초과 5% 이하', text: '줄 간격이 넓은 지문에서만 사용하세요.' },
    { key: 'poor', title: '쓰기 어려움', rule: '5% 초과', text: '거치대와 조명을 바꾸어 다시 점검하세요.' },
  ];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  RA.siteHeader.mount('site-header', { crumb: '정확도 점검' });

  let cameraOn = false;
  let running = false;

  function show(id) {
    for (const s of SCREENS) $(s).hidden = s !== id;
    $('topbar').hidden = id === 's-ready';
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

  // Step screen: all 9 targets stay visible (done = filled gray, current = orange ball with a ring,
  // upcoming = hollow ring), with "n / 9 번째 점" and a progress bar. Resolves to one samples array
  // per target.
  async function collectTargets(targets) {
    const marks = targets.map((t) => h('div', { class: 'target upcoming', style: `left:${t.x}px;top:${t.y}px` }));
    const count = h('p', { class: 'step-count' });
    const bar = h('div', { class: 'step-bar-fill' });
    const legend = h('div', { class: 'step-legend', 'aria-hidden': 'true' },
      h('span', {}, h('i', { class: 'lg-done' }), '완료'),
      h('span', {}, h('i', { class: 'lg-current' }), '지금 보는 점'),
      h('span', {}, h('i', { class: 'lg-upcoming' }), '앞으로 볼 점'));
    // WebGazer cannot be restarted after end(): stopping goes back to a fresh page.
    const stop = h('button', { type: 'button', class: 'ghost', onclick: backToSetup }, '점검 중단');
    const overlay = h('div', { class: 'step-overlay' }, ...marks,
      h('div', { class: 'step-panel' },
        h('p', { class: 'step-title' }, '주황색 점의 한가운데를 계속 바라보세요'),
        h('p', { class: 'step-sub' }, '점이 다음 위치로 옮겨 가면 눈으로 따라가세요. 고개는 움직이지 않습니다.'),
        count,
        h('div', { class: 'step-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': targets.length }, bar)),
      h('div', { class: 'step-foot' }, legend, stop));
    document.body.appendChild(overlay);
    const all = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        targetStates(i, targets.length).forEach((st, k) => { marks[k].className = `target ${st}`; });
        count.textContent = `${i + 1} / ${targets.length} 번째 점`;
        bar.style.width = `${((i + 1) / targets.length) * 100}%`;
        bar.parentNode.setAttribute('aria-valuenow', String(i + 1));
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

    const ok = summary.status === 'ok';
    const diagPx = Math.hypot(viewport.w, viewport.h);
    const tile = (label, value, unit, caption) => h('div', { class: 'stat-tile' },
      h('div', { class: 'stat-label' }, label),
      h('div', { class: 'stat-value' }, h('span', { class: 'stat-number' }, value), unit ? h('span', { class: 'stat-unit' }, unit) : null),
      h('div', { class: 'stat-caption' }, caption));
    $('summary').replaceChildren(
      ok ? tile('평균 오차', Math.round(summary.meanErrorPx), 'px', `${summary.usedTargets}개 점의 평균`) : tile('평균 오차', '—', null, '데이터 없음'),
      ok ? tile('화면 대각선 대비', summary.percentOfDiagonal.toFixed(1), '%', `화면 대각선 ${Math.round(diagPx).toLocaleString('ko-KR')}px 기준`)
        : tile('화면 대각선 대비', '—', null, '데이터 없음'),
      summary.degrees !== null
        ? tile('각도', summary.degrees.toFixed(1), '도', `눈에서 화면까지 ${inputs.distanceCm}cm 기준`)
        : tile('각도', '—', null, '화면 대각선과 거리를 모두 입력하면 계산합니다'));

    const note = $('device-note').value.trim();
    const sub = [note || '기기 메모 없음'];
    if (Number.isFinite(inputs.diagonalInches)) sub.push(`화면 대각선 ${inputs.diagonalInches}인치`);
    if (Number.isFinite(inputs.distanceCm)) sub.push(`눈에서 화면까지 ${inputs.distanceCm}cm`);
    sub.push(summary.noDataTargets === 0 ? `${targets.length}개 점 모두 측정` : `${targets.length}개 중 ${summary.usedTargets}개 점 측정`);
    $('result-sub').textContent = sub.join(' · ');

    $('summary-note').textContent = ok
      ? (summary.noDataTargets ? `데이터가 없는 ${summary.noDataTargets}개 지점은 평균에서 뺐습니다.` : '')
      : '시선 좌표가 한 번도 들어오지 않았습니다. 얼굴이 카메라에 보이는지, 조명이 충분한지 확인하고 다시 점검해 주세요.';
    $('summary-note').hidden = !$('summary-note').textContent;

    const cols = ['지점', '위치 (px)', '오차 (px)', '대각선 대비 (%)', '상태'];
    $('per-target').replaceChildren(
      h('thead', {}, h('tr', {}, ...cols.map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, ...errors.map((e, i) => {
        const pct = e.status === 'ok' ? percentOfDiagonal(e.errorPx, viewport.w, viewport.h) : null;
        const over = overThreshold(pct);
        return h('tr', { class: over ? 'over' : null },
          h('td', {}, `${i + 1} ${targetName(targets[i])}`),
          h('td', {}, `${Math.round(targets[i].x)}, ${Math.round(targets[i].y)}`),
          h('td', {}, e.status === 'ok' ? Math.round(e.errorPx) : '—'),
          h('td', {}, pct === null ? '—' : pct.toFixed(1)),
          h('td', {}, e.status !== 'ok' ? '데이터 없음' : over ? '기준 초과' : '양호'));
      })));

    const level = ok ? accuracyVerdict(summary.percentOfDiagonal) : null;
    $('verdicts').replaceChildren(...VERDICTS.map((v) => h('li', { class: `verdict ${v.key}${v.key === level ? ' current' : ''}` },
      h('span', { class: 'verdict-shape', 'aria-hidden': 'true' }),
      h('div', {},
        h('div', { class: 'verdict-title' }, h('strong', {}, v.title), v.key === level ? h('span', { class: 'verdict-tag' }, '현재 결과') : null),
        h('p', {}, h('span', { class: 'ref-label' }, `참고 기준 ${v.rule}`), ' ', v.text)))));
    $('result-text').value = text;
    $('copy-msg').textContent = '';
    show('s-result');
  }

  async function onCopy() {
    const ta = $('result-text');
    const ok = await copyText(ta.value);
    if (!ok) { $('copy-details').open = true; ta.focus(); ta.select(); }
    $('copy-msg').textContent = ok ? '결과를 복사했습니다. 메모나 메신저에 붙여 넣을 수 있습니다.' : '자동 복사가 막혔습니다. 선택된 글을 직접 복사해 주세요.';
    $('copy-msg').classList.toggle('ok', ok);
  }

  // WebGazer cannot be restarted reliably after end(), so a fresh page load is the clean retry.
  function backToSetup() {
    stopCamera();
    location.reload();
  }

  async function init() {
    // Teacher-only: api.get sends a 401 to the login page.
    try {
      const me = await api.get('/api/me');
      RA.siteHeader.setRole(me && me.role);
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
