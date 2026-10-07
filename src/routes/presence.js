const express = require('express');
const { EventEmitter } = require('events');
const db = require('../db');
const { asyncH } = require('../middleware');
const { PAGE_BY_PATH, canPage } = require('../permissions');

const ACTIVE_MINUTES = 3;   // "active" = sent a heartbeat within this many minutes (they come about once a minute while someone is using the app). Shared with the Dashboard's Active users

// Presence heartbeat. The signed-in app posts { path } about once a minute, but only while the person is really using it (mouse, keys,
// touch or scroll in the last two minutes, tab visible) — so an idle open tab does NOT count as "active". The Dashboard's Active users block
// reads this table. Any signed-in user may post; it only ever writes the caller's own row.
const router = express.Router();

// In-process "someone arrived / moved / left" signal. The live stream below listens to it, so the avatars on the Workload Tracker change the
// moment another person opens, switches or leaves a page instead of on the next poll. (The app runs as a single Node process.)
const bus = new EventEmitter();
bus.setMaxListeners(0);
const changed = () => bus.emit('change');

router.post('/', asyncH(async (req, res) => {
  const path = String((req.body && req.body.path) || '');
  const page = PAGE_BY_PATH[path] ? path : null;   // only real app pages are stored
  const r = await db.query(
    `INSERT INTO user_presence (user_id, last_active_at, page) VALUES ($1, now(), $2)
     ON CONFLICT (user_id) DO UPDATE
        SET last_active_at = now(), page = COALESCE(EXCLUDED.page, user_presence.page)
      WHERE user_presence.last_active_at < now() - interval '15 seconds' OR user_presence.page IS DISTINCT FROM EXCLUDED.page`,
    [req.user.id, page]
  );
  if (r.rowCount) changed();   // the row only changes when the person moved to another page or the heartbeat was due
  res.json({ ok: true });
}));

// "I'm leaving": sent as the tab / browser closes (and by logout on the server), so the person drops off the list at once instead of
// lingering until the heartbeat window runs out. If they have another tab open it simply reappears on that tab's next heartbeat.
router.post('/leave', asyncH(async (req, res) => {
  await db.query('DELETE FROM user_presence WHERE user_id = $1', [req.user.id]);
  changed();
  res.json({ ok: true });
}));

// Who is on a page right now (the avatars at the top of the Workload Tracker).
// Anyone who can open that page may ask; the answer is only people who are currently on that same page.
// Only for pages a group has to be granted (or the Admin page): "who is on their Profile" is nobody else's business,
// and everyone can open Profile, so that would hand any signed-in user a list of names and roles.
function checkPage(req, res) {
  const path = String(req.query.path || '');
  const page = PAGE_BY_PATH[path];
  if (!page || page.always) { res.status(400).json({ error: 'Unknown page' }); return null; }
  if (!canPage(req.user, path)) { res.status(403).json({ error: 'No access to that page' }); return null; }
  return path;
}

async function usersOn(path, me) {
  const { rows } = await db.query(
    `SELECT p.user_id AS id, COALESCE(NULLIF(btrim(u.full_name), ''), u.username) AS name, u.role, p.last_active_at
       FROM user_presence p JOIN users u ON u.id = p.user_id
      WHERE u.is_active AND p.page = $1 AND p.last_active_at >= now() - ($2 || ' minutes')::interval
      ORDER BY (p.user_id = $3) DESC, p.last_active_at DESC LIMIT 30`,
    [path, String(ACTIVE_MINUTES), me]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, lastActiveAt: r.last_active_at, you: r.id === me }));
}

// GET /api/presence?path=/workload
router.get('/', asyncH(async (req, res) => {
  const path = checkPage(req, res);
  if (!path) return;
  res.json({ users: await usersOn(path, req.user.id) });
}));

// GET /api/presence/stream?path=/workload — the same answer, pushed as it changes (Server-Sent Events). The first message is the current list;
// after that a new one is sent whenever someone arrives, switches page or leaves. A slow check every 20 seconds also catches people who just
// went quiet (their heartbeat window ran out), and doubles as the keep-alive. The page falls back to polling if this stream can't stay open.
router.get('/stream', (req, res) => {
  const path = checkPage(req, res);
  if (!path) return;
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',   // nginx must not hold the events back
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  let last = '';
  let closed = false;
  let busy = false;
  let again = false;
  const push = async () => {
    if (closed) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const users = await usersOn(path, req.user.id);
      const body = JSON.stringify(users.map((u) => [u.id, u.name, u.role, u.you]));
      if (!closed && body !== last) { last = body; res.write(`data: ${JSON.stringify({ users })}\n\n`); }
      else if (!closed) res.write(': ping\n\n');
    } catch (e) { /* the next change or tick tries again */ }
    busy = false;
    if (again) { again = false; push(); }
  };
  let timer = null;
  const onChange = () => { clearTimeout(timer); timer = setTimeout(push, 120); };   // bursts (several people arriving at once) become one update
  bus.on('change', onChange);
  const tick = setInterval(push, 20000);
  req.on('close', () => { closed = true; clearTimeout(timer); clearInterval(tick); bus.off('change', onChange); });
  push();
});

module.exports = router;
module.exports.ACTIVE_MINUTES = ACTIVE_MINUTES;
module.exports.presenceChanged = changed;
module.exports.presenceBus = bus;   // the Dashboard's live Active users stream listens to it too
