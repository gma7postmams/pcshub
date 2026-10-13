const fs = require('fs');
const path = require('path');
const { isSysAdmin } = require('./permissions');

// Planned maintenance. While it is ON, only a System Admin can sign in or use the site; everybody else gets an "Under maintenance" page
// (and API calls answer 503). Turn it on / off in either of two ways:
//   1. .env:           MAINTENANCE_MODE=true   (optionally MAINTENANCE_MESSAGE="Back at 3 PM")      — read at start-up: restart the service to apply
//   2. a flag file:    create a file named MAINTENANCE in the app folder (or the path in MAINTENANCE_FILE) — noticed within a second, no restart
//        sudo sh -c 'echo "Back at 3 PM" > /var/www/pcshub/MAINTENANCE'     (the file's text, if any, is the message shown)
//        sudo rm /var/www/pcshub/MAINTENANCE
//   3. the switch in the app: Administration > Maintenance (System Admin) — stored in the database, no restart
// Any one being on is enough. (This is separate from src/backup/maintenance.js, which blocks everyone, admins included, while a backup is restored.)
const FLAG_FILE = process.env.MAINTENANCE_FILE ? path.resolve(process.env.MAINTENANCE_FILE) : path.join(__dirname, '..', 'MAINTENANCE');
const DEFAULT_MESSAGE = 'The site is undergoing scheduled maintenance. Please check back shortly.';
const TRUE = /^(1|true|on|yes)$/i;
const MAX_MESSAGE = 300;

let cache = null;                       // { at, detail }
let ui = { on: false, message: '' };   // the in-app switch (Administration > Maintenance), kept in app_settings

/** Everything about the current state, including which switches are on: { on, message, uiMessage, sources: { ui, env, file } }. Re-read at most once a second. */
function detail() {
  const now = Date.now();
  if (cache && now - cache.at < 1000) return cache.detail;
  const env = TRUE.test(String(process.env.MAINTENANCE_MODE || '').trim());
  let file = false;
  try { file = fs.existsSync(FLAG_FILE); } catch (e) { file = false; }
  let fileText = '';
  if (file) { try { fileText = fs.readFileSync(FLAG_FILE, 'utf8').trim(); } catch (e) { /* present but unreadable: still on */ } }
  const on = env || file || ui.on;
  // the flag file's text wins, then what was typed in the app, then MAINTENANCE_MESSAGE
  const message = on ? (fileText || (ui.on && ui.message) || String(process.env.MAINTENANCE_MESSAGE || '').trim() || DEFAULT_MESSAGE).slice(0, MAX_MESSAGE) : '';
  cache = { at: now, detail: { on, message, uiMessage: ui.message, sources: { ui: ui.on, env, file } } };
  return cache.detail;
}
/** { on, message } — what the page and the guard need. */
const state = () => { const d = detail(); return { on: d.on, message: d.message }; };
const enabled = () => detail().on;
/** Tests (and nothing else) need to see a change straight away. */
const reset = () => { cache = null; ui = { on: false, message: '' }; };

const UI_KEYS = ['maint_on', 'maint_message'];
/** Read the in-app switch from the database (at start-up). */
async function loadUi(db) {
  const { rows } = await db.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [UI_KEYS]);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  ui = { on: m.maint_on === '1', message: String(m.maint_message || '').slice(0, MAX_MESSAGE) };
  cache = null;
  return ui;
}
/** Save the in-app switch (inside the caller's transaction) — call apply() once that has committed. */
async function saveUi(client, on, message) {
  for (const [key, value] of [['maint_on', on ? '1' : '0'], ['maint_message', message]]) {
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, value]
    );
  }
}
const applyUi = (on, message) => { ui = { on: Boolean(on), message: String(message || '').slice(0, MAX_MESSAGE) }; cache = null; };

/** Who may use the site during maintenance. */
const mayUse = (user) => isSysAdmin(user);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Reachable by anyone while maintenance is on: the sign-in page and what it needs, sign-in / sign-out themselves (the sign-in routes refuse
// everyone but a System Admin), the public branding, the status check, and a health probe if one is ever added.
const OPEN = [/^\/login\/?$/, /^\/api\/auth\//, /^\/api\/branding(\/|$)/, /^\/api\/maintenance\/status$/, /^\/api\/health\/?$/];

function page(req, message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Under maintenance</title><link rel="stylesheet" href="/maintenance.css"></head>
<body><main class="box"><h1>Under maintenance</h1>
<p>${esc(message)}</p>
<p class="hint">This page checks again by itself every 30 seconds.</p>
<p class="hint"><a href="/login">Administrator sign in</a></p></main></body></html>`;
}

/** Express middleware: runs after the session user is loaded and before any page or API route. */
function guard(req, res, next) {
  const m = state();
  if (!m.on) return next();
  if (mayUse(req.user)) return next();
  if (OPEN.some((re) => re.test(req.path))) return next();
  res.set({ 'Cache-Control': 'no-store', 'Retry-After': '300' });
  if (req.path.startsWith('/api/')) return res.status(503).json({ error: m.message, maintenance: true });
  if (req.method === 'GET' && req.accepts('html')) {
    // No separate black page any more: everyone goes to the sign-in page, which shows the "Under maintenance" notice and an Administrator Sign In button.
    // Someone who was already signed in is signed out first (they could not use anything anyway).
    const toLogin = () => res.redirect(302, '/login');
    if (req.session && req.user) return req.session.destroy(() => { require('./middleware').clearSessionCookie(res); toLogin(); });
    return toLogin();
  }
  return res.status(503).send('Service temporarily unavailable');
}

module.exports = { state, detail, enabled, mayUse, guard, reset, loadUi, saveUi, applyUi, FLAG_FILE, DEFAULT_MESSAGE, MAX_MESSAGE };
