require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const db = require('./src/db');
const { migrate } = require('./src/migrate');
const {
  loadUser, requireAuth, requirePageAccess, csrfGuard, errorHandler, CLIENT_DIST, INDEX_HTML,
} = require('./src/middleware');
const { PAGE_BY_PATH, landingPath } = require('./src/permissions');
const {
  PROD, cookieSecure, COOKIE_NAME, twofaRequired, trustProxyValue, startupChecks, API_RATE_LIMIT,
} = require('./src/config');

const PORT = parseInt(process.env.PORT, 10) || 3000;
startupChecks();          // exits when SESSION_SECRET is missing or weak
require('./src/totp');    // validates TOTP_ENC_KEY at boot

const app = express();
app.disable('x-powered-by');
if (trustProxyValue() !== null) app.set('trust proxy', trustProxyValue());

// ---------- Security headers ----------
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      ...(cookieSecure ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' },   // same answer as frame-ancestors 'none' for browsers that only read the older header
  hsts: cookieSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
}));
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});

// During a restore everything except the status endpoint answers 503. Registered before sessions: it must not touch the database.
const maintenance = require('./src/backup/maintenance');
app.use(maintenance.middleware);
app.get('/api/maintenance/status', maintenance.status);

app.use(express.json({ limit: '1mb' }));   // the app only speaks JSON (and multipart for uploads): no form-encoded parser

// ---------- Sessions (PostgreSQL) ----------
app.use(session({
  name: COOKIE_NAME,
  // table is created by src/schema.sql, so the runtime DB role needs no DDL rights
  store: new PgStore({ pool: db.pool, tableName: 'user_sessions', createTableIfMissing: false, pruneSessionInterval: 60 * 15 }),
  secret: process.env.SESSION_SECRET,   // startupChecks() has already refused to start without a strong one
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure,
    path: '/',
    maxAge: require('./src/security-settings').idleMs(),
  },
}));
// Idle sign-out is an Admin setting: each request renews the cookie and its store row with the current value.
app.use((req, res, next) => { if (req.session) req.session.cookie.maxAge = require('./src/security-settings').idleMs(); next(); });

// ---------- Static assets (React build) ----------
// Pages are NOT served from here: index.html is only returned by the access-controlled page routes below.
const fs = require('fs');
if (!fs.existsSync(INDEX_HTML)) {
  console.error('Front end not built: run `npm run build` (creates client/dist).');
  process.exit(1);
}
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(CLIENT_DIST, 'sw.js'));
});
// Hashed bundles never change → cache for a year
app.use('/assets', express.static(path.join(CLIENT_DIST, 'assets'), { immutable: true, maxAge: '365d', index: false }));
// The app shell is only handed out by the access-controlled page routes further down, never as a plain file
app.get('/index.html', (req, res) => res.redirect('/'));
app.use(express.static(CLIENT_DIST, { index: false, dotfiles: 'ignore', maxAge: PROD ? '1h' : 0 }));
app.use('/uploads/branding', express.static(path.join(__dirname, 'uploads', 'branding'), {
  maxAge: '7d',
  setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
}));

app.use(loadUser);

// Workload / Plug List imports and exports announce themselves through src/transfer-hook.js; this writes each one
// (and each failure) to the audit log: who, file name and size, filters, row counts, duration. Never row contents.
const { audit } = require('./src/audit');
require('./src/transfer-hook').onTransfer((e) => audit(e.req, e.action, e.entity, e.entityId, e.details));

// ---------- API ----------
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: API_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});
// API answers are per-user data: neither the browser nor a proxy in between may keep a copy
// (the few routes that serve files set their own Cache-Control afterwards).
const noStoreApi = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
app.use('/api', apiLimiter, csrfGuard, noStoreApi);

// Public
app.use('/api/branding', require('./src/routes/branding'));
app.use('/api/auth', require('./src/routes/auth'));

// Everything below needs a signed-in user
app.use('/api', requireAuth);

// Forced password change: only profile/auth/branding/notifications APIs until changed
app.use('/api', (req, res, next) => {
  if (!req.user.must_change_password) return next();
  if (/^\/(profile|notifications)(\/|$)/.test(req.path)) return next();
  return res.status(403).json({ error: 'Password change required', mustChangePassword: true });
});

