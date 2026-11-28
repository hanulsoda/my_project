'use strict';
const path = require('node:path');
const express = require('express');
const { createAuth } = require('./auth');
const { createChildrenRouter, createPassagesRouter } = require('./routes/children');
const { createSessionsRouters } = require('./routes/sessions');
const { createReportsRouters } = require('./routes/reports');
const { createAdminRouter } = require('./routes/admin');
const { createPasswordResetRouter } = require('./routes/password-reset');

// `now` is the single clock for every expiry check, so tests can time-travel.
function createApp({ db, now = Date.now }) {
  const app = express();
  app.disable('x-powered-by');

  const auth = createAuth({ db, now });
  const { childSessions, sessions } = createSessionsRouters({ db, now });
  const reports = createReportsRouters({ db, now });

  // Guards sit on prefixes so routes added by later tasks are protected from the start.
  app.use('/api/admin', auth.requireAdmin);
  for (const prefix of ['/api/children', '/api/passages', '/api/sessions', '/api/share']) {
    app.use(prefix, auth.requireTeacher);
  }
  // Session upload carries up to 100k samples and brings its own 10mb parser, so it must be
  // mounted before the global 1mb one (which would reject it). Only this path gets the larger limit.
  app.use('/api/children/:id/sessions', childSessions);
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/admin', createAdminRouter({ db, now }));
  // Public: the one-time reset token is the credential, so it sits outside the guards above.
  app.use('/api/password-reset', createPasswordResetRouter({ db, now }));
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
