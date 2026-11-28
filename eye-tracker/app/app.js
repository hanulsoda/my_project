const $ = id => document.getElementById(id);
const dot = $('dot'), msg = $('msg');
let calPoints = [];

$('start').onclick = async () => {
  webgazer.setGazeListener(d => {
    if (!d) return;
    dot.style.display = 'block';
    dot.style.left = d.x + 'px';
    dot.style.top = d.y + 'px';
  }).saveDataAcrossSessions(false);
  await webgazer.begin();
  webgazer.showVideoPreview(true).showPredictionPoints(false);
  msg.textContent = '실행 중. 정확도를 위해 "보정"으로 9개 점을 각각 5번 클릭하세요.';
};

$('stop').onclick = () => {
  webgazer.end();
  dot.style.display = 'none';
  calPoints.forEach(p => p.remove());
  calPoints = [];
  msg.textContent = '중지됨';
};

$('calib').onclick = () => {
  calPoints.forEach(p => p.remove());
  calPoints = [];
  const xs = [0.1, 0.5, 0.9], ys = [0.15, 0.5, 0.9];
  let remaining = 9;
  ys.forEach(y => xs.forEach(x => {
    const el = document.createElement('div');
    el.className = 'cal';
    el.style.display = 'block';
    el.style.left = x * innerWidth + 'px';
    el.style.top = y * innerHeight + 'px';
    let clicks = 0;
    el.onclick = () => {
      if (++clicks >= 5) {
        el.classList.add('done');
        el.onclick = null;
        if (--remaining === 0) {
          calPoints.forEach(p => p.remove());
          calPoints = [];
          msg.textContent = '보정 완료';
        }
      }
      el.textContent = '';
      el.style.opacity = 1 - clicks * 0.12;
    };
    document.body.appendChild(el);
    calPoints.push(el);
  }));
  msg.textContent = '각 점을 바라보며 5번씩 클릭하세요.';
};
