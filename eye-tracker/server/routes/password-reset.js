'use strict';
const express = require('express');
const { hashPassword, isValidPassword, sha256Hex, MIN_PASSWORD_LEN, MAX_PASSWORD_LEN } = require('../auth');
const { createLoginLimiter } = require('../login-limiter');
const { audit } = require('../audit');

// PUBLIC (the one-time token is the credential): POST /api/password-reset/:token {password}.
// Same answers as invite acceptance: 404 unknown, 410 used or expired. Failures are counted per
// token hash with the login limiter; a currently valid link is never locked by a bad password.
function createPasswordResetRouter({ db, now }) {
  const limiter = createLoginLimiter({ now });
  const q = {
    byHash: db.prepare('SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?'),
    claim: db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL'),
    setPassword: db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?'),
    dropSessions: db.prepare('DELETE FROM auth_sessions WHERE user_id = ?'),
  };

  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  router.post('/:token', async (req, res, next) => {
    try {
      const key = sha256Hex(req.params.token);
      const gate = limiter.check(key);
      if (gate.blocked) {
        res.set('Retry-After', String(gate.retryAfterSec));
        return res.status(429).json({ error: 'too_many_attempts' });
      }
      limiter.recordFailure(key);
      const reset = q.byHash.get(key);
      if (!reset) return res.status(404).json({ error: 'reset link not found' });
      if (reset.used_at !== null || reset.expires_at <= now()) {
        return res.status(410).json({ error: 'reset link expired or already used' });
      }
      limiter.clear(key);

      const password = req.body?.password;
      if (!isValidPassword(password)) {
        return res.status(400).json({ error: `password must be ${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN} characters` });
      }
      const pwHash = await hashPassword(password);
      // Claim and apply atomically: the await above lets a concurrent request use the link first.
      const outcome = db.transaction(() => {
        if (q.claim.run(now(), reset.id).changes === 0) return 'used';
        q.setPassword.run(pwHash, reset.user_id);
        q.dropSessions.run(reset.user_id); // every old login ends with the old password
        audit(db, now, reset.user_id, 'reset.use', `user:${reset.user_id}`);
        return 'ok';
      })();
      if (outcome === 'used') return res.status(410).json({ error: 'reset link expired or already used' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createPasswordResetRouter };
