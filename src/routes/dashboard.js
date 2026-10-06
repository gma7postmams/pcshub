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
const { ACTIVE_MINUTES } = require('./presence');   // "active now" = used the app within this many minutes
// The window the "Workload by day" chart covers (the dropdown at the top right of the Workload Tracker block).
const RANGES = Object.assign(Object.create(null), {   // the order here is the order of the menu (All time first); the default is DEFAULT_RANGE below
  all: { label: 'All time', sub: 'all time' },
  week: { label: 'This week', sub: 'past week and the week ahead' },
  month: { label: 'This month', sub: 'the whole month' },
  last30: { label: 'Last 30 days', sub: 'the last 30 days' },
  next30: { label: 'Next 30 days', sub: 'the next 30 days' },
});
const DEFAULT_RANGE = 'week';   // what people see until they choose something else
const rangeKey = (q) => (RANGES[q] ? q : DEFAULT_RANGE);
const BUCKET_NAME = { day: 'day', week: 'week', month: 'month', year: 'year' };

/**
 * The chart's bars for a range: [{ day, last, n }] where `day`..`last` is what a bar covers (one day, a week, a month or a year) and n the
 * items in it. Fixed windows are one bar per day. "All time" runs from the first to the last day that has any work and picks the bar size so the
 * chart stays readable: up to ~6 weeks of history -> per day, up to ~7 months -> per week, up to ~5 years -> per month, longer -> per year.
 */
async function workloadDays(range) {
  if (range !== 'all') {
    const start = { week: 'CURRENT_DATE - 6', month: `date_trunc('month', CURRENT_DATE)::date`, last30: 'CURRENT_DATE - 29', next30: 'CURRENT_DATE' }[range];
    const end = { week: 'CURRENT_DATE + 7', month: `(date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date`, last30: 'CURRENT_DATE', next30: 'CURRENT_DATE + 29' }[range];
    const { rows } = await db.query(
      `SELECT d::date AS day, d::date AS last, count(w.id)::int AS n
         FROM generate_series(${start}, ${end}, interval '1 day') d
         LEFT JOIN workload_items w ON w.work_date = d::date
        GROUP BY d ORDER BY d`
    );
    return { rows, bucket: 'day' };
  }
  // from the first to the last day that has work — and always through today, so the chart shows where "now" is even when every item is in the past or the future
  const { rows: [span] } = await db.query(
    `SELECT least(min(work_date), CURRENT_DATE) AS first, greatest(max(work_date), CURRENT_DATE) AS last,
            (greatest(max(work_date), CURRENT_DATE) - least(min(work_date), CURRENT_DATE) + 1) AS days, count(*)::int AS items
       FROM workload_items`
  );
  if (!span || !span.items) return { rows: [], bucket: 'day' };
  const bucket = span.days <= 45 ? 'day' : span.days <= 210 ? 'week' : span.days <= 1830 ? 'month' : 'year';
  const step = { day: '1 day', week: '7 days', month: '1 month', year: '1 year' }[bucket];
  const trunc = { day: 'day', week: 'week', month: 'month', year: 'year' }[bucket];   // weeks start on Monday
  const { rows } = await db.query(
    `SELECT b::date AS day, (b + interval '${step}' - interval '1 day')::date AS last, count(w.id)::int AS n
       FROM generate_series(date_trunc('${trunc}', $1::date), date_trunc('${trunc}', $2::date), interval '${step}') b
       LEFT JOIN workload_items w ON w.work_date >= b::date AND w.work_date < (b + interval '${step}')::date
      GROUP BY b ORDER BY b`, [span.first, span.last]
  );
  return { rows, bucket };
}
const rangeSub = (range, bucket) => (range === 'all' ? `all time · one bar per ${BUCKET_NAME[bucket]}` : RANGES[range].sub);

const unitsFor = (team) => Object.entries(UNIT_TEAMS).filter(([, teams]) => teams.includes(team)).map(([u]) => u);

