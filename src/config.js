// Central runtime configuration + startup safety checks.
const PROD = process.env.NODE_ENV === 'production';

// HTTPS-only features (secure cookie, HSTS, upgrade-insecure-requests).
const cookieSecure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : PROD;
// __Host- prefix: browser only accepts it over HTTPS, path=/, no Domain — blocks subdomain cookie injection.
const COOKIE_NAME = cookieSecure ? '__Host-phub.sid' : 'phub.sid';

// 2FA is off for everyone by default. An Admin turns it on (or off) per user; a user it is on for must enrol before using the app.
function twofaRequired(user) {
  return Boolean(user && user.twofa_required);
}

// Trust proxy: required behind nginx/Traefik so rate limits and audit logs see real client IPs
function trustProxyValue() {
  const t = process.env.TRUST_PROXY;
  if (!t) return null;
  return /^\d+$/.test(t) ? parseInt(t, 10) : t;
}

// Sessions: signed out after SESSION_HOURS without activity, and always after SESSION_MAX_HOURS since sign-in.
const posInt = (v, def) => (Number.isFinite(parseInt(v, 10)) && parseInt(v, 10) > 0 ? parseInt(v, 10) : def);
const SESSION_IDLE_MS = posInt(process.env.SESSION_HOURS, 12) * 3600 * 1000;
const SESSION_MAX_MS = Math.max(posInt(process.env.SESSION_MAX_HOURS, 168) * 3600 * 1000, SESSION_IDLE_MS);

// Requests per minute per client IP across the whole API (sign-in has its own, stricter limit).
const API_RATE_LIMIT = posInt(process.env.API_RATE_LIMIT, 300);

// The address(es) people open the app at, e.g. https://hub.example.com (comma-separated). Optional: when set, a
// state-changing request must come from exactly one of them.
// Stored the way browsers send an Origin header (scheme://host[:port], default ports and any path dropped).
const APP_ORIGIN_PROBLEMS = [];
const APP_ORIGINS = (process.env.APP_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) throw new Error('not http(s)');
    return u.origin.toLowerCase();
  } catch (e) { APP_ORIGIN_PROBLEMS.push(s); return null; }
}).filter(Boolean);

// A secret that is easy to guess is the same as no secret: placeholder text and low-variety strings are refused.
function weakSecret(s) {
  if (!s || s.length < 32) return true;
  if (/change[-_ ]?me|your[-_ ]?secret|dev-only|example|placeholder/i.test(s)) return true;
  return new Set(s).size < 10;
}

function startupChecks() {
  const problems = [];
  const warn = [];
  // Required in every mode: there is no built-in fallback, so a forgotten setting can never leave sessions signed with a known key.
  if (APP_ORIGIN_PROBLEMS.length) problems.push(`APP_ORIGIN is not a web address: ${APP_ORIGIN_PROBLEMS.join(', ')}. Use the form https://hub.example.com`);
  if (weakSecret(process.env.SESSION_SECRET)) problems.push('SESSION_SECRET must be 32+ random characters, not a placeholder. Generate one with: openssl rand -hex 48');
  if (PROD && !process.env.BACKUP_SIGNING_KEY) warn.push('BACKUP_SIGNING_KEY not set: backups are created unsigned, so a tampered archive cannot be told apart from a real one. Set it with: openssl rand -hex 32');
  if (PROD && /change[-_ ]?me/i.test(process.env.ADMIN_PASSWORD || '')) warn.push('ADMIN_PASSWORD is still the placeholder from .env.example. Change it (and remove it from .env once the first Admin has signed in).');
  if (PROD && !cookieSecure) warn.push('COOKIE_SECURE=false in production: sessions travel without the Secure flag. Only acceptable on an isolated LAN.');
  if (PROD && !process.env.TRUST_PROXY) warn.push('TRUST_PROXY not set. If this runs behind a reverse proxy, every user shares the proxy IP for rate limiting and audit logs. Set TRUST_PROXY=1.');
  warn.forEach((w) => console.warn(`[security] ${w}`));
  if (problems.length) {
    problems.forEach((p) => console.error(`[security] ${p}`));
    process.exit(1);
  }
}

module.exports = {
  PROD, cookieSecure, COOKIE_NAME, twofaRequired, trustProxyValue, startupChecks,
  SESSION_IDLE_MS, SESSION_MAX_MS, API_RATE_LIMIT, APP_ORIGINS,
};
