'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const { createLoginLimiter } = require('./login-limiter');
const { audit } = require('./audit');

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // legacy password login (break-glass only)
const SSO_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // staff arriving from the academy site
const STUDENT_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // one measurement visit, not a school day
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LEN = 8;
const MAX_PASSWORD_LEN = 256;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "scrypt$<salt hex>$<key hex>"
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  // Malformed hex decodes to a short/empty buffer; never let that compare equal to anything.
  if (salt.length === 0 || expected.length !== KEY_LEN) return false;
  const actual = await scrypt(password, salt, KEY_LEN);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const isValidPassword = (v) => typeof v === 'string' && v.length >= MIN_PASSWORD_LEN && v.length <= MAX_PASSWORD_LEN;

function readSidCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === 'sid') return part.slice(eq + 1).trim() || null;
  }
  return null;
}

function setSidCookie(res, value, maxAgeSec) {
  const attrs = [`sid=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (process.env.NODE_ENV !== 'test') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// A hash to burn scrypt time on when the email is unknown (keeps login timing uniform).
let dummyHash;

// config.allowPasswordLogin: the password, invite and reset routes exist only when it is true.
function createAuth({ db, now = Date.now, config = {} }) {
  const allowPasswordLogin = config.allowPasswordLogin === true;
  const loginLimiter = createLoginLimiter({ now });
  const inviteLimiter = createLoginLimiter({ now }); // keyed by sha256(token)
  const q = {
    userByEmail: db.prepare('SELECT id, email, pw_hash, role, disabled_at FROM users WHERE email = ?'),
    insertSession: db.prepare('INSERT INTO auth_sessions (token, user_id, expires_at, launch_sid) VALUES (?, ?, ?, ?)'),
    deleteSession: db.prepare('DELETE FROM auth_sessions WHERE token = ?'),
    sessionUser: db.prepare(
      `SELECT u.id, u.email, u.role, u.disabled_at, s.expires_at, s.launch_sid FROM auth_sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
    insertInvite: db.prepare(
      `INSERT INTO invites (id, token, email, expires_at)
       VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM invites), ?, ?, ?) RETURNING id`),
    touchLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
    invite: db.prepare('SELECT token, email, expires_at, used_at FROM invites WHERE token = ?'),
    useInvite: db.prepare('UPDATE invites SET used_at = ? WHERE token = ? AND used_at IS NULL'),
    insertUser: db.prepare("INSERT INTO users (email, pw_hash, role, created_at) VALUES (?, ?, 'teacher', ?)"),
    insertStudentSession: db.prepare(
      'INSERT INTO student_sessions (token_hash, child_id, external_student_id, expires_at) VALUES (?, ?, ?, ?)'),
    deleteStudentSession: db.prepare('DELETE FROM student_sessions WHERE token_hash = ?'),
    // The child must still carry the student number the session was opened for: unlinking or
    // relinking a child ends its student sessions at once.
    studentSession: db.prepare(
      `SELECT s.expires_at, c.id, c.code, c.initials, c.grade_band, c.consent_date FROM student_sessions s
       JOIN children c ON c.id = s.child_id AND c.external_student_id = s.external_student_id
       WHERE s.token_hash = ?`),
  };

  function authenticate(req) {
    const sid = readSidCookie(req);
    if (!sid) return null;
    const row = q.sessionUser.get(sid);
    if (!row) return null;
    // A disabled account is logged out at once, even if its cookie is otherwise valid.
    if (row.disabled_at !== null) return null;
    if (row.expires_at <= now()) {
      q.deleteSession.run(sid);
      return null;
    }
    return { id: row.id, email: row.email, role: row.role, launchSid: row.launch_sid ?? null };
  }

  // A student session (from the academy's student menu). Never a users row: it only names the one
  // child it may measure. Returns { childId, code, initials, gradeBand, consentDate } or null.
  function authenticateStudent(req) {
    const sid = readSidCookie(req);
    if (!sid) return null;
    const key = sha256Hex(sid);
    const row = q.studentSession.get(key);
    if (!row) return null;
    if (row.expires_at <= now()) {
      q.deleteStudentSession.run(key);
      return null;
    }
    return {
      childId: row.id, code: row.code, initials: row.initials, gradeBand: row.grade_band, consentDate: row.consent_date || null,
    };
  }

  // A signed-in student is told "not for you" (403) with no data; everyone else unknown is 401.
  const refuse = (req, res) => (authenticateStudent(req)
    ? res.status(403).json({ error: 'student_session' })
    : res.status(401).json({ error: 'login required' }));

  // Teachers and admins both pass; admins are accounts too. Student sessions never pass.
  function requireTeacher(req, res, next) {
    const user = authenticate(req);
    if (!user) return refuse(req, res);
    req.user = user;
    next();
  }

  function requireAdmin(req, res, next) {
    const user = authenticate(req);
    if (!user) return refuse(req, res);
    if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    req.user = user;
    next();
  }

  // Like requireTeacher, but a student session passes too when allow(req, student) says this exact
  // request is one a student may make; it then gets req.student and no req.user.
  function requireTeacherOrStudent(allow) {
    return (req, res, next) => {
      const user = authenticate(req);
      if (user) { req.user = user; return next(); }
      const student = authenticateStudent(req);
      if (!student) return res.status(401).json({ error: 'login required' });
      if (!allow(req, student)) return res.status(403).json({ error: 'student_session' });
      req.student = student;
      next();
    };
  }

  // Ends whatever session the request's cookie names (staff or student). Used by logout and by
  // /sso before it opens a new session, so an old cookie can never be carried over (fixation).
  function endSession(req) {
    const sid = readSidCookie(req);
    if (!sid) return;
    q.deleteSession.run(sid);
    q.deleteStudentSession.run(sha256Hex(sid));
  }

  // launchSid: the signed token's sid (never a request value), or '' / null for none.
  function startUserSession(res, userId, launchSid = null) {
    const token = crypto.randomBytes(32).toString('hex');
    q.insertSession.run(token, userId, now() + SSO_SESSION_TTL_MS, launchSid || null);
    q.touchLogin.run(now(), userId);
    setSidCookie(res, token, SSO_SESSION_TTL_MS / 1000);
  }

  // Only sha256 of the cookie value is stored for students.
  function startStudentSession(res, child) {
    const token = crypto.randomBytes(32).toString('hex');
    q.insertStudentSession.run(sha256Hex(token), child.id, child.external_student_id, now() + STUDENT_SESSION_TTL_MS);
    setSidCookie(res, token, STUDENT_SESSION_TTL_MS / 1000);
  }

  const router = express.Router();

  if (allowPasswordLogin) router.post('/api/login', async (req, res, next) => {
    try {
      const email = normEmail(req.body?.email);
      const password = req.body?.password;
      if (!email || typeof password !== 'string' || password.length > MAX_PASSWORD_LEN) {
        return res.status(400).json({ error: 'email and password required' });
      }
      // Checked before any scrypt work, keyed on the email whether or not the account exists, so
      // the response never reveals which emails are real. The attempt is counted up front (and
      // cleared on success) so a burst of concurrent guesses cannot all slip past the check.
      const gate = loginLimiter.check(email);
      if (gate.blocked) {
        res.set('Retry-After', String(gate.retryAfterSec));
        return res.status(429).json({ error: 'too_many_attempts' });
      }
      loginLimiter.recordFailure(email);

      const user = q.userByEmail.get(email);
      dummyHash ??= await hashPassword('dummy-password');
      const ok = await verifyPassword(password, user ? user.pw_hash : dummyHash);
      if (!user || user.disabled_at !== null || !ok) return res.status(401).json({ error: 'invalid email or password' });
      loginLimiter.clear(email);

      const token = crypto.randomBytes(32).toString('hex');
      q.insertSession.run(token, user.id, now() + SESSION_TTL_MS, null);
      q.touchLogin.run(now(), user.id);
      setSidCookie(res, token, SESSION_TTL_MS / 1000);
      res.json({ id: user.id, email: user.email, role: user.role });
    } catch (err) { next(err); }
  });

  // Who am I? Lets the UI show admin-only controls; the server still enforces roles on every route.
  // A student gets their own child's labels only (what the reading page shows), never scores.
  router.get('/api/me', (req, res) => {
    const user = authenticate(req);
    if (user) {
      return res.json({
        email: user.email, role: user.role, passwordLogin: allowPasswordLogin, launchStudentId: user.launchSid,
      });
    }
    const student = authenticateStudent(req);
    if (!student) return res.status(401).json({ error: 'login required' });
    res.json({
      role: 'student',
      child: {
        id: student.childId, code: student.code, initials: student.initials, gradeBand: student.gradeBand, consentDate: student.consentDate,
      },
    });
  });

  // Clears the cookie; the UI then goes to /academy (the academy site), the only way back in.
  router.post('/api/logout', (req, res) => {
    endSession(req);
    setSidCookie(res, '', 0);
    res.json({ ok: true, next: '/academy' });
  });

  if (allowPasswordLogin) router.post('/api/admin/invites', (req, res) => {
    const email = normEmail(req.body?.email);
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'valid email required' });
    if (q.userByEmail.get(email)) return res.status(409).json({ error: 'account already exists' });
    const token = crypto.randomBytes(32).toString('base64url');
    const { id } = q.insertInvite.get(token, email, now() + INVITE_TTL_MS);
    audit(db, now, req.user.id, 'invite.create', `invite:${id}`, email);
    res.json({ token });
  });

  if (allowPasswordLogin) router.post('/api/invites/:token/accept', async (req, res, next) => {
    try {
      // Per-token failure limit (key = hash, so the raw token never sits in memory): repeated
      // unknown/used/expired answers for one token end in 429. A token that is currently valid is
      // cleared, so a typo'd password can never lock out its rightful holder.
      const key = sha256Hex(req.params.token);
      const gate = inviteLimiter.check(key);
      if (gate.blocked) {
        res.set('Retry-After', String(gate.retryAfterSec));
        return res.status(429).json({ error: 'too_many_attempts' });
      }
      inviteLimiter.recordFailure(key);
      const invite = q.invite.get(req.params.token);
      if (!invite) return res.status(404).json({ error: 'invite not found' });
      if (invite.used_at !== null || invite.expires_at <= now()) {
        return res.status(410).json({ error: 'invite expired or already used' });
      }
      inviteLimiter.clear(key);
      const password = req.body?.password;
      if (!isValidPassword(password)) {
        return res.status(400).json({ error: `password must be ${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN} characters` });
      }
      const pwHash = await hashPassword(password);
      // Re-check and consume atomically: the await above lets a concurrent accept slip in.
      const created = db.transaction(() => {
        if (q.useInvite.run(now(), invite.token).changes === 0) return 'used';
        if (q.userByEmail.get(invite.email)) throw Object.assign(new Error('exists'), { code: 'EXISTS' });
        q.insertUser.run(invite.email, pwHash, now());
        return 'ok';
      });
      let outcome;
      try { outcome = created(); } catch (err) {
        if (err.code === 'EXISTS') return res.status(409).json({ error: 'account already exists' });
        throw err;
      }
      if (outcome === 'used') return res.status(410).json({ error: 'invite expired or already used' });
      res.status(201).json({ email: invite.email });
    } catch (err) { next(err); }
  });

  // A password reset ends any login lockout the account had collected (key = normalized email).
  const clearLoginLimit = (email) => loginLimiter.clear(normEmail(email));

  return {
    router, requireTeacher, requireAdmin, requireTeacherOrStudent, authenticate, authenticateStudent,
    endSession, startUserSession, startStudentSession, clearLoginLimit,
  };
}

// Creates the first admin account when the users table is empty. Returns true if created.
async function ensureFirstAdmin(db, { email, password, now = Date.now }) {
  const norm = normEmail(email);
  if (!norm || typeof password !== 'string' || !password) return false;
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return false;
  db.prepare("INSERT INTO users (email, pw_hash, role, created_at) VALUES (?, ?, 'admin', ?)")
    .run(norm, await hashPassword(password), now());
  return true;
}

module.exports = {
  SSO_SESSION_TTL_MS, STUDENT_SESSION_TTL_MS,
  createAuth, sha256Hex, hashPassword, verifyPassword, ensureFirstAdmin, normEmail, isValidPassword, MIN_PASSWORD_LEN, MAX_PASSWORD_LEN,
};
