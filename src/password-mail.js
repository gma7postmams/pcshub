// Emails about passwords: the temporary password an Admin sends from Administration > Access > Users.
const mailer = require('./mailer');

const esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function appName() {
  let n = mailer.shortName();
  if (!n) {
    try { const r = await require('./db').query(`SELECT value FROM app_settings WHERE key='app_name'`); n = r.rows[0] && r.rows[0].value; } catch (e) { /* fall through */ }
  }
  return n || 'PULSE';
}

/** Email the new temporary password to `user` ({ full_name, username, email }), laid out exactly like the sign-in code email. Throws if it cannot be sent. */
async function sendTemporaryPassword(user, temp) {
  const { brand, PREHEADER } = require('./email-code');
  const app = await appName();
  const b = await brand();
  const heading = String(process.env.MAIL_HEADING || '').trim() || b.name || app;
  const f = 'font-family:Arial,Helvetica,sans-serif';
  const text = `Your ${app} temporary password is ${temp}\n\nUsername: ${user.username}\n\nSign in with it and you will be asked to choose a new password. If you did not expect this, tell an Admin.`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f3f4f6">
${PREHEADER}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#ffffff;border-radius:8px">
<tr><td align="center" style="padding:28px 24px 8px">
<div style="${f};font-size:20px;line-height:1.3;font-weight:700;color:#000000">${esc(heading)}</div>
</td></tr>
<tr><td style="padding:18px 36px 8px;${f};font-size:17px;color:#374151">Your ${esc(app)} temporary password is:</td></tr>
<tr><td align="center" style="padding:6px 36px 14px"><div style="${f};font-size:26px;font-weight:700;letter-spacing:2px;color:#111827">${esc(temp)}</div></td></tr>
<tr><td style="padding:0 36px 28px;${f};font-size:15px;line-height:1.5;color:#374151">Username: <strong>${esc(user.username)}</strong><br>Sign in with it and you will be asked to choose a new password.<br>If you did not expect this, tell an Admin.</td></tr>
</table></td></tr></table></body></html>`;
  await mailer.send({ to: user.email, subject: `Your ${app} temporary password`, text, html });
}

module.exports = { sendTemporaryPassword };
