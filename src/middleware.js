const path = require('path');
const db = require('./db');
const { canPage, can, canSection } = require('./permissions');
const { SESSION_MAX_MS, APP_ORIGINS, COOKIE_NAME, cookieSecure } = require('./config');

// React build output. Every page returns the same index.html, but only after the role/group check.
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
const INDEX_HTML = path.join(CLIENT_DIST, 'index.html');

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Must repeat the attributes the cookie was set with, or browsers ignore the request to drop a __Host- cookie.
const clearSessionCookie = (res) => res.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure: cookieSecure });
// End the signed-in session but leave the request with a fresh, empty one (later handlers such as sign-in expect req.session to exist).
const endSession = (req, res, next) => req.session.regenerate((err) => { clearSessionCookie(res); next(err); });

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Attach req.user from session. Re-loaded on every request so role, group and group-permission
// changes (and deactivation) apply immediately.
const loadUser = asyncH(async (req, res, next) => {
  req.user = null;
  const uid = req.session && req.session.userId;
  if (!uid) return next();
  // Absolute lifetime: however active it is, a session ends SESSION_MAX_HOURS after sign-in.
  if (!req.session.createdAt) req.session.createdAt = Date.now();   // sessions from before this check existed start counting now
  if (Date.now() - req.session.createdAt > SESSION_MAX_MS) return endSession(req, res, next);
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.full_name, u.email, u.role, u.group_id, g.name AS group_name,
            u.is_active, u.must_change_password, u.totp_enabled, u.appearance,
            COALESCE((SELECT array_agg(gp.perm_key) FROM group_permissions gp WHERE gp.group_id = u.group_id), '{}') AS perms
       FROM users u LEFT JOIN groups g ON g.id = u.group_id
      WHERE u.id=$1`,
    [uid]
  );
  const u = rows[0];
  if (!u || !u.is_active) return endSession(req, res, next);
  req.user = u;
  next();
});

function isApi(req) {
  return req.originalUrl.startsWith('/api/');
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  if (isApi(req)) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/login');
}

/**
 * Independent page lock. Used for both the HTML page route and the page's API routes.
 * Locked => 403 (HTML 403 page or JSON).
 */
function requirePageAccess(pagePath) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (canPage(req.user, pagePath)) return next();
    if (isApi(req)) return res.status(403).json({ error: `${who(req.user)} cannot access ${pagePath}` });
    // Same app shell with a 403 status; the React app renders the 'Access locked' screen
    res.set('Cache-Control', 'no-store');
    return res.status(403).sendFile(INDEX_HTML);
  };
}

/** Allows a user who can open ANY of the pages (e.g. the plug list is read by both the PSD Daily Plug List page and the Workload Tracker). */
function requireAnyPage(paths) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (paths.some((p) => canPage(req.user, p))) return next();
    return res.status(403).json({ error: `${who(req.user)} cannot access ${paths[0]}` });
  };
}

function requireAction(action) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (can(req.user, action)) return next();
    return res.status(403).json({ error: `Your role (${req.user.role}) or group does not permit: ${action}` });
  };
}

function requireSection(key) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (canSection(req.user, key)) return next();
    return res.status(403).json({ error: `${who(req.user)} cannot access section ${key}` });
  };
}

function who(u) {
  return u.group_name ? `Group "${u.group_name}"` : 'You are not enrolled in a group and';
}

// CSRF defence for state-changing API calls, in three layers:
//  1. the session cookie is SameSite=Lax, so browsers do not attach it to cross-site POST/PUT/PATCH/DELETE;
//  2. a custom header is required (a cross-site page cannot set one without a CORS preflight, which is never allowed);
//  3. the browser's own statement of where the request came from (Sec-Fetch-Site / Origin) must be this site.
let warnedOrigin = false;
function fromThisSite(req) {
  const origin = (req.get('Origin') || '').toLowerCase();
  if (APP_ORIGINS.length && origin) return APP_ORIGINS.includes(origin);
  const site = req.get('Sec-Fetch-Site');
  if (site) return site === 'same-origin';
  if (!origin) return true;   // not a browser (scripts, health checks): layers 1 and 2 still apply
  // Older browsers / plain-HTTP sites send Origin only: its host name must be the one this request was addressed to.
  // (Host names are compared without the port: a proxy often drops it, and cookies are not separated by port anyway.)
  const nameOf = (h) => { try { return new URL(`http://${String(h).trim()}`).hostname.toLowerCase(); } catch (e) { return null; } };
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch (e) { return false; }
  const hosts = [req.get('Host')];
  if (req.app.get('trust proxy')) hosts.push(...String(req.get('X-Forwarded-Host') || '').split(','));
  if (host && hosts.some((h) => h && nameOf(h) === host)) return true;
  if (!warnedOrigin) {
    warnedOrigin = true;
    console.warn(`[security] Blocked a request from origin ${origin} (this server was addressed as ${req.get('Host')}). `
      + 'If that origin is this app behind a proxy, set APP_ORIGIN to it (and TRUST_PROXY=1).');
  }
  return false;
}

function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'PromoHub') return res.status(403).json({ error: 'Missing request header' });
  if (!fromThisSite(req)) return res.status(403).json({ error: 'Cross-site request blocked' });
  return next();
}

function errorHandler(err, req, res, _next) {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error('[error]', err);
  const message = status >= 500 ? 'Internal server error' : err.message;
  if (isApi(req)) return res.status(status).json({ error: message, ...(err.extra || {}) });
  res.status(status).send(message);
}

module.exports = { clearSessionCookie, asyncH, HttpError, loadUser, requireAuth, requirePageAccess, requireAnyPage, requireAction, requireSection, csrfGuard, errorHandler, CLIENT_DIST, INDEX_HTML };
