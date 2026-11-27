// 폴더 안의 HTML을 모두 PDF로 바꿉니다(A4, 바닥글에 쪽번호).
// 사용: node tools/study/render.js <HTML이 든 폴더>   (Playwright가 node에서 보여야 합니다)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const dir = path.resolve(process.argv[2] || '.');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
  const browser = await chromium.launch();
  for (const f of files) {
    const page = await browser.newPage();
    await page.goto('file://' + path.join(dir, f));
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
