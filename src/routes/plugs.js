// PSD Daily Plug List — its own page (/plug-list) and API (/api/plugs). See the access note in build() below.
//
// The PSD's daily plug list workbook has one sheet per day. Each sheet: a "DATE:" line near the top ("September 28,Monday Plug list"),
// then a table with NO / PLUG ID / PROG NAME/PROJ TITLE / PSD / Account By:. Late additions sit under an "Additional for …" line.
// Import reads every sheet, works out each sheet's date, and adds the plugs (re-importing an updated file only adds what is new).
// The Workload Tracker copies Plug ID, PSD and Prog. Name from this list (see fillFromPlugList in workload.js and the tab in the UI).
const multer = require('multer');
const { assertSafeXlsx, oneImportAtATime } = require('../xlsx-guard');
const db = require('../db');
const v = require('../validate');
const express = require('express');
const { asyncH, HttpError, requireAction, requireAnyPage } = require('../middleware');
const { can } = require('../permissions');
const { audit } = require('../audit');
const { logRun } = require('../transferlog');
const { emitTransfer } = require('../transfer-hook');   // import events — the audit log subscribes to these (see src/transfer-hook.js)

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

const MONTHS = Object.assign(Object.create(null), { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 });
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = (n) => String(n).padStart(2, '0');

/** A cell's value as plain text (rich text, formulas and numbers handled; real dates give '' — callers deal with those). */
function textOf(val) {
  if (val == null) return '';
  if (val.richText) return val.richText.map((t) => t.text).join('');
  if (val instanceof Date) return '';
  if (typeof val === 'object' && val.result !== undefined) return textOf(val.result);
  if (typeof val === 'object' && val.text !== undefined) return textOf(val.text);
  return String(val);
}
/** A Prog. Name cell: Excel turns titles like "23:23" into a time of day, so give those back as HH:MM. */
function titleOf(val) {
  if (val instanceof Date) {
    return val.getUTCFullYear() < 1901 ? `${pad(val.getUTCHours())}:${pad(val.getUTCMinutes())}` : val.toISOString().slice(0, 10);
  }
  return textOf(val).replace(/\s+/g, ' ').trim();
}
function monthDay(text) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})\b/i.exec(String(text || ''));
  return m ? { month: MONTHS[m[1].toLowerCase()], day: Number(m[2]) } : null;
}

/**
 * Reads the whole workbook. Returns { sheets: [{ sheet, date, plugs: [...], skippedNoId, additional }], warnings: [] }.
 * A plug is { seq, list_no, plug_id, prog_name, psd, account_by, is_additional }. Pure (no database), so it can be tested alone.
 */
