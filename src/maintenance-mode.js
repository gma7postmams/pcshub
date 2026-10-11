const fs = require('fs');
const path = require('path');
const { isSysAdmin } = require('./permissions');

// Planned maintenance. While it is ON, only a System Admin can sign in or use the site; everybody else gets an "Under maintenance" page
// (and API calls answer 503). Turn it on / off in either of two ways:
//   1. .env:           MAINTENANCE_MODE=true   (optionally MAINTENANCE_MESSAGE="Back at 3 PM")      — read at start-up: restart the service to apply
//   2. a flag file:    create a file named MAINTENANCE in the app folder (or the path in MAINTENANCE_FILE) — noticed within a second, no restart
//        sudo sh -c 'echo "Back at 3 PM" > /var/www/pcshub/MAINTENANCE'     (the file's text, if any, is the message shown)
//        sudo rm /var/www/pcshub/MAINTENANCE
// Either one being on is enough. (This is separate from src/backup/maintenance.js, which blocks everyone, admins included, while a backup is restored.)
const FLAG_FILE = process.env.MAINTENANCE_FILE ? path.resolve(process.env.MAINTENANCE_FILE) : path.join(__dirname, '..', 'MAINTENANCE');
const DEFAULT_MESSAGE = 'The site is undergoing scheduled maintenance. Please check back shortly.';
const TRUE = /^(1|true|on|yes)$/i;
const MAX_MESSAGE = 300;

let cache = { at: 0, value: { on: false, message: '' } };

/** { on, message } — re-read at most once a second so toggling the flag file is picked up without a restart. */
function state() {
  const now = Date.now();
  if (now - cache.at < 1000) return cache.value;
  let on = TRUE.test(String(process.env.MAINTENANCE_MODE || '').trim());
  let message = String(process.env.MAINTENANCE_MESSAGE || '').trim();
  let flagged = false;
  try { flagged = fs.existsSync(FLAG_FILE); } catch (e) { flagged = false; }
  if (flagged) {
    on = true;
    try { message = fs.readFileSync(FLAG_FILE, 'utf8').trim() || message; } catch (e) { /* present but unreadable: still on, default message */ }
  }
  cache = { at: now, value: { on, message: on ? (message || DEFAULT_MESSAGE).slice(0, MAX_MESSAGE) : '' } };
  return cache.value;
}
const enabled = () => state().on;
/** Tests (and nothing else) need to see a change straight away. */
const reset = () => { cache = { at: 0, value: { on: false, message: '' } }; };

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
  if (req.method === 'GET' && req.accepts('html')) return res.status(503).type('html').send(page(req, m.message));
  return res.status(503).send('Service temporarily unavailable');
}

module.exports = { state, enabled, mayUse, guard, reset, FLAG_FILE, DEFAULT_MESSAGE };
