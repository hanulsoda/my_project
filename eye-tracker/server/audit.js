'use strict';
// Append-only audit trail for account and data actions. Callers pass what happened, to what, and
// by whom; never a token, password, hash or personal data (targets are ids like "user:5").
const MAX_DETAIL = 200;

function audit(db, now, actorUserId, action, target, detail = null) {
  db.prepare('INSERT INTO audit_log (at, actor_user_id, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .run(now(), actorUserId ?? null, action, target, detail === null ? null : String(detail).slice(0, MAX_DETAIL));
}

module.exports = { audit, MAX_DETAIL };
