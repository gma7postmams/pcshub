const express = require('express');
const db = require('../db');
const { asyncH } = require('../middleware');
const { canPage, canSection } = require('../permissions');
const { UNIT_TEAMS } = require('./workload').helpers;

const router = express.Router();

// Each dashboard block is only computed and returned if the user may see it:
//   kpis / recent      -> the Dashboard sections granted to their group (Ingest & Approval)
//   workload           -> they can open the Workload Tracker
//   plugs              -> they can open the PSD Daily Plug List
const unitsFor = (team) => Object.entries(UNIT_TEAMS).filter(([, teams]) => teams.includes(team)).map(([u]) => u);

router.get('/', asyncH(async (req, res) => {
  const u = req.user;
  const out = {
    sections: { kpis: canSection(u, 'dashboard.kpis'), recent: canSection(u, 'dashboard.recent') },
    canOpen: {
      ingest: canPage(u, '/ingest'),
      approval: canPage(u, '/approval'),
      reports: canPage(u, '/reports'),
      workload: canPage(u, '/workload'),
      plugs: canPage(u, '/plug-list'),
    },
    kpis: null,
    recent: null,
    workload: null,
    plugs: null,
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
  if (out.sections.recent) {
    const { rows } = await db.query(
      `SELECT id, program, platform, episode_date, status, updated_at FROM ingest_records ORDER BY updated_at DESC LIMIT 8`
    );
    out.recent = rows;
  }

  // ---- Workload Tracker ----
  if (out.canOpen.workload) {
    const [totals, units, byDay, byPlatform, upcoming, priority, recent] = await Promise.all([
      db.query(`SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE work_date = CURRENT_DATE)::int AS today,
                       count(*) FILTER (WHERE work_date >= date_trunc('week', CURRENT_DATE)::date
                                          AND work_date <  date_trunc('week', CURRENT_DATE)::date + 7)::int AS this_week,
                       count(*) FILTER (WHERE units_concerned IS NULL)::int AS unassigned,
                       count(*) FILTER (WHERE is_priority)::int AS priority
                  FROM workload_items`),
      db.query(`SELECT units_concerned AS u, count(*)::int AS n FROM workload_items WHERE units_concerned IS NOT NULL GROUP BY 1`),
      // the week behind and the week ahead, so a quiet or busy stretch is visible at a glance
      db.query(`SELECT d::date AS day, count(w.id)::int AS n
                  FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE + 7, interval '1 day') d
                  LEFT JOIN workload_items w ON w.work_date = d::date
                 GROUP BY d ORDER BY d`),
      db.query(`SELECT COALESCE(NULLIF(btrim(platform), ''), '(none)') AS k, count(*)::int AS n
                  FROM workload_items GROUP BY 1 ORDER BY n DESC, k LIMIT 6`),
      db.query(`SELECT * FROM (
                  SELECT 'VGFX' AS team, w.breakdate_vgfx AS at, w.id, w.plug_id, w.prog_name, w.psd, w.is_priority
                    FROM workload_items w WHERE w.breakdate_vgfx >= LOCALTIMESTAMP AND w.units_concerned = ANY($1)
                  UNION ALL
                  SELECT 'VEDIT', w.breakdate_vedit, w.id, w.plug_id, w.prog_name, w.psd, w.is_priority
                    FROM workload_items w WHERE w.breakdate_vedit >= LOCALTIMESTAMP AND w.units_concerned = ANY($2)
                ) e ORDER BY at, team LIMIT 8`, [unitsFor('VGFX'), unitsFor('VEDIT')]),
      db.query(`SELECT id, work_date, plug_id, prog_name, psd, units_concerned
                  FROM workload_items WHERE is_priority AND work_date >= CURRENT_DATE - 7
                 ORDER BY work_date, id LIMIT 6`),
      db.query(`SELECT w.id, w.work_date, w.plug_id, w.prog_name, w.units_concerned, w.updated_at, COALESCE(NULLIF(u.full_name, ''), u.username) AS by
                  FROM workload_items w LEFT JOIN users u ON u.id = w.updated_by
                 ORDER BY w.updated_at DESC LIMIT 6`),
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
      total: t.total, today: t.today, thisWeek: t.this_week, unassigned: t.unassigned, priority: t.priority, breakdatesNext7Days: nextWeek,
      byTeam, byDay: byDay.rows, byPlatform: byPlatform.rows, upcoming: upcoming.rows, priorityItems: priority.rows, recent: recent.rows,
    };
  }

  // ---- PSD Daily Plug List ----
  if (out.canOpen.plugs) {
    const [all, focus] = await Promise.all([
      db.query(`SELECT count(*)::int AS plugs, count(DISTINCT plug_date)::int AS days, min(plug_date) AS first, max(plug_date) AS last FROM workload_plugs`),
      // the list day that matters now: today's, else the latest one before today, else the next one coming
      db.query(`WITH pick AS (
                  SELECT COALESCE(
                    (SELECT max(plug_date) FROM workload_plugs WHERE plug_date <= CURRENT_DATE),
                    (SELECT min(plug_date) FROM workload_plugs)) AS d)
                SELECT pick.d AS date,
                       count(p.id)::int AS total,
                       count(p.id) FILTER (WHERE EXISTS (
                         SELECT 1 FROM workload_items w WHERE w.work_date = p.plug_date
                            AND upper(p.plug_id) IN (SELECT upper(btrim(x)) FROM unnest(string_to_array(w.plug_id, E'\\n')) AS x)))::int AS in_workload
                  FROM pick LEFT JOIN workload_plugs p ON p.plug_date = pick.d
                 GROUP BY pick.d`),
    ]);
    const a = all.rows[0];
    const f = focus.rows[0];
    out.plugs = {
      plugs: a.plugs, days: a.days, first: a.first, last: a.last,
      focus: f && f.date ? { date: f.date, total: f.total, inWorkload: f.in_workload } : null,
    };
  }
  res.json(out);
}));

module.exports = router;
