'use strict';
(function () {
  const { api } = window.ReadingApp;
  const form = document.getElementById('accept');
  const msg = document.getElementById('msg');
  const done = document.getElementById('done');
  const token = new URLSearchParams(location.search).get('token');

  function fail(text) {
    msg.textContent = text;
    msg.hidden = false;
  }

  if (!token) {
    form.hidden = true;
    fail('초대 링크가 올바르지 않습니다.');
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.hidden = true;
    const pw = document.getElementById('password').value;
    if (pw.length < 8) return fail('비밀번호는 8자 이상이어야 합니다.');
    if (pw !== document.getElementById('password2').value) return fail('비밀번호 확인이 일치하지 않습니다.');
    try {
      await api.post(`/api/invites/${encodeURIComponent(token)}/accept`, { password: pw }, { noRedirect: true });
      form.hidden = true;
      done.hidden = false;
    } catch (err) {
      if (err.status === 404) fail('존재하지 않는 초대입니다.');
      else if (err.status === 410) fail('만료되었거나 이미 사용된 초대입니다. 관리자에게 새 초대를 요청하세요.');
      else if (err.status === 409) fail('이미 계정이 있습니다. 로그인해 주세요.');
      else fail(err.message);
    }
  });
})();
