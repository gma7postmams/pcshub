// TOTP (RFC 6238) with encrypted-at-rest secrets and replay protection.
const crypto = require('crypto');
const { authenticator } = require('otplib');

authenticator.options = { step: 30, window: 1, digits: 6 };

const PROD = process.env.NODE_ENV === 'production';
const PREFIX = 'v1:';

function loadKey() {
  const hex = process.env.TOTP_ENC_KEY || '';
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  if (PROD) {
    console.error('TOTP_ENC_KEY must be set to 64 hex chars (32 bytes) in production: openssl rand -hex 32');
    process.exit(1);
  }
  console.warn('[warn] TOTP_ENC_KEY not set — deriving a dev-only key from SESSION_SECRET. Set it before going live.');
  return crypto.createHash('sha256').update(`totp:${process.env.SESSION_SECRET || 'dev'}`).digest();
}
const KEY = loadKey();
// Rotation: set TOTP_ENC_KEY to the new key and TOTP_ENC_KEY_OLD to the previous one, restart once
// (secrets are re-encrypted on boot), then remove TOTP_ENC_KEY_OLD.
//
// Installs that never set TOTP_ENC_KEY had their key derived from SESSION_SECRET. So that changing SESSION_SECRET, or
// setting TOTP_ENC_KEY for the first time, does not leave everyone's 2FA unreadable, secrets written under such a
// derived key can still be opened (and are re-encrypted under the current key on the next start):
//   - the key derived from the current SESSION_SECRET,
//   - the key derived from SESSION_SECRET_OLD (set it for one start when you change SESSION_SECRET),
//   - the keys older versions derived when SESSION_SECRET was missing or still the .env.example placeholder.
const derived = (secret) => crypto.createHash('sha256').update(`totp:${secret}`).digest();
const OLD_KEYS = [
  /^[0-9a-fA-F]{64}$/.test(process.env.TOTP_ENC_KEY_OLD || '') ? Buffer.from(process.env.TOTP_ENC_KEY_OLD, 'hex') : null,
  process.env.SESSION_SECRET ? derived(process.env.SESSION_SECRET) : null,
  process.env.SESSION_SECRET_OLD ? derived(process.env.SESSION_SECRET_OLD) : null,
  derived('dev'),
  derived('change-me-to-a-random-32-character-secret'),
].filter((k) => k && !k.equals(KEY));

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

function decrypt(stored) {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext (encrypted by migrateSecrets on boot)
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((x) => Buffer.from(x, 'base64'));
  const open = (key) => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });   // a shortened tag is refused, not accepted
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  };
  try { return open(KEY); } catch (e) {
    for (const k of OLD_KEYS) { try { return open(k); } catch (_) { /* try the next one */ } }
    throw e;
  }
}

function decryptsWithCurrentKey(stored) {
  if (!stored || !stored.startsWith(PREFIX)) return false;
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':').map((x) => Buffer.from(x, 'base64'));
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv, { authTagLength: 16 });
    d.setAuthTag(tag); d.update(ct); d.final();
    return true;
  } catch (_) { return false; }
}

function generateSecret() {
  return authenticator.generateSecret(20); // 160-bit, base32
}

function keyUri(account, issuer, secret) {
  return authenticator.keyuri(account, issuer, secret);
}

/** Returns the time-step the token matched, or null. */
function matchStep(token, secret) {
  const t = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(t) || !secret) return null;
  const delta = authenticator.checkDelta(t, secret);
  if (delta === null || delta === undefined) return null;
  return Math.floor(Date.now() / 1000 / 30) + delta;
}

/**
 * Verify a code for a stored (encrypted) secret and consume it atomically so it cannot be reused.
 * Returns true only if the code is valid AND newer than the last code this user used.
 */
async function verifyAndConsume(runner, userId, storedSecret, token) {
  let secret;
  try { secret = decrypt(storedSecret); } catch (_) { return false; }
  const step = matchStep(token, secret);
  if (step === null) return false;
  const r = await runner.query(
    `UPDATE users SET totp_last_step=$2 WHERE id=$1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING id`,
    [userId, step]
  );
  return r.rowCount === 1;
}

/** Encrypt plaintext secrets from earlier versions, and re-encrypt secrets still under TOTP_ENC_KEY_OLD. */
async function migrateSecrets(db) {
  const { rows } = await db.query(`SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL`);
  let plain = 0; let rekeyed = 0; let unreadable = 0;
  for (const r of rows) {
    if (!r.totp_secret.startsWith(PREFIX)) {
      await db.query('UPDATE users SET totp_secret=$2 WHERE id=$1', [r.id, encrypt(r.totp_secret)]); plain++;
    } else if (!decryptsWithCurrentKey(r.totp_secret)) {
      try { await db.query('UPDATE users SET totp_secret=$2 WHERE id=$1', [r.id, encrypt(decrypt(r.totp_secret))]); rekeyed++; } catch (_) { unreadable++; }
    }
  }
  if (plain) console.log(`[migrate] encrypted ${plain} plaintext TOTP secret(s).`);
  if (rekeyed) console.log(`[migrate] re-encrypted ${rekeyed} TOTP secret(s) with the new TOTP_ENC_KEY.`);
  if (unreadable) console.warn(`[security] ${unreadable} TOTP secret(s) cannot be decrypted with TOTP_ENC_KEY — set TOTP_ENC_KEY_OLD (or SESSION_SECRET_OLD if no TOTP_ENC_KEY was ever set) to the previous value for one start, or have an Admin "Reset 2FA" for those users.`);
}

module.exports = { encrypt, decrypt, generateSecret, keyUri, matchStep, verifyAndConsume, migrateSecrets };
