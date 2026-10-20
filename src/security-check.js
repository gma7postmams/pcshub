// Security self-check: looks at this server's own settings, files, accounts and backups, and attacks its own front door, then reports
// what is fine and what to fix. Read-only: it changes nothing. Run from Administration → Security → "Run security check".
//
// Each result: { id, area, title, status: 'ok' | 'warn' | 'fail' | 'info', detail, fix? }
//   fail = fix it now · warn = should be fixed · info = good to know · ok = fine
// The live probes call this server over 127.0.0.1 with a per-process token, so the security watch does not count them as an attack.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const db = require('./db');
const cfg = require('./config');
const bcfg = require('./backup/config');
const settings = require('./security-settings');

const TOKEN = crypto.randomBytes(24).toString('hex');
const isProbe = (req) => Boolean(req && req.get && req.get('X-Selfcheck') === TOKEN);
const ROOT = path.join(__dirname, '..');

const add = (list) => (id, area, title, status, detail, fix) => list.push({ id, area, title, status, detail, ...(fix ? { fix } : {}) });

// ---- server settings and files ----
function configChecks(a) {
  const prod = cfg.PROD;
  a('prod', 'Server', 'Running in production mode', prod ? 'ok' : 'warn', prod ? 'NODE_ENV=production.' : 'Not in production mode: secure cookies, HSTS and some warnings are off.', 'Set NODE_ENV=production in .env (the service file) and restart.');
  a('secret', 'Server', 'Session secret is strong', cfg.weakSecret(process.env.SESSION_SECRET) ? 'fail' : 'ok', cfg.weakSecret(process.env.SESSION_SECRET) ? 'SESSION_SECRET is missing, short or a placeholder.' : 'Long and random.', 'Set SESSION_SECRET to the output of: openssl rand -hex 48 (everyone is signed out once).');
  a('https', 'Server', 'Cookies are HTTPS-only (Secure)', cfg.cookieSecure ? 'ok' : (prod ? 'warn' : 'info'), cfg.cookieSecure ? 'The session cookie is sent only over HTTPS.' : 'COOKIE_SECURE is off: the session cookie can travel over plain HTTP, where anyone on the network can read it.', 'Serve the app over HTTPS and set COOKIE_SECURE=true. Acceptable only on an isolated LAN.');
  const tp = process.env.TRUST_PROXY || '';
  a('proxy', 'Server', 'Client IP address is trusted correctly', /^(true|yes|on)$/i.test(tp) ? 'fail' : (!tp && prod ? 'warn' : 'ok'),
    /^(true|yes|on)$/i.test(tp) ? 'TRUST_PROXY=true believes any X-Forwarded-For header, so IP rules, limits and the audit log can be faked.' : (!tp && prod ? 'TRUST_PROXY is not set: behind a proxy everyone shares the proxy IP, so IP rules and per-IP limits act on the gateway.' : 'Set to a proxy count or address list, or no proxy.'),
    'Set TRUST_PROXY=1 (number of proxies in front) or the proxy address(es).');
  a('origin', 'Server', 'Allowed web address is set (APP_ORIGIN)', cfg.APP_ORIGINS.length ? 'ok' : 'info', cfg.APP_ORIGINS.length ? cfg.APP_ORIGINS.join(', ') : 'Not set: cross-site requests are still blocked by the header and cookie rules, but pinning the address is stricter.', 'Set APP_ORIGIN=https://your-address.');
  a('totpkey', 'Server', 'Own key for 2FA secrets (TOTP_ENC_KEY)', process.env.TOTP_ENC_KEY ? 'ok' : 'warn', process.env.TOTP_ENC_KEY ? 'Set.' : 'Not set: 2FA secrets are encrypted with a key derived from SESSION_SECRET, so changing the session secret breaks every 2FA.', 'Set TOTP_ENC_KEY (openssl rand -hex 32). Keep a copy off the server.');
  a('adminpw', 'Server', 'No leftover first-admin password in .env', process.env.ADMIN_PASSWORD ? 'warn' : 'ok', process.env.ADMIN_PASSWORD ? 'ADMIN_PASSWORD is still in the environment. It is only needed for the very first start.' : 'Not present.', 'Delete the ADMIN_PASSWORD line from .env.');
  try {
    const st = fs.statSync(path.join(ROOT, '.env'));
    const open = st.mode & 0o007;
    a('envperm', 'Server', '.env is not readable by other users', open ? 'warn' : 'ok', open ? `.env permissions are ${(st.mode & 0o777).toString(8)}: any user on this machine can read the secrets.` : `Permissions ${(st.mode & 0o777).toString(8)}.`, 'chmod 640 /var/www/pcshub/.env (owner pch).');
  } catch (_) { a('envperm', 'Server', '.env is not readable by other users', 'info', 'There is no .env file next to the app (settings come from the service environment).'); }
  try {
    const st = fs.statSync(bcfg.BACKUP_DIR);
    const open = st.mode & 0o077;
    a('bkperm', 'Server', 'Backup folder is private', open ? 'warn' : 'ok', open ? `${bcfg.BACKUP_DIR} permissions are ${(st.mode & 0o777).toString(8)}: other users can read backups (password hashes, 2FA secrets).` : `Permissions ${(st.mode & 0o777).toString(8)}.`, `chmod 700 ${bcfg.BACKUP_DIR}`);
  } catch (_) { a('bkperm', 'Server', 'Backup folder is private', 'info', 'No backup folder yet.'); }
  const major = parseInt(process.versions.node, 10);
  a('node', 'Server', 'Node.js version is supported', major >= 20 ? 'ok' : 'warn', `Node.js ${process.versions.node}.`, 'Move to a current LTS release (20 or newer).');
}

