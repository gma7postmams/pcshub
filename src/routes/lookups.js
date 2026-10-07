const express = require('express');
const db = require('../db');
const { asyncH, HttpError } = require('../middleware');
const { canPage } = require('../permissions');

const router = express.Router();

// Which page each dropdown category belongs to. A user only gets the values for pages their group can open.
const CATEGORY_PAGE = Object.assign(Object.create(null), {
  program: ['/ingest', '/workload', '/plugs'],
  platform: '/ingest',
  workload_platform: '/workload',
  plug_type: '/workload',
});

// Active dropdown values: GET /api/dropdowns?categories=platform,plug_type
router.get('/dropdowns', asyncH(async (req, res) => {
  const cats = [...new Set(String(req.query.categories || req.query.category || '')
    .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10))];
  if (!cats.length) throw new HttpError(400, 'category is required');
  if (cats.some((c) => !CATEGORY_PAGE[c])) throw new HttpError(400, 'Unknown category');
  if (cats.some((c) => ![].concat(CATEGORY_PAGE[c]).some((pg) => canPage(req.user, pg)))) throw new HttpError(403, 'Not permitted');
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

module.exports = router;
