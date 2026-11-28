'use strict';
// Measurement flow: consent check -> choose passage -> camera -> ball calibration -> (optional
// "색으로 보기" rehearsal, nothing recorded) -> read (one or more pages) -> upload.
// The camera <video> is a local preview only. The only things sent are {passageId, screen,
// words (boxes), samples ({t,x,y})}; in "fill" mode words and samples also carry `page`.
(function () {
  const {
    api, h, GRADE_LABEL, layoutPassage, fitFontPx, makeMeasure, planFill, FILL, runBallCalibration, startCapture,
    startPractice, PRACTICE_TEXT, CALIBRATION_SECONDS, safeMargins, watchGeometry, geometryOf,
  } = window.ReadingApp;
  const $ = (id) => document.getElementById(id);
  const SCREENS = ['s-loading', 's-error', 's-consent', 's-setup', 's-ready', 's-sending', 's-fail', 's-finish'];
  const DONE_BAR_PX = 64; // keep the passage clear of the "다음"/"다 읽었어요" button (fixed, bottom-right)
  const TAP_GUARD_MS = 500; // clicks this soon after a screen/page change are ignored (double tap)
  const DONE_MIN_SHOWN_MS = 1000; // 다 읽었어요 only works once the last page has been shown this long

  let child = null;
  let passages = [];
  let passage = null;
  let capture = null;
  let screenAtStart = null;
  let payload = null;
  let cameraOn = false;
  let fillMode = true; // 글자 크기: 꽉 채우기 (fill.js planFill) or 지문 기본 크기 (fitFontPx)
  let practiceOn = false;
  let plan = null; // fill plan
  let pageIdx = 0;
  let pageWords = []; // word boxes of the pages shown so far (fill mode)
  let practice = null;
  let geometry = null; // watchGeometry() from planning to the end of the measurement
  let shownAt = 0; // when the current screen/page was shown (performance.now)

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
    if (practice) { practice.stop(); practice = null; }
    if (geometry) { geometry.stop(); geometry = null; }
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

  // 지문 기본 크기: lays the passage out hidden and checks every word fits in the viewport without
  // scrolling: gaze coordinates are viewport coordinates, so a scrolled page would break the word
  // boxes. If it does not fit at the passage's own size, the font is stepped down (see fitFontPx)
  // to a floor of 85% (never below 16px). The uploaded word boxes always come from the final layout.
  function renderPassage() {
    const el = $('passage');
    setFillStyle(false);
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

  // ---- 꽉 채우기: big text that fills the screen, pages when needed (fill.js) -----------------
  const sideMargin = () => Math.max(24, Math.round(0.04 * window.innerWidth));

  function setFillStyle(on) {
    const el = $('passage');
    $('passage-wrap').classList.toggle('fill', on);
    el.style.left = on ? `${sideMargin()}px` : '';
    el.style.width = on ? `${window.innerWidth - 2 * sideMargin()}px` : '';
    el.style.top = on ? '0px' : '';
    el.style.wordSpacing = on ? `${FILL.WORD_SPACING_EM}em` : '';
  }

  // Plans `text` for the current viewport, laid out hidden. Returns the fill.js plan.
  function planText(text) {
    $('passage-wrap').hidden = false;
    $('passage-wrap').classList.add('measuring');
    setFillStyle(true);
    return planFill({
      measure: makeMeasure($('passage'), text),
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      bottomReserve: DONE_BAR_PX,
      right: window.innerWidth - sideMargin(),
      minPx: FILL.FLOOR_PX[child.gradeBand] || FILL.FLOOR_PX.elementary,
      minPitchPx: FILL.PITCH_GAIN * Number(passage.fontPx) * Number(passage.lineHeight),
      topMarginPx: safeMargins(window.innerHeight).top,
      bottomMarginPx: safeMargins(window.innerHeight).bottom,
      minViewportW: FILL.MIN_VIEWPORT_W,
    });
  }

  // Lays out words [firstWord, endWord) with plan p; returns their viewport boxes.
  function showFillText(p, words, firstWord, endWord) {
    const el = $('passage');
    setFillStyle(true);
    el.style.fontSize = `${p.fontPx}px`;
    el.style.lineHeight = String(p.lineHeight);
    el.style.top = `${p.top}px`;
    return layoutPassage(el, words.slice(firstWord, endWord).join(' '));
  }

  const wordsOf = (text) => String(text).split(/\s+/).filter(Boolean);

  // Shows page n of the passage; its boxes get the passage-wide i, continuing line ids and `page`.
  function showPage(n) {
    pageIdx = n;
    const pg = plan.pages[n];
    const boxes = showFillText(plan, wordsOf(passage.text), pg.firstWord, pg.endWord);
    const lineBase = pageWords.length ? pageWords[pageWords.length - 1].line + 1 : 0;
    for (const b of boxes) pageWords.push({ ...b, i: pg.firstWord + b.i, line: lineBase + b.line, page: n });
    setButtons(n === plan.pages.length - 1 ? 'done' : 'next');
  }

  // Shows one of the bottom buttons and gives it the keyboard focus (Enter/Space work).
  function setButtons(which) {
    for (const id of ['begin', 'next', 'done']) $(id).hidden = id !== which;
    shownAt = performance.now();
    focusPrimary();
  }

  function focusPrimary() {
    const btn = ['begin', 'next', 'done'].map($).find((b) => !b.hidden);
    if (btn) btn.focus({ preventScroll: true });
  }

  const tooSoon = (ms = TAP_GUARD_MS) => performance.now() - shownAt < ms;

  // The layout, the calibration and the gaze are only valid for the geometry the passage was
  // planned for: any change (even one undone) ends the measurement without upload.
  function geometryBroken() {
    return !geometry || geometry.changed();
  }

  function abortChangedScreen() {
    stopCamera();
    showError('화면이 바뀌었어요', '측정 중에 화면 크기나 방향이 바뀌어 이 기록은 쓸 수 없습니다. 처음부터 다시 시작해 주세요.');
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
    fillMode = document.querySelector('input[name="size"]:checked').value === 'fill';
    practiceOn = $('practice').checked;
    if (geometry) geometry.stop();
    geometry = watchGeometry(window); // baseline: the geometry the passage is planned for
    plan = fillMode ? planText(passage.text) : null;
    if (fillMode ? !plan.ok : !renderPassage()) {
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

  // ---- calibration, rehearsal and reading -------------------------------------------------
  async function onCalibrate() {
    show(null); // the calibration overlay takes the whole screen
    await runBallCalibration(window.webgazer, { seconds: CALIBRATION_SECONDS[child.gradeBand] });
    window.webgazer.showVideoPreview(false); // no camera picture on top of the text
    if (practiceOn) showPractice(); else beginReading();
  }

  // "연습해 보기": a short practice text (not the passage, so the child does not pre-read it) with
  // the looked-at word coloured. Its gaze goes to the highlighter only and is never stored.
  function showPractice() {
    let boxes;
    if (fillMode) {
      const p = planText(PRACTICE_TEXT);
      const words = wordsOf(PRACTICE_TEXT);
      const pg = p.ok ? p.pages[0] : { firstWord: 0, endWord: words.length };
      boxes = showFillText(p.ok ? p : plan, words, pg.firstWord, pg.endWord);
    } else {
      boxes = layoutPassage($('passage'), PRACTICE_TEXT);
    }
    const spans = [...$('passage').querySelectorAll('span.w')];
    const maxDist = 2 * Math.max(...boxes.map((b) => b.h), 1);
    $('passage-wrap').hidden = false;
    $('passage-wrap').classList.remove('measuring');
    setButtons('begin');
    practice = startPractice(window.webgazer, spans, boxes, { maxDist });
  }

  function onBegin() {
    if (!practice || tooSoon()) return;
    practice.stop();
    practice = null;
    beginReading();
  }

  function beginReading() {
    if (geometryBroken()) return abortChangedScreen();
    screenAtStart = geometryOf(window); // before the layout: the layout must be for this geometry
    pageWords = [];
    // Laid out while displayed (hidden boxes measure 0x0), then revealed.
    $('passage-wrap').hidden = false;
    $('passage-wrap').classList.add('measuring');
    if (fillMode) showPage(0);
    else {
      if (!renderPassage()) return abortChangedScreen();
      setButtons('done');
    }
    $('passage-wrap').classList.remove('measuring');
    focusPrimary(); // could not take focus while the page was hidden for layout
    capture = startCapture(window.webgazer, undefined, { paged: fillMode });
  }

  function onNext() {
    if (!plan || !capture || pageIdx >= plan.pages.length - 1 || tooSoon()) return;
    if (geometryBroken()) { capture.stop(); return abortChangedScreen(); }
    capture.setPage(pageIdx + 1);
    showPage(pageIdx + 1);
  }

  async function onDone() {
    if (!capture || tooSoon(DONE_MIN_SHOWN_MS)) return;
    const samples = capture.stop();
    capture = null;
    const now = geometryOf(window);
    const screen = { w: now.w, h: now.h };
    if (geometryBroken() || screen.w !== screenAtStart.w || screen.h !== screenAtStart.h) return abortChangedScreen();
    const words = fillMode ? pageWords : layoutPassage($('passage'), passage.text);
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
    $('begin').addEventListener('click', onBegin);
    $('next').addEventListener('click', onNext);
    $('done').addEventListener('click', onDone);
    $('retry').addEventListener('click', upload);
    show('s-setup');
  }

  init();
})();
