'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { sha256Hex } = require('../auth');
const { disableUser, enableUser } = require('../admin-cli');
const { audit } = require('../audit');
const { NOT_FOUND } = require('./children');

const RESET_TTL_MS = 24 * 60 * 60 * 1000;
const AUDIT_DEFAULT_LIMIT = 100;
const AUDIT_MAX_LIMIT = 500;

const parseId = (raw) => (/^\d{1,15}$/.test(raw) ? Number(raw) : null);

function toTeacher(r) {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    disabled: r.disabled_at !== null,
    createdAt: r.created_at,
    lastLoginAt: r.last_login_at,
    childCount: r.child_count,
    externalId: r.external_id ?? null, // "teacher:12" for accounts made by the academy sign-in
  };
}

// Mounted at /api/admin behind requireAdmin (app.js). Account upkeep reuses the operator CLI's
// helpers so the web and the CLI cannot drift apart. Nothing here returns a hash or a token
// except the one-time reset link, which is the point of that call.
// Listing and disabling/enabling accounts always works (a disabled account is refused at /sso
// too). Reset links and invites are the legacy password flows: they exist only with
// config.allowPasswordLogin (ALLOW_PASSWORD_LOGIN=1).
function createAdminRouter({ db, now, config = {} }) {
  const legacy = config.allowPasswordLogin === true;
  const q = {
    teachers: db.prepare(
      `SELECT u.id, u.email, u.role, u.disabled_at, u.created_at, u.last_login_at, u.external_id,
              (SELECT COUNT(*) FROM children c WHERE c.teacher_id = u.id) AS child_count
       FROM users u ORDER BY u.id`),
    teacher: db.prepare(
      `SELECT u.id, u.email, u.role, u.disabled_at, u.created_at, u.last_login_at, u.external_id,
              (SELECT COUNT(*) FROM children c WHERE c.teacher_id = u.id) AS child_count
       FROM users u WHERE u.id = ?`),
    expireResets: db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL'),
    insertReset: db.prepare(
      'INSERT INTO password_resets (user_id, token_hash, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id'),
    pendingInvites: db.prepare(
      'SELECT id, email, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY id'),
    revokeInvite: db.prepare('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?'),
    audit: db.prepare(
      `SELECT a.id, a.at, a.actor_user_id, u.email AS actor_email, a.action, a.target, a.detail
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.id DESC LIMIT ?`),
  };

  const router = express.Router();

  router.get('/teachers', (req, res) => {
    res.json(q.teachers.all().map(toTeacher));
  });

  // Unknown or non-numeric ids are the shared 404.
  function loadTeacher(req, res, next) {
    const id = parseId(req.params.id);
    const row = id === null ? undefined : q.teacher.get(id);
    if (!row) return res.status(404).json(NOT_FOUND);
    req.target = row;
    next();
  }

  router.post('/teachers/:id/disable', loadTeacher, (req, res) => {
    const target = req.target;
    if (target.disabled_at === null) {
      try {
        disableUser(db, target.email, { now });
      } catch (err) {
        if (err.cliError) return res.status(409).json({ error: err.message });
        throw err;
      }
      audit(db, now, req.user.id, 'teacher.disable', `user:${target.id}`);
    }
    res.json(toTeacher(q.teacher.get(target.id)));
  });

  router.post('/teachers/:id/enable', loadTeacher, (req, res) => {
    const target = req.target;
    if (target.disabled_at !== null) {
      enableUser(db, target.email);
      audit(db, now, req.user.id, 'teacher.enable', `user:${target.id}`);
    }
    res.json(toTeacher(q.teacher.get(target.id)));
  });

  // One-time reset link. Only sha256(token) is stored; a new link retires the user's earlier
  // unused ones (those answer 410 like any spent link).
  // A disabled account gets no link: a reset must never be a way back in, and enabling is its own
  // explicit, audited step.
  if (legacy) router.post('/teachers/:id/reset-link', loadTeacher, (req, res) => {
    if (req.target.disabled_at !== null) {
      return res.status(409).json({ error: '비활성화된 계정은 재설정할 수 없습니다. 먼저 활성화해 주세요' });
    }
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = now() + RESET_TTL_MS;
    const resetId = db.transaction(() => {
      q.expireResets.run(now(), req.target.id);
      return q.insertReset.get(req.target.id, sha256Hex(token), now(), expiresAt, req.user.id).id;
    })();
    audit(db, now, req.user.id, 'reset.create', `user:${req.target.id}`, `reset=${resetId}`);
    res.status(201).json({ url: `/reset.html?token=${token}`, expiresAt });
  });

  if (legacy) router.get('/invites', (req, res) => {
    res.json(q.pendingInvites.all(now()).map((i) => ({ id: i.id, email: i.email, expiresAt: i.expires_at })));
  });

  // Revoking retires the invite the way using it would (its link then answers 410) and keeps the
  // row, so an id is never handed out twice.
  if (legacy) router.delete('/invites/:id', (req, res) => {
    const id = parseId(req.params.id);
    const changes = id === null ? 0 : q.revokeInvite.run(now(), id, now()).changes;
    if (!changes) return res.status(404).json(NOT_FOUND);
    audit(db, now, req.user.id, 'invite.revoke', `invite:${id}`);
    res.status(204).end();
  });

  router.get('/audit', (req, res) => {
    const raw = req.query.limit;
    let limit = AUDIT_DEFAULT_LIMIT;
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw) || Number(raw) < 1) {
        return res.status(400).json({ error: `limit must be an integer from 1 to ${AUDIT_MAX_LIMIT}` });
      }
      limit = Math.min(Number(raw), AUDIT_MAX_LIMIT);
    }
    res.json(q.audit.all(limit).map((r) => ({
      id: r.id,
      at: r.at,
      actorUserId: r.actor_user_id,
      actorEmail: r.actor_email,
      action: r.action,
      target: r.target,
      detail: r.detail,
    })));
  });

  return router;
}

module.exports = { createAdminRouter };
