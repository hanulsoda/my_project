'use strict';
// The one small HTML page /sso and /academy answer with when they cannot sign someone in.
// It never says why (no detail for a probing client); the only dynamic value is ACADEMY_URL,
// which is validated by config.js and HTML-escaped here.
const MESSAGES = {
  retry: '다힘 사이트에서 다시 들어와 주세요',
  notLinked: '아직 측정 대상으로 등록되지 않았어요. 선생님께 말씀해 주세요.',
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function noticePage(kind, academyUrl) {
  const text = MESSAGES[kind] ?? MESSAGES.retry;
  const link = academyUrl
    ? `<p><a class="btn" href="${escapeHtml(academyUrl)}">다힘 사이트로 가기</a></p>`
    : '';
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>읽기 시선 기록</title>
<link rel="stylesheet" href="/css/app.css">
</head>
<body>
<main>
  <div class="card" style="max-width:420px;margin:48px auto">
    <h1>읽기 시선 기록</h1>
    <p>${escapeHtml(text)}</p>
    ${link}
  </div>
</main>
</body>
</html>
`;
}

function sendNotice(res, status, kind, academyUrl) {
  res.status(status);
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.send(noticePage(kind, academyUrl));
}

module.exports = { noticePage, sendNotice, escapeHtml, MESSAGES };
