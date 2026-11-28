'use strict';
// Settings read from the environment (server/index.js), passed to createApp as `config`.
//   SSO_SECRET            shared with the academy site; >= 32 chars after trimming and not the
//                         .env.example placeholder, else SSO is off
//   ACADEMY_URL           where people are sent to (re)enter; an absolute http(s) URL
//   ALLOW_PASSWORD_LOGIN  "1" turns on the legacy password/invite/reset flows (break-glass)
const { MIN_SECRET_LEN } = require('./sso-token');

function parseAcademyUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

function loadConfig(env = process.env) {
  // Trimmed like the academy side does, so a pasted newline cannot make the two secrets differ.
  const secret = typeof env.SSO_SECRET === 'string' ? env.SSO_SECRET.trim() : '';
  // The .env.example placeholder is long enough to pass the length rule: refuse it explicitly.
  const placeholder = /^change-me/i.test(secret);
  return {
    ssoSecret: secret.length >= MIN_SECRET_LEN && !placeholder ? secret : null,
    ssoSecretTooShort: secret.length > 0 && secret.length < MIN_SECRET_LEN,
    academyUrl: parseAcademyUrl(env.ACADEMY_URL),
    allowPasswordLogin: env.ALLOW_PASSWORD_LOGIN === '1',
  };
}

module.exports = { loadConfig, parseAcademyUrl };
