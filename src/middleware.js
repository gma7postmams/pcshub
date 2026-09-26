const path = require('path');
const db = require('./db');
const { canPage, can, canSection } = require('./permissions');

const VIEWS = path.join(__dirname, '..', 'views');

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.full_name, u.email, u.role, u.group_id, g.name AS group_name,
            u.is_active, u.must_change_password, u.totp_enabled, u.appearance,
            COALESCE((SELECT array_agg(gp.perm_key) FROM group_permissions gp WHERE gp.group_id = u.group_id), '{}') AS perms
       FROM users u LEFT JOIN groups g ON g.id = u.group_id
      WHERE u.id=$1`,
    [uid]
  );
  const u = rows[0];
  if (!u || !u.is_active) {
    return req.session.destroy(() => next());
  }
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
    return res.status(403).sendFile(path.join(VIEWS, '403.html'));
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

// Basic CSRF defence for state-changing API calls: same-site cookie + custom header
// (a cross-site form cannot set custom headers without a CORS preflight, which we never allow).
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') === 'PromoHub') return next();
  return res.status(403).json({ error: 'Missing request header' });
}

function errorHandler(err, req, res, _next) {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error('[error]', err);
  const message = status >= 500 ? 'Internal server error' : err.message;
  if (isApi(req)) return res.status(status).json({ error: message, ...(err.extra || {}) });
  res.status(status).send(message);
}

module.exports = { asyncH, HttpError, loadUser, requireAuth, requirePageAccess, requireAction, requireSection, csrfGuard, errorHandler, VIEWS };