// Enforced 2FA (turned on per user by an Admin): only profile/notifications APIs until 2FA is set up
app.use('/api', (req, res, next) => {
  if (!twofaRequired(req.user) || req.user.totp_enabled) return next();
  if (/^\/(profile|notifications)(\/|$)/.test(req.path)) return next();
  return res.status(403).json({ error: 'Two-factor authentication must be set up first', twofaSetupRequired: true });
});

app.use('/api/profile',       requirePageAccess('/profile'),   require('./src/routes/profile'));
app.use('/api/notifications', require('./src/routes/notifications'));
app.use('/api/presence',      require('./src/routes/presence'));   // who is working right now (feeds the Dashboard's Active users)
app.use('/api',               require('./src/routes/lookups'));
app.use('/api/dashboard',     requirePageAccess('/dashboard'), require('./src/routes/dashboard'));
app.use('/api/ingest',        requirePageAccess('/ingest'),    require('./src/routes/ingest'));
app.use('/api/workload',      requirePageAccess('/workload'),  require('./src/routes/workload'));
app.use('/api/plugs',         require('./src/routes/plugs')(require('./src/routes/workload').helpers));   // PSD Daily Plug List (page + API of its own)
app.use('/api/knowledge',     requirePageAccess('/knowledge'), require('./src/routes/knowledge'));
app.use('/api/admin/backups', requirePageAccess('/admin'),     require('./src/routes/backups'));
app.use('/api/admin',         requirePageAccess('/admin'),     require('./src/routes/admin'));


app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Pages ----------
// One React app. Each page URL is gated server-side (role + group) before index.html is returned,
// so a locked page answers 403 even on a direct visit; the API behind it is gated the same way.
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
const sendApp = (req, res) => res.sendFile(INDEX_HTML);

app.get('/login', noStore, (req, res) => {
  if (req.user) return res.redirect(landingPath(req.user));
  sendApp(req, res);
});
app.get('/', (req, res) => res.redirect(req.user ? landingPath(req.user) : '/login'));

// The Approval page is part of the Ingest Tracker now (old links and notifications still land somewhere useful)
app.get('/approval', (req, res) => res.redirect('/ingest'));

for (const page of Object.keys(PAGE_BY_PATH)) {
  app.get(page, noStore, requirePageAccess(page), (req, res) => {
    if (page !== '/profile') {
      if (req.user.must_change_password) return res.redirect('/profile?force=1');
      if (twofaRequired(req.user) && !req.user.totp_enabled) return res.redirect('/profile?setup2fa=1');
    }
    sendApp(req, res);
  });
}

// Unknown URL: signed-in users get the app's 404 screen; others go to sign-in
app.use((req, res) => {
  if (req.method !== 'GET' || !req.accepts('html')) return res.status(404).send('Not found');
  if (!req.user) return res.redirect('/login');
  res.set('Cache-Control', 'no-store');
  return res.status(404).sendFile(INDEX_HTML);
});
app.use(errorHandler);

// ---------- Boot ----------
// MIGRATE_ON_START=false: run `npm run migrate` with an owner DB login instead, and give the app a DML-only login
// (see db/app-role.sql).
const boot = process.env.MIGRATE_ON_START === 'false'
  ? db.query('SELECT 1 FROM users LIMIT 1')
  : migrate(db);

boot
  .then(() => require('./src/roles').loadRoles(db))
  .then(() => require('./src/security-settings').load())
  .then(() => require('./src/backup/service').recoverStale())
  .then(() => require('./src/backup/analysis').startupCleanup())
  .then(async () => {
    // Workload rows that have a Plug ID but no PSD / PROG. NAME yet are filled from the PSD Daily Plug List
    try {
      const n = await require('./src/routes/plugs').backfillWorkload(db);
      if (n) {
        console.log(
          `[workload] filled PSD / PROG. NAME on ${n} existing row(s) from the PSD Daily Plug List`
        );
      }
    } catch (e) {
      console.error('[workload] plug list fill skipped:', e.message);
    }

    // Production default: localhost only — users reach the app through the HTTPS reverse proxy.
    const HOST = process.env.HOST || (PROD ? '127.0.0.1' : '0.0.0.0');

    try { require('./src/backup/scheduler').start(); } catch (e) { console.error('[backup] scheduler not started:', e.message); }

    app.listen(PORT, HOST, () =>
      console.log(
        `Promotional Content Hub listening on ${HOST}:${PORT} (${PROD ? 'production' : 'development'})`
      )
    );
  })
  .catch((e) => {
    console.error('Startup failed:', e);
    process.exit(1);
  });

module.exports = app;
