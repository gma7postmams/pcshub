const express = require('express');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const validator = require('validator');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError } = require('../middleware');
const { can } = require('../permissions');
const emailCode = require('../email-code');
const mailer = require('../mailer');
const { audit } = require('../audit');
const totp = require('../totp');
const { MODES } = require('../themes');
const { twofaRequired } = require('../config');
const stepUp = require('../reauth');

const router = express.Router();

router.put('/', asyncH(async (req, res) => {
  const full_name = v.str(req.body.full_name, { field: 'Full name', max: 120, required: true });
  const email = v.str(req.body.email, { field: 'Email', max: 200 });
  if (email && !validator.isEmail(email)) throw new HttpError(400, 'Invalid email');
  const { rows } = await db.query('SELECT full_name, email FROM users WHERE id=$1', [req.user.id]);
  const current = rows[0];
  if (req.user.totp_enabled && req.user.twofa_method === 'email' && (current.email || '') !== (email || '')) {
    throw new HttpError(400, 'Your email address receives your sign-in codes, so only an Admin can change it');
  }
  await db.query('UPDATE users SET full_name=$2, email=$3, updated_at=now() WHERE id=$1', [req.user.id, full_name, email]);

  const details = {};
  if (current.full_name !== full_name) {
    details.old_full_name = current.full_name;
    details.new_full_name = full_name;
  }
  if (current.email !== email) {
    details.old_email = current.email;
    details.new_email = email;
  }
  await audit(req, 'profile.update', 'user', req.user.id, details);
  res.json({ ok: true });
}));

router.post('/password', asyncH(async (req, res) => {
  const current = typeof req.body.current === 'string' ? req.body.current : '';
  const next = v.password(req.body.password, { username: req.user.username, fullName: req.user.full_name });
  // Wrong guesses are counted per user (shared with the other "confirm your password" prompts), so a session left
  // open cannot be used to work out the password.
  stepUp.attempt(req.user.id);
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (current.length > 200 || !(await bcrypt.compare(current, rows[0].password_hash))) {
    await audit(req, 'auth.reauth_failed', 'user', req.user.id, { for: 'profile.password_change' });
    throw new HttpError(400, 'Current password is incorrect');
  }
  stepUp.succeed(req.user.id);
  if (await bcrypt.compare(next, rows[0].password_hash)) throw new HttpError(400, 'New password must differ from the current one');
  const hash = await bcrypt.hash(next, 12);
  await db.query('UPDATE users SET password_hash=$2, must_change_password=FALSE, updated_at=now() WHERE id=$1', [req.user.id, hash]);
  // Invalidate the user's other sessions
  await db.query(`DELETE FROM user_sessions WHERE sid <> $1 AND (sess->>'userId')::int = $2`, [req.sessionID, req.user.id]);
  await audit(req, 'profile.password_change', 'user', req.user.id);
  res.json({ ok: true });
}));

// Per-user appearance (Dark / Light / System). Theme palette itself is set by Admin.
router.put('/appearance', asyncH(async (req, res) => {
  const mode = v.oneOf(req.body.mode, MODES, { field: 'Appearance' });
  await db.query('UPDATE users SET appearance=$2, updated_at=now() WHERE id=$1', [req.user.id, mode]);
  res.json({ ok: true, mode });
}));

