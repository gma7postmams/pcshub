const express = require('express');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError, requireAction } = require('../middleware');
const { can } = require('../permissions');
const { audit } = require('../audit');
const { notifyUsers, notifyCapable } = require('../notify');

const router = express.Router();

// Status is the CM decision: blank (Pending) until a CM user picks DONE or NON-COMPLIANT.
const CM_STATUSES = ['DONE', 'NON-COMPLIANT'];

const SELECT = `
  SELECT i.*, n.no, ru.full_name AS requested_by_name, cu.full_name AS created_by_name,
         uu.full_name AS updated_by_name, cmu.full_name AS cm_decided_by_name
    FROM ingest_records i
    -- NO.: the record's place in the whole list in the order the table shows it (newest first): the newest is 1 and the numbers count UP down the
    -- table. It is worked out from what exists now, so it renumbers by itself when a record is deleted, and it does not change with filters or search.
    LEFT JOIN (SELECT id, (row_number() OVER (ORDER BY created_at DESC, id DESC))::int AS no FROM ingest_records) n ON n.id = i.id
    LEFT JOIN users ru ON ru.id = i.requested_by_user_id
    LEFT JOIN users cu ON cu.id = i.created_by
    LEFT JOIN users uu ON uu.id = i.updated_by
    LEFT JOIN users cmu ON cmu.id = i.cm_decided_by`;

// Episode / Breakdate: one date (YYYY-MM-DD) or a range (YYYY-MM-DD/YYYY-MM-DD, start first). Returns the text as stored and its first day.
function episodeRange(x) {
  const raw = x == null ? '' : String(x).trim();
  const m = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(raw);
  if (!m) { const d = v.date(raw, { field: 'Episode / Breakdate' }); return { text: d, start: d }; }
  const a = v.date(m[1], { field: 'Episode / Breakdate (from)' });
  const b = v.date(m[2], { field: 'Episode / Breakdate (to)' });
  if (b < a) throw new HttpError(400, 'Episode / Breakdate: the end date is before the start date');
  return { text: a === b ? a : `${a}/${b}`, start: a };
}

async function assertDropdown(client, category, value, field) {
  const { rows } = await client.query(
    'SELECT 1 FROM dropdown_options WHERE category=$1 AND value=$2 AND is_active', [category, value]
  );
  if (!rows.length) throw new HttpError(400, `${field} "${value}" is not a valid option`);
}

async function parseBody(client, body, user, current = null) {
  const hasEpisodeText = Object.prototype.hasOwnProperty.call(body, 'episode_break_date_text');
  let episode_break_date_text;
  let episode_date;
  if (hasEpisodeText) {
    // Date picker: only a real calendar date (YYYY-MM-DD) or empty is accepted from the form.
    const ep = episodeRange(body.episode_break_date_text);
    episode_date = ep.start;
    episode_break_date_text = ep.text;
  } else {
    const hasLegacyDate = Object.prototype.hasOwnProperty.call(body, 'episode_date');
    const legacyDate = v.date(body.episode_date, { field: 'Episode date' });
    if (current && (!hasLegacyDate || legacyDate === current.episode_date_iso)) {
      // Older clients send the full form; preserve free-text values when its legacy date is unchanged.
      episode_break_date_text = current.episode_break_date_text;
      episode_date = current.episode_date;
    } else {
      episode_date = legacyDate;
      episode_break_date_text = legacyDate;
    }
  }
  const rec = {
    program: v.str(body.program, { field: 'Program', max: 200, required: true }),
    billable_party: v.str(body.billable_party, { field: 'Billable Party', max: 200 }),
    platform: v.str(body.platform, { field: 'Platform', max: 100, required: true }),
    episode_date,
    episode_break_date_text,
    materials_count: v.int(body.materials_count, { field: 'Materials count', min: 0 }),
    source: v.str(body.source, { field: 'Source', max: 500 }),
    // Destination Folder and Approved By are filled in by PCS / OCS (action ingest.approve); for anyone else the stored value is kept.
    destination_folder: can(user, 'ingest.approve')
      ? v.str(body.destination_folder, { field: 'Destination Folder', max: 1000 })
      : (current ? current.destination_folder : null),
    // Approved By is never typed in: it is set only by the Approve button (POST /:id/approve) from the signed-in approver.
    approved_by: current ? current.approved_by : null,
    // Requested By is never taken from the client: it is the signed-in user who creates the request
    // (kept as-is when someone else later edits it; legacy rows with no requester fall back to the editor).
    requested_by_user_id: current && (current.requested_by_user_id || current.requested_by_psd) ? current.requested_by_user_id : user.id,
    requested_by_psd: current && (current.requested_by_user_id || current.requested_by_psd) ? current.requested_by_psd : user.full_name,
    remarks: v.str(body.remarks, { field: 'Remarks', max: 4000 }),
  };
  await assertDropdown(client, 'platform', rec.platform, 'Platform');
  return rec;
}

