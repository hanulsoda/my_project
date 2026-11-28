'use strict';
const express = require('express');
const { GRADE_BANDS, listPassages } = require('../passages');
const { audit } = require('../audit');
const { toCsv } = require('../csv');
const { isReferenceOnly } = require('../metrics');

const MAX_LEN = 32;
const MAX_NOTE_LEN = 500;
const NOT_FOUND = { error: 'not found' };
const EXPORT_HEADER = [
  'code', 'initials', 'gradeBand', 'group', 'consentDate', 'sessionCount', 'lastSessionAt',
  'lastWpm', 'lastLinesRead', 'lastTotalLines', 'lastReliable',
];

function isValidIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// code and initials: the trimmed value (1..MAX_LEN chars), or null when invalid.
function parseLabel(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length <= MAX_LEN ? t : null;
}

// Optional free-text fields: null, '' or blank clears (stored as NULL). `group` is trimmed (it is
// matched exactly by the list filter); `note` is kept as typed. code and initials are trimmed too.
function parseGroup(v) {
  if (v === null || v === undefined) return { value: null };
  if (typeof v !== 'string') return { error: `group must be a string up to ${MAX_LEN} chars, or null to clear` };
  const g = v.trim();
  if (g.length > MAX_LEN) return { error: `group must be a string up to ${MAX_LEN} chars, or null to clear` };
  return { value: g || null };
}

function parseNote(v) {
  if (v === null || v === undefined) return { value: null };
  if (typeof v !== 'string' || v.length > MAX_NOTE_LEN) {
    return { error: `note must be a string up to ${MAX_NOTE_LEN} chars, or null to clear` };
  }
  return { value: v.trim() ? v : null };
}

// consent_date is NOT NULL in the schema; '' means "no consent recorded yet".
function toChild(row) {
  return {
    id: row.id,
    code: row.code,
    initials: row.initials,
    gradeBand: row.grade_band,
    consentDate: row.consent_date || null,
    group: row.group_name ?? null,
    note: row.note ?? null,
    createdAt: row.created_at,
  };
}

