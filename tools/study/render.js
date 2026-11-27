// 폴더 안의 HTML을 모두 PDF로 바꿉니다(A4, 바닥글에 쪽번호).
// 사용: node tools/study/render.js <HTML이 든 폴더>
// Playwright는 package.json에 넣지 않았습니다(받은 Chromium이 이 컴퓨터의 것과 달라 렌더가 깨질 수 있음).
// 따로 `npm i -g playwright`로 설치하고 `NODE_PATH=$(npm root -g)`를 주세요.
// 이 컴퓨터에 맞는 Chromium도 있어야 합니다(다른 곳에 있으면 PLAYWRIGHT_BROWSERS_PATH).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e;
  console.error('Playwright를 찾지 못했습니다. `npm i -g playwright`로 설치하고 NODE_PATH=$(npm root -g) 를 준 뒤 다시 실행하세요.');
  console.error('이 컴퓨터에 맞는 Chromium도 필요합니다(설치 위치가 다르면 PLAYWRIGHT_BROWSERS_PATH를 지정).');
  process.exit(1);
}

(async () => {
  const dir = path.resolve(process.argv[2] || '.');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
  const browser = await chromium.launch();
  for (const f of files) {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(dir, f)).href);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.pdf({
      path: path.join(dir, f.replace(/\.html$/, '.pdf')), format: 'A4', printBackground: true, preferCSSPageSize: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:7px;width:100%;text-align:center;color:#888">AI가 정리한 학습 자료입니다. 선생님 확인 후 사용하세요. &nbsp; <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    console.log('pdf', f);
    await page.close();
  }
  await browser.close();
})();
