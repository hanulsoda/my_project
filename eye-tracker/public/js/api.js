'use strict';
// JSON fetch wrapper for the teacher API. Cookies (sid) travel automatically (same origin).
(function (root) {
  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  // opts.noRedirect: a 401 is an ordinary error (used by the login form itself).
  async function request(method, path, body, opts = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      throw new ApiError(0, '서버에 연결할 수 없습니다.');
    }
    if (res.status === 401 && !opts.noRedirect) {
      location.href = '/index.html';
      throw new ApiError(401, 'login required');
    }
    if (res.status === 204) return null;
    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `요청 실패 (${res.status})`);
    return data;
  }

  // A student signed in from the academy site may not list children (the server answers 403
  // "student_session"). The reading page asks for the list only to find its own child, which
  // /api/me carries for a student, so that one call is answered from there.
  async function getChildren(opts) {
    try {
      return await request('GET', '/api/children', undefined, opts);
    } catch (err) {
      if (err.status !== 403 || err.message !== 'student_session') throw err;
      const me = await request('GET', '/api/me', undefined, opts);
      if (me && me.role === 'student' && typeof document !== 'undefined') document.documentElement.dataset.role = 'student';
      return me && me.role === 'student' && me.child ? [me.child] : [];
    }
  }

  const api = {
    get: (path, opts) => (path === '/api/children' ? getChildren(opts) : request('GET', path, undefined, opts)),
    post: (path, body, opts) => request('POST', path, body ?? {}, opts),
    patch: (path, body, opts) => request('PATCH', path, body, opts),
    del: (path, opts) => request('DELETE', path, undefined, opts),
  };

  const GRADE_LABEL = { elementary: '초등', middle: '중등', high: '고등' };
  const exported = { api, ApiError, GRADE_LABEL };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root) root.ReadingApp = Object.assign(root.ReadingApp || {}, exported);
})(typeof window !== 'undefined' ? window : undefined);