function parsePlugWorkbook(wb, year) {
  const sheets = [];
  const warnings = [];
  for (const ws of wb.worksheets) {
    if (!ws || ws.rowCount < 2) continue;
    // header row: the one with a "Plug ID" cell (first 15 rows)
    let headerRow = 0;
    const col = {};
    for (let r = 1; r <= Math.min(15, ws.rowCount) && !headerRow; r++) {
      const found = {};
      ws.getRow(r).eachCell((cell, c) => {
        const t = textOf(cell.value).toLowerCase().replace(/[^a-z]/g, '');
        if (t === 'plugid') found.plug = c;
        else if (/^prog.*(name|title)|^proj.*title/.test(t)) found.prog = c;
        else if (t === 'psd') found.psd = c;
        else if (t.startsWith('accountby')) found.acct = c;
        else if (t === 'no') found.no = c;
      });
      if (found.plug) { headerRow = r; Object.assign(col, found); }
    }
    if (!headerRow) { warnings.push(`Sheet "${ws.name}": no PLUG ID column header found, skipped`); continue; }

    // the sheet's date: a "Sept 28,Monday plug list" style line in the first rows, else the sheet's name ("Sept 28")
    let md = null;
    let dayText = '';
    for (let r = 1; r < headerRow && !md; r++) {
      ws.getRow(r).eachCell((cell) => { if (!md) { const t = textOf(cell.value); const hit = monthDay(t); if (hit) { md = hit; dayText = t; } } });
    }
    if (!md) { md = monthDay(ws.name); dayText = ''; }
    let hasData = false;
    for (let r = headerRow + 1; r <= ws.rowCount && !hasData; r++) hasData = !!textOf(ws.getRow(r).getCell(col.plug).value).trim();
    if (!md && !hasData) continue;   // a blank template sheet: nothing to import and nothing to warn about
    if (!md) { warnings.push(`Sheet "${ws.name}": no date found (expected something like "September 28" in the DATE line or the sheet name), skipped`); continue; }
    const probe = new Date(Date.UTC(year, md.month - 1, md.day));
    if (probe.getUTCMonth() !== md.month - 1 || probe.getUTCDate() !== md.day) { warnings.push(`Sheet "${ws.name}": ${md.month}/${md.day} is not a real date, skipped`); continue; }
    const date = `${year}-${pad(md.month)}-${pad(md.day)}`;
    const wk = /,\s*([A-Za-z]{3})/.exec(dayText);
    if (wk && wk[1].toLowerCase() !== WEEKDAYS[probe.getUTCDay()]) {
      warnings.push(`Sheet "${ws.name}": says ${wk[1]} but ${date} is a ${WEEKDAYS[probe.getUTCDay()]} — check the year (${year}) is right`);
    }

    const plugs = [];
    const seen = new Set();
    let additional = false;
    let skippedNoId = 0;
    const cellOf = (row, c) => (c ? row.getCell(c).value : null);
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const plugId = textOf(cellOf(row, col.plug)).replace(/\s+/g, ' ').trim();
      const prog = titleOf(cellOf(row, col.prog));
      const psd = textOf(cellOf(row, col.psd)).replace(/\s+/g, ' ').trim();
      const acct = textOf(cellOf(row, col.acct)).replace(/\s+/g, ' ').trim();
      if (!plugId) { if (prog || psd) skippedNoId++; continue; }
      if (/^additional\b/i.test(plugId) && !prog && !psd) { additional = true; continue; }   // the "Additional for Sept 28" divider
      const key = `${plugId}|${prog}|${psd}`.toUpperCase();
      if (seen.has(key)) continue;   // the same line listed twice
      seen.add(key);
      const no = Number(textOf(cellOf(row, col.no)));
      plugs.push({
        seq: plugs.length + 1, list_no: Number.isInteger(no) && no > 0 ? no : null,
        plug_id: plugId.slice(0, 200), prog_name: prog.slice(0, 300), psd: psd.slice(0, 200), account_by: acct.slice(0, 100), is_additional: additional,
      });
    }
    if (!plugs.length) continue;   // e.g. the blank template sheet
    sheets.push({ sheet: ws.name, date, plugs, skippedNoId, additional: plugs.filter((p) => p.is_additional).length });
  }
  return { sheets, warnings };
}

/**
 * Fills PSD and PROG. NAME / PROJ. TITLE on EXISTING Workload rows that have a Plug ID but those left blank, from the PSD Daily Plug List
 * entry for the same Work Date + Plug ID (first line of the Plug ID cell, any letter case; the first match on that day's list wins).
 * Only blanks are filled — anything already typed stays — and rows in a locked date range are left alone.
 * Optional { from, to } limit it to those dates. Returns how many rows changed.
 */
async function backfillWorkload(runner, { from = null, to = null, userId = null } = {}) {
  const { rowCount } = await runner.query(
    `WITH src AS (
       SELECT DISTINCT ON (plug_date, upper(plug_id)) plug_date, upper(plug_id) AS pid, psd, prog_name
         FROM workload_plugs
        WHERE ($1::date IS NULL OR plug_date >= $1::date) AND ($2::date IS NULL OR plug_date <= $2::date)
        ORDER BY plug_date, upper(plug_id), seq, id)
     UPDATE workload_items w
        SET psd = CASE WHEN btrim(COALESCE(w.psd, '')) = '' AND src.psd <> '' THEN src.psd ELSE w.psd END,
            prog_name = CASE WHEN btrim(COALESCE(w.prog_name, '')) = '' AND src.prog_name <> '' THEN src.prog_name ELSE w.prog_name END,
            updated_by = COALESCE($3::int, w.updated_by), updated_at = now()
       FROM src
      WHERE w.work_date = src.plug_date
        AND upper(btrim(split_part(w.plug_id, E'\n', 1))) = src.pid
        AND ((btrim(COALESCE(w.psd, '')) = '' AND src.psd <> '') OR (btrim(COALESCE(w.prog_name, '')) = '' AND src.prog_name <> ''))
        AND NOT EXISTS (SELECT 1 FROM workload_locks l WHERE w.work_date BETWEEN l.from_date AND l.to_date)`,
    [from, to, userId]
  );
  return rowCount;
}

