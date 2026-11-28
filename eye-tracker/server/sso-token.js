'use strict';
// Entry tokens from the academy (Dahim) site. Contract (docs/sso.md):
//   token   = <payload_b64url>.<sig_hex>
//   payload = {"v":1,"role":"director|teacher|student","uid":"..","sid":"..","exp":<unix s>,"n":"<hex>"}
//   sig     = lowercase hex HMAC-SHA256(secret, payload_b64url as ASCII)
// The signature is checked (constant time) before the payload is even decoded. Anything that is
// not exactly a valid token is refused; the reason is for tests only and never leaves the server.
const crypto = require('node:crypto');

const MAX_TOKEN_LEN = 1024;
const MAX_FUTURE_SEC = 330; // the academy issues exp = now + 300; 30 s of clock skew on top
const SKEW_SEC = 60; // a token stays usable this long after exp (clock skew on the past side)
const MIN_SECRET_LEN = 32;

const TOKEN_RE = /^([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/;
const NONCE_RE = /^[0-9a-f]{16,64}$/;
const TEACHER_UID_RE = /^[1-9]\d{0,9}$/; // admin_teacher_id > 0 on the academy site
const DIRECTOR_UID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const STUDENT_ID_RE = /^\d{4,12}$/; // academy student numbers are zero-padded ("0123")
const KEYS = ['exp', 'n', 'role', 'sid', 'uid', 'v'];

const fail = (reason) => ({ ok: false, reason });
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkPayload(p) {
  if (!isPlainObject(p)) return 'shape';
  const keys = Object.keys(p).sort();
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i])) return 'fields';
  if (p.v !== 1) return 'version';
  if (typeof p.uid !== 'string' || typeof p.sid !== 'string' || typeof p.n !== 'string') return 'types';
  if (!Number.isSafeInteger(p.exp)) return 'exp';
  if (!NONCE_RE.test(p.n)) return 'nonce';
  if (p.sid !== '' && !STUDENT_ID_RE.test(p.sid)) return 'sid';
  switch (p.role) {
    case 'director': return DIRECTOR_UID_RE.test(p.uid) ? null : 'uid';
    case 'teacher': return TEACHER_UID_RE.test(p.uid) ? null : 'uid';
    case 'student': return STUDENT_ID_RE.test(p.uid) && p.sid === p.uid ? null : 'uid';
    default: return 'role';
  }
}

// Returns { ok: true, payload } or { ok: false, reason }. Does NOT consume the nonce (the route does).
function verifyEntryToken(token, { secret, nowMs }) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LEN) return fail('disabled');
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LEN) return fail('size');
  const m = TOKEN_RE.exec(token);
  if (!m) return fail('format');
  const expected = crypto.createHmac('sha256', secret).update(m[1], 'ascii').digest();
  const given = Buffer.from(m[2], 'hex'); // always 32 bytes: the regex allows exactly 64 hex chars
  if (!crypto.timingSafeEqual(expected, given)) return fail('signature');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
  } catch {
    return fail('json');
  }
  const bad = checkPayload(payload);
  if (bad) return fail(bad);
  const nowSec = Math.floor(nowMs / 1000);
  if (payload.exp > nowSec + MAX_FUTURE_SEC) return fail('future');
  if (nowSec > payload.exp + SKEW_SEC) return fail('expired');
  return { ok: true, payload };
}

// Where /sso may send the browser. Only these exact shapes; anything else is the role default.
const NEXT_CHILDREN = '/children.html';
const NEXT_STUDENT_RE = /^\/children\.html\?student=(\d{4,12})$/;
const NEXT_READ_RE = /^\/read\.html\?child=([1-9]\d{0,14})$/;

function safeNext(next, { role, sid, childId }) {
  if (role === 'student') return `/read.html?child=${Number(childId)}`;
  if (sid) return `/children.html?student=${sid}`; // sid was validated as digits by verifyEntryToken
  if (typeof next !== 'string') return NEXT_CHILDREN;
  if (next === NEXT_CHILDREN || NEXT_STUDENT_RE.test(next) || NEXT_READ_RE.test(next)) return next;
  return NEXT_CHILDREN;
}

module.exports = {
  verifyEntryToken, safeNext, MAX_TOKEN_LEN, MAX_FUTURE_SEC, SKEW_SEC, MIN_SECRET_LEN, STUDENT_ID_RE,
};
