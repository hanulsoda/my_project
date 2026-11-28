'use strict';
const express = require('express');
const { GRADE_BANDS, listPassages } = require('../passages');
const { audit } = require('../audit');
const { toCsv } = require('../csv');
const { isReferenceOnly } = require('../metrics');

const MAX_LEN = 32;
const MAX_NOTE_LEN = 500;
const NOT_FOUND = { error: 'not found' };
const DUPLICATE_STUDENT = { error: '이미 등록된 학생입니다' };
// What a teacher gets for any student number they may not link: not launched for it, or already
// linked elsewhere. One answer for both, so it never tells whether a number is registered.
const LINK_REFUSED = { error: '이 학생 번호로는 등록할 수 없습니다. 다힘 사이트의 학생 화면에서 "측정"으로 들어와 주세요.' };
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

// The academy student number that links a child to a student sign-in: null/''/blank clears.
function parseExternalStudentId(v) {
  if (v === null || v === undefined) return { value: null };
  const error = `externalStudentId must be a string up to ${MAX_LEN} chars, or null to clear`;
  if (typeof v !== 'string') return { error };
  const t = v.trim();
  if (t.length > MAX_LEN) return { error };
  return { value: t || null };
}

// Visibility (docs/sso.md): the director (users.role 'admin') sees and manages every child; a
// teacher only the children they own. Every query takes (userId, isDirector) for
// "(teacher_id = ? OR ? = 1)"; this is the one place that decides it.
const scopeOf = (req) => [req.user.id, req.user.role === 'admin' ? 1 : 0];

// May this caller link `value` to a child? The director: any number. A teacher: only the student
// number their current session was launched for by a signed academy token (auth_sessions.launch_sid).
const mayLinkStudent = (req, value) => req.user.role === 'admin' || (req.user.launchSid !== null && req.user.launchSid === value);

// A director writing to a child another account owns leaves an audit row naming the owner.
function auditCrossWrite(db, now, req, ownerId, action, target) {
  if (req.user.role === 'admin' && ownerId !== req.user.id) {
    audit(db, now, req.user.id, 'director.cross_write', target, `${action} owner=user:${ownerId}`);
  }
}

// consent_date is NOT NULL in the schema; '' means "no consent recorded yet". The owner
// (teacherId) is shown to the director only, who manages every child; a teacher sees no
// teacher identifiers at all.
function toChild(row, req) {
  const child = {
    id: row.id,
    code: row.code,
    initials: row.initials,
    gradeBand: row.grade_band,
    consentDate: row.consent_date || null,
    group: row.group_name ?? null,
    note: row.note ?? null,
    externalStudentId: row.external_student_id ?? null,
    createdAt: row.created_at,
  };
  if (req.user.role === 'admin') child.teacherId = row.teacher_id;
  return child;
}