// ---- people and rules ----
async function accountChecks(a) {
  const p = settings.get();
  const { rows: [u] } = await db.query(`SELECT count(*) FILTER (WHERE is_active AND role IN ('Admin','System Admin'))::int AS admins,
        count(*) FILTER (WHERE is_active AND role IN ('Admin','System Admin') AND NOT totp_enabled)::int AS admins_no2fa,
        count(*) FILTER (WHERE is_active AND role = 'System Admin')::int AS sysadmins,
        count(*) FILTER (WHERE is_active AND COALESCE(last_login_at, created_at) < now() - interval '90 days')::int AS stale,
        count(*) FILTER (WHERE is_active AND must_change_password AND updated_at < now() - interval '14 days')::int AS pw_pending,
        count(*) FILTER (WHERE locked_until > now())::int AS locked,
        count(*) FILTER (WHERE is_active AND email IS NULL AND role IN ('Admin','System Admin'))::int AS admins_noemail FROM users`);
  a('admin2fa', 'People', 'Every Admin uses 2FA', u.admins_no2fa ? 'fail' : 'ok', u.admins_no2fa ? `${u.admins_no2fa} of ${u.admins} active Admins have no 2FA.` : `All ${u.admins} active Admins have 2FA.`, 'Administration → Access → Users: turn on 2FA for those Admins, and tick "Require 2FA for every Admin" in Security → Rules.');
  a('req2fa', 'People', 'Rule: 2FA required for Admins', p.requireAdmin2fa ? 'ok' : 'warn', p.requireAdmin2fa ? 'On.' : 'Off: a new Admin can sign in with a password alone.', 'Security → Rules → Require 2FA for every Admin.');
  a('pwlen', 'People', 'Minimum password length is 10 or more', p.minPasswordLength >= 10 ? 'ok' : 'warn', `Minimum is ${p.minPasswordLength} characters.`, 'Security → Rules → raise the minimum to 12.');
  a('lock', 'People', 'Wrong-password lock is strict enough', p.lockAfterFailures <= 5 ? 'ok' : 'warn', `Locks after ${p.lockAfterFailures} wrong passwords for ${p.lockMinutes} minutes.`, 'Security → Rules → lock after 5.');
  a('session', 'People', 'Sessions end reasonably soon', p.maxSessionHours <= 168 && p.idleSignOutHours <= 12 ? 'ok' : 'warn', `Idle sign-out ${p.idleSignOutHours} h, longest session ${p.maxSessionHours} h.`, 'Security → Rules → idle 12 h or less, longest 168 h (7 days) or less.');
  a('sysadmins', 'People', 'Few System Admins', u.sysadmins <= 3 ? 'ok' : 'info', `${u.sysadmins} active System Admin${u.sysadmins === 1 ? '' : 's'}. A System Admin can do everything, including see locations and read backups.`, 'Give day-to-day admins the Admin role instead.');
  a('stale', 'People', 'No long-unused accounts', u.stale ? 'warn' : 'ok', u.stale ? `${u.stale} active account${u.stale === 1 ? ' has' : 's have'} not signed in for 90 days.` : 'Everyone active has signed in within 90 days.', 'Administration → Access → Users: deactivate or delete accounts that are no longer needed.');
  a('pwpending', 'People', 'No password change left waiting', u.pw_pending ? 'info' : 'ok', u.pw_pending ? `${u.pw_pending} account${u.pw_pending === 1 ? ' has' : 's have'} been told to change the password for over 14 days and have not.` : 'None waiting.', null);
  a('adminmail', 'People', 'Admins have an email address (for alerts)', u.admins_noemail ? 'info' : 'ok', u.admins_noemail ? `${u.admins_noemail} active Admin${u.admins_noemail === 1 ? ' has' : 's have'} no email address.` : 'All Admins have one.', null);
}

