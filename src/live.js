const express = require('express');
const { EventEmitter } = require('events');
const { canPage } = require('./permissions');

// Live updates for the trackers. When anybody saves, adds, deletes or imports on the Ingest Tracker, the Workload Tracker or the PSD Daily Plug List,
// every other open browser is told "ingest / workload / plugs changed" and quietly re-reads that list — no page refresh needed.
// The message carries NO data (only the topic and which browser tab made the change), so nothing leaks: each browser fetches the rows itself,
// through the normal API and its normal permission checks. (The app runs as a single Node process, so an in-memory bus is enough.)
const bus = new EventEmitter();
bus.setMaxListeners(0);

// topic -> the page a person needs to be allowed on to hear about it
const TOPIC_PAGE = { ingest: '/ingest', workload: '/workload', plugs: '/plug-list' };
// Workload rows are copied from / flagged against the plug list, so a change in one is news to the other
const ALSO = { workload: ['plugs'], plugs: ['workload'] };

let seq = 0;
function publish(topics, tab) {
  const all = new Set();
  [].concat(topics).forEach((t) => { if (TOPIC_PAGE[t]) { all.add(t); (ALSO[t] || []).forEach((x) => all.add(x)); } });
  all.forEach((t) => bus.emit('change', { t, by: tab || null, n: ++seq }));
}

/** Router middleware: after a successful save (POST / PUT / PATCH / DELETE answered 2xx) tell everyone the topic changed. */
function track(topic) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const tab = String(req.get('x-tab') || '').slice(0, 40) || null;
    res.on('finish', () => { if (res.statusCode >= 200 && res.statusCode < 300) publish(topic, tab); });
    next();
  };
}

/** Tell these users their notification bell changed (no data: the browser re-reads /api/notifications itself). */
function publishNotif(userIds) {
  const ids = [...new Set([].concat(userIds || []).filter((x) => Number.isInteger(x)))];
  if (!ids.length) return;
  setTimeout(() => bus.emit('notif', { ids }), 250);   // a moment after the insert, so a surrounding transaction has committed
}

const router = express.Router();

// POST /api/live/focus { topic, key, on } — "I am editing this cell" (on) / "I left it" (off). Other people's open trackers light that cell up with the
// editor's name. Carries no data besides the cell's key (row id : column) and the editor's name; it is never stored. A cell that stops being
// refreshed (closed tab, lost connection) fades from everyone's screen by itself after ~25 seconds.
router.post('/focus', (req, res) => {
  const b = req.body || {};
  const topic = String(b.topic || '');
  if (!TOPIC_PAGE[topic] || !canPage(req.user, TOPIC_PAGE[topic])) return res.status(403).json({ error: 'No access to that page' });
  // `cells`: every cell of the person's block, each "<row id>:<column>|<outer edges: any of t b l r>" (at most 800). `key` = one cell (older pages).
  const cells = (Array.isArray(b.cells) ? b.cells : [b.key]).slice(0, 800).map((c) => String(c || '').slice(0, 80)).filter(Boolean);
  if (!cells.length) return res.status(400).json({ error: 'Missing cell' });
  const key = cells[0];
  const text = b.on !== false && b.kind !== 'select' && typeof b.text === 'string' ? b.text.slice(0, 1000) : null;   // what the editor has typed so far (never stored; only passed on to the others looking at the page)
  const name = String(req.user.full_name || req.user.username || 'Someone').slice(0, 60);
  bus.emit('cell', { topic, key, cells, on: b.on !== false, kind: b.kind === 'select' ? 'select' : 'edit', text, uid: req.user.id, name, by: String(req.get('x-tab') || '').slice(0, 40) || null });
  res.json({ ok: true });
});

// GET /api/live/stream — Server-Sent Events. One connection per browser (the page shares it between tabs), carrying every topic the person may see.
router.get('/stream', (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',   // nginx must not hold the events back
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  let closed = false;
  const send = (m) => { if (!closed) res.write(`data: ${JSON.stringify(m)}\n\n`); };
  const onChange = (m) => { if (canPage(req.user, TOPIC_PAGE[m.t])) send(m); };
  bus.on('change', onChange);
  const onCell = (m) => { if (canPage(req.user, TOPIC_PAGE[m.topic])) send({ t: 'cell', topic: m.topic, key: m.key, cells: m.cells, on: m.on, kind: m.kind, text: m.text, uid: m.uid, name: m.name, by: m.by }); };
  bus.on('cell', onCell);
  const onNotif = (m) => { if (req.user && m.ids.includes(req.user.id)) send({ t: 'notif' }); };
  bus.on('notif', onNotif);
  const beat = setInterval(() => send({ t: 'ping' }), 20000);   // keep-alive, and lets the page tell "quiet" from "connection lost"
  req.on('close', () => { closed = true; clearInterval(beat); bus.off('change', onChange); bus.off('notif', onNotif); bus.off('cell', onCell); });
  send({ t: 'ping' });
});

module.exports = router;
module.exports.publish = publish;
module.exports.track = track;
module.exports.publishNotif = publishNotif;
