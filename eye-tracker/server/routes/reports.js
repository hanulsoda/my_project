'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { applyQualityRule, isReferenceOnly } = require('../metrics');
const { NOT_FOUND, scopeOf, auditCrossWrite } = require('./children');
const { audit } = require('../audit');

const DAY_MS = 86400000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const DISCLAIMER = '선별 지표이며 진단이 아닙니다.';

const parseId = (raw) => (/^\d{1,15}$/.test(raw) ? Number(raw) : null);

// Routers, each mounted by app.js:
// "scoped" = own children for a teacher, every child for the director (scopeOf in children.js).
//   childTrend    /api/children/:id/trend   (teacher-guarded, scoped)
//   sessionShare  /api/sessions/:id/share   (teacher-guarded, scoped)
//   sessionShares /api/sessions/:id/shares  (teacher-guarded, scoped; lists a session's links)
//   share         /api/share                (teacher-guarded, scoped)
//   report        /api/report               (PUBLIC: the token is the only credential)
function createReportsRouters({ db, now }) {
  const q = {
    child: db.prepare('SELECT id FROM children WHERE id = ? AND (teacher_id = ? OR ? = 1)'),
    trend: db.prepare(
      "SELECT started_at, metrics_json FROM read_sessions WHERE child_id = ? AND kind = 'reference' ORDER BY started_at, id",
    ),
    ownSession: db.prepare(
      `SELECT s.id, c.teacher_id FROM read_sessions s JOIN children c ON c.id = s.child_id
       WHERE s.id = ? AND (c.teacher_id = ? OR ? = 1)`,
    ),
    listLinks: db.prepare(
      'SELECT token, expires_at, revoked_at FROM share_links WHERE session_id = ? ORDER BY rowid DESC',
    ),
    insertLink: db.prepare('INSERT INTO share_links (token, session_id, expires_at) VALUES (?, ?, ?)'),
    ownLink: db.prepare(
      `SELECT l.session_id, c.teacher_id FROM share_links l
       JOIN read_sessions s ON s.id = l.session_id JOIN children c ON c.id = s.child_id
       WHERE l.token = ? AND (c.teacher_id = ? OR ? = 1)`,
    ),
    revoke: db.prepare(
      `UPDATE share_links SET revoked_at = ?
       WHERE token = ? AND revoked_at IS NULL AND session_id IN (
         SELECT s.id FROM read_sessions s JOIN children c ON c.id = s.child_id WHERE (c.teacher_id = ? OR ? = 1))`,
    ),
    report: db.prepare(
      `SELECT l.expires_at, l.revoked_at, s.child_id, s.started_at, s.metrics_json,
              c.code, c.initials, c.grade_band
       FROM share_links l
       JOIN read_sessions s ON s.id = l.session_id
       JOIN children c ON c.id = s.child_id
       WHERE l.token = ?`,
    ),
  };

  // Only summary figures: no per-line or per-word arrays ever leave through the trend. `reliable`
  // tells the chart which points are 참고용 (legacy rows: detail === 'line' was reference only).
  function trendFor(childId) {
    return q.trend.all(childId).map((r) => {
      const m = applyQualityRule(JSON.parse(r.metrics_json));
      return {
        startedAt: r.started_at, wpm: m.wpm, regressions: m.regressions, skippedLines: m.skippedLines,
        quality: m.quality, reliable: !isReferenceOnly(m),
      };
    });
  }

  const childTrend = express.Router({ mergeParams: true });
  childTrend.get('/', (req, res) => {
    const id = parseId(req.params.id);
    const child = id === null ? undefined : q.child.get(id, ...scopeOf(req));
    if (!child) return res.status(404).json(NOT_FOUND);
    res.json(trendFor(child.id));
  });

  const sessionShare = express.Router({ mergeParams: true });
  sessionShare.post('/', (req, res) => {
    const body = req.body ?? {};
    const days = 'days' in body ? body.days : DEFAULT_DAYS; // explicit null/'' is invalid, not "default"
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      return res.status(400).json({ error: `days must be an integer from 1 to ${MAX_DAYS}` });
    }
    const id = parseId(req.params.id);
    const session = id === null ? undefined : q.ownSession.get(id, ...scopeOf(req));
    if (!session) return res.status(404).json(NOT_FOUND);

    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = now() + days * DAY_MS;
    q.insertLink.run(token, session.id, expiresAt);
    audit(db, now, req.user.id, 'share.create', `session:${session.id}`, `days=${days}`);
    auditCrossWrite(db, now, req, session.teacher_id, 'share.create', `session:${session.id}`);
    res.status(201).json({ token, url: `/report.html?token=${token}`, expiresAt });
  });

  // Lets a teacher find (and then revoke) a link whose token they no longer have.
  const sessionShares = express.Router({ mergeParams: true });
  sessionShares.get('/', (req, res) => {
    const id = parseId(req.params.id);
    const session = id === null ? undefined : q.ownSession.get(id, ...scopeOf(req));
    if (!session) return res.status(404).json(NOT_FOUND);
    res.json(q.listLinks.all(session.id).map((l) => ({ token: l.token, expiresAt: l.expires_at, revokedAt: l.revoked_at })));
  });

  const share = express.Router();
  share.delete('/:token', (req, res) => {
    const link = q.ownLink.get(req.params.token, ...scopeOf(req));
    if (!link) return res.status(404).json(NOT_FOUND);
    // Revoking a revoked link keeps the first stamp and writes no second audit row (still 204).
    if (q.revoke.run(now(), req.params.token, ...scopeOf(req)).changes > 0) {
      audit(db, now, req.user.id, 'share.revoke', `session:${link.session_id}`);
      auditCrossWrite(db, now, req, link.teacher_id, 'share.revoke', `session:${link.session_id}`);
    }
    res.status(204).end();
  });

  const report = express.Router();
  report.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  report.get('/:token', (req, res) => {
    const r = q.report.get(req.params.token);
    if (!r) return res.status(404).json({ error: 'not_found' });
    if (r.revoked_at !== null || now() >= r.expires_at) return res.status(410).json({ error: 'gone' });
    // Built field by field: nothing outside this whitelist (ids, teacher, samples, words) can leak.
    res.json({
      child: { initials: r.initials, gradeBand: r.grade_band },
      session: { startedAt: r.started_at, metrics: applyQualityRule(JSON.parse(r.metrics_json)) },
      trend: trendFor(r.child_id),
      disclaimer: DISCLAIMER,
    });
  });

  return { childTrend, sessionShare, sessionShares, share, report };
}

module.exports = { createReportsRouters };
