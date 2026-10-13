const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { asyncH, HttpError, requireAuth, clearSessionCookie } = require('../middleware');
const { audit } = require('../audit');
const { allowedPages, allowedActions, allowedSections, landingPath } = require('../permissions');
const totp = require('../totp');
const emailCode = require('../email-code');
const maintenanceMode = require('../maintenance-mode');
const mailer = require('../mailer');
const v = require('../validate');
const { twofaRequired } = require('../config');

const router = express.Router();

const settings = require('../security-settings');   // lock after N wrong passwords, for M minutes: set in Admin > Security
// Dummy hash so timing is similar when the username does not exist
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);
// One message for every failure so responses never reveal whether a username exists, is locked or disabled
const GENERIC_FAIL = 'Incorrect username or password.';
// Said when the account exists and is locked (a different answer from a wrong password, so people know to wait or ask an Admin to unlock it)
const lockedMessage = (until) => {
  const mins = Math.max(1, Math.ceil((new Date(until) - Date.now()) / 60000));
  return `This account is locked after too many wrong passwords. Try again in ${mins} ${mins === 1 ? 'minute' : 'minutes'}, or ask an Administrator to unlock it.`;
};

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
  const lock = attempts >= settings.get().lockAfterFailures;
  await db.query(
    `UPDATE users SET failed_attempts=$2, locked_until=CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
     WHERE id=$1`,
    [user.id, lock ? 0 : attempts, lock, String(settings.get().lockMinutes)]
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


// While planned maintenance is on only a System Admin may sign in. Checked once the password is right (so nobody learns anything about an
// account from the answer) and again before the 2FA step completes, in case maintenance started in between.
const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);
const MAINTENANCE_NOTE = ' Only site administrators can sign in right now.';
async function refuseDuringMaintenance(req, res, user) {
  if (!maintenanceMode.enabled() || maintenanceMode.mayUse(user)) return false;
  await audit(req, 'auth.login_blocked_maintenance', 'user', user.id, { username: user.username });
  res.status(503).set({ 'Cache-Control': 'no-store', 'Retry-After': '300' }).json({ error: sentence(maintenanceMode.state().message) + MAINTENANCE_NOTE, maintenance: true });
  return true;
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
    throw new HttpError(401, lockedMessage(user.locked_until), { locked: true });
  }
  if (!ok) {
    const locked = await recordFailure(user);
    await audit(req, locked ? 'auth.locked' : 'auth.login_failed', 'user', user.id, { username });
    if (locked) throw new HttpError(401, lockedMessage(new Date(Date.now() + settings.get().lockMinutes * 60000)), { locked: true });   // this wrong password was the one that locked it
    throw new HttpError(401, GENERIC_FAIL);
  }
  if (!user.is_active) {
    await audit(req, 'auth.login_inactive', 'user', user.id, { username });
    throw new HttpError(401, GENERIC_FAIL);
  }

  if (await refuseDuringMaintenance(req, res, user)) return;

  if (user.totp_enabled) {
    await regenerate(req);
    req.session.pending2fa = { userId: user.id, at: Date.now(), tries: 0 };
    if (user.twofa_method === 'email') {
      try { await emailCode.issue(req.session, user, 'login'); } catch (e) {
        await audit(req, 'auth.2fa_email_failed', 'user', user.id, { username: user.username, error: e.message });
        delete req.session.pending2fa; await save(req);
        throw e;
      }
      await save(req);
      return res.json({ twofa: true, method: 'email', sentTo: mailer.mask(user.email) });
    }
    await save(req);
    return res.json({ twofa: true, method: 'app' });
  }

  await completeLogin(req, user);
  res.json({ ok: true, mustChangePassword: user.must_change_password });
}));

// Forgot password, by email code (no link, so no address has to be trusted): 1) the person gives their username or email and a 6-digit code is emailed
// (the answer is the same whether or not such an account exists); 2) they enter the code with a new password. The code lives in their session, works
// once for 10 minutes and allows 5 tries. Nothing changes until the code is right.
router.post('/forgot', loginLimiter, asyncH(async (req, res) => {
  if (!mailer.configured()) throw new HttpError(503, 'Resetting a password by email is not set up. Ask an Administrator to reset your password.');
  const who = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  if (!who || who.length > 120) throw new HttpError(400, 'Enter your username or email address');
  const { rows } = await db.query('SELECT * FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1) LIMIT 2', [who]);
  const user = rows.length === 1 ? rows[0] : null;   // two accounts on one address: nothing is sent, ask an Admin
  if (user && user.is_active && user.email) {
    try {
      await emailCode.issue(req.session, user, 'reset');
      req.session.pwReset = { uid: user.id, at: Date.now() };
      await save(req);
      await audit(req, 'auth.password_forgot', 'user', user.id, { username: user.username });
    } catch (e) { console.error('[forgot] could not send the code:', e.message); }   // never tells the caller (it would show the account exists)
  }
  res.json({ ok: true });
}));

