const express = require('express');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError, requireAction } = require('../middleware');
const { audit } = require('../audit');

// Mounted behind requirePageAccess('/workload'); writes need requireAction('workload.write').
//
// ONE table (workload_items) holds every section. "Section Assigned" (VEDIT / VGFX / AUDIO) decides
// which columns a row uses; columns that do not belong to the row's section are blanked on save.
const router = express.Router();

const SECTIONS = ['VEDIT', 'VGFX', 'AUDIO'];

// Field definitions (also sent to the client via /meta so the UI never hard-codes them)
const FIELDS = {
  work_date:   { label: 'Work Date', type: 'date', required: true },
  section:     { label: 'Section Assigned', type: 'select', options: SECTIONS, required: true },
  platform:    { label: 'Platform', type: 'select', lookup: 'workload_platform', max: 100 },
  plug_id:     { label: 'Plug ID', type: 'text', multiline: true, max: 1000, required: true },
  psd:         { label: 'PSD', type: 'text', max: 200 },
  prog_name:   { label: 'Prog Name / Project Title', type: 'text', max: 300 },
  remarks:     { label: 'Remarks', type: 'text', multiline: true, max: 4000 },
  breakdate:   { label: 'Breakdate', type: 'text', multiline: true, max: 1000 },
  vo:          { label: 'VO', type: 'text', multiline: true, max: 1000 },
  script:      { label: 'Script', type: 'text', multiline: true, max: 1000 },
  art_stb:     { label: 'Art/STB', type: 'text', multiline: true, max: 1000 },
  audio_guide: { label: 'Audio Guide', type: 'text', multiline: true, max: 1000 },
  total_mats:  { label: 'Total Mats', type: 'text', multiline: true, max: 500 },
  length:      { label: 'Length', type: 'text', max: 100 },
  status:      { label: 'Status', type: 'text', multiline: true, max: 500 },
};
const COLS = Object.keys(FIELDS);

// Columns shown per section, in the same order as the team's Excel sheets (Work Date first)
const VIDEO = ['platform', 'plug_id', 'psd', 'breakdate', 'vo', 'script', 'art_stb', 'audio_guide', 'remarks', 'total_mats', 'prog_name'];
const AUDIO = ['platform', 'plug_id', 'psd', 'length', 'remarks', 'status'];
const SECTION_COLS = { VEDIT: VIDEO, VGFX: VIDEO, AUDIO };
const VIEWS = {
  ALL: ['work_date', 'section', 'platform', 'plug_id', 'psd', 'prog_name', 'remarks'],
  VEDIT: ['work_date', ...VIDEO],
  VGFX: ['work_date', ...VIDEO],
  AUDIO: ['work_date', ...AUDIO],
};

const MAX_BATCH = 200;
const SEARCH_COLS = ['plug_id', 'psd', 'prog_name', 'remarks', 'breakdate', 'vo', 'script', 'art_stb', 'audio_guide', 'total_mats', 'status'];

router.get('/meta', (req, res) => res.json({ ready: true, sections: SECTIONS, fields: FIELDS, views: VIEWS }));

async function assertPlatform(client, value) {
  const { rows } = await client.query(
    `SELECT 1 FROM dropdown_options WHERE category='workload_platform' AND value=$1 AND is_active`, [value]
  );
  if (!rows.length) throw new HttpError(400, `Platform "${value}" is not a valid option`);
}

/** Validate one row; returns the values to store (columns outside the section are null). */
async function parseRow(client, body, current) {
  const section = v.oneOf(body.section, SECTIONS, { field: 'Section Assigned' });
  const rec = { work_date: v.date(body.work_date, { field: 'Work Date', required: true }), section };
  for (const k of COLS) {
    if (k === 'work_date' || k === 'section') continue;
    const f = FIELDS[k];
    rec[k] = SECTION_COLS[section].includes(k)
      ? v.str(body[k], { field: f.label, max: f.max, required: !!f.required })
      : null;
  }
  if (section === 'AUDIO' && !rec.platform) rec.platform = 'RADIO'; // audio tabs have no Platform column; they are radio plugs
  // A value already stored on the row stays valid even if the option was deactivated since
  if (rec.platform && !(current && current.platform === rec.platform)) await assertPlatform(client, rec.platform);
  return rec;
}

const colList = COLS.map((c) => `"${c}"`);

async function insertRow(client, rec, userId) {
  const params = [...COLS.map((c) => rec[c]), userId];
  const { rows } = await client.query(
    `INSERT INTO workload_items (${colList.join(',')}, created_by, updated_by)
     VALUES (${COLS.map((_, i) => `$${i + 1}`).join(',')}, $${COLS.length + 1}, $${COLS.length + 1}) RETURNING id`,
    params
  );
  return rows[0].id;
}

async function updateRow(client, id, rec, userId) {
  const sets = COLS.map((c, i) => `"${c}"=$${i + 2}`).join(', ');
  const params = [id, ...COLS.map((c) => rec[c]), userId];
  await client.query(
    `UPDATE workload_items SET ${sets}, updated_by=$${COLS.length + 2}, updated_at=now() WHERE id=$1`, params
  );
}

const SELECT = `
  SELECT w.*, uu.full_name AS updated_by_name
    FROM workload_items w LEFT JOIN users uu ON uu.id = w.updated_by`;

