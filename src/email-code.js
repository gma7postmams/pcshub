// One-time codes sent by email as the second sign-in step (for accounts where an authenticator app is not practical,
// e.g. one account shared by a group). The code is kept only as a keyed hash in the user's server-side session:
// 6 digits, valid 10 minutes, 5 wrong tries, one new code per minute, used once.
const crypto = require('crypto');
const mailer = require('./mailer');
const { HttpError } = require('./middleware');

const TTL_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_TRIES = 5;
const MAX_SENDS = 5;
const KEY = process.env.SESSION_SECRET || 'dev';

const hash = (uid, purpose, code) => crypto.createHmac('sha256', KEY).update(`${uid}:${purpose}:${code}`).digest('hex');

const SUBJECT = { login: 'sign-in', reauth: 'confirmation', enroll: 'two-step setup' };

/** Create and email a new code. `session` is req.session. Throws HttpError when too soon, too many, or the mail fails. */
async function issue(session, user, purpose, appName) {
  // The name in the subject and text: MAIL_APP_NAME if set; else the sender name in SMTP_FROM without a trailing "Notifications"
  // ("PULSE Notifications <..>" -> "PULSE"); else the app name from Admin > Branding.
  if (!appName) {
    appName = String(process.env.MAIL_APP_NAME || '').trim() || mailer.senderName().replace(/\s+notifications?$/i, '').trim();
    if (!appName) {
      try { const r = await require('./db').query(`SELECT value FROM app_settings WHERE key='app_name'`); appName = r.rows[0] && r.rows[0].value; } catch (e) { /* fall through */ }
    }
    appName = appName || 'Promotional Content Hub';
  }
  if (!user.email) throw new HttpError(400, 'This account has no email address. Ask an Admin to add one.');
  const cur = session.emailCode;
  const same = cur && cur.uid === user.id && cur.purpose === purpose;
  if (same && Date.now() - cur.sentAt < COOLDOWN_MS) throw new HttpError(429, 'A code was just sent. Wait a minute before asking for another.');
  if (same && cur.sends >= MAX_SENDS) throw new HttpError(429, 'Too many codes requested. Sign in again to start over.');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  session.emailCode = { uid: user.id, purpose, h: hash(user.id, purpose, code), exp: Date.now() + TTL_MS, tries: 0, sentAt: Date.now(), sends: same ? cur.sends + 1 : 1 };
  try {
    await mailer.send({
      to: user.email,
      subject: `${code} is your ${appName} code`,
      text: `Your ${appName} ${SUBJECT[purpose] || 'verification'} code is ${code}\n\nIt works once and expires in 10 minutes. If you did not just try to sign in or confirm something, ignore this email and tell an Admin.`,
    });
  } catch (e) {
    delete session.emailCode;
    console.error('[email-code] send failed:', e.message);
    throw new HttpError(503, 'The code could not be emailed. Ask an Admin to check the email settings.');
  }
}

/** True once for the right code. Wrong answers are counted; the code is dead after 5. */
function check(session, userId, purpose, input) {
  const c = session.emailCode;
  if (!c || c.uid !== userId || c.purpose !== purpose || Date.now() > c.exp) return false;
  const code = String(input == null ? '' : input).replace(/\s/g, '');
  c.tries += 1;
  if (c.tries > MAX_TRIES) { delete session.emailCode; return false; }
  if (!/^\d{6}$/.test(code)) return false;
  const a = Buffer.from(hash(userId, purpose, code)); const b = Buffer.from(c.h);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) { delete session.emailCode; return true; }
  return false;
}

module.exports = { issue, check };
