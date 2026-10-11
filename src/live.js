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

const router = express.Router();

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
  const beat = setInterval(() => send({ t: 'ping' }), 20000);   // keep-alive, and lets the page tell "quiet" from "connection lost"
  req.on('close', () => { closed = true; clearInterval(beat); bus.off('change', onChange); });
  send({ t: 'ping' });
});

module.exports = router;
module.exports.publish = publish;
module.exports.track = track;
