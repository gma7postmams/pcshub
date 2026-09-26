const express = require('express');
const db = require('../db');
const v = require('../validate');
const { asyncH } = require('../middleware');

const router = express.Router();

router.get('/', asyncH(async (req, res) => {
  const [list, unread] = await Promise.all([
    db.query(`SELECT id, title, body, link, is_read, created_at FROM notifications
               WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, [req.user.id]),
    db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND NOT is_read`, [req.user.id]),
  ]);
  res.json({ unread: unread.rows[0].n, rows: list.rows });
}));

router.post('/read-all', asyncH(async (req, res) => {
  await db.query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND NOT is_read', [req.user.id]);
  res.json({ ok: true });
}));

router.post('/:id/read', asyncH(async (req, res) => {
  await db.query('UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2', [v.id(req.params.id), req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
