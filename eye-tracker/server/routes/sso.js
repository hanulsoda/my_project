'use strict';
// GET /sso?t=<token>&next=<path>  sign-in from the academy (Dahim) site; see docs/sso.md.
// GET /academy                    302 to ACADEMY_URL (the UI's "다힘 사이트로" and logout target).
//
// Every refusal is the same friendly page with no detail. The token is never logged, stored or
// echoed: only its nonce is kept (sso_nonces), until exp + skew, to make each token single-use.
const express = require('express');
const { verifyEntryToken, safeNext, SKEW_SEC } = require('../sso-token');
const { sendNotice } = require('../sso-page');
const { audit } = require('../audit');

const UNUSABLE_PASSWORD = '!sso'; // not "scrypt$..": verifyPassword can never accept it
const ROLE_OF = { director: 'admin', teacher: 'teacher' };

function createSsoRouter({ db, now, config, auth }) {
  const academyUrl = config.academyUrl ?? null;
  const q = {
    purgeNonces: db.prepare('DELETE FROM sso_nonces WHERE expires_at <= ?'),
    useNonce: db.prepare('INSERT OR IGNORE INTO sso_nonces (nonce, expires_at) VALUES (?, ?)'),
    userByExternal: db.prepare('SELECT id, role, disabled_at FROM users WHERE external_id = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (email, pw_hash, role, created_at, external_id) VALUES (?, ?, ?, ?, ?) RETURNING id'),
    childByStudent: db.prepare('SELECT id, external_student_id FROM children WHERE external_student_id = ?'),
  };

  // Auto-provisions a staff account on its first visit. Returns the users row or null.
  const provision = db.transaction((externalId, role, email) => {
    const found = q.userByExternal.get(externalId);
    if (found) return found;
    const { id } = q.insertUser.get(email, UNUSABLE_PASSWORD, role, now(), externalId);
    audit(db, now, id, 'user.provision', `user:${id}`, externalId);
    return q.userByExternal.get(externalId);
  });

  // Single use: the nonce is recorded inside one transaction with the purge of expired ones.
  const consumeNonce = db.transaction((nonce, exp) => {
    q.purgeNonces.run(now());
    return q.useNonce.run(nonce, (exp + SKEW_SEC) * 1000).changes === 1;
  });

  const router = express.Router();

  router.get('/sso', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const refuse = () => sendNotice(res, 403, 'retry', academyUrl);
    if (!config.ssoSecret) return sendNotice(res, 503, 'retry', academyUrl);

    const v = verifyEntryToken(req.query.t, { secret: config.ssoSecret, nowMs: now() });
    if (!v.ok) return refuse();
    const p = v.payload;
    if (!consumeNonce(p.n, p.exp)) return refuse();

    if (p.role === 'student') {
      const child = q.childByStudent.get(p.sid);
      if (!child) return sendNotice(res, 404, 'notLinked', academyUrl);
      auth.endSession(req);
      auth.startStudentSession(res, child);
      return res.redirect(302, safeNext(req.query.next, { role: 'student', sid: p.sid, childId: child.id }));
    }

    let user;
    try {
      user = provision(`${p.role}:${p.uid}`, ROLE_OF[p.role], `${p.role}-${p.uid.toLowerCase()}@sso.invalid`);
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) return refuse();
      throw err;
    }
    // A disabled account is refused exactly like a password login would be.
    if (!user || user.disabled_at !== null) return refuse();
    auth.endSession(req);
    auth.startUserSession(res, user.id);
    res.redirect(302, safeNext(req.query.next, { role: p.role, sid: p.sid }));
  });

  router.get('/academy', (req, res) => {
    if (!academyUrl) return sendNotice(res, 503, 'retry', null);
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.redirect(302, academyUrl);
  });

  return router;
}

module.exports = { createSsoRouter, UNUSABLE_PASSWORD };