// Who is working in the app right now, and who was earlier in the last 24 hours. Used by the full dashboard and, on its own, by the
// light GET /api/dashboard/users the page polls every few seconds so people's locations stay current.
async function activeUsers(u) {
  const { rows } = await db.query(
    `SELECT p.user_id AS id, COALESCE(NULLIF(btrim(u.full_name), ''), u.username) AS name, u.role, p.page, p.last_active_at,
            (p.last_active_at >= now() - ($1 || ' minutes')::interval) AS active
       FROM user_presence p JOIN users u ON u.id = p.user_id
      WHERE u.is_active AND p.last_active_at >= now() - interval '24 hours'
      ORDER BY p.last_active_at DESC LIMIT 60`, [String(ACTIVE_MINUTES)]
  );
  const row = (r) => ({ id: r.id, name: r.name, role: r.role, page: r.page && PAGE_BY_PATH[r.page] ? PAGE_BY_PATH[r.page].label : null, path: r.page && PAGE_BY_PATH[r.page] ? r.page : null, lastActiveAt: r.last_active_at, you: r.id === u.id });
  return { windowMinutes: ACTIVE_MINUTES, active: rows.filter((r) => r.active).map(row), earlier: rows.filter((r) => !r.active).slice(0, 12).map(row) };
}

// ---- Recent Activity ----
// The latest things people did in the hub, taken from the audit log. Each kind of action belongs to a page, and a person only sees the
// actions for pages their group can open, so the card never shows work they have no access to.
const ACTIVITY = Object.assign(Object.create(null), {
  'ingest.create':            { page: '/ingest',   hue: 'blue',   verb: 'added a new ingest record', kind: 'ingest' },
  'ingest.update':            { page: '/ingest',   hue: 'blue',   verb: 'updated ingest record', kind: 'ingest' },
  'ingest.cm_done':           { page: '/ingest',   hue: 'blue',   verb: 'marked compliant', kind: 'ingest' },
  'ingest.cm_non_compliant':  { page: '/ingest',   hue: 'blue',   verb: 'marked non-compliant', kind: 'ingest' },
  'ingest.delete':            { page: '/ingest',   hue: 'blue',   verb: 'deleted ingest record', kind: 'ingest' },
  'workload.create':          { page: '/workload', hue: 'purple', verb: 'added workload item', kind: 'workload' },
  'workload.update':          { page: '/workload', hue: 'purple', verb: 'updated workload item', kind: 'workload' },
  'workload.delete':          { page: '/workload', hue: 'purple', verb: 'deleted workload item', kind: 'workload' },
  'workload.plug_add':        { page: '/plug-list', hue: 'amber', verb: 'added to the PSD Daily Plug List', kind: 'plug' },
  'workload.plug_edit':       { page: '/plug-list', hue: 'amber', verb: 'edited the PSD Daily Plug List', kind: 'plug' },
  'workload.plug_delete':     { page: '/plug-list', hue: 'amber', verb: 'removed from the PSD Daily Plug List', kind: 'plug' },
  'knowledge.upload':         { page: '/knowledge', hue: 'teal',  verb: 'uploaded', kind: 'doc' },
  'knowledge.rename':         { page: '/knowledge', hue: 'teal',  verb: 'renamed', kind: 'doc' },
  'knowledge.delete':         { page: '/knowledge', hue: 'teal',  verb: 'deleted', kind: 'doc' },
});
const ACTIVITY_SHOWN = 5;