/** WHERE for the plug list: ?date= (one day), ?from= / ?to= (a period), ?q= (plug ID / program / PSD contains). Returns { where, params }. */
function plugFilter(query) {
  const params = [];
  const where = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (query.date) add('p.plug_date = ?', v.date(query.date, { field: 'Date' }));
  if (query.from) add('p.plug_date >= ?', v.date(query.from, { field: 'From' }));
  if (query.to) add('p.plug_date <= ?', v.date(query.to, { field: 'To' }));
  if (query.q) {
    params.push(v.like(query.q, 80));
    where.push(`(p.plug_id ILIKE $${params.length} OR p.prog_name ILIKE $${params.length} OR p.psd ILIKE $${params.length})`);
  }
  return { where, params };
}
const whereSql = (where) => (where.length ? `WHERE ${where.join(' AND ')}` : '');

module.exports = function build({ UNITS, canonUnit = (x) => x, parseRow, insertRow, loadCustomCols, loadLocks, assertNotLocked }) {
  const router = express.Router();
  // Mounted at /api/plugs. Anyone who can open the PSD Daily Plug List page OR the Workload Tracker may read the list (the tracker
  // uses it to fill PSD / PROG. NAME); changing it needs the plugs.write action (Manager / Admin + the Plug List page), and the two
  // operations that create or change Workload rows (copy, fill) also need workload.write.
  router.use(requireAnyPage(['/plug-list', '/workload']));
  // Ids are 32-bit in the database: an out-of-range number is simply a plug that does not exist.
  router.param('id', (req, res, next, raw) => {
    try { req.params.id = v.id(raw); } catch (e) { return res.status(404).json({ error: 'Plug not found' }); }
    return next();
  });
  // ---- which days have a list ----
  router.get('/dates', asyncH(async (req, res) => {
    const { rows } = await db.query('SELECT plug_date AS date, count(*)::int AS n FROM workload_plugs GROUP BY plug_date ORDER BY plug_date DESC LIMIT 366');
    const all = (await db.query('SELECT count(*)::int AS plugs, count(DISTINCT plug_date)::int AS days, min(plug_date) AS first, max(plug_date) AS last FROM workload_plugs')).rows[0];
    res.json({ dates: rows, total: all.plugs, days: all.days, first: all.first, last: all.last });
  }));

  // ---- list: ?date=YYYY-MM-DD, or ?from=&to=, optional ?q= and ?used=1 (adds in_workload: is it already in the Workload Tracker) ----
  router.get('/', asyncH(async (req, res) => {
    const { where, params } = plugFilter(req.query);
    const used = req.query.used === '1'
      ? `, EXISTS (SELECT 1 FROM workload_items w WHERE w.work_date = p.plug_date
           AND upper(p.plug_id) IN (SELECT upper(btrim(x)) FROM unnest(string_to_array(w.plug_id, E'\\n')) AS x)) AS in_workload`
      : '';
    const { limit, offset } = v.paging(req.query, { def: 3000, max: 5000 });
    let order = req.query.order === 'desc' ? 'p.plug_date DESC, p.seq, p.id' : 'p.plug_date, p.seq, p.id';   // newest day first, or oldest first; list order within a day
    // a clicked column header (?sort=&dir=) sorts the whole result, text case-insensitively, empty values last
    const SORTS = { plug_date: 'p.plug_date', plug_id: 'lower(p.plug_id)', prog_name: 'lower(p.prog_name)', psd: 'lower(p.psd)', account_by: 'lower(p.account_by)' };
    if (used) SORTS.in_workload = 'in_workload';
    if (Object.prototype.hasOwnProperty.call(SORTS, req.query.sort)) {
      order = `${SORTS[req.query.sort]} ${req.query.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, p.plug_date, p.seq, p.id`;
    }
    const total = (await db.query(`SELECT count(*)::int AS n FROM workload_plugs p ${whereSql(where)}`, params)).rows[0].n;
    const { rows } = await db.query(
      `SELECT p.id, p.plug_date, p.seq, p.list_no, p.plug_id, p.prog_name, p.psd, p.account_by, p.is_additional${used}
         FROM workload_plugs p ${whereSql(where)} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params
    );
    res.json({ rows, total });
  }));

  // ---- Excel export of what the list shows (same filters, search and sort); logged in the audit trail ----
  router.get('/export', asyncH(async (req, res) => {
    const ExcelJS = require('exceljs');
    const { where, params } = plugFilter(req.query);
    const SORTS = { plug_date: 'p.plug_date', plug_id: 'lower(p.plug_id)', prog_name: 'lower(p.prog_name)', psd: 'lower(p.psd)', account_by: 'lower(p.account_by)' };
    const order = Object.prototype.hasOwnProperty.call(SORTS, req.query.sort)
      ? `${SORTS[req.query.sort]} ${req.query.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, p.plug_date, p.seq, p.id`
      : (req.query.order === 'desc' ? 'p.plug_date DESC, p.seq, p.id' : 'p.plug_date, p.seq, p.id');
    const { rows } = await db.query(
      `SELECT p.plug_date, p.plug_id, p.prog_name, p.psd, p.account_by, p.is_additional,
              EXISTS (SELECT 1 FROM workload_items w WHERE w.work_date = p.plug_date
                 AND upper(p.plug_id) IN (SELECT upper(btrim(x)) FROM unnest(string_to_array(w.plug_id, E'\n')) AS x)) AS in_workload
         FROM workload_plugs p ${whereSql(where)} ORDER BY ${order} LIMIT 20000`, params
    );
    const wb = new ExcelJS.Workbook();
    wb.creator = 'PromoHub';
    const ws = wb.addWorksheet('PSD Daily Plug List');
    ws.columns = [
      { header: 'DATE', key: 'd', width: 14 }, { header: 'PLUG ID', key: 'plug_id', width: 18 },
      { header: 'PROG. NAME / PROJ. TITLE', key: 'prog_name', width: 40 }, { header: 'PSD', key: 'psd', width: 20 },
      { header: 'ACCOUNT BY', key: 'account_by', width: 16 }, { header: 'IN WORKLOAD', key: 'in_workload', width: 14 },
    ];
    for (const r of rows) {
      ws.addRow({ d: r.plug_date instanceof Date ? r.plug_date.toISOString().slice(0, 10) : String(r.plug_date).slice(0, 10), plug_id: r.plug_id + (r.is_additional ? ' (additional)' : ''), prog_name: r.prog_name, psd: r.psd, account_by: r.account_by, in_workload: r.in_workload ? 'Yes' : 'No' });
    }
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } };
    const buffer = await wb.xlsx.writeBuffer();
    const filename = `PSD_Plug_List_${new Date().toISOString().slice(0, 10)}.xlsx`;
    await audit(req, 'workload.plugs_export', 'workload_plug', null, { rows: rows.length, truncated: rows.length >= 20000, filters: { date: req.query.date, from: req.query.from, to: req.query.to, q: req.query.q }, file: filename });
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(Buffer.from(buffer));
  }));

  // ---- import the PSD's daily plug list workbook ----
  router.post('/import', requireAction('plugs.write'), upload.single('file'), oneImportAtATime, asyncH(async (req, res) => {
    const t0 = Date.now();
    const info = { target: 'plug list', file: req.file ? req.file.originalname : null, bytes: req.file ? req.file.size : 0 };
    try {
      if (!req.file) throw new HttpError(400, 'No file uploaded');
      let ExcelJS;
      try { ExcelJS = require('exceljs'); } catch (e) {
        throw new HttpError(501, 'Import needs the "exceljs" package. Run "npm install" on the server, then restart.');
      }
      await assertSafeXlsx(req.file.buffer, req.file.originalname);   // file type + unpacked-size limits, before anything is loaded into memory
      const wb = new ExcelJS.Workbook();
      try { await wb.xlsx.load(req.file.buffer); } catch (e) { throw new HttpError(400, 'Could not read that file as an Excel workbook (.xlsx)'); }
      // the list has no year in it: use the one typed in, else a year in the file name ("September_2026_Plug_List"), else this year
      const typed = parseInt(req.body && req.body.year, 10);
      const inName = /(?<!\d)(20\d{2})(?!\d)/.exec(req.file.originalname || '');   // not \b: "September_2026_Plug_List" has no word boundary around the year
      const year = typed || (inName ? Number(inName[1]) : new Date().getFullYear());
      if (year < 2000 || year > 2100) throw new HttpError(400, 'Year must be between 2000 and 2100');
      info.year = year;

      const { sheets, warnings } = parsePlugWorkbook(wb, year);
      if (!sheets.length) {
        throw new HttpError(400, 'No plugs found — expected one sheet per day with the columns NO, PLUG ID, PROG NAME/PROJ TITLE, PSD, Account By '
          + `and a date such as "September 28" in the DATE line or the sheet name.${warnings.length ? ` (${warnings[0]})` : ''}`);
      }
      const result = [];
      await db.tx(async (c) => {
        for (const sh of sheets) {
          const p = sh.plugs;
          const { rows } = await c.query(
            `INSERT INTO workload_plugs (plug_date, seq, list_no, plug_id, prog_name, psd, account_by, is_additional, source_file, created_by)
             SELECT $1::date, t.seq, t.list_no, t.plug_id, t.prog_name, t.psd, t.account_by, t.addl, $2, $3
               FROM unnest($4::int[], $5::int[], $6::text[], $7::text[], $8::text[], $9::text[], $10::bool[]) AS t(seq, list_no, plug_id, prog_name, psd, account_by, addl)
             ON CONFLICT (plug_date, plug_id, prog_name, psd)
             DO UPDATE SET seq = EXCLUDED.seq, list_no = EXCLUDED.list_no, account_by = EXCLUDED.account_by,
                           is_additional = EXCLUDED.is_additional, source_file = EXCLUDED.source_file, updated_at = now()
             RETURNING (xmax = 0) AS inserted`,
            [sh.date, req.file.originalname || null, req.user.id, p.map((x) => x.seq), p.map((x) => x.list_no), p.map((x) => x.plug_id),
              p.map((x) => x.prog_name), p.map((x) => x.psd), p.map((x) => x.account_by), p.map((x) => x.is_additional)]
          );
          const added = rows.filter((r) => r.inserted).length;
          result.push({ sheet: sh.sheet, date: sh.date, plugs: p.length, added, existing: p.length - added, additional: sh.additional, skipped: sh.skippedNoId });
        }
      });
      const filled = await backfillWorkload(db, { from: result[0].date, to: result[result.length - 1].date, userId: req.user.id });   // rows already in the tracker with blank PSD / Prog. Name
      const copied = await autoCopy(req, 'p.plug_date = ANY($1::date[])', [result.map((r) => r.date)]);   // new plugs go straight into the Workload Tracker
      const total = result.reduce((o, s) => ({ plugs: o.plugs + s.plugs, added: o.added + s.added, skipped: o.skipped + s.skipped }), { plugs: 0, added: 0, skipped: 0 });
      await emitTransfer(req, 'workload.plugs_import', { ...info, days: result.length, from: result[0].date, to: result[result.length - 1].date, ...total, workloadRowsFilled: filled, copiedToWorkload: copied ? copied.created : null, warnings: warnings.slice(0, 20), ms: Date.now() - t0 });
      res.json({ ok: true, year, days: result.length, workloadRowsFilled: filled, copied, ...total, existing: total.plugs - total.added, sheets: result, warnings: warnings.slice(0, 20) });
    } catch (e) {
      await emitTransfer(req, 'workload.plugs_import_failed', { ...info, error: e && e.message ? e.message : String(e), ms: Date.now() - t0 });
      throw e;
    }
  }));

  // ---- add / edit / delete a single plug by hand ----
  const plugBody = (body) => ({
    plug_date: v.date(body.plug_date, { field: 'Date', required: true }),
    plug_id: (v.str(body.plug_id, { field: 'Plug ID', max: 200, required: true }) || '').replace(/\s+/g, ' ').trim(),
    prog_name: v.str(body.prog_name, { field: 'PROG. NAME / PROJ. TITLE', max: 300 }) || '',
    psd: v.str(body.psd, { field: 'PSD', max: 200 }) || '',
    account_by: v.str(body.account_by, { field: 'Account By', max: 100 }) || '',
  });
  const dupe = (e) => { if (e && e.code === '23505') throw new HttpError(409, 'That plug (same Plug ID, program and PSD) is already on this day\'s list'); throw e; };

  const checkProg = async (name, current) => {
    if (!name || name === current) return;
    const { rows } = await db.query("SELECT 1 FROM dropdown_options WHERE category='program' AND value=$1 AND is_active", [name]);
    if (!rows.length) throw new HttpError(400, `PROG. NAME / PROJ. TITLE "${name}" is not a valid option`);
  };

  router.post('/', requireAction('plugs.write'), asyncH(async (req, res) => {
    const b = plugBody(req.body || {});
    await checkProg(b.prog_name, null);
    let row;
    try {
      ({ rows: [row] } = await db.query(
        `INSERT INTO workload_plugs (plug_date, seq, plug_id, prog_name, psd, account_by, source_file, created_by)
         VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM workload_plugs WHERE plug_date = $1), $2, $3, $4, $5, 'added by hand', $6) RETURNING id`,
        [b.plug_date, b.plug_id, b.prog_name, b.psd, b.account_by, req.user.id]
      ));
    } catch (e) { dupe(e); }
    await audit(req, 'workload.plug_add', 'workload_plug', row.id, { plug_date: b.plug_date, plug_id: b.plug_id });
    const filled = await backfillWorkload(db, { from: b.plug_date, to: b.plug_date, userId: req.user.id });
    const copied = await autoCopy(req, 'p.id = $1', [row.id]);
    res.status(201).json({ id: row.id, workloadRowsFilled: filled, copied });
  }));

  // Excel mode: save a whole grid at once — rows with an id are updated, rows without are added; all or nothing (an error names the grid row).
  const MAX_BATCH = 500;
  router.post('/batch', requireAction('plugs.write'), asyncH(async (req, res) => {
    const list = req.body && req.body.rows;
    if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'No rows to save');
    if (list.length > MAX_BATCH) throw new HttpError(400, `Save at most ${MAX_BATCH} rows at a time`);
    const out = await db.tx(async (c) => {
      const addedIds = [];
      const days = new Set();
      let updated = 0;
      for (let i = 0; i < list.length; i++) {
        const row = list[i] || {};
        try {
          const b = plugBody(row);
          days.add(b.plug_date);
          if (row.id) {
            const id = v.id(row.id);
            const cur = await c.query('SELECT prog_name FROM workload_plugs WHERE id=$1 FOR UPDATE', [id]);
            if (!cur.rows.length) throw new HttpError(404, 'Plug no longer exists (deleted by someone else?)');
            await checkProg(b.prog_name, cur.rows[0].prog_name);
            await c.query('UPDATE workload_plugs SET plug_date=$2, plug_id=$3, prog_name=$4, psd=$5, account_by=$6, updated_at=now() WHERE id=$1',
              [id, b.plug_date, b.plug_id, b.prog_name, b.psd, b.account_by]);
            await audit(req, 'workload.plug_edit', 'workload_plug', id, { plug_date: b.plug_date, plug_id: b.plug_id }, c);
            updated++;
          } else {
            await checkProg(b.prog_name, null);
            const ins = await c.query(
              `INSERT INTO workload_plugs (plug_date, seq, plug_id, prog_name, psd, account_by, source_file, created_by)
               VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM workload_plugs WHERE plug_date = $1), $2, $3, $4, $5, 'added by hand', $6) RETURNING id`,
              [b.plug_date, b.plug_id, b.prog_name, b.psd, b.account_by, req.user.id]);
            await audit(req, 'workload.plug_add', 'workload_plug', ins.rows[0].id, { plug_date: b.plug_date, plug_id: b.plug_id }, c);
            addedIds.push(ins.rows[0].id);
          }
        } catch (e) {
          if (e && e.code === '23505') throw new HttpError(409, `Row ${i + 1}: that plug (same Plug ID, program and PSD) is already on this day's list`);
          if (e instanceof HttpError) throw new HttpError(e.status, `Row ${i + 1}: ${e.message}`);
          throw e;
        }
      }
      return { added: addedIds.length, updated, addedIds, days: [...days].sort() };
    });
    const filled = await backfillWorkload(db, { from: out.days[0], to: out.days[out.days.length - 1], userId: req.user.id });
    const copied = out.addedIds.length ? await autoCopy(req, 'p.id = ANY($1::bigint[])', [out.addedIds]) : null;
    res.json({ ok: true, added: out.added, updated: out.updated, workloadRowsFilled: filled, copied });
  }));

  router.put('/:id(\\d+)', requireAction('plugs.write'), asyncH(async (req, res) => {
    const b = plugBody(req.body || {});
    const cur = await db.query('SELECT prog_name FROM workload_plugs WHERE id=$1', [req.params.id]);
    await checkProg(b.prog_name, cur.rows[0] && cur.rows[0].prog_name);
    try {
      const r = await db.query(
        `UPDATE workload_plugs SET plug_date=$2, plug_id=$3, prog_name=$4, psd=$5, account_by=$6, updated_at=now() WHERE id=$1`,
        [req.params.id, b.plug_date, b.plug_id, b.prog_name, b.psd, b.account_by]
      );
      if (!r.rowCount) throw new HttpError(404, 'Plug not found');
    } catch (e) { dupe(e); }
    await audit(req, 'workload.plug_edit', 'workload_plug', req.params.id, { plug_date: b.plug_date, plug_id: b.plug_id });
    const filled = await backfillWorkload(db, { from: b.plug_date, to: b.plug_date, userId: req.user.id });
    res.json({ ok: true, workloadRowsFilled: filled });
  }));

  router.delete('/:id(\\d+)', requireAction('plugs.write'), asyncH(async (req, res) => {
    const { rows } = await db.query('DELETE FROM workload_plugs WHERE id=$1 RETURNING plug_date, plug_id', [req.params.id]);
    if (!rows.length) throw new HttpError(404, 'Plug not found');
    await audit(req, 'workload.plug_delete', 'workload_plug', req.params.id, rows[0]);
    res.json({ ok: true });
  }));

  // ---- fill blank PSD / PROG. NAME / PROJ. TITLE on rows already in the Workload Tracker (optional { from, to }) ----
  router.post('/fill', requireAction('workload.write'), asyncH(async (req, res) => {
    const body = req.body || {};
    const from = body.from ? v.date(body.from, { field: 'From' }) : null;
    const to = body.to ? v.date(body.to, { field: 'To' }) : null;
    const filled = await backfillWorkload(db, { from, to, userId: req.user.id });
    await logRun(req, 'workload.plugs_fill', { from, to, rowsFilled: filled });
    res.json({ ok: true, filled });
  }));

  // ---- delete all: the selected day's list, or every day's (Admin only). Workload rows already made from plugs are not touched. ----
  router.post('/delete-all', requireAction('plugs.write'), asyncH(async (req, res) => {
    if (!req.user || req.user.role !== 'Admin') throw new HttpError(403, 'Only an Admin can delete the whole plug list');
    const body = req.body || {};
    const scope = body.scope === 'all' ? 'all' : 'range';   // 'range' = what a view shows: ?from / ?to / ?q (a single day is from = to)
    let filters = null;
    let result;
    if (scope === 'all') result = await db.query('DELETE FROM workload_plugs');
    else {
      filters = { from: body.from || body.date || undefined, to: body.to || body.date || undefined, q: body.q || undefined };
      if (!filters.from && !filters.to && !filters.q) throw new HttpError(400, 'Choose a period or search to delete, or delete everything');
      const { where, params } = plugFilter(filters);
      result = await db.query(`DELETE FROM workload_plugs p ${whereSql(where)}`, params);
    }
    await logRun(req, 'workload.plugs_delete_all', { scope, filters, deleted: result.rowCount });
    res.json({ ok: true, deleted: result.rowCount });
  }));

  // ---- copy a day's plugs (or the chosen ones) into the Workload Tracker: one new row per plug not already there ----
  // The shared core of "Copy to Workload": one new Workload row per plug that isn't there yet for that day (Plug ID matched in any letter case, also
  // inside a multi-line Plug ID cell). Days in a locked period are skipped. Used by the Copy button and, automatically, after an import or a new plug.
  const copyPlugs = async (req, plugs, units) => {
    const locks = await loadLocks(db);
    const dates = [...new Set(plugs.map((p) => p.plug_date))];
    const { rows: have } = await db.query(
      `SELECT DISTINCT w.work_date AS d, upper(btrim(x)) AS id FROM workload_items w, unnest(string_to_array(w.plug_id, E'\\n')) AS x WHERE w.work_date = ANY($1::date[])`, [dates]
    );
    const taken = new Set(have.map((r) => `${r.d}|${r.id}`));
    const customCols = await loadCustomCols(db);
    let created = 0;
    let already = 0;
    let locked = 0;
    const errors = [];
    await db.tx(async (c) => {
      for (const p of plugs) {
        const key = `${p.plug_date}|${p.plug_id.toUpperCase()}`;
        if (taken.has(key)) { already++; continue; }
        try { assertNotLocked(locks, p.plug_date); } catch (e) { locked++; continue; }   // a day inside a locked period is skipped
        try {
          const rec = await parseRow(c, { work_date: p.plug_date, units_concerned: units, plug_id: p.plug_id, psd: p.psd, prog_name: p.prog_name }, null, customCols, { allowBlankUnits: true });
          const id = await insertRow(c, rec, req.user.id);
          await audit(req, 'workload.create', 'workload_item', id, { from_plug_list: true, plug_id: p.plug_id }, c);
          taken.add(key);
          created++;
        } catch (e) {
          errors.push(`${p.plug_date} ${p.plug_id}: ${e instanceof HttpError ? e.message : 'unexpected error'}`);
        }
      }
    });
    return { created, already, locked, errors, dates };
  };
  // After an import or a hand-added plug: the same copy, done for you. Quiet on failure (the plug list change itself already succeeded) and skipped
  // for someone who may not write to the Workload Tracker.
  const autoCopy = async (req, where, params) => {
    if (!can(req.user, 'workload.write')) return null;
    try {
      const { rows } = await db.query(`SELECT p.id, p.plug_date, p.plug_id, p.prog_name, p.psd FROM workload_plugs p WHERE ${where} ORDER BY p.plug_date, p.seq, p.id LIMIT 5000`, params);
      if (!rows.length) return { created: 0, already: 0, locked: 0, errors: [] };
      const out = await copyPlugs(req, rows, null);
      await logRun(req, 'workload.plugs_copy', { mode: 'automatic', days: out.dates.length, from: out.dates[0], to: out.dates[out.dates.length - 1], units: '(blank)', requested: rows.length,
        created: out.created, alreadyInWorkload: out.already, skippedLocked: out.locked, errors: out.errors.slice(0, 20) });
      return { created: out.created, already: out.already, locked: out.locked, errors: out.errors.slice(0, 5) };
    } catch (e) { console.error('[plugs] automatic copy failed', e.message); return null; }
  };

  router.post('/copy', requireAction('workload.write'), asyncH(async (req, res) => {
    const t0 = Date.now();
    const body = req.body || {};
    // Units Concerned is NOT known from the plug list: rows are made with it blank (they show under All until someone sets it).
    // A value may still be passed in (optional).
    const units = body.units_concerned ? v.oneOf(canonUnit(body.units_concerned), UNITS, { field: 'Units Concerned' }) : null;
    // which plugs: the chosen ones ({ ids }, from any days), or everything in a view ({ from, to, q } — or one { date })
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 5000).map((n) => { try { return v.id(n); } catch (e) { return null; } }).filter(Boolean) : null;
    const LIMIT = 5000;
    let found;
    if (ids) {
      found = await db.query('SELECT p.id, p.plug_date, p.plug_id, p.prog_name, p.psd FROM workload_plugs p WHERE p.id = ANY($1::bigint[]) ORDER BY p.plug_date, p.seq, p.id', [ids]);
    } else {
      const { where, params } = plugFilter({ from: body.from || body.date || undefined, to: body.to || body.date || undefined, q: body.q || undefined });
      found = await db.query(`SELECT p.id, p.plug_date, p.plug_id, p.prog_name, p.psd FROM workload_plugs p ${whereSql(where)} ORDER BY p.plug_date, p.seq, p.id LIMIT ${LIMIT + 1}`, params);
    }
    const truncated = found.rows.length > LIMIT;
    const plugs = found.rows.slice(0, LIMIT);
    if (!plugs.length) return res.json({ ok: true, created: 0, already: 0, locked: 0, errors: [], truncated: false });
    const { created, already, locked, errors, dates } = await copyPlugs(req, plugs, units);
    await logRun(req, 'workload.plugs_copy', {
      mode: ids ? 'selected' : 'view', days: dates.length, from: dates[0], to: dates[dates.length - 1], units: units || '(blank)', requested: plugs.length,
      created, alreadyInWorkload: already, skippedLocked: locked, truncated, errors: errors.slice(0, 20), ms: Date.now() - t0,
    });
    res.json({ ok: true, created, already, locked, errors: errors.slice(0, 20), truncated });
  }));

  return router;
};

module.exports.parsePlugWorkbook = parsePlugWorkbook;
module.exports.backfillWorkload = backfillWorkload;