function buildFilter(query) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (query.section) add('w.section = ?', v.oneOf(String(query.section), SECTIONS, { field: 'section' }));
  if (query.platform) add('w.platform = ?', String(query.platform));
  if (query.from) add('w.work_date >= ?', v.date(query.from, { field: 'from' }));
  if (query.to) add('w.work_date <= ?', v.date(query.to, { field: 'to' }));
  if (query.q) {
    params.push(`%${String(query.q).slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`);
    const p = `$${params.length}`;
    where.push(`(${SEARCH_COLS.map((c) => `w.${c} ILIKE ${p}`).join(' OR ')})`);
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

router.get('/', asyncH(async (req, res) => {
  const { whereSql, params } = buildFilter(req.query);
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, MAX_BATCH * 2);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const total = await db.query(`SELECT count(*)::int AS n FROM workload_items w ${whereSql}`, params);
  const { rows } = await db.query(
    `${SELECT} ${whereSql} ORDER BY w.work_date DESC NULLS LAST, w.id ASC LIMIT ${limit} OFFSET ${offset}`, params
  );
  res.json({ total: total.rows[0].n, rows });
}));

// Export: one sheet per section (mirrors the team's workbook). exceljs is loaded lazily so the app
// still starts if `npm install` has not been run yet after pulling this change.
router.get('/export', asyncH(async (req, res) => {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch (e) {
    throw new HttpError(501, 'Excel export needs the "exceljs" package. Run "npm install" on the server, then restart.');
  }
  const { whereSql, params } = buildFilter(req.query);
  const { rows } = await db.query(
    `SELECT w.* FROM workload_items w ${whereSql} ORDER BY w.work_date ASC, w.id ASC LIMIT 20000`, params
  );
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PromoHub';
  const wanted = req.query.section ? [String(req.query.section)] : SECTIONS;
  for (const section of wanted) {
    const ws = wb.addWorksheet(section);
    const keys = VIEWS[section];
    ws.columns = keys.map((k) => ({
      header: FIELDS[k].label, key: k,
      width: FIELDS[k].multiline ? 32 : k === 'work_date' ? 13 : 20,
    }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    rows.filter((r) => r.section === section).forEach((r) => {
      const row = ws.addRow(keys.reduce((o, k) => ({ ...o, [k]: r[k] }), {}));
      row.alignment = { wrapText: true, vertical: 'top' };
    });
  }
  const stamp = req.query.from || req.query.to ? `${req.query.from || ''}_${req.query.to || ''}` : 'all';
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="Workload_${stamp}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

router.post('/', requireAction('workload.write'), asyncH(async (req, res) => {
  const id = await db.tx(async (c) => {
    const rec = await parseRow(c, req.body, null);
    const newId = await insertRow(c, rec, req.user.id);
    await audit(req, 'workload.create', 'workload_item', newId, rec, c);
    return newId;
  });
  res.status(201).json({ ok: true, id });
}));

// Batch save (Excel mode): rows with an id are updated, rows without are created — all or nothing.
router.post('/batch', requireAction('workload.write'), asyncH(async (req, res) => {
  const list = req.body && req.body.rows;
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'No rows to save');
  if (list.length > MAX_BATCH) throw new HttpError(400, `Save at most ${MAX_BATCH} rows at a time`);
  const out = await db.tx(async (c) => {
    let created = 0;
    let updated = 0;
    for (let i = 0; i < list.length; i++) {
      const row = list[i] || {};
      try {
        if (row.id) {
          const id = v.id(row.id);
          const cur = await c.query('SELECT platform FROM workload_items WHERE id=$1 FOR UPDATE', [id]);
          if (!cur.rows.length) throw new HttpError(404, 'Row no longer exists (deleted by someone else?)');
          const rec = await parseRow(c, row, cur.rows[0]);
          await updateRow(c, id, rec, req.user.id);
          await audit(req, 'workload.update', 'workload_item', id, rec, c);
          updated++;
        } else {
          const rec = await parseRow(c, row, null);
          const id = await insertRow(c, rec, req.user.id);
          await audit(req, 'workload.create', 'workload_item', id, rec, c);
          created++;
        }
      } catch (e) {
        if (e instanceof HttpError) throw new HttpError(e.status, `Row ${i + 1}: ${e.message}`);
        throw e;
      }
    }
    return { created, updated };
  });
  res.json({ ok: true, ...out });
}));

router.put('/:id', requireAction('workload.write'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  await db.tx(async (c) => {
    const cur = await c.query('SELECT platform FROM workload_items WHERE id=$1 FOR UPDATE', [id]);
    if (!cur.rows.length) throw new HttpError(404, 'Workload item not found');
    const rec = await parseRow(c, req.body, cur.rows[0]);
    await updateRow(c, id, rec, req.user.id);
    await audit(req, 'workload.update', 'workload_item', id, rec, c);
  });
  res.json({ ok: true });
}));

router.delete('/:id', requireAction('workload.write'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const { rows } = await db.query(
    'DELETE FROM workload_items WHERE id=$1 RETURNING work_date, section, plug_id', [id]
  );
  if (!rows.length) throw new HttpError(404, 'Workload item not found');
  await audit(req, 'workload.delete', 'workload_item', id, rows[0]);
  res.json({ ok: true });
}));

module.exports = router;
