// Central runtime configuration + startup safety checks.
const PROD = process.env.NODE_ENV === 'production';

// HTTPS-only features (secure cookie, HSTS, upgrade-insecure-requests).
const cookieSecure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : PROD;
// __Host- prefix: browser only accepts it over HTTPS, path=/, no Domain — blocks subdomain cookie injection.
const COOKIE_NAME = cookieSecure ? '__Host-phub.sid' : 'phub.sid';

// Who must use 2FA: 'admin' (default), 'all', or 'none'
const REQUIRE_2FA = ['admin', 'all', 'none'].includes(process.env.REQUIRE_2FA) ? process.env.REQUIRE_2FA : 'admin';

function twofaRequired(user) {
  if (!user) return false;
  if (REQUIRE_2FA === 'all') return true;
  if (REQUIRE_2FA === 'admin') return user.role === 'Admin';
  return false;
}

// Trust proxy: required behind nginx/Traefik so rate limits and audit logs see real client IPs
function trustProxyValue() {
  const t = process.env.TRUST_PROXY;
  if (!t) return null;
  return /^\d+$/.test(t) ? parseInt(t, 10) : t;
}

function startupChecks() {
  const problems = [];
  const warn = [];
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) problems.push('SESSION_SECRET must be 32+ random chars (openssl rand -hex 48)');
  if (PROD && !cookieSecure) warn.push('COOKIE_SECURE=false in production: sessions travel without the Secure flag. Only acceptable on an isolated LAN.');
  if (PROD && !process.env.TRUST_PROXY) warn.push('TRUST_PROXY not set. If this runs behind a reverse proxy, every user shares the proxy IP for rate limiting and audit logs. Set TRUST_PROXY=1.');
  if (REQUIRE_2FA === 'none' && PROD) warn.push('REQUIRE_2FA=none: Admin accounts can sign in with a password only.');
  warn.forEach((w) => console.warn(`[security] ${w}`));
  if (problems.length) {
    problems.forEach((p) => console.error(`[security] ${p}`));
    if (PROD) process.exit(1);
  }
}

module.exports = { PROD, cookieSecure, COOKIE_NAME, REQUIRE_2FA, twofaRequired, trustProxyValue, startupChecks };
