'use strict';
const path = require('node:path');
const express = require('express');
const { createAuth } = require('./auth');
const { loadConfig, parseAcademyUrl } = require('./config');
const { MIN_SECRET_LEN } = require('./sso-token');
const { createChildrenRouter, createPassagesRouter, NOT_FOUND } = require('./routes/children');
const { createSessionsRouters } = require('./routes/sessions');
const { createReportsRouters } = require('./routes/reports');
const { createAdminRouter } = require('./routes/admin');
const { createPasswordResetRouter } = require('./routes/password-reset');
const { createSsoRouter } = require('./routes/sso');

// The legacy password flows. Unless ALLOW_PASSWORD_LOGIN=1 they answer 404 before any guard runs
// (so their existence is not even hinted at by a 401). Matched case-insensitively on the raw and
// on the decoded path, since the static server decodes "%2e" and the router ignores case.
const LEGACY_PATHS = [
  /^\/api\/login\/?$/i,
  /^\/api\/invites(\/|$)/i,
  /^\/api\/password-reset(\/|$)/i,
  /^\/api\/admin\/invites(\/|$)/i,
  /^\/api\/admin\/teachers\/[^/]+\/reset-link\/?$/i,
  /^\/(invite|reset|login)\.html$/i,
  /^\/js\/(invite|login)\.js$/i,
];
// Pages a student session may open; any other page sends the student back to their measurement.
const STUDENT_PAGES = /^\/(read|index|report)\.html$/i;

function decodedPath(p) {
  try { return decodeURIComponent(p); } catch { return null; }
}

// The file the static server would resolve: decoded, "." / ".." / repeated slashes collapsed
// (send() does the same), so "//login.html", "/./login.html" or "/x/../login.html" all match.
function resolvedPath(p) {
  const decoded = decodedPath(p);
  if (decoded === null || decoded.includes('\0')) return null;
  return path.posix.normalize(`/${decoded}`).replace(/\/{2,}/g, '/');
}

function normalizeConfig(config) {
  const secret = typeof config.ssoSecret === 'string' ? config.ssoSecret.trim() : '';
  return {
    ssoSecret: secret.length >= MIN_SECRET_LEN ? secret : null,
    academyUrl: parseAcademyUrl(config.academyUrl),
    allowPasswordLogin: config.allowPasswordLogin === true,
  };
}

// `now` is the single clock for every expiry check, so tests can time-travel.
// `config` comes from the environment by default (server/config.js); tests pass their own.
function createApp({ db, now = Date.now, config = loadConfig(process.env) }) {
  const cfg = normalizeConfig(config);
  const app = express();
  app.disable('x-powered-by');

  const auth = createAuth({ db, now, config: cfg });
  const { childSessions, sessions } = createSessionsRouters({ db, now });
  const reports = createReportsRouters({ db, now });

  if (!cfg.allowPasswordLogin) {
    app.use((req, res, next) => {
      const resolved = resolvedPath(req.path);
      if (resolved === null) return res.status(400).json({ error: 'bad path' });
      if (LEGACY_PATHS.some((re) => re.test(req.path) || re.test(resolved))) return res.status(404).json(NOT_FOUND);
      next();
    });
  }

  app.use(createSsoRouter({ db, now, config: cfg, auth }));

  // Guards sit on prefixes so routes added by later tasks are protected from the start.
  // A student session passes exactly two of them: its own child's upload, and the passage list of
  // its own grade band. Every other /api route refuses it (requireTeacher/requireAdmin).
  app.use('/api/admin', auth.requireAdmin);
  app.use('/api/children', auth.requireTeacherOrStudent((req, student) => {
    const m = /^\/([1-9]\d{0,14})\/sessions\/?$/.exec(req.path);
    return req.method === 'POST' && m !== null && Number(m[1]) === student.childId;
  }));
  app.use('/api/passages', auth.requireTeacherOrStudent((req, student) => (
    req.method === 'GET' && (req.path === '/' || req.path === '') && req.query.gradeBand === student.gradeBand
  )));
  for (const prefix of ['/api/sessions', '/api/share']) app.use(prefix, auth.requireTeacher);
  // Session upload carries up to 100k samples and brings its own 10mb parser, so it must be
  // mounted before the global 1mb one (which would reject it). Only this path gets the larger limit.
  app.use('/api/children/:id/sessions', childSessions);
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/admin', createAdminRouter({ db, now, config: cfg }));
  if (cfg.allowPasswordLogin) {
    // Public: the one-time reset token is the credential, so it sits outside the guards above.
    app.use('/api/password-reset', createPasswordResetRouter({ db, now, clearLoginLimit: auth.clearLoginLimit }));
  }
  app.use('/api/children', createChildrenRouter({ db, now }));
  app.use('/api/passages', createPassagesRouter());
  app.use('/api/children/:id/trend', reports.childTrend);
  app.use('/api/sessions/:id/share', reports.sessionShare);
  app.use('/api/sessions/:id/shares', reports.sessionShares);
  app.use('/api/sessions', sessions);
  app.use('/api/share', reports.share);
  // Public parent report: deliberately outside the guards above; the share token is the credential.
  app.use('/api/report', reports.report);
  app.use(auth.router);

  // A student who opens a staff page (children.html, measure.html, ...) goes back to their own
  // measurement. The pages hold no data anyway; this keeps the student out of staff screens.
  app.use((req, res, next) => {
    const page = resolvedPath(req.path) ?? req.path;
    if (req.method !== 'GET' || !/\.html$/i.test(page) || STUDENT_PAGES.test(page)) return next();
    const student = auth.authenticateStudent(req);
    if (!student) return next();
    res.set('Cache-Control', 'no-store');
    res.redirect(302, `/read.html?child=${student.childId}`);
  });

  // Front end. Last among the routes so it can never shadow /api; dotfiles are ignored (404),
  // there is no directory listing, and nothing outside public/ is reachable.
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: 'index.html',
    dotfiles: 'ignore',
    redirect: false,
    setHeaders: (res) => res.set('Referrer-Policy', 'no-referrer'),
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp };
