const express = require('express');
const db = require('../db');
const { asyncH } = require('../middleware');
const { PAGE_BY_PATH } = require('../permissions');

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

module.exports = router;
