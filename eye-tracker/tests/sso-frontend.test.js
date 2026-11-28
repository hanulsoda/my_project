'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

function withFetch(handler, fn) {
  const prev = global.fetch;
  global.fetch = async (p) => {
    const { status, body } = handler(p);
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return fn().finally(() => { global.fetch = prev; });
}

test('api.js: a student session gets its own child for the reading page\'s list call', async () => {
  delete require.cache[require.resolve('../public/js/api.js')];
  const { api } = require('../public/js/api.js');
  const child = { id: 7, code: 'S1', initials: 'KJ', gradeBand: 'elementary', consentDate: '2026-03-01' };
  await withFetch((p) => (p === '/api/children'
    ? { status: 403, body: { error: 'student_session' } }
    : { status: 200, body: { role: 'student', child } }), async () => {
    assert.deepEqual(await api.get('/api/children'), [child]);
  });
  // Any other 403 (or a teacher) is untouched.
  await withFetch(() => ({ status: 403, body: { error: 'admin only' } }), async () => {
    await assert.rejects(api.get('/api/children'), (err) => err.status === 403);
  });
  await withFetch(() => ({ status: 200, body: [{ id: 1 }] }), async () => {
    assert.deepEqual(await api.get('/api/children'), [{ id: 1 }]);
  });
});

test('children page: academy student registration form and logout to the academy', () => {
  const html = read('children.html');
  for (const id of ['student-card', 'link-form', 'link-code', 'link-initials', 'link-band', 'link-consent']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /측정 대상으로 등록/);
  assert.doesNotMatch(html, /id="link-name"|이름 <input/, 'no field for the student\'s real name');
  const js = read('js/children.js');
  // LOGOUT lives in the shared site header: POST /api/logout, then the academy site.
  const header = read('js/site-header.js');
  assert.match(header, /fetch\('\/api\/logout', \{ method: 'POST'/);
  assert.match(header, /location\.href = '\/academy'/);
  assert.match(js, /siteHeader\.mount\(/);
  assert.match(js, /externalStudentId: studentId/);
  assert.match(js, /me\.launchStudentId/, 'a teacher registers only the signed launch student number');
  assert.match(html, /id="link-note"/);
  assert.doesNotMatch(js, /innerHTML/);
});

test('reading files owned by the other agent are untouched by SSO', () => {
  // read.js still lists children and finds its own; the student path is served by api.js.
  assert.match(read('js/read.js'), /api\.get\('\/api\/children'\)/);
});
