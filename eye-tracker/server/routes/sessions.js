'use strict';
const express = require('express');
const { applyQualityRule } = require('../metrics');
const { computeLineMetrics, MAX_PAGE } = require('../line-metrics');
const { getPassage } = require('../passages');
const { NOT_FOUND, scopeOf, auditCrossWrite } = require('./children');

const MAX_WORDS = 2000;
const MAX_SAMPLES = 100000;
const EDGE_TOLERANCE_PX = 4;
const UPLOAD_LIMIT = '10mb';
const MAX_NOTE_LEN = 500;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPage = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_PAGE;
const parseId = (raw) => (/^\d{1,15}$/.test(raw) ? Number(raw) : null);

// Returns {error} for a malformed upload, else the normalised values (only known fields are kept).
// A passage shown as pages sends `page` (0..MAX_PAGE, default 0) on words and samples: words in
// page order, every line of a later page after the lines of earlier pages, samples only on pages
// that have words. `page` is stored only when it was sent.
function validateUpload(body) {
  if (!isObj(body)) return { error: 'body must be a JSON object' };
  const { passageId, screen, words, samples } = body;

  const passage = typeof passageId === 'string' ? getPassage(passageId) : null;
  if (!passage) return { error: 'unknown passageId' };
  if (!isObj(screen) || !isNum(screen.w) || !isNum(screen.h) || screen.w <= 0 || screen.h <= 0) {
    return { error: 'screen.w and screen.h must be positive numbers' };
  }

  if (!Array.isArray(words) || words.length === 0 || words.length > MAX_WORDS) {
    return { error: `words must be a non-empty array of at most ${MAX_WORDS}` };
  }
  const cleanWords = [];
  let lastPage = 0;
  let maxLineBefore = -Infinity; // largest line id on the pages before the current one
  let maxLineHere = -Infinity;
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (!isObj(w) || !['i', 'line', 'x', 'y', 'w', 'h'].every((f) => isNum(w[f]))) {
      return { error: `words[${k}] must have finite numeric i, line, x, y, w, h` };
    }
    if (w.i !== k) return { error: `words[${k}].i must equal ${k}` };
    // Gaze is in viewport coordinates: a word box off the screen cannot have been read there
    // (e.g. a layout made for a larger window). Small rounding at the edge is tolerated.
    if (w.x < -EDGE_TOLERANCE_PX || w.y < -EDGE_TOLERANCE_PX
      || w.x + w.w > screen.w + EDGE_TOLERANCE_PX || w.y + w.h > screen.h + EDGE_TOLERANCE_PX) {
      return { error: `words[${k}] lies outside the screen` };
    }
    const clean = { i: w.i, line: w.line, x: w.x, y: w.y, w: w.w, h: w.h };
    if (w.page !== undefined) {
      if (!isPage(w.page)) return { error: `words[${k}].page must be an integer 0..${MAX_PAGE}` };
      clean.page = w.page;
    }
    const page = clean.page ?? 0;
    if (page < lastPage) return { error: `words[${k}].page must not go back to an earlier page` };
    if (page > lastPage) { maxLineBefore = Math.max(maxLineBefore, maxLineHere); maxLineHere = -Infinity; lastPage = page; }
    if (w.line <= maxLineBefore) return { error: `words[${k}].line must come after the lines of earlier pages (page ${page})` };
    maxLineHere = Math.max(maxLineHere, w.line);
    cleanWords.push(clean);
  }
  const wordPages = new Set(cleanWords.map((w) => w.page ?? 0));

  if (!Array.isArray(samples)) return { error: 'samples must be an array' };
  if (samples.length > MAX_SAMPLES) return { status: 413, error: `at most ${MAX_SAMPLES} samples` };
  const cleanSamples = [];
  for (let k = 0; k < samples.length; k++) {
    const s = samples[k];
    const coord = (v) => isNum(v) || v === null;
    if (!isObj(s) || !isNum(s.t) || !coord(s.x) || !coord(s.y)) {
      return { error: `samples[${k}] must be {t: number, x: number|null, y: number|null}` };
    }
    const clean = { t: s.t, x: s.x, y: s.y };
    if (s.page !== undefined) {
      if (!isPage(s.page)) return { error: `samples[${k}].page must be an integer 0..${MAX_PAGE}` };
      if (!wordPages.has(s.page)) return { error: `samples[${k}].page ${s.page} has no words` };
      clean.page = s.page;
    }
    cleanSamples.push(clean);
  }
  cleanSamples.sort((a, b) => a.t - b.t);

  return { passage, screen: { w: screen.w, h: screen.h }, words: cleanWords, samples: cleanSamples };
}