// Sortable columns (query ?sort=<key>&dir=asc|desc). Text sorts case-insensitively; empty values always go last.
const SORTS = {
  program: 'lower(i.program)', platform: 'lower(i.platform)', billable_party: 'lower(i.billable_party)',
  episode_break_date_text: 'i.episode_date', source: 'lower(i.source)', materials_count: 'i.materials_count',
  requested_by: "lower(COALESCE(NULLIF(i.requested_by_psd, ''), ru.full_name))", destination_folder: 'lower(i.destination_folder)',
  approved_by: 'lower(i.approved_by)', cm_status: 'i.cm_status', updated: 'i.updated_at',
};
function orderBy(q) {
  const col = Object.prototype.hasOwnProperty.call(SORTS, q.sort) ? SORTS[q.sort] : null;
  if (!col) return 'i.created_at DESC, i.id DESC';
  return `${col} ${q.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, i.created_at DESC, i.id DESC`;
}

// ---- audit helpers ----
const AUDITED = ['program', 'billable_party', 'platform', 'episode_break_date_text', 'materials_count', 'source', 'destination_folder', 'remarks'];
const same = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);
/** { field: { from, to } } for every audited field whose value differs */
function changesOf(before, after) {
  const out = {};
  for (const f of AUDITED) if (!same(before[f], after[f])) out[f] = { from: before[f] == null ? null : before[f], to: after[f] == null ? null : after[f] };
  return out;
}
/** A refused action (record locked by CM, delete not allowed) is logged too. Runs outside the failed transaction so the entry survives its rollback. */
async function auditBlocked(req, action, id, details) {
  await audit(req, action, 'ingest_record', id, details).catch(() => {});
}

