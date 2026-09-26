const express = require('express');
const db = require('../db');
const { asyncH } = require('../middleware');
const { canPage, canSection } = require('../permissions');

const router = express.Router();

// Each dashboard section is only computed and returned if the user's group grants it.
router.get('/', asyncH(async (req, res) => {
  const u = req.user;
  const out = {
    sections: { kpis: canSection(u, 'dashboard.kpis'), recent: canSection(u, 'dashboard.recent') },
    canOpen: {
      ingest: canPage(u, '/ingest'),
      approval: canPage(u, '/approval'),
      reports: canPage(u, '/reports'),
    },
    kpis: null,
    recent: null,
  };
  if (out.sections.kpis) {
    const [counts, month] = await Promise.all([
      db.query(`SELECT status, count(*)::int AS n FROM ingest_records GROUP BY status`),
      db.query(`SELECT count(*)::int AS created, count(*) FILTER (WHERE status='Approved')::int AS approved
                  FROM ingest_records WHERE created_at >= date_trunc('month', now())`),
    ]);
    out.kpis = {
      total: counts.rows.reduce((a, r) => a + r.n, 0),
      byStatus: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
      thisMonth: month.rows[0],
    };
  }
  if (out.sections.recent) {
    const { rows } = await db.query(
      `SELECT id, program, platform, episode_date, status, updated_at FROM ingest_records ORDER BY updated_at DESC LIMIT 8`
    );
    out.recent = rows;
  }
  res.json(out);
}));

module.exports = router;
