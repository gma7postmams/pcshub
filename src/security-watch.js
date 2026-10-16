// Security watch: writes blocked attacks to the audit log, notices a burst of them and tells the Admins.
//
//  event()      a request was blocked (permission refused, not signed in, cross-site, rate limited). Written to the audit log once a minute
//               per source + kind + route (a stale tab polling must not flood it) and counted towards the burst alarm.
//  failure()    a wrong password / 2FA code. Counted towards the alarm (the audit line is written by the caller).
//  lockBudget   one IP may lock only a few accounts per window, so a stranger cannot lock everybody out by guessing wrong passwords.
//  alert        BURST_N signs from one IP inside BURST_MS (or one lock-out, or one login rate-limit hit) -> an audit line, a bell/phone
//               notification and an email to every active Admin (email only if SMTP is set up). At most one alert per source per ALERT_GAP_MS.
const db = require('./db');
const { audit } = require('./audit');

const THROTTLE_MS = 60 * 1000;
const BURST_N = 10;
const BURST_MS = 5 * 60 * 1000;
const ALERT_GAP_MS = 15 * 60 * 1000;
const LOCK_BUDGET = 2;
const LOCK_BUDGET_MS = 15 * 60 * 1000;

const SYSTEM = { user: { id: null, username: 'security-watch' }, ip: null };

const logged = new Map();    // throttle key -> last audit time
const sources = new Map();   // ip -> { hits: [timestamps], routes: Map(key -> time), alertedAt }
const locks = new Map();     // ip -> [timestamps of lock-outs this IP caused]
const alerted = new Map();   // alert key -> time

function prune(now) {
  if (logged.size + sources.size + locks.size + alerted.size < 2000) return;
  for (const [k, t] of logged) if (now - t > THROTTLE_MS) logged.delete(k);
  for (const [k, s] of sources) { s.hits = s.hits.filter((t) => now - t < BURST_MS); if (!s.hits.length && now - (s.alertedAt || 0) > ALERT_GAP_MS) sources.delete(k); }
  for (const [k, a] of locks) { const keep = a.filter((t) => now - t < LOCK_BUDGET_MS); if (keep.length) locks.set(k, keep); else locks.delete(k); }
  for (const [k, t] of alerted) if (now - t > ALERT_GAP_MS) alerted.delete(k);
}

/** Tell every active Admin: bell + phone, and an email when the server can send mail. Never throws. */
async function tellAdmins(title, body) {
  try {
    const { rows } = await db.query(`SELECT id, email FROM users WHERE is_active AND role IN ('Admin','System Admin')`);
    await require('./notify').notifyUsers(rows.map((r) => r.id), { title, body, link: '/admin', kind: 'security_alert' });
    const mailer = require('./mailer');
    if (mailer.configured()) {
      // every Admin's own address, plus the security alert address(es) from Administration → Security (default: ADMIN_EMAIL)
      const to = [...new Set([...rows.map((r) => (r.email || '').trim().toLowerCase()), ...require('./security-settings').alertEmails()].filter(Boolean))];
      if (to.length) await mailer.send({ to: to.join(','), subject: `[Security alert] ${title}`, text: `${body}\n\nSee Administration → Audit Log for the details.` });
    }
    else console.warn('[security-watch] alert not emailed: SMTP is not set up');
  } catch (e) { console.error('[security-watch] could not notify the admins:', e.message); }
}

function raise(key, ip, title, body, details) {
  const now = Date.now();
  if (now - (alerted.get(key) || 0) < ALERT_GAP_MS) return;
  alerted.set(key, now);
  console.warn(`[security] ALERT ${title} (${ip || 'unknown ip'})`);
  audit({ ...SYSTEM, ip }, 'security.alert', 'security', null, { title, ...details }).catch(() => {});
  tellAdmins(title, body);
}

function count(req, weight, routeKey) {
  const now = Date.now();
  const ip = req.ip || 'unknown';
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

/** May this IP still cause an account to be locked? */
function lockBudgetLeft(req) {
  const now = Date.now();
  const a = (locks.get(req.ip || 'unknown') || []).filter((t) => now - t < LOCK_BUDGET_MS);
  return a.length < LOCK_BUDGET;
}

/** An account was just locked by wrong passwords from this IP. */
function locked(req, username) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  locks.set(ip, [...(locks.get(ip) || []).filter((t) => now - t < LOCK_BUDGET_MS), now]);
  raise(`lock|${username}`, ip, `Account locked: ${username}`, `"${username}" was locked after too many wrong passwords, last attempt from ${ip}. Unlock it in Administration → Users if it was the real person.`, { username });
}

/** For tests */
function reset() { logged.clear(); sources.clear(); locks.clear(); alerted.clear(); }

module.exports = { event, failure, lockBudgetLeft, locked, reset, BURST_N, LOCK_BUDGET };
