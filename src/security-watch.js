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
const net = require('net');
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
    if (require('./security-check').isProbe(req)) return;   // the self-check attacking its own front door
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

// ---- scanner probes (see probe-guard.js) ----
const PROBE_N = 3;                 // this many DIFFERENT probe paths from one address ...
const PROBE_MS = 10 * 60 * 1000;   // ... within this long ...
const PROBE_BLOCK_HOURS = 24;      // ... and the address is blocked for this long
const probes = new Map();          // ip -> Map(path -> time)

const isPrivateIp = (ip) => {
  const a = require('./ip-rules').unmap(ip);
  if (net.isIPv4(a)) { const [x, y] = a.split('.').map(Number); return x === 10 || x === 127 || x === 0 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127); }
  return a === '::1' || /^f[cd]/i.test(a) || /^fe[89ab]/i.test(a) || a === '::';
};

/** A request for a path only scanners use was answered with 404. */
function probe(req) {
  try {
    if (require('./security-check').isProbe(req)) return;   // the self-check asks for /.env on purpose
    const now = Date.now();
    prune(now);
    const urlPath = (req.originalUrl || req.url || '').split('?')[0].slice(0, 200);
    const route = `${req.method} ${urlPath}`;
    const key = `${req.ip}|-|security.probe|${route}`;
    if (now - (logged.get(key) || 0) >= THROTTLE_MS) {
      logged.set(key, now);
      console.warn(`[security] probe ${route} from ${req.ip}`);
      audit(req, 'security.probe', 'security', null, { route: urlPath, method: req.method }).catch(() => {});
    }
    count(req, 2, `security.probe|${route}`);
    const ip = req.ip || 'unknown';
    let seen = probes.get(ip);
    if (!seen) { seen = new Map(); probes.set(ip, seen); }
    seen.set(urlPath, now);
    for (const [p, t] of seen) if (now - t > PROBE_MS) seen.delete(p);
    if (seen.size >= PROBE_N) autoBlock(req, [...seen.keys()]);
  } catch (e) { console.error('[security-watch]', e.message); }
}

async function autoBlock(req, paths) {
  const ip = req.ip;
  const rules = require('./ip-rules');
  const proxied = Boolean(process.env.TRUST_PROXY) && rules.unmap(ip) === rules.unmap((req.socket && req.socket.remoteAddress) || '');   // the proxy's own address: blocking it would shut everybody out
  const off = String(process.env.AUTO_BLOCK_PROBES || '').toLowerCase() === 'false';
  if (off || !ip || rules.isAllowed(ip) || rules.isBlocked(ip) || isPrivateIp(ip) || proxied || rules.disabled()) return;   // inside the network, or already dealt with: the alert below still tells the Admins
  probes.delete(ip);
  try {
    const ok = await rules.autoBlock(ip, `Automatic: asked for ${paths.length} scanner-only paths (${paths.slice(0, 3).join(', ')})`, PROBE_BLOCK_HOURS);
    if (!ok) return;
    console.warn(`[security] ALERT scanner ${ip} blocked for ${PROBE_BLOCK_HOURS} h (${paths.join(', ')})`);
    audit({ ...SYSTEM, ip }, 'security.ip_auto_blocked', 'security', null, { ip, hours: PROBE_BLOCK_HOURS, paths: paths.length, sample: paths.slice(0, 5) }).catch(() => {});
    raise(`probe-block|${ip}`, ip, `Scanner blocked: ${ip}`, `${ip} asked for ${paths.length} paths that only attack tools use (${paths.slice(0, 3).join(', ')}) and was blocked for ${PROBE_BLOCK_HOURS} hours. Remove it in Administration → IP Access if that was a mistake.`, { ip, hours: PROBE_BLOCK_HOURS, paths: paths.length });
  } catch (e) { console.error('[security-watch] could not block the scanner:', e.message); }
}

/** The virus scanner found something in an upload (the file has already been refused and deleted). */
function malware(req, file, signature) {
  try {
    const who = req.user ? req.user.username : 'someone not signed in';
    count(req, 3, null);
    raise(`malware|${req.ip}|${who}|${signature}`, req.ip, `Virus blocked in an upload (${signature})`, `${who} tried to upload "${file}" from ${req.ip || 'an unknown address'}: the virus scanner found ${signature} and the file was refused.`, { file, signature, username: req.user ? req.user.username : null });
  } catch (e) { console.error('[security-watch]', e.message); }
}

/** The virus scanner did not answer (uploads are refused, or let through unchecked when CLAMAV_FAIL=open). */
function scannerDown(reason) {
  const open = String(process.env.CLAMAV_FAIL || '').toLowerCase() === 'open';
  raise('scanner-down', null, 'Virus scanner is not answering', `${open ? 'Uploads are being accepted WITHOUT a virus check' : 'Uploads are being refused'} until it is back (${String(reason).slice(0, 120)}). Check that clamd is running on this server.`, { reason: String(reason).slice(0, 200), failOpen: open });
}

/** The scheduled self-check found something that was not wrong last time. */
function checkAlert(checks, result) {
  const fails = checks.filter((c) => c.status === 'fail').length;
  const title = `Security check: ${checks.length} new problem${checks.length === 1 ? '' : 's'}${fails ? ` (${fails} to fix now)` : ''}`;
  const lines = checks.slice(0, 6).map((c) => `${c.status === 'fail' ? 'FIX NOW' : 'Should fix'}: ${c.title} — ${c.detail}`);
  raise(`selfcheck|${checks.map((c) => c.id).sort().join(',')}`, null, title, `${lines.join(' ')}${checks.length > 6 ? ` …and ${checks.length - 6} more.` : ''} Open Administration → Security to see how to fix.`, { count: checks.length, ids: checks.map((c) => c.id), fail: result.fail, warn: result.warn });
}

/** For tests */
function reset() { logged.clear(); sources.clear(); alerted.clear(); probes.clear(); }

module.exports = { event, failure, ipLocked, distributed, malware, scannerDown, checkAlert, probe, reset, BURST_N };