// Two routers: `childSessions` for /api/children/:id/sessions (upload and list) and `sessions`
// for /api/sessions. Both scope every query through scopeOf(req) (own children; the director all).
// A student session (req.student) reaches only the upload, for its own child (guard in app.js).
function createSessionsRouters({ db, now }) {
  const q = {
    child: db.prepare('SELECT id, consent_date, teacher_id FROM children WHERE id = ? AND (teacher_id = ? OR ? = 1)'),
    studentChild: db.prepare('SELECT id, consent_date, teacher_id FROM children WHERE id = ?'),
    insert: db.prepare(
      `INSERT INTO read_sessions
         (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listByChild: db.prepare(
      'SELECT id, passage_id, kind, started_at, metrics_json, note FROM read_sessions WHERE child_id = ? ORDER BY started_at, id',
    ),
    get: db.prepare(
      `SELECT s.*, c.teacher_id FROM read_sessions s JOIN children c ON c.id = s.child_id
       WHERE s.id = ? AND (c.teacher_id = ? OR ? = 1)`,
    ),
    setNote: db.prepare(
      `UPDATE read_sessions SET note = ?
       WHERE id = ? AND child_id IN (SELECT id FROM children WHERE (teacher_id = ? OR ? = 1))`,
    ),
    ownSession: db.prepare(
      `SELECT s.id, c.teacher_id FROM read_sessions s JOIN children c ON c.id = s.child_id
       WHERE s.id = ? AND (c.teacher_id = ? OR ? = 1)`,
    ),
    updateMetrics: db.prepare(
      `UPDATE read_sessions SET metrics_json = ?
       WHERE id = ? AND child_id IN (SELECT id FROM children WHERE (teacher_id = ? OR ? = 1))`,
    ),
  };

  const childSessions = express.Router({ mergeParams: true });

  // Ownership (404) and consent (403) are decided before the body is parsed or validated.
  function loadChild(req, res, next) {
    const id = parseId(req.params.id);
    let child;
    if (req.user) child = id === null ? undefined : q.child.get(id, ...scopeOf(req));
    else if (req.student && id === req.student.childId) child = q.studentChild.get(id);
    if (!child) return res.status(404).json(NOT_FOUND);
    req.child = child;
    next();
  }
  function requireConsent(req, res, next) {
    if (!req.child.consent_date) return res.status(403).json({ error: 'consent_required' });
    next();
  }

  // Own, larger parser: applies to this route only, the app-wide limit stays 1mb.
  childSessions.post('/', loadChild, requireConsent, express.json({ limit: UPLOAD_LIMIT }), (req, res) => {
    const v = validateUpload(req.body);
    if (v.error) return res.status(v.status ?? 400).json({ error: v.error });

    const metrics = computeLineMetrics(v.samples, v.words, v.screen);
    const { lastInsertRowid } = q.insert.run(
      req.child.id, v.passage.id, v.passage.kind, now(), v.screen.w, v.screen.h,
      JSON.stringify(v.words), JSON.stringify(v.samples), JSON.stringify(metrics),
    );
    // A student sees no scores anywhere: their upload answers with the new id only.
    if (!req.user) return res.status(201).json({ id: Number(lastInsertRowid) });
    auditCrossWrite(db, now, req, req.child.teacher_id, 'session.create', `child:${req.child.id}`);
    // Raw metrics are stored; every response goes through the quality rule.
    res.status(201).json({ id: Number(lastInsertRowid), metrics: applyQualityRule(metrics) });
  });

  // Staff only from here on (a student session never gets this far: guard in app.js).
  const staffOnly = (req, res, next) => (req.user ? next() : res.status(403).json({ error: 'student_session' }));

  childSessions.get('/', staffOnly, loadChild, (req, res) => {
    res.json(q.listByChild.all(req.child.id).map((r) => ({
      id: r.id,
      passageId: r.passage_id,
      kind: r.kind,
      startedAt: r.started_at,
      metrics: applyQualityRule(JSON.parse(r.metrics_json)),
      note: r.note ?? null,
    })));
  });

  const sessions = express.Router();
  sessions.use(staffOnly);
  sessions.get('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const r = id === null ? undefined : q.get.get(id, ...scopeOf(req));
    if (!r) return res.status(404).json(NOT_FOUND);
    res.json({
      id: r.id,
      childId: r.child_id,
      passageId: r.passage_id,
      kind: r.kind,
      title: getPassage(r.passage_id)?.title ?? null,
      startedAt: r.started_at,
      screen: { w: r.screen_w, h: r.screen_h },
      words: JSON.parse(r.words_json),
      samples: JSON.parse(r.samples_json),
      metrics: applyQualityRule(JSON.parse(r.metrics_json)),
      note: r.note ?? null,
    });
  });

  // Teacher's private note on one session ("오전, 안경 벗고 읽음"). Only the teacher routes return
  // it; the public parent report builds its payload from a whitelist that does not include it.
  sessions.patch('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const r = id === null ? undefined : q.ownSession.get(id, ...scopeOf(req)); // ownership only, no payload load
    if (!r) return res.status(404).json(NOT_FOUND);
    const body = req.body ?? {};
    if (!Object.hasOwn(body, 'note')) return res.status(400).json({ error: 'note is required (a string, or null to clear)' });
    const { note } = body;
    if (note !== null && (typeof note !== 'string' || note.length > MAX_NOTE_LEN)) {
      return res.status(400).json({ error: `note must be a string up to ${MAX_NOTE_LEN} chars, or null to clear` });
    }
    const value = note === null || note.trim() === '' ? null : note;
    q.setNote.run(value, r.id, ...scopeOf(req));
    auditCrossWrite(db, now, req, r.teacher_id, 'session.note', `session:${r.id}`);
    res.json({ id: r.id, note: value });
  });

  // Recomputes the metrics of a stored session with the current analysis (e.g. rows stored with the
  // old word-level metrics). Samples were validated and sorted at upload; they are used as stored.
  sessions.post('/:id/reanalyze', (req, res) => {
    const id = parseId(req.params.id);
    const r = id === null ? undefined : q.get.get(id, ...scopeOf(req));
    if (!r) return res.status(404).json(NOT_FOUND);
    const metrics = computeLineMetrics(
      JSON.parse(r.samples_json), JSON.parse(r.words_json), { w: r.screen_w, h: r.screen_h },
    );
    q.updateMetrics.run(JSON.stringify(metrics), r.id, ...scopeOf(req));
    auditCrossWrite(db, now, req, r.teacher_id, 'session.reanalyze', `session:${r.id}`);
    res.json({ id: r.id, metrics: applyQualityRule(metrics) });
  });

  return { childSessions, sessions };
}

module.exports = { createSessionsRouters };
