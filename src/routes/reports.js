const express = require('express');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError, requireSection } = require('../middleware');
const { audit } = require('../audit');

const router = express.Router();

function ingestFilters(q) {
  const params = [];
  const where = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  const from = v.date(q.from, { field: 'From' });
  const to = v.date(q.to, { field: 'To' });
  // Date basis: episode date or created date
  const col = q.basis === 'episode' ? 'i.episode_date' : 'i.created_at::date';
  if (from) add(`${col} >= ?`, from);
  if (to) add(`${col} <= ?`, to);
  if (q.program) add('i.program = ?', String(q.program));
  if (q.platform) add('i.platform = ?', String(q.platform));
  if (q.status) add('i.status = ?', String(q.status));
  return { params, whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

router.get('/ingest', requireSection('reports.ingest'), asyncH(async (req, res) => {
  const { params, whereSql } = ingestFilters(req.query);
  const q = (sql) => db.query(sql, params).then((r) => r.rows);
  const [totals, byStatus, byPlatform, byProgram, byMonth, turnaround] = await Promise.all([
    q(`SELECT count(*)::int AS total FROM ingest_records i ${whereSql}`),
    q(`SELECT status AS k, count(*)::int AS n FROM ingest_records i ${whereSql} GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT platform AS k, count(*)::int AS n FROM ingest_records i ${whereSql} GROUP BY 1 ORDER BY 2 DESC`),
    q(`SELECT program AS k, count(*)::int AS n FROM ingest_records i ${whereSql} GROUP BY 1 ORDER BY 2 DESC LIMIT 15`),
    q(`SELECT to_char(date_trunc('month', i.created_at), 'YYYY-MM') AS k, count(*)::int AS n
         FROM ingest_records i ${whereSql} GROUP BY 1 ORDER BY 1 DESC LIMIT 12`),
    q(`SELECT round(avg(extract(epoch FROM ar.decided_at - ar.requested_at))/3600.0, 1)::float AS avg_hours,
              count(*)::int AS decided
         FROM approval_requests ar JOIN ingest_records i ON i.id = ar.ingest_record_id
         ${whereSql ? whereSql + ' AND' : 'WHERE'} ar.decided_at IS NOT NULL`),
  ]);
  res.json({
    total: totals[0].total,
    byStatus, byPlatform, byProgram,
    byMonth: byMonth.reverse(),
    approval: turnaround[0],
  });
}));

function csvCell(val) {
  if (val === null || val === undefined) return '';
  let s = val instanceof Date ? val.toISOString() : String(val);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula-injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/ingest.csv', requireSection('reports.export'), asyncH(async (req, res) => {
  const { params, whereSql } = ingestFilters(req.query);
  const { rows } = await db.query(
    `SELECT i.id, i.program, i.platform, i.episode_date, i.source, i.destination_folder,
            ru.full_name AS requested_by, i.requested_by_psd, i.remarks, i.status,
            cu.full_name AS created_by, i.created_at, i.updated_at
       FROM ingest_records i
       LEFT JOIN users ru ON ru.id = i.requested_by_user_id
       LEFT JOIN users cu ON cu.id = i.created_by
       ${whereSql} ORDER BY i.created_at DESC LIMIT 50000`, params
  );
  const header = ['ID', 'Program', 'Platform', 'Episode Date', 'Source', 'Destination Folder', 'Requested By',
    'Requested By (PSD)', 'Remarks', 'Status', 'Created By', 'Created At', 'Updated At'];
  const keys = ['id', 'program', 'platform', 'episode_date', 'source', 'destination_folder', 'requested_by',
    'requested_by_psd', 'remarks', 'status', 'created_by', 'created_at', 'updated_at'];
  const csv = [header.join(','), ...rows.map((r) => keys.map((k) => csvCell(r[k])).join(','))].join('\r\n');
  await audit(req, 'reports.export_ingest', 'report', null, { format: 'csv', rows: rows.length, truncated: rows.length >= 50000, filters: req.query });
  console.log(`[reports] reports.export_ingest ${JSON.stringify({ user: req.user ? req.user.username : 'unknown', ip: req.ip, rows: rows.length })}`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ingest-report-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + csv);
}));

module.exports = router;