/** WHERE for the list and the Excel export (same filters, same search). */
function ingestFilter(q) {
  const req = { query: q };
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.status && CM_STATUSES.includes(req.query.status)) add('i.cm_status = ?', req.query.status);
  else if (/^pending$/i.test(String(req.query.status || ''))) where.push('i.cm_status IS NULL');
  // approval=pending: nobody has approved it yet; approval=approved: it has an approver (the same test the approve route uses)
  if (/^pending$/i.test(String(req.query.approval || ''))) where.push(`(i.approved_at IS NULL AND COALESCE(btrim(i.approved_by), '') = '')`);
  else if (/^approved$/i.test(String(req.query.approval || ''))) where.push(`(i.approved_at IS NOT NULL OR COALESCE(btrim(i.approved_by), '') <> '')`);
  if (req.query.program) add('i.program = ?', String(req.query.program));
  if (req.query.platform) add('i.platform = ?', String(req.query.platform));
  // a range counts when it overlaps the filter: it ends on/after "from" and starts on/before "to"
  const epEnd = `COALESCE(CASE WHEN i.episode_break_date_text ~ '^\\d{4}-\\d{2}-\\d{2}/\\d{4}-\\d{2}-\\d{2}$' THEN split_part(i.episode_break_date_text, '/', 2)::date END, i.episode_date)`;
  if (req.query.from) add(`${epEnd} >= ?`, v.date(req.query.from, { field: 'from' }));
  if (req.query.to) add('i.episode_date <= ?', v.date(req.query.to, { field: 'to' }));
  if (req.query.q) {
    params.push(v.like(req.query.q, 100));
    const p = `$${params.length}`;
    where.push(`(i.program ILIKE ${p} OR i.billable_party ILIKE ${p} OR i.episode_break_date_text ILIKE ${p}
                 OR i.source ILIKE ${p} OR i.destination_folder ILIKE ${p} OR i.approved_by ILIKE ${p}
                 OR i.remarks ILIKE ${p} OR i.requested_by_psd ILIKE ${p} OR ru.full_name ILIKE ${p})`);
  }
  return { where, params, whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

router.get('/', asyncH(async (req, res) => {
  const { params, whereSql } = ingestFilter(req.query);
  const { limit, offset } = v.paging(req.query, { def: 50, max: 200 });
  const countQ = await db.query(
    `SELECT count(*)::int AS n FROM ingest_records i LEFT JOIN users ru ON ru.id=i.requested_by_user_id ${whereSql}`, params
  );
  const { rows } = await db.query(
    `${SELECT} ${whereSql} ORDER BY ${orderBy(req.query)} LIMIT ${limit} OFFSET ${offset}`, params
  );
  res.json({ total: countQ.rows[0].n, rows });
}));

// Excel export of what the list shows: same filters, search and sort. Logged in the audit trail.
router.get('/export', asyncH(async (req, res) => {
  const ExcelJS = require('exceljs');
  const { params, whereSql } = ingestFilter(req.query);
  const { rows } = await db.query(`${SELECT} ${whereSql} ORDER BY ${orderBy(req.query)} LIMIT 20000`, params);
  const dayText = (r) => {
    const t = r.episode_break_date_text || (r.episode_date ? new Date(r.episode_date).toISOString().slice(0, 10) : '');
    const m = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(t || '');
    return m ? `${m[1]} to ${m[2]}` : (t || '');
  };
  // Styled like the Workload export (and like the web table): tinted header, vertical grid lines, centred cells, bold names, coloured Platform and
  // Status (CM) text (Excel can't give a cell a pill background), the decision / approval time on a second line, nothing cropped.
  const { exportPalette, hueOf } = require('./workload').helpers;
  const pal = await exportPalette(db);
  const grid = { style: 'thin', color: { argb: pal.gridBorder } };
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const nice = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}` : String(iso || ''); };
  const niceDay = (r) => {
    const t = r.episode_break_date_text || (r.episode_date ? new Date(r.episode_date).toISOString().slice(0, 10) : '');
    const m = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(t || '');
    return m ? `${nice(m[1])} – ${nice(m[2])}` : (/^\d{4}-\d{2}-\d{2}/.test(t || '') ? nice(t) : (t || ''));
  };
  const niceTime = (ts) => { if (!ts) return ''; const d = new Date(ts); const h = d.getHours(); return `${nice(d.toISOString())} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
  const CM_HUE = { DONE: 'green', 'NON-COMPLIANT': 'red', PENDING: 'amber' };
  const grey = { color: { argb: pal.pillFg('gray') }, size: 9 };
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PromoHub';
  const ws = wb.addWorksheet('Ingest');
  const COLS = [
    { header: 'PROG. NAME / PROJ. TITLE', key: 'program' }, { header: 'Platform', key: 'platform' },
    { header: 'Billable Party', key: 'billable_party' }, { header: 'Episode / Breakdate', key: 'ep' },
    { header: 'Source', key: 'source', wrap: true }, { header: 'No. of Materials', key: 'materials_count' },
    { header: 'Requested By', key: 'req' }, { header: 'Destination Folder', key: 'destination_folder', wrap: true },
    { header: 'Approved By', key: 'approved_by' }, { header: 'Status (CM)', key: 'cm' }, { header: 'Updated', key: 'updated' },
  ];
  ws.columns = COLS.map((c) => ({ header: c.header, key: c.key, width: 20 }));
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: pal.black }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pal.headerFill } };
    cell.border = { bottom: grid, right: grid };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  const lens = COLS.map((c) => c.header.length);
  const seen = (key, text) => { const i = COLS.findIndex((c) => c.key === key); String(text || '').split('\n').forEach((t) => { lens[i] = Math.max(lens[i], t.length); }); };
  for (const r of rows) {
    const status = r.cm_status || 'PENDING';
    const row = ws.addRow({
      program: r.program, platform: r.platform, billable_party: r.billable_party, ep: niceDay(r), source: r.source,
      materials_count: r.materials_count, req: r.requested_by_psd || r.requested_by_name || '', destination_folder: r.destination_folder,
      approved_by: r.approved_by, cm: status, updated: r.updated_at ? new Date(r.updated_at).toISOString().replace('T', ' ').slice(0, 16) : '',
    });
    row.alignment = { wrapText: false, vertical: 'middle', horizontal: 'center' };
    COLS.forEach((c) => { row.getCell(c.key).border = { right: grid }; if (c.wrap) row.getCell(c.key).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; });
    row.getCell('program').font = { bold: true };
    if (r.platform) { const fam = r.platform.replace(/\s*\(.*\)\s*$/, '') || r.platform; row.getCell('platform').font = { bold: true, color: { argb: pal.pillFg(hueOf(fam)) } }; }
    if (r.destination_folder) row.getCell('destination_folder').font = { name: 'Consolas' };
    // Status (CM): the decision in its colour, then when / by whom it was decided, then the non-compliant reason (like the web cell)
    const lines = [{ text: status, font: { bold: true, color: { argb: pal.pillFg(CM_HUE[status] || 'amber') } } }];
    if (r.cm_status) {
      const when = `${niceTime(r.cm_decided_at)}${r.cm_decided_by_name ? ` · ${r.cm_decided_by_name}` : ''}`;
      if (when.trim()) lines.push({ text: `\n${when}`, font: grey });
      if (r.cm_status === 'NON-COMPLIANT' && r.cm_non_compliant_reason) lines.push({ text: `\n${r.cm_non_compliant_reason}`, font: grey });
    }
    row.getCell('cm').value = { richText: lines };
    row.getCell('cm').alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    if (r.approved_by) {
      const t = niceTime(r.approved_at);
      row.getCell('approved_by').value = { richText: [{ text: r.approved_by, font: { color: { argb: pal.black } } }, ...(t ? [{ text: `\n${t}`, font: grey }] : [])] };
      row.getCell('approved_by').alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    }
    row.getCell('updated').font = { color: { argb: pal.pillFg('gray') } };
    seen('program', r.program); seen('platform', r.platform); seen('billable_party', r.billable_party); seen('ep', niceDay(r));
    seen('source', r.source && r.source.length > 45 ? 'x'.repeat(45) : r.source); seen('materials_count', r.materials_count);
    seen('req', r.requested_by_psd || r.requested_by_name || ''); seen('destination_folder', r.destination_folder && r.destination_folder.length > 45 ? 'x'.repeat(45) : r.destination_folder);
    seen('approved_by', `${r.approved_by || ''}\n${r.approved_by ? niceTime(r.approved_at) : ''}`);
    seen('cm', `${status}\n${r.cm_status ? `${niceTime(r.cm_decided_at)}${r.cm_decided_by_name ? ` · ${r.cm_decided_by_name}` : ''}` : ''}`);
    seen('updated', 'YYYY-MM-DD HH:MM');
  }
  ws.columns.forEach((column, i) => { column.width = Math.ceil(lens[i] * 1.15) + 3; });   // wide enough that nothing is cropped (long Source / Folder text wraps)
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } };
  const buffer = await wb.xlsx.writeBuffer();
  const filename = `Ingest_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await audit(req, 'ingest.export', 'ingest_record', null, { rows: rows.length, truncated: rows.length >= 20000, filters: { ...req.query, sort: undefined, dir: undefined }, file: filename });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.send(Buffer.from(buffer));
}));

// ---- Import from Excel: reads a file shaped like this page's own Export (header row; the same column names). Every row becomes a NEW request from the person
// importing (Requested By is always them, Approved By and Status (CM) start empty, exactly as for a request added in the table). Columns this page
// doesn't take from a file (Requested By, Approved By, Status (CM), Updated) are ignored. A row that is already in the list (same program, platform,
// Billable Party, Source and Episode / Breakdate) is left out, so importing the same file twice doesn't double the list. Destination Folder is
// only read for PCS / OCS, like everywhere else.
const multer = require('multer');
const { assertSafeXlsx, oneImportAtATime } = require('../xlsx-guard');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const IMPORT_HEADERS = {
  'prog. name / proj. title': 'program', 'program': 'program', 'prog name/proj title': 'program',
  'platform': 'platform', 'billable party': 'billable_party', 'episode / breakdate': 'episode_break_date_text',
  'source': 'source', 'no. of materials': 'materials_count', 'destination folder': 'destination_folder', 'remarks': 'remarks',
};
const MON_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const iso3 = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function oneDay(part) {   // "2026-10-10", "Oct 10, 2026", "10/10/2026" or an Excel date
  if (part instanceof Date) return part.toISOString().slice(0, 10);
  const t = String(part).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return iso3(m[1], m[2], m[3]);
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  const mon = m && (MON_NUM[m[1].slice(0, 4).toLowerCase()] || MON_NUM[m[1].slice(0, 3).toLowerCase()]);
  if (m && mon) return iso3(m[3], mon, m[2]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return iso3(m[3], m[1], m[2]);
  throw new HttpError(400, `Episode / Breakdate "${t}" is not a date`);
}
function episodeFromCell(val) {   // one date, or "start – end" / "start to end" / "start/end" → what the table stores
  if (val == null || val === '') return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const parts = String(val).split(/\s+(?:–|—|-|to)\s+|\//).map((x) => x.trim()).filter(Boolean);
  if (parts.length === 1) return oneDay(parts[0]);
  if (parts.length === 2) return `${oneDay(parts[0])}/${oneDay(parts[1])}`;
  throw new HttpError(400, `Episode / Breakdate "${String(val).trim()}" is not a date or a date range`);
}
router.post('/import', requireAction('ingest.write'), upload.single('file'), oneImportAtATime, asyncH(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  await assertSafeXlsx(req.file.buffer, req.file.originalname);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.file.buffer); } catch (e) { throw new HttpError(400, 'Could not read that file as an Excel workbook (.xlsx)'); }
  const text = (c) => { const x = c && c.value; if (x == null) return ''; if (x instanceof Date) return x; if (x.richText) return x.richText.map((t) => t.text).join(''); if (typeof x === 'object' && x.text != null) return String(x.text); return typeof x === 'number' ? x : String(x); };
  const recs = [];
  for (const ws of wb.worksheets) {
    if (!ws || ws.rowCount < 2) continue;
    const colKey = {};
    ws.getRow(1).eachCell((cell, n) => { const k = IMPORT_HEADERS[String(text(cell)).trim().toLowerCase()]; if (k) colKey[n] = k; });
    if (!Object.values(colKey).includes('program')) continue;   // not an ingest sheet
    for (let r = 2; r <= ws.rowCount && recs.length < 2000; r++) {
      const row = ws.getRow(r);
      const o = { __row: r, __sheet: ws.name };
      let any = false;
      for (const [n, k] of Object.entries(colKey)) { const val = text(row.getCell(Number(n))); if (val !== '' && val != null) { o[k] = val; any = true; } }
      if (any) recs.push(o);
    }
  }
  if (!recs.length) throw new HttpError(400, 'Nothing recognisable to import — expected the column headings this page\'s own Export has (PROG. NAME / PROJ. TITLE, Platform, Billable Party, Episode / Breakdate, …).');
  let created = 0; let existing = 0;
  const errors = [];
  await db.tx(async (c) => {
    const have = new Set((await c.query(`SELECT program, platform, COALESCE(billable_party, '') AS bp, COALESCE(source, '') AS src, COALESCE(episode_break_date_text, '') AS ep FROM ingest_records`)).rows
      .map((x) => [x.program, x.platform, x.bp, x.src, x.ep].join('\u0001')));
    for (const o of recs) {
      try {
        const body = {
          program: String(o.program ?? ''), platform: String(o.platform ?? ''), billable_party: String(o.billable_party ?? ''), source: String(o.source ?? ''),
          episode_break_date_text: episodeFromCell(o.episode_break_date_text),
          materials_count: o.materials_count === undefined || o.materials_count === '' ? null : o.materials_count,
          destination_folder: String(o.destination_folder ?? ''), remarks: String(o.remarks ?? ''),
        };
        const r = await parseBody(c, body, req.user);
        const key = [r.program, r.platform, r.billable_party || '', r.source || '', r.episode_break_date_text || ''].join('\u0001');
        if (have.has(key)) { existing++; continue; }   // compared with what was already there, not with earlier rows of this file
        const { rows } = await c.query(
          `INSERT INTO ingest_records (program, billable_party, platform, episode_date, episode_break_date_text, materials_count, source, destination_folder,
             approved_by, requested_by_user_id, requested_by_psd, remarks, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id`,
          [r.program, r.billable_party, r.platform, r.episode_date, r.episode_break_date_text, r.materials_count, r.source, r.destination_folder,
            r.approved_by, r.requested_by_user_id, r.requested_by_psd, r.remarks, req.user.id]
        );
        await audit(req, 'ingest.create', 'ingest_record', rows[0].id, { ...r, imported: true }, c);
        created++;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        errors.push(`Row ${o.__row}${o.program ? ` (${String(o.program).slice(0, 40)})` : ''}: ${e.message}`);
      }
    }
  });
  await audit(req, 'ingest.import', 'ingest_record', null, { file: req.file.originalname, rows: recs.length, created, existing, skipped: errors.length });
  res.json({ ok: true, created, existing, skipped: errors.length, errors: errors.slice(0, 20) });
}));

router.get('/:id', asyncH(async (req, res) => {
  const { rows } = await db.query(`${SELECT} WHERE i.id=$1`, [v.id(req.params.id)]);
  if (!rows.length) throw new HttpError(404, 'Ingest record not found');
  res.json(rows[0]);
}));

// Create — Requested By is always the signed-in user
router.post('/', requireAction('ingest.write'), asyncH(async (req, res) => {
  const created = await db.tx(async (c) => {
    const r = await parseBody(c, req.body, req.user);
    const { rows } = await c.query(
      `INSERT INTO ingest_records (program, billable_party, platform, episode_date, episode_break_date_text,
         materials_count, source, destination_folder, approved_by, requested_by_user_id, requested_by_psd, remarks,
         created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id`,
      [r.program, r.billable_party, r.platform, r.episode_date, r.episode_break_date_text,
        r.materials_count, r.source, r.destination_folder, r.approved_by, r.requested_by_user_id,
        r.requested_by_psd, r.remarks, req.user.id]
    );
    await audit(req, 'ingest.create', 'ingest_record', rows[0].id, r, c);
    await notifyCapable('ingest.approve', {
      title: `New ingest: ${r.program}`,
      body: `${req.user.full_name} added a new ingest request (${r.platform}). Destination Folder and Approved By are waiting.`,
      link: `/ingest?id=${rows[0].id}`,
    }, { excludeUserId: req.user.id }, c);
    return rows[0];
  });
  res.status(201).json({ ok: true, id: created.id });
}));

// Who should hear about a change to a record: whoever created it, the person who requested it, and whoever approved it — never the person making the change.
function interested(r, actorId) {
  return [r.created_by, r.requested_by_user_id, r.approved_by_user_id].filter((uid) => uid && uid !== actorId);
}

router.put('/:id', requireAction('ingest.write'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  let blocked = null;
  try {
  await db.tx(async (c) => {
    const cur = await c.query(
      `SELECT cm_status, episode_date, to_char(episode_date, 'YYYY-MM-DD') AS episode_date_iso,
              episode_break_date_text, destination_folder, approved_by, requested_by_user_id, requested_by_psd,
              program, billable_party, platform, materials_count, source, remarks
         FROM ingest_records WHERE id=$1 FOR UPDATE`, [id]
    );
    if (!cur.rows.length) throw new HttpError(404, 'Ingest record not found');
    if (cur.rows[0].cm_status && !can(req.user, 'ingest.cm_complete')) {
      blocked = { cm_status: cur.rows[0].cm_status, program: cur.rows[0].program };
      throw new HttpError(409, `Record is marked ${cur.rows[0].cm_status} and can no longer be edited`);
    }
    const r = await parseBody(c, req.body, req.user, cur.rows[0]);
    await c.query(
      `UPDATE ingest_records SET program=$2, billable_party=$3, platform=$4, episode_date=$5,
         episode_break_date_text=$6, materials_count=$7, source=$8, destination_folder=$9, approved_by=$10,
         requested_by_user_id=$11, requested_by_psd=$12, remarks=$13, updated_by=$14, updated_at=now()
       WHERE id=$1`,
      [id, r.program, r.billable_party, r.platform, r.episode_date, r.episode_break_date_text,
        r.materials_count, r.source, r.destination_folder, r.approved_by, r.requested_by_user_id,
        r.requested_by_psd, r.remarks, req.user.id]
    );
    const changes = changesOf(cur.rows[0], r);
    if (Object.keys(changes).length) await audit(req, 'ingest.update', 'ingest_record', id, { program: r.program, changes }, c);
  });
  } catch (e) {
    if (blocked) await auditBlocked(req, 'ingest.edit_blocked', id, { ...blocked, reason: e.message });
    throw e;
  }
  res.json({ ok: true });
}));

// Click-to-edit one cell in the table (the same idea as the Workload Tracker): PATCH { field, value } writes only that column, so other people's
// edits to the rest of the row are kept. Requested By is deliberately not here: it is always the signed-in person who created the request.
const CELL_FIELDS = {
  program: (x) => v.str(x, { field: 'Program', max: 200, required: true }),
  platform: (x) => v.str(x, { field: 'Platform', max: 100, required: true }),
  billable_party: (x) => v.str(x, { field: 'Billable Party', max: 200 }),
  episode_break_date_text: (x) => episodeRange(x),
  source: (x) => v.str(x, { field: 'Source', max: 500 }),
  materials_count: (x) => v.int(x, { field: 'Materials count', min: 0 }),
  destination_folder: (x) => v.str(x, { field: 'Destination Folder', max: 1000 }),   // PCS / OCS only (below)
  remarks: (x) => v.str(x, { field: 'Remarks', max: 4000 }),
};

router.patch('/:id', requireAction('ingest.write'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const field = String((req.body && req.body.field) || '');
  if (!Object.prototype.hasOwnProperty.call(CELL_FIELDS, field)) throw new HttpError(400, 'That column cannot be edited here');
  if (field === 'destination_folder' && !can(req.user, 'ingest.approve')) {
    throw new HttpError(403, 'Only PCS / OCS can fill in the Destination Folder');
  }
  const value = CELL_FIELDS[field](req.body.value);
  let blocked = null;
  let row;
  try {
  row = await db.tx(async (c) => {
    const cur = await c.query('SELECT cm_status, program, billable_party, platform, episode_break_date_text, materials_count, source, destination_folder, remarks FROM ingest_records WHERE id=$1 FOR UPDATE', [id]);
    if (!cur.rows.length) throw new HttpError(404, 'Ingest record not found');
    if (cur.rows[0].cm_status && !can(req.user, 'ingest.cm_complete')) {
      blocked = { cm_status: cur.rows[0].cm_status, program: cur.rows[0].program, field };
      throw new HttpError(409, `Record is marked ${cur.rows[0].cm_status} and can no longer be edited`);
    }
    if (field === 'platform') await assertDropdown(c, 'platform', value, 'Platform');
    // `field` is one of the fixed keys above (never user text), so it is safe to name the column here
    if (field === 'episode_break_date_text') {
      await c.query('UPDATE ingest_records SET episode_date=$2, episode_break_date_text=$3, updated_by=$4, updated_at=now() WHERE id=$1', [id, value.start, value.text, req.user.id]);   // separate params: one column is a date, the other text
    } else {
      await c.query(`UPDATE ingest_records SET ${field}=$2, updated_by=$3, updated_at=now() WHERE id=$1`, [id, value, req.user.id]);
    }
    const newVal = field === 'episode_break_date_text' ? value.text : value;
    const changes = changesOf(cur.rows[0], { [field]: newVal });
    delete changes.__none;
    const only = {}; if (changes[field]) only[field] = changes[field];
    if (Object.keys(only).length) await audit(req, 'ingest.update', 'ingest_record', id, { program: cur.rows[0].program, changes: only, via: 'table cell' }, c);
    const out = await c.query(`${SELECT} WHERE i.id=$1`, [id]);
    return out.rows[0];
  });
  } catch (e) {
    if (blocked) await auditBlocked(req, 'ingest.edit_blocked', id, { ...blocked, reason: e.message });
    throw e;
  }
  res.json({ ok: true, row });
}));

// Approve: final, like the CM decision. Approved By and the time are set from whoever is signed in and presses the button — never typed in.
// The Destination Folder (filled in by PCS / OCS) must be there first. Audit-logged; the requester and creator are notified.
router.post('/:id/approve', requireAction('ingest.approve'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  await db.tx(async (c) => {
    const cur = await c.query(
      `SELECT id, program, platform, destination_folder, approved_by, approved_at, created_by, requested_by_user_id
         FROM ingest_records WHERE id=$1 FOR UPDATE`, [id]
    );
    const r = cur.rows[0];
    if (!r) throw new HttpError(404, 'Ingest record not found');
    if (r.approved_at || (r.approved_by && String(r.approved_by).trim())) throw new HttpError(409, 'This record is already approved');
    if (!r.destination_folder || !String(r.destination_folder).trim()) throw new HttpError(400, 'Fill in the Destination Folder before approving');
    await c.query(
      `UPDATE ingest_records SET approved_by=$2, approved_by_user_id=$3, approved_at=now(), updated_by=$3, updated_at=now() WHERE id=$1`,
      [id, req.user.full_name, req.user.id]
    );
    await audit(req, 'ingest.approve', 'ingest_record', id, { approved_by: req.user.full_name }, c);
    await notifyUsers(interested(r, req.user.id), {
      title: `Ingest approved: ${r.program}`,
      body: `${req.user.full_name} approved this ingest request`,
      link: `/ingest?id=${id}`,
    }, c);
    // Approval is what puts the request in front of CM, so the people who set the CM Status need to know it is ready.
    await notifyCapable('ingest.cm_complete', {
      title: `Ready for CM: ${r.program}`,
      body: `${req.user.full_name} approved an ingest request${r.platform ? ` (${r.platform})` : ''}. It is waiting for the CM Status.`,
      link: `/ingest?id=${id}`,
    }, { excludeUserId: req.user.id }, c);
  });
  res.json({ ok: true });
}));

// Undo an approval (a mistaken click): the record goes back to not approved and can be approved again. Audit-logged.
router.post('/:id/unapprove', requireAction('ingest.approve'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  await db.tx(async (c) => {
    const cur = await c.query('SELECT program, approved_by, approved_by_user_id, approved_at, created_by, requested_by_user_id FROM ingest_records WHERE id=$1 FOR UPDATE', [id]);
    const r = cur.rows[0];
    if (!r) throw new HttpError(404, 'Ingest record not found');
    if (!r.approved_at && !(r.approved_by && String(r.approved_by).trim())) return;   // nothing to undo
    await c.query('UPDATE ingest_records SET approved_by=NULL, approved_by_user_id=NULL, approved_at=NULL, updated_by=$2, updated_at=now() WHERE id=$1', [id, req.user.id]);
    await audit(req, 'ingest.unapprove', 'ingest_record', id, { previous: r.approved_by }, c);
    await notifyUsers(interested(r, req.user.id), {
      title: `Approval withdrawn: ${r.program}`,
      body: `${req.user.full_name} withdrew the approval of this ingest request`,
      link: `/ingest?id=${id}`,
    }, c);
  });
  res.json({ ok: true });
}));

// Status (CM): DONE or NON-COMPLIANT (with a reason), changeable later, or back to Pending after a mistaken click. Every change is audit-logged with who and when.
router.post('/:id/cm-decision', requireAction('ingest.cm_complete'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const decision = v.oneOf(req.body.decision, [...CM_STATUSES, 'Pending'], { field: 'CM decision' });
  const reason = v.str(req.body.reason, { field: 'Non-compliant reason', max: 2000 });
  if (decision === 'NON-COMPLIANT' && !reason) throw new HttpError(400, 'A reason is required for NON-COMPLIANT');

  if (decision === 'Pending') {   // clear the decision: back to Pending, with no decider, time or reason
    await db.tx(async (c) => {
      const cur = await c.query('SELECT cm_status, program, created_by, requested_by_user_id, approved_by_user_id FROM ingest_records WHERE id=$1 FOR UPDATE', [id]);
      if (!cur.rows.length) throw new HttpError(404, 'Ingest record not found');
      if (!cur.rows[0].cm_status) return;
      await c.query(
        `UPDATE ingest_records SET cm_status=NULL, cm_decided_by=NULL, cm_decided_at=NULL, cm_non_compliant_reason=NULL,
                updated_by=$2, updated_at=now() WHERE id=$1`, [id, req.user.id]
      );
      await audit(req, 'ingest.cm_reset', 'ingest_record', id, { previous: cur.rows[0].cm_status }, c);
      await notifyUsers(interested(cur.rows[0], req.user.id), {
        title: `Ingest back to Pending: ${cur.rows[0].program}`,
        body: `${req.user.full_name} cleared the CM Status (was ${cur.rows[0].cm_status})`,
        link: `/ingest?id=${id}`,
      }, c);
    });
    return res.json({ ok: true, status: 'Pending' });
  }

  await db.tx(async (c) => {
    const cur = await c.query(
      `SELECT id, cm_status, cm_non_compliant_reason, program, created_by, requested_by_user_id, approved_by_user_id
         FROM ingest_records WHERE id=$1 FOR UPDATE`, [id]
    );
    const r = cur.rows[0];
    if (!r) throw new HttpError(404, 'Ingest record not found');
    const newReason = decision === 'NON-COMPLIANT' ? reason : null;
    if (r.cm_status === decision && r.cm_non_compliant_reason === newReason) return;   // nothing changed: no new timestamp

    await c.query(
      `UPDATE ingest_records
          SET cm_status=$2, cm_decided_by=$3, cm_decided_at=now(), cm_non_compliant_reason=$4,
              updated_by=$3, updated_at=now()
        WHERE id=$1`,
      [id, decision, req.user.id, newReason]
    );
    await audit(req, decision === 'DONE' ? 'ingest.cm_done' : 'ingest.cm_non_compliant',
      'ingest_record', id, { decision, reason: newReason, previous: r.cm_status }, c);

    const reasonSuffix = decision === 'NON-COMPLIANT' ? ` — ${reason}` : '';
    await notifyUsers(interested(r, req.user.id), {
      title: `Ingest ${decision}: ${r.program}`,
      body: `${req.user.full_name} marked this ingest request ${decision}${reasonSuffix}`,
      link: `/ingest?id=${id}`,
    }, c);
  });
  res.json({ ok: true, status: decision });
}));

// A request with a CM decision is kept as a historical record — except that an Admin may delete one that is DONE (NON-COMPLIANT ones stay).
function deleteBlock(cm, user) {
  if (!cm || (cm === 'DONE' && user && user.role === 'Admin')) return null;
  return cm === 'DONE' ? 'Only an Admin can delete a request that is DONE in CM' : 'CM-completed requests are preserved as historical records';
}

router.delete('/:id', requireAction('ingest.delete'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  let blocked = null;
  try {
  await db.tx(async (c) => {
    const cur = await c.query('SELECT program, cm_status FROM ingest_records WHERE id=$1 FOR UPDATE', [id]);
    if (!cur.rows.length) throw new HttpError(404, 'Ingest record not found');
    const block = deleteBlock(cur.rows[0].cm_status, req.user);
    if (block) { blocked = { ...cur.rows[0], reason: block }; throw new HttpError(409, block); }
    await c.query('DELETE FROM ingest_records WHERE id=$1', [id]);
    await audit(req, 'ingest.delete', 'ingest_record', id, cur.rows[0], c);
  });
  } catch (e) {
    if (blocked) await auditBlocked(req, 'ingest.delete_blocked', id, blocked);
    throw e;
  }
  res.json({ ok: true });
}));

// Batch delete: removes every selected record that may be deleted and reports the ones that were kept (same rules as above).
router.post('/delete', requireAction('ingest.delete'), asyncH(async (req, res) => {
  const raw = req.body && req.body.ids;
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Choose at least one record');
  if (raw.length > 500) throw new HttpError(400, 'Delete at most 500 records at a time');
  const ids = [...new Set(raw.map((x) => v.id(x)))];
  const out = await db.tx(async (c) => {
    const { rows } = await c.query('SELECT id, program, cm_status FROM ingest_records WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
    const ok = rows.filter((r) => !deleteBlock(r.cm_status, req.user));
    const kept = rows.length - ok.length;
    if (ok.length) {
      await c.query('DELETE FROM ingest_records WHERE id = ANY($1::int[])', [ok.map((r) => r.id)]);
      for (const r of ok) await audit(req, 'ingest.delete', 'ingest_record', r.id, { program: r.program, cm_status: r.cm_status, batch: true }, c);
    }
    for (const r of rows.filter((x) => deleteBlock(x.cm_status, req.user))) {
      await audit(req, 'ingest.delete_blocked', 'ingest_record', r.id, { program: r.program, cm_status: r.cm_status, reason: deleteBlock(r.cm_status, req.user), batch: true }, c);
    }
    return { deleted: ok.length, kept, missing: ids.length - rows.length };
  });
  res.json({ ok: true, ...out });
}));

module.exports = router;
module.exports.episodeRange = episodeRange;   // exported for the tests
