'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyEntryToken, safeNext, MAX_TOKEN_LEN } = require('../server/sso-token');
const { TEST_SSO_SECRET, makePayload, encodePayload, signPart, signToken } = require('./sso-helpers');

const NOW = 1_800_000_000_000; // ms
const NOW_S = NOW / 1000;
const verify = (token, nowMs = NOW, secret = TEST_SSO_SECRET) => verifyEntryToken(token, { secret, nowMs });

test('verifyEntryToken: valid tokens', async (t) => {
  await t.test('teacher, director and student tokens verify and return the payload', () => {
    for (const p of [
      makePayload({ role: 'teacher', uid: '12' }, NOW),
      makePayload({ role: 'teacher', uid: '12', sid: '0123' }, NOW),
      makePayload({ role: 'director', uid: 'admin' }, NOW),
      makePayload({ role: 'student', uid: '0123', sid: '0123' }, NOW),
    ]) {
      const r = verify(signToken(p));
      assert.equal(r.ok, true, JSON.stringify(p));
      assert.deepEqual(r.payload, p);
    }
  });

  await t.test('clock window: exp up to 330 s ahead and up to 60 s behind is accepted', () => {
    assert.equal(verify(signToken(makePayload({ exp: NOW_S + 330 }, NOW))).ok, true);
    assert.equal(verify(signToken(makePayload({ exp: NOW_S - 60 }, NOW))).ok, true);
  });
});

test('verifyEntryToken: everything else fails closed', async (t) => {
  const good = makePayload({}, NOW);
  const goodToken = signToken(good);

  const cases = {
    'wrong secret': signToken(good, 'another-secret-that-is-long-enough-1234567890'),
    'tampered payload (sig of the original)': `${encodePayload({ ...good, role: 'director', uid: 'admin' })}.${goodToken.split('.')[1]}`,
    'tampered signature': goodToken.slice(0, -1) + (goodToken.endsWith('0') ? '1' : '0'),
    'uppercase signature hex': `${goodToken.split('.')[0]}.${goodToken.split('.')[1].toUpperCase()}`,
    'truncated signature': goodToken.slice(0, -2),
    'expired (61 s past exp)': signToken(makePayload({ exp: NOW_S - 61 }, NOW)),
    'too far in the future (331 s)': signToken(makePayload({ exp: NOW_S + 331 }, NOW)),
    'unknown version': signToken({ ...good, v: 2 }),
    'version as string': signToken({ ...good, v: '1' }),
    'unknown role': signToken({ ...good, role: 'parent' }),
    'role admin (the academy says director)': signToken({ ...good, role: 'admin' }),
    'missing uid': signToken((({ uid, ...rest }) => rest)(good)),
    'missing sid': signToken((({ sid, ...rest }) => rest)(good)),
    'missing exp': signToken((({ exp, ...rest }) => rest)(good)),
    'missing nonce': signToken((({ n, ...rest }) => rest)(good)),
    'extra field': signToken({ ...good, name: '김철수' }),
    'short nonce': signToken({ ...good, n: 'abc123' }),
    'non-hex nonce': signToken({ ...good, n: 'zzzzzzzzzzzzzzzzzzzz' }),
    'exp not an integer': signToken({ ...good, exp: NOW_S + 0.5 }),
    'exp as string': signToken({ ...good, exp: String(NOW_S + 100) }),
    'teacher uid not numeric': signToken({ ...good, uid: 'abc' }),
    'teacher uid zero (that is the director on the academy site)': signToken({ ...good, uid: '0' }),
    'non-ASCII uid': signToken({ ...good, role: 'director', uid: '원장' }),
    'student without sid': signToken({ ...good, role: 'student', uid: '0123', sid: '' }),
    'student sid differs from uid': signToken({ ...good, role: 'student', uid: '0123', sid: '0456' }),
    'student id not digits': signToken({ ...good, role: 'student', uid: 'ab12', sid: 'ab12' }),
    'sid with a slash': signToken({ ...good, sid: '01/23' }),
    'payload is an array': signToken([1, 2, 3]),
    'payload is not JSON': `${encodePayload('not json')}.${signPart(encodePayload('not json'))}`,
    'oversized token': (() => { const b = 'A'.repeat(MAX_TOKEN_LEN); return `${b}.${signPart(b)}`; })(),
    'non-ASCII characters in the token': `${goodToken.split('.')[0]}é.${goodToken.split('.')[1]}`,
    'base64 padding/standard alphabet': `${goodToken.split('.')[0]}=.${goodToken.split('.')[1]}`,
    'three parts': `${goodToken}.00`,
    'empty string': '',
    'not a string (array)': [goodToken],
    'not a string (undefined)': undefined,
  };
  for (const [name, token] of Object.entries(cases)) {
    await t.test(name, () => {
      const r = verify(token);
      assert.equal(r.ok, false);
      assert.equal(r.payload, undefined, 'no payload on failure');
    });
  }

  await t.test('a missing or short secret never verifies anything', () => {
    for (const secret of [undefined, null, '', 'short']) {
      assert.equal(verifyEntryToken(goodToken, { secret, nowMs: NOW }).ok, false);
    }
  });
});

test('safeNext: only the allowlisted paths, otherwise the role default', async (t) => {
  const teacher = { role: 'teacher', sid: '' };
  await t.test('allowed values pass through for staff', () => {
    assert.equal(safeNext('/children.html', teacher), '/children.html');
    assert.equal(safeNext('/children.html?student=0123', teacher), '/children.html?student=0123');
    assert.equal(safeNext('/read.html?child=42', teacher), '/read.html?child=42');
    assert.equal(safeNext('/read.html?child=42', { role: 'director', sid: '' }), '/read.html?child=42');
  });

  await t.test('staff with a student id in the token go to that student', () => {
    assert.equal(safeNext(undefined, { role: 'teacher', sid: '0123' }), '/children.html?student=0123');
    assert.equal(safeNext('/read.html?child=42', { role: 'director', sid: '0456' }), '/children.html?student=0456');
  });

  await t.test('a student always lands on their own measurement', () => {
    assert.equal(safeNext('/children.html', { role: 'student', sid: '0123', childId: 7 }), '/read.html?child=7');
    assert.equal(safeNext('/read.html?child=8', { role: 'student', sid: '0123', childId: 7 }), '/read.html?child=7');
    assert.equal(safeNext(undefined, { role: 'student', sid: '0123', childId: 7 }), '/read.html?child=7');
  });

  const attacks = [
    undefined, '', '/', '//evil.com', '/\\evil', '\\\\evil.com', 'https://evil', 'https://evil.com/children.html',
    '/children.html@evil', '/children.html@evil.com', '//evil.com/children.html', '/children.html/../admin',
    '/children.html?student=0123&x=1', '/children.html?student=../../x', '/children.html#x', '/read.html?child=0',
    '/read.html?child=1e3', '/read.html?child=42/../x', '%2F%2Fevil.com', '/%2F/evil.com', '%2fchildren.html',
    '/children.html%40evil', '/CHILDREN.HTML', ' /children.html', '/children.html ', '/children.html\n',
    'javascript:alert(1)', '/report.html?token=abc', ['/children.html'], { a: 1 },
  ];
  for (const next of attacks) {
    await t.test(`rejects ${JSON.stringify(next)}`, () => {
      assert.equal(safeNext(next, teacher), '/children.html');
    });
  }
});
