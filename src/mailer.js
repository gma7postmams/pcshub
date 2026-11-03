// Outgoing email (used for 2FA codes). SMTP login stays in the server's .env, never in the database or the Admin screens:
//   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for port 465), SMTP_USER, SMTP_PASS, SMTP_FROM ("Name <address>")

let transport = null;
const configured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);

function get() {
  if (!transport) {
    const port = parseInt(process.env.SMTP_PORT, 10) || 587;
    const nodemailer = require('nodemailer');   // loaded on first use, so the app still starts if `npm install` was missed
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
  }
  return transport;
}

async function send({ to, subject, text, html, attachments }) {
  if (!configured()) throw new Error('Email is not set up on the server');
  await get().sendMail({ from: process.env.SMTP_FROM, to, subject, text, html, attachments });
}

/** The display name in SMTP_FROM ("PULSE Notifications <no-reply@example.com>" -> "PULSE Notifications"), or '' when there is none. */
const senderName = () => {
  const m = String(process.env.SMTP_FROM || '').match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return m ? m[1].trim() : '';
};

/** The short product name used in emails and in authenticator apps: MAIL_APP_NAME, else the sender name without a trailing "Notifications" ("PULSE"), else ''. */
const shortName = () => String(process.env.MAIL_APP_NAME || '').trim() || senderName().replace(/\s+notifications?$/i, '').trim();

/** j***@example.com — shown on the sign-in screen so the right mailbox is recognised without exposing it. */
const mask = (email) => {
  const [a, d] = String(email || '').split('@');
  return d ? `${a.slice(0, 1)}***@${d}` : '';
};

module.exports = { configured, send, mask, senderName, shortName };
