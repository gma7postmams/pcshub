const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
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
const { MODES, THEME_KEYS } = require('../themes');
const { twofaRequired } = require('../config');
const stepUp = require('../reauth');

const router = express.Router();

// ---- Phone notifications (Web Push) ----
router.get('/push', asyncH(async (req, res) => {
  const { rows } = await db.query('SELECT endpoint FROM push_subscriptions WHERE user_id=$1', [req.user.id]);
  let key;
  try { key = await require('../push').publicKey(); } catch (e) {
    console.error('push setup failed:', e.message);
    throw new HttpError(400, e.code === 'MODULE_NOT_FOUND' ? 'Push notifications are not installed on the server yet (an Admin needs to run npm install and restart)' : 'Push notifications are not available right now');
  }
  res.json({ key, endpoints: rows.map((r) => r.endpoint) });
}));
router.post('/push', asyncH(async (req, res) => {
  const sub = req.body || {};
  const endpoint = v.str(sub.endpoint, { field: 'Endpoint', max: 1000, required: true });
  const p256dh = v.str(sub.keys && sub.keys.p256dh, { field: 'Key', max: 200, required: true });
  const auth = v.str(sub.keys && sub.keys.auth, { field: 'Key', max: 100, required: true });
  if (!/^https:\/\//.test(endpoint)) throw new HttpError(400, 'Invalid endpoint');
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id=$1, p256dh=$3, auth=$4, ua=$5`,
    [req.user.id, endpoint, p256dh, auth, String(req.get('user-agent') || '').slice(0, 200)]);
  res.json({ ok: true });
}));
router.delete('/push', asyncH(async (req, res) => {
  const endpoint = v.str(req.body && req.body.endpoint, { field: 'Endpoint', max: 1000 });
  if (endpoint) await db.query('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [req.user.id, endpoint]);
  else await db.query('DELETE FROM push_subscriptions WHERE user_id=$1', [req.user.id]);
  res.json({ ok: true });
}));
router.post('/push/test', asyncH(async (req, res) => {
  await require('../push').sendPush([req.user.id], { title: 'Test notification', body: 'Phone notifications are working.', link: '/profile' });
  res.json({ ok: true });
}));

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

// ---- Profile picture ----
// The page crops the chosen image to a square and sends it as a small JPEG; the server only keeps a real JPEG of a sane size, as uploads/avatars/<id>.jpg.
// Any signed-in user may look at any picture (they already see each other's names); nothing else about the account is exposed here.
const AVATAR_DIR = path.join(__dirname, '..', '..', 'uploads', 'avatars');
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 400 * 1024, files: 1 } });
const avatarFile = (id) => path.join(AVATAR_DIR, `${Number(id)}.jpg`);

router.post('/avatar', (req, res, next) => avatarUpload.single('avatar')(req, res, (err) => {
  if (err) return next(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'That picture is too large (400 KB at most after it is cropped).' : 'Could not read that picture.'));
  return next();
}), asyncH(async (req, res) => {
  const f = req.file;
  if (!f || f.buffer.length < 200 || !(f.buffer[0] === 0xff && f.buffer[1] === 0xd8 && f.buffer[2] === 0xff)) throw new HttpError(400, 'Choose a JPEG, PNG or WebP picture.');
  await fs.promises.mkdir(AVATAR_DIR, { recursive: true });
  await fs.promises.writeFile(avatarFile(req.user.id), f.buffer);
  const v = Date.now();
  await db.query('UPDATE users SET avatar_v=$2, updated_at=now() WHERE id=$1', [req.user.id, v]);
  res.json({ ok: true, avatar_v: v });
}));

router.delete('/avatar', asyncH(async (req, res) => {
  await fs.promises.unlink(avatarFile(req.user.id)).catch(() => {});
  await db.query('UPDATE users SET avatar_v=NULL, updated_at=now() WHERE id=$1', [req.user.id]);
  res.json({ ok: true });
}));

router.get('/avatar/:id', asyncH(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.sendStatus(404);
  const { rows } = await db.query('SELECT avatar_v FROM users WHERE id=$1 AND is_active', [id]);
  if (!rows.length || !rows[0].avatar_v) return res.sendStatus(404);
  res.set({ 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  return res.type('jpeg').sendFile(avatarFile(id), (e) => { if (e && !res.headersSent) res.sendStatus(404); });
}));

// Personal colour theme. Empty/null = no personal choice: the user follows the Admin default theme (which can change at any time).
router.put('/theme', asyncH(async (req, res) => {
  const raw = req.body.theme;
  const theme = raw === null || raw === undefined || raw === '' ? null : v.oneOf(raw, THEME_KEYS, { field: 'Theme' });
  await db.query('UPDATE users SET theme=$2, updated_at=now() WHERE id=$1', [req.user.id, theme]);
  res.json({ ok: true, theme });
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

  const { limit, offset } = v.paging(req.query, { def: 25, max: 200 });

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
