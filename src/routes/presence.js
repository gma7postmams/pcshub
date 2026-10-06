const express = require('express');
const db = require('../db');
const { asyncH } = require('../middleware');
const { PAGE_BY_PATH, canPage } = require('../permissions');

const ACTIVE_MINUTES = 3;   // "active" = sent a heartbeat within this many minutes (they come about once a minute while someone is using the app). Shared with the Dashboard's Active users

// Presence heartbeat. The signed-in app posts { path } about once a minute, but only while the person is really using it (mouse, keys,
// touch or scroll in the last two minutes, tab visible) — so an idle open tab does NOT count as "active". The Dashboard's Active users block
// reads this table. Any signed-in user may post; it only ever writes the caller's own row.
const router = express.Router();

router.post('/', asyncH(async (req, res) => {
  const path = String((req.body && req.body.path) || '');
  const page = PAGE_BY_PATH[path] ? path : null;   // only real app pages are stored
  await db.query(
    `INSERT INTO user_presence (user_id, last_active_at, page) VALUES ($1, now(), $2)
     ON CONFLICT (user_id) DO UPDATE
        SET last_active_at = now(), page = COALESCE(EXCLUDED.page, user_presence.page)
      WHERE user_presence.last_active_at < now() - interval '15 seconds' OR user_presence.page IS DISTINCT FROM EXCLUDED.page`,
    [req.user.id, page]
  );
  res.json({ ok: true });
}));

// "I'm leaving": sent as the tab / browser closes (and by logout on the server), so the person drops off the list at once instead of
// lingering until the heartbeat window runs out. If they have another tab open it simply reappears on that tab's next heartbeat.
router.post('/leave', asyncH(async (req, res) => {
  await db.query('DELETE FROM user_presence WHERE user_id = $1', [req.user.id]);
  res.json({ ok: true });
}));

// Who is on a page right now (the avatars at the top of the Workload Tracker): GET /api/presence?path=/workload
// Anyone who can open that page may ask; the answer is only people who are currently on that same page.
router.get('/', asyncH(async (req, res) => {
  const path = String(req.query.path || '');
  const page = PAGE_BY_PATH[path];
  // Only for pages a group has to be granted (or the Admin page): "who is on their Profile" is nobody else's business,
  // and everyone can open Profile, so that would hand any signed-in user a list of names and roles.
  if (!page || page.always) return res.status(400).json({ error: 'Unknown page' });
  if (!canPage(req.user, path)) return res.status(403).json({ error: 'No access to that page' });
  const { rows } = await db.query(
    `SELECT p.user_id AS id, COALESCE(NULLIF(btrim(u.full_name), ''), u.username) AS name, u.role, p.last_active_at
       FROM user_presence p JOIN users u ON u.id = p.user_id
      WHERE u.is_active AND p.page = $1 AND p.last_active_at >= now() - ($2 || ' minutes')::interval
      ORDER BY (p.user_id = $3) DESC, p.last_active_at DESC LIMIT 30`,
    [path, String(ACTIVE_MINUTES), req.user.id]
  );
  res.json({ users: rows.map((r) => ({ id: r.id, name: r.name, role: r.role, lastActiveAt: r.last_active_at, you: r.id === req.user.id })) });
}));

module.exports = router;
module.exports.ACTIVE_MINUTES = ACTIVE_MINUTES;