// ---- watching ----
async function monitorChecks(a) {
  const mailer = require('./mailer');
  a('smtp', 'Monitoring', 'Email is set up (security alerts can be emailed)', mailer.configured() ? 'ok' : 'warn', mailer.configured() ? `Sending from ${process.env.SMTP_FROM}.` : 'SMTP is not set up: alerts reach System Admins only by the bell and phone.', 'Add SMTP_HOST and SMTP_FROM (see .env.example) and restart.');
  a('alertmail', 'Monitoring', 'A security alert address is set', settings.get().alertEmail ? 'ok' : 'info', settings.get().alertEmail || 'None: alerts go to each System Admin\'s own address.', 'Security → Rules → Security alert email.');
  const { rows: [r] } = await db.query(`SELECT count(*) FILTER (WHERE action IN ('auth.login_failed','auth.locked') AND created_at > now() - interval '24 hours')::int AS failed24,
        count(*) FILTER (WHERE action = 'security.alert' AND created_at > now() - interval '7 days')::int AS alerts7,
        max(created_at) AS last FROM audit_logs`);
  a('failed24', 'Monitoring', 'Failed sign-ins in the last 24 hours', r.failed24 >= 50 ? 'warn' : 'info', `${r.failed24} failed sign-in${r.failed24 === 1 ? '' : 's'}.`, r.failed24 >= 50 ? 'Open the Audit Log and look for one address or one account being hit.' : null);
  a('alerts7', 'Monitoring', 'Security alerts in the last 7 days', r.alerts7 ? 'warn' : 'ok', r.alerts7 ? `${r.alerts7} alert${r.alerts7 === 1 ? '' : 's'}: see Audit Log → Security Alert.` : 'None.', r.alerts7 ? 'Review them in the Audit Log.' : null);
  a('auditkeep', 'Monitoring', 'Sign-in, security and admin lines are protected', 'ok', `Kept ${require('./audit').protectDays()} days through Clear Data and retention, and copied to the server log.`, null);
  const geo = require('./geoip').status();
  a('geo', 'Monitoring', 'IP location data is installed', geo && geo.installed ? 'ok' : 'info', geo && geo.installed ? 'Installed.' : 'Not installed: locations are not shown next to addresses.', 'On the server: npm run geoip:update');
}

