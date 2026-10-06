const path = require('path');
const { CLIENT_DIST } = require('../middleware');

// In-memory by design: it must keep working while the database is being replaced.
const state = { active: false, stage: '', since: null };

const begin = (stage) => { state.active = true; state.stage = stage; state.since = Date.now(); };
const setStage = (stage) => { state.stage = stage; };
const end = () => { state.active = false; state.stage = ''; };
const isActive = () => state.active;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function status(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ active: state.active, stage: state.active ? state.stage : null });
}

/** Must run before sessions: nothing here may touch the database. */
function middleware(req, res, next) {
  if (!state.active) return next();
  if (req.path === '/api/maintenance/status') return status(req, res);
  if (req.path === '/maintenance.css') return res.sendFile(path.join(CLIENT_DIST, 'maintenance.css'));
  res.set({ 'Cache-Control': 'no-store', 'Retry-After': '30' });
  if (req.path.startsWith('/api/')) {
    return res.status(503).json({ error: 'The system is being restored from a backup and is temporarily unavailable.', maintenance: true });
  }
  if (req.method === 'GET' && req.accepts('html')) {
    return res.status(503).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Maintenance</title><link rel="stylesheet" href="/maintenance.css"></head>
<body><main class="box"><h1>System maintenance</h1>
<p>The system is being restored from a backup. Access is temporarily unavailable.</p>
<p class="stage">${esc(state.stage)}</p><p class="hint">This page refreshes automatically.</p></main></body></html>`);
  }
  return res.status(503).send('Service temporarily unavailable');
}

module.exports = { begin, setStage, end, isActive, middleware, status };