async function recentActivity(u) {
  const actions = Object.keys(ACTIVITY).filter((a) => canPage(u, ACTIVITY[a].page));
  if (!actions.length) return null;
  // join keys are compared as text, so a non-numeric entity_id on some other kind of row can never make the cast fail
  const { rows } = await db.query(
    `SELECT x.id, x.user_id, x.action, x.entity_id, x.details, x.created_at,
            COALESCE(NULLIF(btrim(u.full_name), ''), x.username, 'Someone') AS name,
            COALESCE(i.program, w.prog_name, x.details->>'program', x.details->>'prog_name', x.details->>'title', x.details->>'filename') AS label
       FROM (SELECT a.*, CASE WHEN a.entity = 'approval_request' THEN a.details->>'ingest_record_id'
                              WHEN a.entity = 'ingest_record' THEN a.entity_id END AS ingest_key
               FROM audit_logs a WHERE a.action = ANY($1) ORDER BY a.created_at DESC, a.id DESC LIMIT 60) x
       LEFT JOIN users u ON u.id = x.user_id
       LEFT JOIN ingest_records i ON i.id::text = x.ingest_key
       LEFT JOIN workload_items w ON x.entity = 'workload_item' AND w.id::text = x.entity_id
      ORDER BY x.created_at DESC, x.id DESC`, [actions]
  );
  // a burst of edits to the same thing by the same person (typing into cells) is one line, not ten
  const seen = new Set();
  const items = [];
  for (const r of rows) {
    const k = `${r.user_id}|${r.action}|${r.entity_id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const a = ACTIVITY[r.action];
    items.push({ id: r.id, name: r.name, verb: a.verb, label: r.label || null, hue: a.hue, path: a.page, at: r.created_at, you: r.user_id === u.id });
    if (items.length >= ACTIVITY_SHOWN) break;
  }
  return items;
}

// Just the chart's days for another range (the dropdown), without recomputing the whole dashboard.
router.get('/days', asyncH(async (req, res) => {
  if (!canPage(req.user, '/workload')) return res.status(403).json({ error: 'No access to the Workload Tracker' });
  const range = rangeKey(req.query.range);
  res.set('Cache-Control', 'no-store');
  const { rows, bucket } = await workloadDays(range);
  res.json({ range, label: RANGES[range].label, sub: rangeSub(range, bucket), bucket, days: rows });
}));

router.get('/users', asyncH(async (req, res) => {
  if (!canSection(req.user, 'dashboard.users')) return res.status(403).json({ error: 'Active users is not enabled for your group' });
  res.set('Cache-Control', 'no-store');
  res.json({ users: await activeUsers(req.user) });
}));

router.get('/', asyncH(async (req, res) => {
  const u = req.user;
  const out = {
    sections: { kpis: canSection(u, 'dashboard.kpis'), users: canSection(u, 'dashboard.users') },
    canOpen: {
      ingest: canPage(u, '/ingest'),
      workload: canPage(u, '/workload'),
      plugs: canPage(u, '/plug-list'),
    },
    kpis: null,
    users: null,
    activity: null,
    workload: null,
    today: (await db.query('SELECT CURRENT_DATE AS d')).rows[0].d,
  };

  // ---- Ingest Tracker ----
  if (out.sections.kpis) {
    const [counts, month] = await Promise.all([
      db.query(`SELECT COALESCE(cm_status, 'Pending') AS status, count(*)::int AS n FROM ingest_records GROUP BY 1`),
      db.query(`SELECT count(*)::int AS created, count(*) FILTER (WHERE cm_status='DONE')::int AS done
                  FROM ingest_records WHERE created_at >= date_trunc('month', now())`),
    ]);
    out.kpis = {
      total: counts.rows.reduce((a, r) => a + r.n, 0),
      byStatus: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
      thisMonth: month.rows[0],
    };
  }
  // ---- Active users ----
  if (out.sections.users) out.users = await activeUsers(u);
  // ---- Recent Activity ----
  out.activity = await recentActivity(u);

  // ---- Workload Tracker ----
  if (out.canOpen.workload) {
    const range = rangeKey(req.query.range);
    const [totals, units, byDay] = await Promise.all([
      db.query(`SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE work_date = CURRENT_DATE)::int AS today,
                       count(*) FILTER (WHERE work_date >= date_trunc('week', CURRENT_DATE)::date
                                          AND work_date <  date_trunc('week', CURRENT_DATE)::date + 7)::int AS this_week,
                       count(*) FILTER (WHERE is_priority)::int AS priority
                  FROM workload_items`),
      db.query(`SELECT units_concerned AS u, count(*)::int AS n FROM workload_items WHERE units_concerned IS NOT NULL GROUP BY 1`),
      workloadDays(range),
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
      byTeam, byDay: byDay.rows, bucket: byDay.bucket, range, rangeLabel: RANGES[range].label, rangeSub: rangeSub(range, byDay.bucket), ranges: Object.entries(RANGES).map(([k, v]) => ({ key: k, label: v.label })),
    };
  }

  res.json(out);
}));

module.exports = router;
