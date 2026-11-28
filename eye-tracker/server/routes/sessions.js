'use strict';
const express = require('express');
const { applyQualityRule } = require('../metrics');
const { computeLineMetrics } = require('../line-metrics');
const { getPassage } = require('../passages');
const { NOT_FOUND } = require('./children');

const MAX_WORDS = 2000;
const MAX_SAMPLES = 100000;
const UPLOAD_LIMIT = '10mb';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const parseId = (raw) => (/^\d{1,15}$/.test(raw) ? Number(raw) : null);

// Returns {error} for a malformed upload, else the normalised values (only known fields are kept).
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
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    if (!isObj(w) || !['i', 'line', 'x', 'y', 'w', 'h'].every((f) => isNum(w[f]))) {
      return { error: `words[${k}] must have finite numeric i, line, x, y, w, h` };
    }
    if (w.i !== k) return { error: `words[${k}].i must equal ${k}` };
    cleanWords.push({ i: w.i, line: w.line, x: w.x, y: w.y, w: w.w, h: w.h });
  }

  if (!Array.isArray(samples)) return { error: 'samples must be an array' };
  if (samples.length > MAX_SAMPLES) return { status: 413, error: `at most ${MAX_SAMPLES} samples` };
  const cleanSamples = [];
  for (let k = 0; k < samples.length; k++) {
    const s = samples[k];
    const coord = (v) => isNum(v) || v === null;
    if (!isObj(s) || !isNum(s.t) || !coord(s.x) || !coord(s.y)) {
      return { error: `samples[${k}] must be {t: number, x: number|null, y: number|null}` };
    }
    cleanSamples.push({ t: s.t, x: s.x, y: s.y });
  }
  cleanSamples.sort((a, b) => a.t - b.t);

  return { passage, screen: { w: screen.w, h: screen.h }, words: cleanWords, samples: cleanSamples };
}

// Two routers: `childSessions` for /api/children/:id/sessions (upload and list) and `sessions`
// for /api/sessions. Both scope every query through children.teacher_id = req.user.id.
function createSessionsRouters({ db, now }) {
  const q = {
    child: db.prepare('SELECT id, consent_date FROM children WHERE id = ? AND teacher_id = ?'),
    insert: db.prepare(
      `INSERT INTO read_sessions
         (child_id, passage_id, kind, started_at, screen_w, screen_h, words_json, samples_json, metrics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    listByChild: db.prepare(
      'SELECT id, passage_id, kind, started_at, metrics_json FROM read_sessions WHERE child_id = ? ORDER BY started_at, id',
    ),
    get: db.prepare(
      `SELECT s.* FROM read_sessions s JOIN children c ON c.id = s.child_id
       WHERE s.id = ? AND c.teacher_id = ?`,
    ),
    updateMetrics: db.prepare(
      `UPDATE read_sessions SET metrics_json = ?
       WHERE id = ? AND child_id IN (SELECT id FROM children WHERE teacher_id = ?)`,
    ),
  };

  const childSessions = express.Router({ mergeParams: true });

  // Ownership (404) and consent (403) are decided before the body is parsed or validated.
  function loadChild(req, res, next) {
    const id = parseId(req.params.id);
    const child = id === null ? undefined : q.child.get(id, req.user.id);
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
    // Raw metrics are stored; every response goes through the quality rule.
    res.status(201).json({ id: Number(lastInsertRowid), metrics: applyQualityRule(metrics) });
  });

  childSessions.get('/', loadChild, (req, res) => {
    res.json(q.listByChild.all(req.child.id).map((r) => ({
      id: r.id,
      passageId: r.passage_id,
      kind: r.kind,
      startedAt: r.started_at,
      metrics: applyQualityRule(JSON.parse(r.metrics_json)),
    })));
  });

  const sessions = express.Router();
  sessions.get('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const r = id === null ? undefined : q.get.get(id, req.user.id);
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
    });
  });

  // Recomputes the metrics of a stored session with the current analysis (e.g. rows stored with the
  // old word-level metrics). Samples were validated and sorted at upload; they are used as stored.
  sessions.post('/:id/reanalyze', (req, res) => {
    const id = parseId(req.params.id);
    const r = id === null ? undefined : q.get.get(id, req.user.id);
    if (!r) return res.status(404).json(NOT_FOUND);
    const metrics = computeLineMetrics(
      JSON.parse(r.samples_json), JSON.parse(r.words_json), { w: r.screen_w, h: r.screen_h },
    );
    q.updateMetrics.run(JSON.stringify(metrics), r.id, req.user.id);
    res.json({ id: r.id, metrics: applyQualityRule(metrics) });
  });

  return { childSessions, sessions };
}

module.exports = { createSessionsRouters };