// ---- backups ----
async function backupChecks(a) {
  const { rows: [b] } = await db.query(`SELECT filename, signed, verify_status, finished_at FROM backup_jobs WHERE kind='create' AND status='succeeded' ORDER BY finished_at DESC LIMIT 1`);
  if (!b) { a('bklast', 'Backups', 'A recent backup exists', 'fail', 'No successful backup has ever been made.', 'Administration → Backup and Restore → Create backup, and set a schedule.'); return; }
  const hours = Math.round((Date.now() - new Date(b.finished_at).getTime()) / 3600000);
  a('bklast', 'Backups', 'A recent backup exists', hours > 72 ? 'fail' : hours > 30 ? 'warn' : 'ok', `Latest backup is ${hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`} old.`, 'Set a daily schedule in Backup and Restore.');
  a('bkenc', 'Backups', 'Backups are encrypted', /\.enc$/.test(b.filename || '') ? 'ok' : 'warn', /\.enc$/.test(b.filename || '') ? 'The latest backup is encrypted (AES-256-GCM).' : 'The latest backup is not encrypted: it holds password hashes and 2FA secrets.', 'Set BACKUP_ENC_KEY (openssl rand -hex 32), keep a copy off the server, restart.');
  a('bksign', 'Backups', 'Backups are signed', b.signed ? 'ok' : 'warn', b.signed ? 'Signed, so a changed archive is detected.' : 'Not signed: a tampered backup could not be told apart from a real one.', 'Set BACKUP_SIGNING_KEY (openssl rand -hex 32) and restart.');
  a('bkverify', 'Backups', 'The latest backup was verified', b.verify_status === 'ok' ? 'ok' : 'warn', b.verify_status === 'ok' ? 'Verified.' : 'Not verified yet.', 'Backup and Restore → Verify.');
}

// ---- attack our own front door ----
function probe(method, urlPath, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: parseInt(process.env.PORT, 10) || 3000, path: urlPath, method, timeout: 5000, headers: { 'X-Selfcheck': TOKEN, ...headers } }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { if ((n += c.length) < 20000) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}
async function liveChecks(a) {
  const home = await probe('GET', '/login');
  if (!home) { a('probe', 'Live test', 'The server answers its own test requests', 'info', 'Could not reach this server on 127.0.0.1 (a different PORT or HOST?), so the live tests were skipped.', null); return; }
  const h = home.headers;
  const missing = [['content-security-policy', 'CSP'], ['x-content-type-options', 'nosniff'], ['x-frame-options', 'frame-deny'], ['referrer-policy', 'referrer policy']].filter(([k]) => !h[k]).map(([, n]) => n);
  a('headers', 'Live test', 'Security headers are sent', missing.length ? 'fail' : 'ok', missing.length ? `Missing: ${missing.join(', ')}.` : 'CSP, nosniff, frame-deny and referrer policy are present.', 'A proxy in front may be stripping them; check its config.');
  const csp = h['content-security-policy'] || '';
  a('csp', 'Live test', 'The page blocks inline scripts (CSP)', /script-src[^;]*'unsafe-(inline|eval)'/.test(csp) ? 'fail' : 'ok', /script-src[^;]*'unsafe-(inline|eval)'/.test(csp) ? "script-src allows 'unsafe-inline' or 'unsafe-eval'." : 'Scripts only run from this site.', null);
  a('powered', 'Live test', 'Server does not announce its software', h['x-powered-by'] ? 'warn' : 'ok', h['x-powered-by'] ? `X-Powered-By: ${h['x-powered-by']}` : 'No X-Powered-By header.', null);
  const unauth = await probe('GET', '/api/ingest');
  a('unauth', 'Live test', 'Data needs a sign-in', unauth && unauth.status === 401 ? 'ok' : 'fail', `GET /api/ingest without signing in answered ${unauth ? unauth.status : 'nothing'} (should be 401).`, 'Do not expose the app without its login; check any proxy rule that adds access.');
  const csrf = await probe('POST', '/api/ingest', { 'Content-Type': 'application/json' });
  a('csrf', 'Live test', 'Changes need the app header (cross-site requests blocked)', csrf && csrf.status === 403 ? 'ok' : 'fail', `POST without the app header answered ${csrf ? csrf.status : 'nothing'} (should be 403).`, null);
  const leaks = [];
  for (const p of ['/.env', '/uploads/..%2f.env', '/..%2f.env', '/package.json', '/server.js', '/src/db.js', '/.git/config']) {
    const r = await probe('GET', p);
    if (r && r.status === 200 && /SESSION_SECRET|DATABASE_URL|"dependencies"|require\(|\[core\]/.test(r.body)) leaks.push(p);
  }
  a('leaks', 'Live test', 'Source and settings files are not downloadable', leaks.length ? 'fail' : 'ok', leaks.length ? `Readable from the web: ${leaks.join(', ')}` : '.env, package.json, source and .git are not served.', 'Fix the proxy/static rules so only the built app is served.');
  const sensitive = await probe('GET', '/api/admin/users');
  a('admin', 'Live test', 'Admin pages need an Admin', sensitive && [401, 403].includes(sensitive.status) ? 'ok' : 'fail', `GET /api/admin/users without signing in answered ${sensitive ? sensitive.status : 'nothing'}.`, null);
}

// ---- known weak packages (needs the npm registry: skipped when unreachable) ----
function auditChecks(a) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--omit=dev', '--json'], { cwd: ROOT, timeout: 25000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      let v = null;
      try { v = JSON.parse(stdout).metadata.vulnerabilities; } catch (_) { /* offline or no npm */ }
      if (!v) a('npmaudit', 'Packages', 'No known vulnerable packages', 'info', 'Could not check (no npm, or no route to the npm registry).', 'Run: npm audit --omit=dev');
      else if (v.critical || v.high) a('npmaudit', 'Packages', 'No known vulnerable packages', 'fail', `${v.critical} critical, ${v.high} high, ${v.moderate} moderate.`, 'Run: npm audit fix --omit=dev (review), then rebuild and restart.');
      else if (v.moderate || v.low) a('npmaudit', 'Packages', 'No known vulnerable packages', 'warn', `${v.moderate} moderate, ${v.low} low.`, 'Run: npm audit --omit=dev');
      else a('npmaudit', 'Packages', 'No known vulnerable packages', 'ok', 'npm audit found nothing.', null);
      resolve();
    });
  });
}

let running = null;
/** Runs every check. One run at a time (a second call waits for the first). */
function run() {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const list = [];
    const a = add(list);
    const steps = [
      ['server settings', async () => configChecks(a)], ['people and rules', () => accountChecks(a)], ['monitoring', () => monitorChecks(a)],
      ['backups', () => backupChecks(a)], ['live test', () => liveChecks(a)], ['packages', () => auditChecks(a)],
    ];
    for (const [name, fn] of steps) {
      try { await fn(); } catch (e) { a(`err-${name}`, 'Self-check', `Could not check ${name}`, 'info', String(e.message).slice(0, 200), null); }
    }
    const count = (s) => list.filter((c) => c.status === s).length;
    return { at: new Date().toISOString(), durationMs: Date.now() - started, fail: count('fail'), warn: count('warn'), info: count('info'), ok: count('ok'), checks: list };
  })().finally(() => { running = null; });
  return running;
}

module.exports = { run, isProbe };
