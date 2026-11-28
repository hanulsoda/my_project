'use strict';
// Cross-language proof: tokens signed by the academy's PHP library (deploy/academy-site/
// reading_sso_lib.php, run in php:8.3-cli) verify in Node, and tampered, expired or replayed ones
// fail. The fixture was made with the fixed TEST secret and a fixed clock; regenerate with
//   docker run --rm -v "$PWD":/w php:8.3-cli php /w/tests/php/make-tokens.php \
//     "$(node -e "process.stdout.write(require('./tests/sso-helpers').TEST_SSO_SECRET)")" 1800000000 \
//     > tests/fixtures/php-sso-tokens.json
// The clock is always passed in (nowMs / the test server's clock), so the fixture never "expires".
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyEntryToken } = require('../server/sso-token');
const { startTestServer } = require('./helpers');
const { TEST_SSO_SECRET, encodePayload } = require('./sso-helpers');
const fixture = require('./fixtures/php-sso-tokens.json');

const NOW_MS = fixture.now * 1000;
const verify = (token, nowMs = NOW_MS, secret = TEST_SSO_SECRET) => verifyEntryToken(token, { secret, nowMs });
const decode = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

test('PHP-signed tokens verify in Node', async (t) => {
  assert.match(fixture.php, /^8\.3\./, 'made with php:8.3-cli');
  const expected = {
    director: { role: 'director', uid: 'admin', sid: '' },
    teacher: { role: 'teacher', uid: '12', sid: '' },
    teacherStudent: { role: 'teacher', uid: '12', sid: '0123' },
    student: { role: 'student', uid: '0123', sid: '0123' },
  };
  for (const [name, want] of Object.entries(expected)) {
    await t.test(name, () => {
      const r = verify(fixture.tokens[name]);
      assert.equal(r.ok, true, r.reason);
      assert.deepEqual({ role: r.payload.role, uid: r.payload.uid, sid: r.payload.sid }, want);
      assert.equal(r.payload.v, 1);
      assert.equal(r.payload.exp, fixture.now + 300);
      assert.match(r.payload.n, /^[0-9a-f]{32}$/);
    });
  }
  await t.test('the PHP URL builder escapes the next path', () => {
    assert.equal(fixture.url, 'https://reading.dahim.kr/sso?t=TOKEN&next=%2Fchildren.html');
  });
});

test('PHP-signed tokens: tampering, expiry and the wrong secret fail', async (t) => {
  const token = fixture.tokens.teacher;
  const [b64, sig] = token.split('.');
  await t.test('tampered payload (role raised to director, PHP signature kept)', () => {
    const forged = encodePayload({ ...decode(token), role: 'director', uid: 'admin' });
    assert.equal(verify(`${forged}.${sig}`).ok, false);
  });
  await t.test('tampered signature (one hex digit)', () => {
    const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    assert.equal(verify(`${b64}.${flipped}`).ok, false);
  });
  await t.test('expired: 361 s after it was made (exp + 60 s skew is the limit)', () => {
    assert.equal(verify(token, NOW_MS + 360 * 1000).ok, true, 'still inside the skew');
    assert.equal(verify(token, NOW_MS + 361 * 1000).ok, false);
  });
  await t.test('made too far ahead of the verifier\'s clock', () => {
    assert.equal(verify(token, NOW_MS - 31 * 1000).ok, false);
  });
  await t.test('another secret', () => {
    assert.equal(verify(token, NOW_MS, 'some-other-secret-of-at-least-32-chars!').ok, false);
  });
});

test('PHP-signed tokens through /sso: sign-in, then replay refused', async (t) => {
  const srv = await startTestServer();
  t.after(srv.close);
  srv.clock.t = NOW_MS;

  await t.test('teacher token: 302 to the children page; the same token again is refused', async () => {
    const first = await srv.ssoEnter({}, { token: fixture.tokens.teacher });
    assert.equal(first.res.status, 302);
    assert.equal(first.res.headers.get('location'), '/children.html');
    const again = await srv.ssoEnter({}, { token: fixture.tokens.teacher });
    assert.equal(again.res.status, 403);
    assert.equal(again.cookie, null);
  });

  await t.test('teacher launching a student: lands on that student', async () => {
    const r = await srv.ssoEnter({}, { token: fixture.tokens.teacherStudent });
    assert.equal(r.res.headers.get('location'), '/children.html?student=0123');
    const made = await fetch(`${srv.url}/api/children`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: r.cookie },
      body: JSON.stringify({ code: 'S-0123', initials: 'KJ', gradeBand: 'elementary', externalStudentId: '0123' }),
    });
    assert.equal(made.status, 201);
  });

  await t.test('student token: their own measurement; director token: an admin session', async () => {
    const s = await srv.ssoEnter({}, { token: fixture.tokens.student });
    assert.equal(s.res.status, 302);
    assert.match(s.res.headers.get('location'), /^\/read\.html\?child=\d+$/);
    const d = await srv.ssoEnter({}, { token: fixture.tokens.director });
    assert.equal(d.res.status, 302);
    const me = await (await fetch(`${srv.url}/api/me`, { headers: { cookie: d.cookie } })).json();
    assert.equal(me.role, 'admin');
  });

});

test('PHP-signed token through /sso on a server whose clock is past exp + 60 s: refused', async (t) => {
  const srv = await startTestServer(); // fresh: the token's nonce was never used here
  t.after(srv.close);
  srv.clock.t = NOW_MS + 361 * 1000;
  const late = await srv.ssoEnter({}, { token: fixture.tokens.director });
  assert.equal(late.res.status, 403);
  srv.clock.t = NOW_MS + 300 * 1000;
  assert.equal((await srv.ssoEnter({}, { token: fixture.tokens.director })).res.status, 302, 'the same token, in time, works');
});
