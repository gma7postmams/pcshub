const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { asyncH, HttpError, requireAuth, clearSessionCookie } = require('../middleware');
const { audit } = require('../audit');
const { allowedPages, allowedActions, allowedSections, landingPath } = require('../permissions');
const totp = require('../totp');
const { twofaRequired } = require('../config');

const router = express.Router();

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Dummy hash so timing is similar when the username does not exist
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);
// One message for every failure so responses never reveal whether a username exists, is locked or disabled
const GENERIC_FAIL = 'Invalid username or password, or the account is temporarily locked.';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: parseInt(process.env.LOGIN_RATE_LIMIT, 10) || 20, // attempts per IP per 15 min
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
}
function save(req) {
  return new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
}

async function recordFailure(user) {
  const attempts = user.failed_attempts + 1;
  const lock = attempts >= MAX_FAILED;
  await db.query(
    `UPDATE users SET failed_attempts=$2, locked_until=CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
     WHERE id=$1`,
    [user.id, lock ? 0 : attempts, lock, String(LOCK_MINUTES)]
  );
  return lock;
}

async function completeLogin(req, user) {
  await regenerate(req);
  req.session.userId = user.id;
  req.session.createdAt = Date.now();   // start of the absolute session lifetime (SESSION_MAX_HOURS)
  await db.query('UPDATE users SET failed_attempts=0, locked_until=NULL, last_login_at=now() WHERE id=$1', [user.id]);
  req.user = { id: user.id, username: user.username };
  await audit(req, 'auth.login', 'user', user.id);
  await save(req);
}

router.post('/login', loginLimiter, asyncH(async (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || !password) throw new HttpError(400, 'Username and password are required');
  // Nothing valid is this long: answer like any other failure without hashing it or writing it to the audit log
  if (username.length > 60 || password.length > 200) throw new HttpError(401, GENERIC_FAIL);

  const { rows } = await db.query('SELECT * FROM users WHERE lower(username)=lower($1)', [username]);
  const user = rows[0];

  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    await audit(req, 'auth.login_failed', 'user', null, { username, reason: 'unknown_user' });
    throw new HttpError(401, GENERIC_FAIL);
  }
  const ok = await bcrypt.compare(password, user.password_hash); // always run: same timing for locked accounts
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await audit(req, 'auth.login_blocked_locked', 'user', user.id, { username });
    throw new HttpError(401, GENERIC_FAIL);
  }
  if (!ok) {
    const locked = await recordFailure(user);
    await audit(req, locked ? 'auth.locked' : 'auth.login_failed', 'user', user.id, { username });
    throw new HttpError(401, GENERIC_FAIL);
  }
  if (!user.is_active) {
    await audit(req, 'auth.login_inactive', 'user', user.id, { username });
    throw new HttpError(401, GENERIC_FAIL);
  }

  if (user.totp_enabled) {
    await regenerate(req);
    req.session.pending2fa = { userId: user.id, at: Date.now(), tries: 0 };
    await save(req);
    return res.json({ twofa: true });
  }

  await completeLogin(req, user);
  res.json({ ok: true, mustChangePassword: user.must_change_password });
}));

router.post('/2fa', loginLimiter, asyncH(async (req, res) => {
  const p = req.session.pending2fa;
  if (!p || Date.now() - p.at > 5 * 60 * 1000) {
    delete req.session.pending2fa;
    throw new HttpError(401, '2FA session expired. Please sign in again.');
  }
  const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [p.userId]);
  const user = rows[0];
  if (!user || !user.is_active || !user.totp_enabled) throw new HttpError(401, 'Please sign in again.');

  // Valid AND not previously used (replay-protected)
  const valid = await totp.verifyAndConsume(db, user.id, user.totp_secret, req.body.token);
  if (!valid) {
    p.tries += 1;
    if (p.tries >= 5) {
      delete req.session.pending2fa;
      await recordFailure(user);
    }
    await save(req);
    await audit(req, 'auth.2fa_failed', 'user', user.id, { username: user.username });
    throw new HttpError(401, 'Invalid authentication code');
  }
  await completeLogin(req, user);
  res.json({ ok: true, mustChangePassword: user.must_change_password });
}));

router.post('/logout', asyncH(async (req, res) => {
  if (req.user) await audit(req, 'auth.logout', 'user', req.user.id);
  if (req.user) await db.query('DELETE FROM user_presence WHERE user_id = $1', [req.user.id]).then(() => require('./presence').presenceChanged()).catch(() => { /* presence is best-effort */ });   // signed out = no longer "active"
  req.session.destroy(() => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });
}));

router.get('/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    user: {
      id: u.id, username: u.username, full_name: u.full_name, email: u.email,
      role: u.role, group: u.group_name || null, totp_enabled: u.totp_enabled, must_change_password: u.must_change_password,
      totp_required: twofaRequired(u),
      appearance: u.appearance || 'system',
    },
    pages: allowedPages(u),
    sections: allowedSections(u),
    actions: allowedActions(u),
    landing: landingPath(u),
    // A fingerprint of THIS sign-in (a one-way hash of the session id — the id itself is never sent to the page). It changes every time someone
    // signs in, so the page can keep a per-sign-in preference (the Dashboard's period menu) and forget it at sign-out.
    session_key: crypto.createHash('sha256').update(String(req.sessionID || '')).digest('hex').slice(0, 20),
  });
});

module.exports = router;
