// Security watch: writes blocked attacks to the audit log, notices a burst of them and tells the Admins.
//
//  event()      a request was blocked (permission refused, not signed in, cross-site, rate limited). Written to the audit log once a minute
//               per source + kind + route (a stale tab polling must not flood it) and counted towards the burst alarm.
//  failure()    a wrong password / 2FA code. Counted towards the alarm (the audit line is written by the caller).
//  guard        wrong passwords are counted per account AND per IP (see login-guard.js): an IP that guesses wrong too often is shut out of
//               that account only, so a stranger cannot lock a known user out of their own account.
//  alert        BURST_N signs from one IP inside BURST_MS (or one IP shut out of an account, or one login rate-limit hit) -> an audit line, a
//               bell/phone notification and an email to every active System Admin (email only if SMTP is set up; Admins are not told).
//               At most one alert per source per ALERT_GAP_MS.
const db = require('./db');
const { audit } = require('./audit');

const THROTTLE_MS = 60 * 1000;
const BURST_N = 10;
const BURST_MS = 5 * 60 * 1000;
const ALERT_GAP_MS = 15 * 60 * 1000;

const SYSTEM = { user: { id: null, username: 'security-watch' }, ip: null };

const logged = new Map();    // throttle key -> last audit time
const sources = new Map();   // ip -> { hits: [timestamps], routes: Map(key -> time), alertedAt }
const alerted = new Map();   // alert key -> time

function prune(now) {
  if (logged.size + sources.size + alerted.size < 2000) return;
  for (const [k, t] of logged) if (now - t > THROTTLE_MS) logged.delete(k);
  for (const [k, s] of sources) { s.hits = s.hits.filter((t) => now - t < BURST_MS); if (!s.hits.length && now - (s.alertedAt || 0) > ALERT_GAP_MS) sources.delete(k); }
  for (const [k, t] of alerted) if (now - t > ALERT_GAP_MS) alerted.delete(k);
}

/** Tell every active System Admin (not plain Admins): bell + phone, and an email when the server can send mail. Never throws. */
async function tellAdmins(title, body) {
  try {
    const { rows } = await db.query(`SELECT id, email FROM users WHERE is_active AND role = 'System Admin'`);
    await require('./notify').notifyUsers(rows.map((r) => r.id), { title, body, link: '/admin', kind: 'security_alert' });
    const mailer = require('./mailer');
    if (mailer.configured()) {
      // every System Admin's own address, plus the security alert address(es) from Administration → Security (default: ADMIN_EMAIL)
      const to = [...new Set([...rows.map((r) => (r.email || '').trim().toLowerCase()), ...require('./security-settings').alertEmails()].filter(Boolean))];
      if (to.length) await mailer.send({ to: to.join(','), subject: `[Security alert] ${title}`, text: `${body}\n\nSee Administration → Audit Log for the details.` });
    }
    else console.warn('[security-watch] alert not emailed: SMTP is not set up');
  } catch (e) { console.error('[security-watch] could not notify the System Admins:', e.message); }
}

function raise(key, ip, title, body, details) {
  const now = Date.now();
  if (now - (alerted.get(key) || 0) < ALERT_GAP_MS) return;
  alerted.set(key, now);
  console.warn(`[security] ALERT ${title} (${ip || 'unknown ip'})`);
  audit({ ...SYSTEM, ip }, 'security.alert', 'security', null, { title, ...details }).catch(() => {});
  let where = '';
  try { where = ip ? require('./geoip').place(require('./geoip').lookup(ip)) : ''; } catch (_) { /* no location is fine */ }
  tellAdmins(title, where ? `${body} Location: ${where}.` : body);   // not in the audit line: only the System Admins who get the alert see it
}

function count(req, weight, routeKey) {
  const now = Date.now();
  const ip = req.ip || 'unknown';
  if (require('./ip-rules').isAllowed(ip)) return;   // a trusted address (IP Access > Allowed) never counts towards an alert
  let s = sources.get(ip);
  if (!s) { s = { hits: [], routes: new Map() }; sources.set(ip, s); }
  s.hits = s.hits.filter((t) => now - t < BURST_MS);
  if (routeKey) {   // the same route again is one sign, not many (a stale tab polling a page it may no longer open)
    if (now - (s.routes.get(routeKey) || 0) < BURST_MS) return;
    s.routes.set(routeKey, now);
    for (const [k, t] of s.routes) if (now - t >= BURST_MS) s.routes.delete(k);
  }
  for (let i = 0; i < weight; i++) s.hits.push(now);
  if (s.hits.length >= BURST_N) {
    raise(`burst|${ip}`, ip, 'Repeated blocked requests', `${s.hits.length} blocked or failed requests from ${ip} in the last ${BURST_MS / 60000} minutes.`, { count: s.hits.length, windowMinutes: BURST_MS / 60000 });
  }
}

/** A request was blocked. action: security.denied | security.unauthenticated | security.csrf_blocked | security.rate_limited */
function event(req, action, details = {}) {
  try {
    const now = Date.now();
    prune(now);
    const route = details.route || `${req.method} ${(req.originalUrl || '').split('?')[0]}`;
    const key = `${req.ip}|${req.user ? req.user.id : '-'}|${action}|${route}`;
    if (now - (logged.get(key) || 0) >= THROTTLE_MS) {
      logged.set(key, now);
      console.warn(`[security] ${action} ${route} from ${req.ip}${req.user ? ` (${req.user.username})` : ''}`);
      audit(req, action, 'security', null, { ...details, route, method: req.method }).catch(() => {});
    }
    // a login rate-limit hit is a brute-force run by itself
    count(req, action === 'security.rate_limited' && details.limiter === 'login' ? BURST_N : 1, action === 'security.rate_limited' ? null : `${action}|${route}`);
  } catch (e) { console.error('[security-watch]', e.message); }
}

/** A wrong password or 2FA code (the caller has written its own audit line). */
function failure(req) {
  try { count(req, 1, null); } catch (e) { console.error('[security-watch]', e.message); }
}

/** This IP was just shut out of one account after too many wrong passwords (the account itself stays open to everyone else). */
function ipLocked(req, username, minutes) {
  const ip = req.ip || 'unknown';
  raise(`lock|${username}|${ip}`, ip, `Sign-in blocked: ${username} from ${ip}`, `${ip} was shut out of "${username}" for ${minutes} min after too many wrong passwords. The account is still open to the real person from their own address.`, { username, minutes });
}

/** Many different addresses are guessing at one account: nobody is locked out (that would hand the attacker a way to lock the real user out), but the System Admins are told. */
function distributed(username, ips, failures) {
  raise(`dist|${username}`, null, `Password guessing on ${username} from ${ips} addresses`, `${failures} wrong passwords on "${username}" from ${ips} different addresses in a short time. The account is not locked (so the real person can still sign in); consider turning on 2FA for it or resetting its password.`, { username, addresses: ips, failures });
}

/** For tests */
function reset() { logged.clear(); sources.clear(); alerted.clear(); }

module.exports = { event, failure, ipLocked, distributed, reset, BURST_N };
