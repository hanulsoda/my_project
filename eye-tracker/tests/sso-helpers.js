'use strict';
// Test-only signer for academy entry tokens (the real signer is the PHP page on the academy site).
// The secret is a fixed, obviously fake test value; it is never a real deployment secret.
const crypto = require('node:crypto');

const TEST_SSO_SECRET = 'test-only-sso-secret-0123456789abcdef-not-real';
const TEST_ACADEMY_URL = 'https://academy.example.test/';

let nonceCounter = 0;
const freshNonce = () => crypto.createHash('sha256').update(`nonce-${process.pid}-${++nonceCounter}-${Math.random()}`).digest('hex').slice(0, 32);

// payload fields default to a valid teacher token expiring 5 minutes after `nowMs`.
function makePayload(overrides = {}, nowMs = Date.now()) {
  return {
    v: 1, role: 'teacher', uid: '12', sid: '', exp: Math.floor(nowMs / 1000) + 300, n: freshNonce(), ...overrides,
  };
}

function encodePayload(payload) {
  return Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8').toString('base64url');
}

function signPart(b64, secret = TEST_SSO_SECRET) {
  return crypto.createHmac('sha256', secret).update(b64, 'ascii').digest('hex');
}

function signToken(payload, secret = TEST_SSO_SECRET) {
  const b64 = encodePayload(payload);
  return `${b64}.${signPart(b64, secret)}`;
}

module.exports = { TEST_SSO_SECRET, TEST_ACADEMY_URL, makePayload, encodePayload, signPart, signToken, freshNonce };