// Every query is scoped by teacher_id = req.user.id (no admin bypass), and a foreign or
// unknown id is always the same 404, so ids can't be probed across teachers.
function createChildrenRouter({ db, now }) {
  const q = {
    list: db.prepare('SELECT * FROM children WHERE teacher_id = ? ORDER BY id'),
    listGroup: db.prepare('SELECT * FROM children WHERE teacher_id = ? AND group_name = ? ORDER BY id'),
    get: db.prepare('SELECT * FROM children WHERE id = ? AND teacher_id = ?'),
    insert: db.prepare(
      `INSERT INTO children (teacher_id, code, initials, grade_band, consent_date, created_at, group_name, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    // One row per child with the figures the export needs; only metrics_json is read from the
    // sessions (never samples or words), and everything is scoped by children.teacher_id.
    exportRows: db.prepare(
      `SELECT c.code, c.initials, c.grade_band, c.group_name, c.consent_date,
              (SELECT COUNT(*) FROM read_sessions s WHERE s.child_id = c.id) AS session_count,
              (SELECT MAX(s.started_at) FROM read_sessions s WHERE s.child_id = c.id) AS last_at,
              (SELECT s.metrics_json FROM read_sessions s WHERE s.child_id = c.id AND s.kind = 'reference'
               ORDER BY s.started_at DESC, s.id DESC LIMIT 1) AS ref_metrics
       FROM children c WHERE c.teacher_id = ? ORDER BY c.id`,
    ),
    update: db.prepare(
      `UPDATE children SET code = ?, initials = ?, grade_band = ?, consent_date = ?, group_name = ?, note = ?
       WHERE id = ? AND teacher_id = ?`,
    ),
    remove: db.prepare('DELETE FROM children WHERE id = ? AND teacher_id = ?'),
  };

  const parseId = (raw) => (/^\d{1,15}$/.test(raw) ? Number(raw) : null);
  const router = express.Router();

  router.get('/', (req, res) => {
    const { group } = req.query;
    if (group === undefined) return res.json(q.list.all(req.user.id).map(toChild));
    if (typeof group !== 'string') return res.status(400).json({ error: 'group must be a single string' });
    res.json(q.listGroup.all(req.user.id, group).map(toChild));
  });

  // Registered before '/:id'. Figures come from the latest reference session and are blank when it
  // is 참고용 (the same rule as the UI); lastSessionAt and sessionCount cover every session.
  router.get('/export.csv', (req, res) => {
    const rows = q.exportRows.all(req.user.id).map((r) => {
      const m = r.ref_metrics === null ? null : JSON.parse(r.ref_metrics);
      const reliable = m === null ? null : !isReferenceOnly(m);
      const figure = (v) => (reliable && Number.isFinite(v) ? v : null);
      return [
        r.code, r.initials, r.grade_band, r.group_name, r.consent_date, r.session_count,
        r.last_at === null ? null : new Date(r.last_at).toISOString(),
        m === null ? null : figure(Number.isFinite(m.wpm) ? Math.round(m.wpm) : null),
        m === null ? null : figure(m.linesRead),
        m === null ? null : figure(m.totalLines),
        reliable,
      ];
    });
    const day = new Date(now()).toISOString().slice(0, 10).replaceAll('-', '');
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="children-${day}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.send(toCsv([EXPORT_HEADER, ...rows]));
  });

  router.get('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const row = id === null ? undefined : q.get.get(id, req.user.id);
    if (!row) return res.status(404).json(NOT_FOUND);
    res.json(toChild(row));
  });

  router.post('/', (req, res) => {
    const { code, initials, gradeBand, consentDate } = req.body ?? {};
    const group = parseGroup(req.body?.group);
    const note = parseNote(req.body?.note);
    const cleanCode = parseLabel(code);
    const cleanInitials = parseLabel(initials);
    if (cleanCode === null) return res.status(400).json({ error: `code must be a non-empty string up to ${MAX_LEN} chars` });
    if (cleanInitials === null) return res.status(400).json({ error: `initials must be a non-empty string up to ${MAX_LEN} chars` });
    if (!GRADE_BANDS.includes(gradeBand)) return res.status(400).json({ error: `gradeBand must be one of ${GRADE_BANDS.join('|')}` });
    if (consentDate != null && !isValidIsoDate(consentDate)) return res.status(400).json({ error: 'consentDate must be a valid YYYY-MM-DD date' });
    if (group.error) return res.status(400).json({ error: group.error });
    if (note.error) return res.status(400).json({ error: note.error });

    try {
      const { lastInsertRowid } = q.insert.run(
        req.user.id, cleanCode, cleanInitials, gradeBand, consentDate ?? '', now(), group.value, note.value,
      );
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
    const sent = (key) => Object.hasOwn(body, key);
    if (!['code', 'initials', 'gradeBand', 'consentDate', 'group', 'note'].some(sent)) {
      return res.status(400).json({ error: 'nothing to update: send code, initials, gradeBand, consentDate, group or note' });
    }
    // Partial update: start from the stored row, validate every field that was sent, and write
    // only when all of them pass.
    const next = {
      code: row.code, initials: row.initials, gradeBand: row.grade_band,
      consentDate: row.consent_date, group: row.group_name, note: row.note,
    };
    if (sent('code')) {
      const c = parseLabel(body.code);
      if (c === null) return res.status(400).json({ error: `code must be a non-empty string up to ${MAX_LEN} chars` });
      next.code = c;
    }
    if (sent('initials')) {
      const i = parseLabel(body.initials);
      if (i === null) return res.status(400).json({ error: `initials must be a non-empty string up to ${MAX_LEN} chars` });
      next.initials = i;
    }
    if (sent('gradeBand')) {
      if (!GRADE_BANDS.includes(body.gradeBand)) return res.status(400).json({ error: `gradeBand must be one of ${GRADE_BANDS.join('|')}` });
      next.gradeBand = body.gradeBand;
    }
    if (sent('consentDate')) {
      // null or '' clears consent (stored as '').
      const clearing = body.consentDate === null || body.consentDate === '';
      if (!clearing && !isValidIsoDate(body.consentDate)) {
        return res.status(400).json({ error: 'consentDate must be a valid YYYY-MM-DD date, or null to clear' });
      }
      next.consentDate = clearing ? '' : body.consentDate;
    }
    if (sent('group')) {
      const g = parseGroup(body.group);
      if (g.error) return res.status(400).json({ error: g.error });
      next.group = g.value;
    }
    if (sent('note')) {
      const n = parseNote(body.note);
      if (n.error) return res.status(400).json({ error: n.error });
      next.note = n.value;
    }
    try {
      q.update.run(next.code, next.initials, next.gradeBand, next.consentDate, next.group, next.note, id, req.user.id);
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'code already in use' });
      throw err;
    }
    res.json(toChild(q.get.get(id, req.user.id)));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const changes = id === null ? 0 : q.remove.run(id, req.user.id).changes;
    if (!changes) return res.status(404).json(NOT_FOUND);
    // The id only: the child's code and initials go with the deleted row, not into the log.
    audit(db, now, req.user.id, 'child.delete', `child:${id}`);
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
