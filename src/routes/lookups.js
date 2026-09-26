const express = require('express');
const db = require('../db');
const { asyncH, HttpError } = require('../middleware');
const { canPage } = require('../permissions');

const router = express.Router();

// Active dropdown values for a category (any signed-in user)
router.get('/dropdowns', asyncH(async (req, res) => {
  const cats = String(req.query.categories || req.query.category || '')
    .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10);
  if (!cats.length) throw new HttpError(400, 'category is required');
  const { rows } = await db.query(
    `SELECT category, value FROM dropdown_options
      WHERE is_active AND category = ANY($1::text[]) ORDER BY category, sort_order, value`,
    [cats]
  );
  const out = {};
  cats.forEach((c) => { out[c] = []; });
  rows.forEach((r) => out[r.category].push(r.value));
  res.json(out);
}));

// Active users (for "Requested by" / assignee pickers) — only for groups that edit such records
router.get('/users/active', asyncH(async (req, res) => {
  if (!canPage(req.user, '/ingest') && !canPage(req.user, '/workload')) throw new HttpError(403, 'Not permitted');
  const { rows } = await db.query(
    `SELECT id, full_name, username FROM users WHERE is_active ORDER BY full_name`
  );
  res.json(rows);
}));

module.exports = router;
