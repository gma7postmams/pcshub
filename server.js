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
  loadUser, requireAuth, requirePageAccess, csrfGuard, errorHandler, VIEWS,
} = require('./src/middleware');
const { PAGE_BY_PATH, landingPath } = require('./src/permissions');
const {
  PROD, cookieSecure, COOKIE_NAME, twofaRequired, trustProxyValue, startupChecks,
} = require('./src/config');
require('./src/totp'); // validates TOTP_ENC_KEY at boot

const PORT = parseInt(process.env.PORT, 10) || 3000;
startupChecks();

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
  hsts: cookieSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
}));
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// ---------- Sessions (PostgreSQL) ----------
app.use(session({
  name: COOKIE_NAME,
  // table is created by src/schema.sql, so the runtime DB role needs no DDL rights
  store: new PgStore({ pool: db.pool, tableName: 'user_sessions', createTableIfMissing: false, pruneSessionInterval: 60 * 15 }),
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure,
    path: '/',
    maxAge: (parseInt(process.env.SESSION_HOURS, 10) || 12) * 3600 * 1000,
  },
}));

// ---------- Static assets (no HTML pages here — pages are access-controlled below) ----------
const pub = path.join(__dirname, 'public');
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.set('Service-Worker-Allowed', '/');
  res.sendFile(path.join(pub, 'sw.js'));
});
app.use(express.static(pub, { index: false, maxAge: PROD ? '1h' : 0 }));
app.use('/uploads/branding', express.static(path.join(__dirname, 'uploads', 'branding'), {
  maxAge: '7d',
  setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
}));

app.use(loadUser);

// ---------- API ----------
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});
app.use('/api', apiLimiter, csrfGuard);

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

// Enforced 2FA (REQUIRE_2FA): only profile/notifications APIs until 2FA is set up
app.use('/api', (req, res, next) => {
  if (!twofaRequired(req.user) || req.user.totp_enabled) return next();
  if (/^\/(profile|notifications)(\/|$)/.test(req.path)) return next();
  return res.status(403).json({ error: 'Two-factor authentication must be set up first', twofaSetupRequired: true });
});

app.use('/api/profile',       requirePageAccess('/profile'),   require('./src/routes/profile'));
app.use('/api/notifications', require('./src/routes/notifications'));
app.use('/api',               require('./src/routes/lookups'));
app.use('/api/dashboard',     requirePageAccess('/dashboard'), require('./src/routes/dashboard'));
app.use('/api/ingest',        requirePageAccess('/ingest'),    require('./src/routes/ingest'));
app.use('/api/approvals',     requirePageAccess('/approval'),  require('./src/routes/approvals'));
app.use('/api/workload',      requirePageAccess('/workload'),  require('./src/routes/workload'));
app.use('/api/reports',       requirePageAccess('/reports'),   require('./src/routes/reports'));
app.use('/api/admin',         requirePageAccess('/admin'),     require('./src/routes/admin'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Pages ----------
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

app.get('/login', noStore, (req, res) => {
  if (req.user) return res.redirect(landingPath(req.user));
  res.sendFile(path.join(VIEWS, 'login.html'));
});
app.get('/', (req, res) => res.redirect(req.user ? landingPath(req.user) : '/login'));
app.get('/offline.html', (req, res) => res.sendFile(path.join(VIEWS, 'offline.html')));

for (const page of Object.keys(PAGE_BY_PATH)) {
  app.get(page, noStore, requirePageAccess(page), (req, res) => {
    if (page !== '/profile') {
      if (req.user.must_change_password) return res.redirect('/profile?force=1');
      if (twofaRequired(req.user) && !req.user.totp_enabled) return res.redirect('/profile?setup2fa=1');
    }
    res.sendFile(path.join(VIEWS, `${page.slice(1)}.html`));
  });
}

app.use((req, res) => res.status(404).sendFile(path.join(VIEWS, '404.html')));
app.use(errorHandler);

// ---------- Boot ----------
// MIGRATE_ON_START=false: run `npm run migrate` with an owner DB login instead, and give the app a DML-only login
// (see db/app-role.sql).
const boot = process.env.MIGRATE_ON_START === 'false' ? db.query('SELECT 1 FROM users LIMIT 1') : migrate(db);
boot
  .then(() => {
    app.listen(PORT, () => console.log(`Promotional Content Hub listening on :${PORT} (${PROD ? 'production' : 'development'})`));
  })
  .catch((e) => {
    console.error('Startup failed:', e);
    process.exit(1);
  });

module.exports = app;