// Every query is scoped by scopeOf(req): a teacher sees only their own children, the director all.
// A foreign or unknown id is always the same 404, so ids can't be probed across teachers.
function createChildrenRouter({ db, now }) {
  const q = {
    list: db.prepare('SELECT * FROM children WHERE (teacher_id = ? OR ? = 1) ORDER BY id'),
    listGroup: db.prepare('SELECT * FROM children WHERE (teacher_id = ? OR ? = 1) AND group_name = ? ORDER BY id'),
    get: db.prepare('SELECT * FROM children WHERE id = ? AND (teacher_id = ? OR ? = 1)'),
    byId: db.prepare('SELECT * FROM children WHERE id = ?'),
    studentTaken: db.prepare('SELECT 1 FROM children WHERE external_student_id = ? AND id != ?'),
    owner: db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('admin', 'teacher') AND disabled_at IS NULL"),
    insert: db.prepare(
      `INSERT INTO children (teacher_id, code, initials, grade_band, consent_date, created_at, group_name, note, external_student_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    // One row per child with the figures the export needs; only metrics_json is read from the
    // sessions (never samples or words), and everything is scoped by children.teacher_id.
    exportRows: db.prepare(
      `SELECT c.code, c.initials, c.grade_band, c.group_name, c.consent_date,
              (SELECT COUNT(*) FROM read_sessions s WHERE s.child_id = c.id) AS session_count,
              (SELECT MAX(s.started_at) FROM read_sessions s WHERE s.child_id = c.id) AS last_at,
              (SELECT s.metrics_json FROM read_sessions s WHERE s.child_id = c.id AND s.kind = 'reference'
               ORDER BY s.started_at DESC, s.id DESC LIMIT 1) AS ref_metrics
       FROM children c WHERE (c.teacher_id = ? OR ? = 1) ORDER BY c.id`,
    ),
    update: db.prepare(
      `UPDATE children SET code = ?, initials = ?, grade_band = ?, consent_date = ?, group_name = ?, note = ?,
              external_student_id = ?, teacher_id = ?
       WHERE id = ? AND (teacher_id = ? OR ? = 1)`,
    ),
    remove: db.prepare('DELETE FROM children WHERE id = ? AND (teacher_id = ? OR ? = 1)'),
  };
  // Constraint errors: the student number (unique across all children) or the per-teacher code.
  // A number linked to another child: the director is told so; a teacher gets the generic refusal.
  const linkTaken = (req, res) => (req.user.role === 'admin'
    ? res.status(409).json(DUPLICATE_STUDENT)
    : res.status(403).json(LINK_REFUSED));
  const conflict = (req, res, err) => (String(err.message).includes('external_student_id')
    ? linkTaken(req, res)
    : res.status(409).json({ error: 'code already in use' }));

  const parseId = (raw) => (/^\d{1,15}$/.test(raw) ? Number(raw) : null);
  const router = express.Router();
  // Staff only. The guard in app.js already refuses student sessions here; this is the backstop.
  router.use((req, res, next) => (req.user ? next() : res.status(403).json({ error: 'student_session' })));

  router.get('/', (req, res) => {
    const { group } = req.query;
    if (group === undefined) return res.json(q.list.all(...scopeOf(req)).map((r) => toChild(r, req)));
    if (typeof group !== 'string') return res.status(400).json({ error: 'group must be a single string' });
    res.json(q.listGroup.all(...scopeOf(req), group).map((r) => toChild(r, req)));
  });

  // Registered before '/:id'. Figures come from the latest reference session and are blank when it
  // is 참고용 (the same rule as the UI); lastSessionAt and sessionCount cover every session.
  router.get('/export.csv', (req, res) => {
    const rows = q.exportRows.all(...scopeOf(req)).map((r) => {
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
    const row = id === null ? undefined : q.get.get(id, ...scopeOf(req));
    if (!row) return res.status(404).json(NOT_FOUND);
    res.json(toChild(row, req));
  });

  router.post('/', (req, res) => {
    const { code, initials, gradeBand, consentDate } = req.body ?? {};
    const group = parseGroup(req.body?.group);
    const note = parseNote(req.body?.note);
    const student = parseExternalStudentId(req.body?.externalStudentId);
    const cleanCode = parseLabel(code);
    const cleanInitials = parseLabel(initials);
    if (cleanCode === null) return res.status(400).json({ error: `code must be a non-empty string up to ${MAX_LEN} chars` });
    if (cleanInitials === null) return res.status(400).json({ error: `initials must be a non-empty string up to ${MAX_LEN} chars` });
    if (!GRADE_BANDS.includes(gradeBand)) return res.status(400).json({ error: `gradeBand must be one of ${GRADE_BANDS.join('|')}` });
    if (consentDate != null && !isValidIsoDate(consentDate)) return res.status(400).json({ error: 'consentDate must be a valid YYYY-MM-DD date' });
    if (group.error) return res.status(400).json({ error: group.error });
    if (note.error) return res.status(400).json({ error: note.error });
    if (student.error) return res.status(400).json({ error: student.error });
    if (student.value !== null) {
      if (!mayLinkStudent(req, student.value)) return res.status(403).json(LINK_REFUSED);
      if (q.studentTaken.get(student.value, 0)) return linkTaken(req, res);
    }

    try {
      const { lastInsertRowid } = q.insert.run(
        req.user.id, cleanCode, cleanInitials, gradeBand, consentDate ?? '', now(), group.value, note.value, student.value,
      );
      res.status(201).json(toChild(q.byId.get(lastInsertRowid), req));
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return conflict(req, res, err);
      throw err;
    }
  });

  router.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const row = id === null ? undefined : q.get.get(id, ...scopeOf(req));
    if (!row) return res.status(404).json(NOT_FOUND);
    const body = req.body ?? {};
    const sent = (key) => Object.hasOwn(body, key);
    if (!['code', 'initials', 'gradeBand', 'consentDate', 'group', 'note', 'externalStudentId', 'teacherId'].some(sent)) {
      return res.status(400).json({ error: 'nothing to update: send code, initials, gradeBand, consentDate, group, note, externalStudentId or teacherId' });
    }
    // Partial update: start from the stored row, validate every field that was sent, and write
    // only when all of them pass.
    const next = {
      code: row.code, initials: row.initials, gradeBand: row.grade_band,
      consentDate: row.consent_date, group: row.group_name, note: row.note,
      externalStudentId: row.external_student_id, teacherId: row.teacher_id,
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
    if (sent('externalStudentId')) {
      const e = parseExternalStudentId(body.externalStudentId);
      if (e.error) return res.status(400).json({ error: e.error });
      // Clearing, or keeping the value the child already has, needs no proof.
      if (e.value !== null && e.value !== row.external_student_id) {
        if (!mayLinkStudent(req, e.value)) return res.status(403).json(LINK_REFUSED);
        if (q.studentTaken.get(e.value, id)) return linkTaken(req, res);
      }
      next.externalStudentId = e.value;
    }
    // Reassigning the owner is the director's alone, and is always audited.
    if (sent('teacherId')) {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'only the director can change the owner' });
      if (!Number.isSafeInteger(body.teacherId) || !q.owner.get(body.teacherId)) {
        return res.status(400).json({ error: 'teacherId must be the id of an existing, active account' });
      }
      next.teacherId = body.teacherId;
    }
    try {
      q.update.run(
        next.code, next.initials, next.gradeBand, next.consentDate, next.group, next.note,
        next.externalStudentId, next.teacherId, id, ...scopeOf(req),
      );
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return conflict(req, res, err);
      throw err;
    }
    if (next.teacherId !== row.teacher_id) {
      audit(db, now, req.user.id, 'child.reassign', `child:${id}`, `from=user:${row.teacher_id} to=user:${next.teacherId}`);
    }
    auditCrossWrite(db, now, req, row.teacher_id, 'child.update', `child:${id}`);
    res.json(toChild(q.byId.get(id), req));
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const row = id === null ? undefined : q.get.get(id, ...scopeOf(req));
    const changes = row ? q.remove.run(id, ...scopeOf(req)).changes : 0;
    if (!changes) return res.status(404).json(NOT_FOUND);
    // The id only: the child's code and initials go with the deleted row, not into the log.
    audit(db, now, req.user.id, 'child.delete', `child:${id}`);
    auditCrossWrite(db, now, req, row.teacher_id, 'child.delete', `child:${id}`);
    res.status(204).end();
  });

  return router;
}

// A student session reaches this only for its own grade band (guard in app.js).
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

module.exports = { createChildrenRouter, createPassagesRouter, NOT_FOUND, scopeOf, auditCrossWrite };
