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

const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The Branding app name, kept for a minute so each code email doesn't hit the database.
let brandCache = { at: 0, name: '' };
async function brand() {
  if (Date.now() - brandCache.at < 60000) return brandCache;
  let name = '';
  try {
    const r = await require('./db').query(`SELECT value FROM app_settings WHERE key='app_name'`);
    name = (r.rows[0] && r.rows[0].value) || '';
  } catch (e) { /* fall back to the app name */ }
  brandCache = { at: Date.now(), name };
  return brandCache;
}

// Keeps the inbox list's preview line empty: mail programs show the first text of the body there, so a hidden run of blank characters comes first.
const PREHEADER = `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${'&#8204;&nbsp;'.repeat(150)}</div>`;

/** The email in the same style as the other notification emails: the full name as a black heading (no logo), then the message. */
function codeEmailHtml({ appName, heading, what, code }) {
  const f = 'font-family:Arial,Helvetica,sans-serif';
  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f3f4f6">
${PREHEADER}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:8px">
<tr><td align="center" style="padding:28px 24px 8px">
<div style="${f};font-size:20px;line-height:1.3;font-weight:700;color:#000000">${esc(heading)}</div>
</td></tr>
<tr><td style="padding:18px 36px 8px;${f};font-size:17px;color:#374151">Your ${esc(appName)} ${esc(what)} code is:</td></tr>
<tr><td align="center" style="padding:6px 36px 14px"><div style="${f};font-size:34px;font-weight:700;letter-spacing:8px;color:#111827">${esc(code)}</div></td></tr>
<tr><td style="padding:0 36px 28px;${f};font-size:15px;line-height:1.5;color:#374151">It works once and expires in 10 minutes.<br>If you did not just try to sign in or confirm something, ignore this email and tell an Admin.</td></tr>
</table></td></tr></table></body></html>`;
}

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
  const b = await brand();
  const heading = String(process.env.MAIL_HEADING || '').trim() || b.name || appName;   // the big black line: MAIL_HEADING in .env, else the app name from Administration → Branding
  const what = SUBJECT[purpose] || 'verification';
  try {
    await mailer.send({
      to: user.email,
      subject: `${code} is your ${appName} code`,
      text: `Your ${appName} ${what} code is ${code}\n\nIt works once and expires in 10 minutes. If you did not just try to sign in or confirm something, ignore this email and tell an Admin.`,
      html: codeEmailHtml({ appName, heading, what, code }),
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
