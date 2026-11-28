'use strict';
const express = require('express');
const { GRADE_BANDS, listPassages } = require('../passages');

const MAX_LEN = 32;
const NOT_FOUND = { error: 'not found' };

function isValidIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isLabel(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_LEN;
}

// consent_date is NOT NULL in the schema; '' means "no consent recorded yet".
function toChild(row) {
  return {
    id: row.id,
    code: row.code,
    initials: row.initials,
    gradeBand: row.grade_band,
    consentDate: row.consent_date || null,
    createdAt: row.created_at,
  };
}

// Every query is scoped by teacher_id = req.user.id (no admin bypass), and a foreign or
// unknown id is always the same 404, so ids can't be probed across teachers.
function createChildrenRouter({ db, now }) {
  const q = {
    list: db.prepare('SELECT * FROM children WHERE teacher_id = ? ORDER BY id'),
    get: db.prepare('SELECT * FROM children WHERE id = ? AND teacher_id = ?'),
    insert: db.prepare(
      'INSERT INTO children (teacher_id, code, initials, grade_band, consent_date, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    setConsent: db.prepare('UPDATE children SET consent_date = ? WHERE id = ? AND teacher_id = ?'),
    remove: db.prepare('DELETE FROM children WHERE id = ? AND teacher_id = ?'),
  };

  const parseId = (raw) => (/^\d{1,15}$/.test(raw) ? Number(raw) : null);
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json(q.list.all(req.user.id).map(toChild));
  });

  router.post('/', (req, res) => {
    const { code, initials, gradeBand, consentDate } = req.body ?? {};
    if (!isLabel(code)) return res.status(400).json({ error: `code must be a non-empty string up to ${MAX_LEN} chars` });
    if (!isLabel(initials)) return res.status(400).json({ error: `initials must be a non-empty string up to ${MAX_LEN} chars` });
    if (!GRADE_BANDS.includes(gradeBand)) return res.status(400).json({ error: `gradeBand must be one of ${GRADE_BANDS.join('|')}` });
    if (consentDate != null && !isValidIsoDate(consentDate)) return res.status(400).json({ error: 'consentDate must be a valid YYYY-MM-DD date' });

    try {
      const { lastInsertRowid } = q.insert.run(req.user.id, code, initials, gradeBand, consentDate ?? '', now());
      res.status(201).json(toChild(q.get.get(lastInsertRowid, req.user.id)));
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'code already in use' });
      throw err;
    }
  });

  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const row = id === null ? undefined : q.get.get(id, req.user.id);
    if (!row) return res.status(404).json(NOT_FOUND);
    const body = req.body ?? {};
    // null or '' clears consent (stored as ''); the key must be present.
    const clearing = body.consentDate === null || body.consentDate === '';
    if (!clearing && !isValidIsoDate(body.consentDate)) {
      return res.status(400).json({ error: 'consentDate must be a valid YYYY-MM-DD date, or null to clear' });
    }
    q.setConsent.run(clearing ? '' : body.consentDate, id, req.user.id);
    res.json(toChild(q.get.get(id, req.user.id)));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const changes = id === null ? 0 : q.remove.run(id, req.user.id).changes;
    if (!changes) return res.status(404).json(NOT_FOUND);
    res.status(204).end();
  });

  return router;
}

function createPassagesRouter() {
  const router = express.Router();
  router.get('/', (req, res) => {
    const { gradeBand } = req.query;
    if (typeof gradeBand !== 'string' || !GRADE_BANDS.includes(gradeBand)) {
      return res.status(400).json({ error: `gradeBand must be one of ${GRADE_BANDS.join('|')}` });
    }
    res.json(listPassages(gradeBand));
  });
  return router;
}

module.exports = { createChildrenRouter, createPassagesRouter, NOT_FOUND };
