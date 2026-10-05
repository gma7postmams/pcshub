const express = require('express');
const db = require('../db');
const { asyncH } = require('../middleware');
const { canPage, canSection, PAGE_BY_PATH } = require('../permissions');
const { UNIT_TEAMS } = require('./workload').helpers;

const router = express.Router();

// Each dashboard block is only computed and returned if the user may see it:
//   kpis               -> the Dashboard section "Ingest KPIs" granted to their group
//   users              -> the Dashboard section "Active users" granted to their group
//   workload           -> they can open the Workload Tracker
const ACTIVE_MINUTES = 5;   // "active now" = used the app within this many minutes (see src/routes/presence.js)
const unitsFor = (team) => Object.entries(UNIT_TEAMS).filter(([, teams]) => teams.includes(team)).map(([u]) => u);

router.get('/', asyncH(async (req, res) => {
  const u = req.user;
  const out = {
    sections: { kpis: canSection(u, 'dashboard.kpis'), users: canSection(u, 'dashboard.users') },
    canOpen: {
      ingest: canPage(u, '/ingest'),
      approval: canPage(u, '/approval'),
      reports: canPage(u, '/reports'),
      workload: canPage(u, '/workload'),
    },
    kpis: null,
    users: null,
    workload: null,
    today: (await db.query('SELECT CURRENT_DATE AS d')).rows[0].d,
  };

  // ---- Ingest & Approval ----
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
  // ---- Active users: who is working in the app right now, and who was earlier in the last 24 hours ----
  if (out.sections.users) {
    const { rows } = await db.query(
      `SELECT p.user_id AS id, COALESCE(NULLIF(btrim(u.full_name), ''), u.username) AS name, u.role, p.page, p.last_active_at,
              (p.last_active_at >= now() - ($1 || ' minutes')::interval) AS active
         FROM user_presence p JOIN users u ON u.id = p.user_id
        WHERE u.is_active AND p.last_active_at >= now() - interval '24 hours'
        ORDER BY p.last_active_at DESC LIMIT 60`, [String(ACTIVE_MINUTES)]
    );
    const row = (r) => ({ id: r.id, name: r.name, role: r.role, page: r.page && PAGE_BY_PATH[r.page] ? PAGE_BY_PATH[r.page].label : null, lastActiveAt: r.last_active_at, you: r.id === u.id });
    out.users = { windowMinutes: ACTIVE_MINUTES, active: rows.filter((r) => r.active).map(row), earlier: rows.filter((r) => !r.active).slice(0, 12).map(row) };
  }

  // ---- Workload Tracker ----
  if (out.canOpen.workload) {
    const [totals, units, byDay] = await Promise.all([
      db.query(`SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE work_date = CURRENT_DATE)::int AS today,
                       count(*) FILTER (WHERE work_date >= date_trunc('week', CURRENT_DATE)::date
                                          AND work_date <  date_trunc('week', CURRENT_DATE)::date + 7)::int AS this_week,
                       count(*) FILTER (WHERE is_priority)::int AS priority
                  FROM workload_items`),
      db.query(`SELECT units_concerned AS u, count(*)::int AS n FROM workload_items WHERE units_concerned IS NOT NULL GROUP BY 1`),
      // the week behind and the week ahead, so a quiet or busy stretch is visible at a glance
      db.query(`SELECT d::date AS day, count(w.id)::int AS n
                  FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE + 7, interval '1 day') d
                  LEFT JOIN workload_items w ON w.work_date = d::date
                 GROUP BY d ORDER BY d`),
    ]);
    // rows per team (a VGFX/VEDIT row counts for both teams)
    const byTeam = { VGFX: 0, VEDIT: 0, AUDIO: 0 };
    units.rows.forEach((r) => (UNIT_TEAMS[r.u] || []).forEach((t) => { byTeam[t] += r.n; }));
    const nextWeek = (await db.query(
      `SELECT count(*)::int AS n FROM (
         SELECT breakdate_vgfx AS at FROM workload_items WHERE breakdate_vgfx >= LOCALTIMESTAMP AND breakdate_vgfx < LOCALTIMESTAMP + interval '7 days' AND units_concerned = ANY($1)
         UNION ALL
         SELECT breakdate_vedit FROM workload_items WHERE breakdate_vedit >= LOCALTIMESTAMP AND breakdate_vedit < LOCALTIMESTAMP + interval '7 days' AND units_concerned = ANY($2)
       ) x`, [unitsFor('VGFX'), unitsFor('VEDIT')])).rows[0].n;
    const t = totals.rows[0];
    out.workload = {
      total: t.total, today: t.today, thisWeek: t.this_week, priority: t.priority, breakdatesNext7Days: nextWeek,
      byTeam, byDay: byDay.rows,
    };
  }

  res.json(out);
}));

module.exports = router;