// --- TOTP 2FA ---
// Users cannot turn 2FA on or off themselves: an Admin switches it on for them (Admin > Users) and they enrol here.
router.post('/2fa/setup', asyncH(async (req, res) => {
  if (!twofaRequired(req.user)) throw new HttpError(403, '2FA is turned on for an account by an Admin');
  if (req.user.totp_enabled) throw new HttpError(400, '2FA is already enabled');
  if (req.user.twofa_method === 'email') throw new HttpError(400, 'Your account uses email codes. Use "Email me a code".');
  // The name the authenticator app shows next to the username: the short name (PULSE), else the Branding app name.
  let issuer = mailer.shortName();
  if (!issuer) {
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key='app_name'`);
    issuer = (rows[0] && rows[0].value) || 'PULSE';
  }
  const secret = totp.generateSecret();
  req.session.totpSetup = totp.encrypt(secret); // sessions are stored in Postgres — keep it encrypted there too
  const qr = await QRCode.toDataURL(totp.keyUri(req.user.username, issuer, secret), { margin: 1, width: 220 });
  res.json({ secret, qr });
}));

// Email method: send a setup code to the account's address, then confirm it (with the password) to switch it on.
const emailReady = (req) => {
  if (!twofaRequired(req.user)) throw new HttpError(403, '2FA is turned on for an account by an Admin');
  if (req.user.twofa_method !== 'email') throw new HttpError(400, 'Your account uses an authenticator app');
  if (req.user.totp_enabled) throw new HttpError(400, '2FA is already enabled');
  if (!require('../security-settings').get().allowEmail2fa || !mailer.configured()) throw new HttpError(400, 'Email codes are not available. Ask an Admin.');
};
router.post('/2fa/email/send', asyncH(async (req, res) => {
  emailReady(req);
  await emailCode.issue(req.session, req.user, 'enroll');
  res.json({ ok: true, sentTo: mailer.mask(req.user.email) });
}));
router.post('/2fa/email/enable', asyncH(async (req, res) => {
  emailReady(req);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!password) throw new HttpError(400, 'Enter your password to turn on 2FA');
  stepUp.attempt(req.user.id);
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (password.length > 200 || !(await bcrypt.compare(password, rows[0].password_hash))) {
    await audit(req, 'auth.reauth_failed', 'user', req.user.id, { for: 'profile.2fa_enable' });
    throw new HttpError(400, 'Password is incorrect');
  }
  stepUp.succeed(req.user.id);
  if (!emailCode.check(req.session, req.user.id, 'enroll', req.body.code)) throw new HttpError(400, 'That code is wrong or has expired');
  await db.query('UPDATE users SET totp_secret=NULL, totp_enabled=TRUE, totp_last_step=NULL, updated_at=now() WHERE id=$1', [req.user.id]);
  await db.query(`DELETE FROM user_sessions WHERE sid <> $1 AND (sess->>'userId')::int = $2`, [req.sessionID, req.user.id]);
  await audit(req, 'profile.2fa_enable', 'user', req.user.id, { method: 'email' });
  res.json({ ok: true });
}));

router.post('/2fa/enable', asyncH(async (req, res) => {
  if (!twofaRequired(req.user)) throw new HttpError(403, '2FA is turned on for an account by an Admin');
  const pending = req.session.totpSetup;
  if (!pending) throw new HttpError(400, 'Start 2FA setup first');
  // The account password is needed as well as the code: otherwise anyone holding an open session could attach their
  // own authenticator and lock the real owner out.
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!password) throw new HttpError(400, 'Enter your password to turn on 2FA');
  stepUp.attempt(req.user.id);
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (password.length > 200 || !(await bcrypt.compare(password, rows[0].password_hash))) {
    await audit(req, 'auth.reauth_failed', 'user', req.user.id, { for: 'profile.2fa_enable' });
    throw new HttpError(400, 'Password is incorrect');
  }
  stepUp.succeed(req.user.id);
  const secret = totp.decrypt(pending);
  const step = totp.matchStep(req.body.token, secret);
  if (step === null) throw new HttpError(400, 'Invalid code — check your authenticator app time and try again');
  await db.query(
    'UPDATE users SET totp_secret=$2, totp_enabled=TRUE, totp_last_step=$3, updated_at=now() WHERE id=$1',
    [req.user.id, pending, step]
  );
  delete req.session.totpSetup;
  // Other sessions were established without 2FA — sign them out
  await db.query(`DELETE FROM user_sessions WHERE sid <> $1 AND (sess->>'userId')::int = $2`, [req.sessionID, req.user.id]);
  await audit(req, 'profile.2fa_enable', 'user', req.user.id);
  res.json({ ok: true });
}));

router.get('/activity-history', asyncH(async (req, res) => {
  if (!can(req.user, 'activity.view')) throw new HttpError(403, 'Activity History is not available for your role');
  const params = [req.user.id];
  const where = ['user_id = $1'];

  if (req.query.action) {
    params.push(v.like(req.query.action, 100));

    where.push(`
      (
        action ILIKE $${params.length}
        OR username ILIKE $${params.length}
        OR entity ILIKE $${params.length}
        OR COALESCE(details::text, '') ILIKE $${params.length}
        OR COALESCE(ip, '') ILIKE $${params.length}
      )
    `);
  }

  if (req.query.from) {
    params.push(v.date(req.query.from, { field: 'From' }));
    where.push(`created_at >= $${params.length}::date`);
  }

  if (req.query.to) {
    params.push(v.date(req.query.to, { field: 'To' }));
    where.push(`created_at < ($${params.length}::date + 1)`);
  }

  const { limit, offset } = v.paging(req.query, { def: 50, max: 200 });

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [cnt, list] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS n
       FROM audit_logs
       ${whereSql}`,
      params
    ),
    db.query(
      `SELECT *
       FROM audit_logs
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit}
       OFFSET ${offset}`,
      params
    ),
  ]);

  res.json({
    total: cnt.rows[0].n,
    rows: list.rows,
  });
}));

module.exports = router;
