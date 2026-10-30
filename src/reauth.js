// Step-up authentication ("confirm it's you") for destructive actions: restoring, downloading and deleting backups, removing old records and clearing data.
//
// The caller re-enters their password (they already signed in with 2FA, so no code is asked unless a route opts in). Wrong answers are counted per
// user, so a stolen session cannot be used to guess the password.
const bcrypt = require('bcrypt');
const db = require('./db');
const totp = require('./totp');
const emailCode = require('./email-code');
const { HttpError } = require('./middleware');
const { audit } = require('./audit');

const num = (v, def) => (Number.isFinite(parseInt(v, 10)) && parseInt(v, 10) >= 0 ? parseInt(v, 10) : def);
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = Math.max(num(process.env.REAUTH_MAX_FAILURES, 5), 1);
// After a successful confirmation, further user-management actions from the same session pass for this long
// (authenticator codes are single-use, so two resets in a row would otherwise have to wait for the next code).
// 0 = ask every time.
const GRACE_MS = num(process.env.REAUTH_GRACE_MINUTES, 5) * 60 * 1000;

const failures = new Map();   // user id -> [timestamps of attempts that were not (yet) proven right]

function recent(userId) {
  const cut = Date.now() - WINDOW_MS;
  const list = (failures.get(userId) || []).filter((t) => t > cut);
  if (list.length) failures.set(userId, list); else failures.delete(userId);
  return list;
}
setInterval(() => { for (const id of failures.keys()) recent(id); }, WINDOW_MS).unref();

/**
 * Call BEFORE checking a password or code. Refuses (429) once the user has used up their wrong answers for the last
 * 15 minutes, otherwise counts this attempt straight away. Counting first and un-counting on success (succeed()) means
 * a burst of simultaneous guesses cannot all slip through before the first one has been judged wrong.
 */
function attempt(userId) {
  const list = recent(userId);
  if (list.length >= MAX_FAILURES) throw new HttpError(429, 'Too many incorrect attempts. Try again in 15 minutes.');
  failures.set(userId, [...list, Date.now()]);
}
/** The answer was right: forget the counted attempts. */
function succeed(userId) { failures.delete(userId); }

const credsOf = (c) => (c && typeof c === 'object' && !Array.isArray(c) ? c : {});

/**
 * Check creds.password (+ creds.code when the caller has 2FA). `creds` is always passed explicitly by the route, so a
 * field of the same name that means something else in the request (e.g. a new user's temporary password) is never
 * mistaken for the confirmation. Throws 403 { reauth: true } when it is missing or wrong.
 * `log` = { action, entity, id, details? } writes an audit line for a wrong answer.
 */
async function verify(req, log, creds, { passwordOnly = true } = {}) {   // by default the password alone is enough: the Admin already signed in with 2FA. Pass { passwordOnly: false } to also ask for the code
  const c = credsOf(creds);
  const password = typeof c.password === 'string' && c.password.length <= 200 ? c.password : '';
  const { rows } = await db.query('SELECT password_hash, totp_enabled, totp_secret, twofa_method FROM users WHERE id=$1', [req.user.id]);
  const u = rows[0];
  const twofa = !passwordOnly && Boolean(u && u.totp_enabled);
  if (!password) throw new HttpError(403, 'Confirm your password to continue', { reauth: true, twofa, method: u && u.twofa_method });   // nothing was guessed: just ask
  attempt(req.user.id);
  let ok = Boolean(u) && await bcrypt.compare(password, u.password_hash);
  if (ok && twofa) ok = u.twofa_method === 'email' ? emailCode.check(req.session, req.user.id, 'reauth', c.code) : await totp.verifyAndConsume(db, req.user.id, u.totp_secret, c.code);
  if (!ok) {
    require('./security-watch').failure(req);
    if (log) await audit(req, log.action, log.entity, log.id, log.details || { outcome: 'denied', reason: 'reauth_failed' });
    throw new HttpError(403, twofa ? 'Password or authentication code is incorrect' : 'Password is incorrect', { reauth: true, twofa });
  }
  succeed(req.user.id);
  req.session.reauthAt = Date.now();
}

/** Like verify(), but a confirmation given by this session in the last few minutes still counts. */
async function recentOrVerify(req, log, creds) {
  const at = req.session && req.session.reauthAt;
  const supplied = typeof credsOf(creds).password === 'string' && credsOf(creds).password;
  if (!supplied && GRACE_MS > 0 && at && Date.now() - at < GRACE_MS) return;
  await verify(req, log, creds);
}

/**
 * "Confirm it's you" for a route that has no password field of its own. The page sends { ..., reauth: { password, code } } (the shared api client does this
 * after it shows its prompt); a confirmation given in the last few minutes still counts. Throws 403 { reauth: true, auto: true, what } when it is missing or wrong.
 *   key = the audit name of the action, what = the words for the prompt ("delete these users").
 */
async function confirm(req, key, what) {
  try { await recentOrVerify(req, { action: 'auth.reauth_failed', entity: 'user', id: req.user.id, details: { for: key, outcome: 'denied', reason: 'reauth_failed' } }, req.body && req.body.reauth); } catch (e) {
    if (e instanceof HttpError && e.extra && e.extra.reauth) e.extra = { ...e.extra, auto: true, what };
    throw e;
  }
}

module.exports = { verify, recentOrVerify, confirm, attempt, succeed };
