// Web Push: sends a notification to the phones / browsers a user has switched "Phone notifications" on for.
// The VAPID key pair is made once and kept in app_settings (no .env step); it never leaves the server except the public half.
const webpush = require('web-push');
const db = require('./db');

let keys = null;
async function getKeys() {
  if (keys) return keys;
  const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key IN ('vapid_public','vapid_private')`);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (!m.vapid_public || !m.vapid_private) {
    const k = webpush.generateVAPIDKeys();
    // two servers starting together: the first insert wins, both then read the stored pair
    await db.query(`INSERT INTO app_settings (key, value) VALUES ('vapid_public', $1), ('vapid_private', $2) ON CONFLICT (key) DO NOTHING`, [k.publicKey, k.privateKey]);
    const again = await db.query(`SELECT key, value FROM app_settings WHERE key IN ('vapid_public','vapid_private')`);
    Object.assign(m, Object.fromEntries(again.rows.map((r) => [r.key, r.value])));
  }
  keys = { publicKey: m.vapid_public, privateKey: m.vapid_private };
  return keys;
}

const subject = () => process.env.PUSH_SUBJECT || 'mailto:admin@localhost.invalid';

async function publicKey() { return (await getKeys()).publicKey; }

/** Send `payload` ({title, body, link}) to every device of `userIds`. Never throws; dead subscriptions (410/404) are deleted. */
async function sendPush(userIds, payload) {
  try {
    const ids = [...new Set((userIds || []).filter((x) => Number.isInteger(x)))];
    if (!ids.length) return;
    const { rows } = await db.query('SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::int[])', [ids]);
    if (!rows.length) return;
    const k = await getKeys();
    const body = JSON.stringify({ title: String(payload.title || '').slice(0, 120), body: String(payload.body || '').slice(0, 240), link: payload.link || '/' });
    await Promise.all(rows.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body,
          { vapidDetails: { subject: subject(), publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 24 * 3600, urgency: 'normal' });
      } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) await db.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]).catch(() => {});
        else console.warn('push failed:', e && (e.statusCode || e.message));
      }
    }));
  } catch (e) { console.warn('push error:', e.message); }
}

module.exports = { publicKey, sendPush };
