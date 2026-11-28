'use strict';
(function () {
  const { api } = window.ReadingApp;
  const form = document.getElementById('login');
  const msg = document.getElementById('msg');

  // Already signed in: go straight to the list.
  api.get('/api/me', { noRedirect: true }).then(() => { location.href = '/children.html'; }, () => {});

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.hidden = true;
    try {
      await api.post('/api/login', {
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }, { noRedirect: true });
      location.href = '/children.html';
    } catch (err) {
      msg.textContent = err.status === 401 ? '이메일 또는 비밀번호가 맞지 않습니다.' : err.message;
      msg.hidden = false;
    }
  });
})();