router.post('/forgot/verify', loginLimiter, asyncH(async (req, res) => {
  const p = req.session.pwReset;
  if (!p || Date.now() - p.at > 15 * 60 * 1000) { delete req.session.pwReset; throw new HttpError(401, 'That reset has expired. Start again with Forgot password.'); }
  const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [p.uid]);
  const user = rows[0];
  if (!user || !user.is_active) throw new HttpError(401, 'That reset has expired. Start again with Forgot password.');
  const pw = v.password(req.body.password, { username: user.username, fullName: user.full_name });   // checked first, so a weak password does not use up the code
  if (!emailCode.check(req.session, user.id, 'reset', req.body.code)) { await save(req); throw new HttpError(401, 'That code is not right, or it has expired.'); }
  const hash = await bcrypt.hash(pw, 12);
  await db.query('UPDATE users SET password_hash=$2, must_change_password=FALSE, failed_attempts=0, locked_until=NULL, updated_at=now() WHERE id=$1', [user.id, hash]);
  await db.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1`, [user.id]);
  delete req.session.pwReset;
  await save(req);
  req.user = { id: user.id, username: user.username };
  await audit(req, 'auth.password_reset_self', 'user', user.id, { username: user.username });
  res.json({ ok: true });
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
  if (await refuseDuringMaintenance(req, res, user)) { delete req.session.pending2fa; await save(req); return; }

  // Valid AND not previously used (replay-protected)
  const valid = user.twofa_method === 'email'
    ? emailCode.check(req.session, user.id, 'login', req.body.token)
    : await totp.verifyAndConsume(db, user.id, user.totp_secret, req.body.token);
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

// Send the sign-in code again (email method only). Needs the first step of this sign-in to be done.
router.post('/2fa/resend', loginLimiter, asyncH(async (req, res) => {
  const p = req.session.pending2fa;
  if (!p || Date.now() - p.at > 5 * 60 * 1000) throw new HttpError(401, '2FA session expired. Please sign in again.');
  const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [p.userId]);
  const user = rows[0];
  if (!user || !user.is_active || user.twofa_method !== 'email') throw new HttpError(400, 'Not available');
  await emailCode.issue(req.session, user, 'login');
  p.at = Date.now();
  await save(req);
  res.json({ ok: true, sentTo: mailer.mask(user.email) });
}));

// "Confirm it's you" prompts for email-method accounts: mail the code, then it is sent back with the password.
router.post('/reauth-code', requireAuth, asyncH(async (req, res) => {
  if (!req.user.totp_enabled || req.user.twofa_method !== 'email') throw new HttpError(400, 'Not available');
  await emailCode.issue(req.session, req.user, 'reauth');
  res.json({ ok: true, sentTo: mailer.mask(req.user.email) });
}));

router.post('/logout', asyncH(async (req, res) => {
  if (req.user) await audit(req, 'auth.logout', 'user', req.user.id);
  if (req.user) await db.query('UPDATE user_presence SET left_at = now(), last_active_at = now() WHERE user_id = $1', [req.user.id]).then(() => require('./presence').presenceChanged()).catch(() => { /* presence is best-effort */ });   // signed out = no longer "active"
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
      role: u.role, group: u.group_name || null, totp_enabled: u.totp_enabled, twofa_method: u.twofa_method, email_2fa_available: require('../security-settings').get().allowEmail2fa && mailer.configured(), must_change_password: u.must_change_password,
      totp_required: twofaRequired(u),
      appearance: u.appearance || 'system',
    },
    pages: allowedPages(u),
    sections: allowedSections(u),
    actions: allowedActions(u),
    landing: landingPath(u),
    maintenance: maintenanceMode.state(),   // { on, message }: only a System Admin gets this far while it is on — the page shows a banner
    // A fingerprint of THIS sign-in (a one-way hash of the session id — the id itself is never sent to the page). It changes every time someone
    // signs in, so the page can keep a per-sign-in preference (the Dashboard's period menu) and forget it at sign-out.
    session_key: crypto.createHash('sha256').update(String(req.sessionID || '')).digest('hex').slice(0, 20),
  });
});

module.exports = router;
