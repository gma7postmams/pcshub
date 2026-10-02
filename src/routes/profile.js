const express = require('express');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const validator = require('validator');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError } = require('../middleware');
const { audit } = require('../audit');
const totp = require('../totp');
const { MODES } = require('../themes');
const { twofaRequired } = require('../config');

const router = express.Router();

router.put('/', asyncH(async (req, res) => {
  const full_name = v.str(req.body.full_name, { field: 'Full name', max: 120, required: true });
  const email = v.str(req.body.email, { field: 'Email', max: 200 });
  if (email && !validator.isEmail(email)) throw new HttpError(400, 'Invalid email');
  const { rows } = await db.query('SELECT full_name, email FROM users WHERE id=$1', [req.user.id]);
  const current = rows[0];
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
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!(await bcrypt.compare(current, rows[0].password_hash))) throw new HttpError(400, 'Current password is incorrect');
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
router.post('/2fa/setup', asyncH(async (req, res) => {
  if (req.user.totp_enabled) throw new HttpError(400, '2FA is already enabled');
  const { rows } = await db.query(`SELECT value FROM app_settings WHERE key='app_name'`);
  const issuer = (rows[0] && rows[0].value) || 'Promotional Content Hub';
  const secret = totp.generateSecret();
  req.session.totpSetup = totp.encrypt(secret); // sessions are stored in Postgres — keep it encrypted there too
  const qr = await QRCode.toDataURL(totp.keyUri(req.user.username, issuer, secret), { margin: 1, width: 220 });
  res.json({ secret, qr });
}));

router.post('/2fa/enable', asyncH(async (req, res) => {
  const pending = req.session.totpSetup;
  if (!pending) throw new HttpError(400, 'Start 2FA setup first');
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

router.post('/2fa/disable', asyncH(async (req, res) => {
  if (twofaRequired(req.user)) throw new HttpError(403, '2FA is required for your account and cannot be disabled');
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const { rows } = await db.query('SELECT password_hash, totp_secret, totp_enabled FROM users WHERE id=$1', [req.user.id]);
  const u = rows[0];
  if (!u.totp_enabled) throw new HttpError(400, '2FA is not enabled');
  if (!(await bcrypt.compare(password, u.password_hash))) throw new HttpError(400, 'Password is incorrect');
  if (!(await totp.verifyAndConsume(db, req.user.id, u.totp_secret, req.body.token))) throw new HttpError(400, 'Invalid or already-used authentication code');
  await db.query('UPDATE users SET totp_secret=NULL, totp_enabled=FALSE, totp_last_step=NULL, updated_at=now() WHERE id=$1', [req.user.id]);
  await audit(req, 'profile.2fa_disable', 'user', req.user.id);
  res.json({ ok: true });
}));

router.get('/activity-history', asyncH(async (req, res) => {
  const params = [req.user.id];
  const where = ['user_id = $1'];

  if (req.query.action) {
    const search = `%${String(req.query.action).trim()}%`;

    params.push(search);

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
    params.push(req.query.from);
    where.push(`created_at >= $${params.length}::date`);
  }

  if (req.query.to) {
    params.push(req.query.to);
    where.push(`created_at < ($${params.length}::date + 1)`);
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

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
