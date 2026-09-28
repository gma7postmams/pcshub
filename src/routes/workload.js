const express = require('express');
const validator = require('validator');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError, requireAction } = require('../middleware');
const { audit } = require('../audit');

// Mounted behind requirePageAccess('/workload'); writes need requireAction('workload.write').
//
// ONE table (workload_items). "Units Concerned" says which team(s) a plug is for; the tabs in the UI
// (All / VGFX / VEDIT / Audio) are filters over it. Field types follow the red notes in the
// Sept 2026 PCS Workload template: "dropdown", "Date" and "Open" (free text you can type or paste).
const router = express.Router();

const UNITS = ['VGFX Only', 'VEDIT Only', 'VGFX/VEDIT', 'Audio - RADIO', 'Audio – AUDIO GUIDE', 'VGFX/VEDIT/Audio'];
// Which teams each Units Concerned option covers (drives the team tabs)
const UNIT_TEAMS = {
  'VGFX Only': ['VGFX'],
  'VEDIT Only': ['VEDIT'],
  'VGFX/VEDIT': ['VGFX', 'VEDIT'],
  'Audio - RADIO': ['AUDIO'],
  'Audio – AUDIO GUIDE': ['AUDIO'],
  'VGFX/VEDIT/Audio': ['VGFX', 'VEDIT', 'AUDIO'],
};
const TEAMS = ['VGFX', 'VEDIT', 'AUDIO'];
const TAB_LABEL = { ALL: 'All', VGFX: 'VGFX', VEDIT: 'VEDIT', AUDIO: 'Audio' };

// Field kinds: date | select | text | audio_guide. `multiline` = textarea. `hint` = placeholder from the red notes.
const OPEN = 'Type or paste anything';
const FROM_PSD = 'Paste from the PSD daily plug list';
const FIELDS = {
  work_date:      { label: 'Work Date', kind: 'date', required: true },
  platform:       { label: 'Platform', kind: 'select', lookup: 'workload_platform', max: 100 },
  billable_party: { label: 'Billable Party', kind: 'text', max: 200, hint: OPEN },
  units_concerned:{ label: 'Units Concerned', kind: 'select', options: UNITS, required: true },
  plug_id:        { label: 'Plug ID', kind: 'text', multiline: true, max: 1000, required: true, hint: FROM_PSD },
  psd:            { label: 'PSD', kind: 'text', max: 200, hint: FROM_PSD },
  breakdate:      { label: 'Breakdate/Time', kind: 'datetime' },
  vo:             { label: 'VO', kind: 'text', multiline: true, max: 1000, hint: OPEN },
  script:         { label: 'Script', kind: 'date' },
  art_stb:        { label: 'Artwork/STB', kind: 'date' },
  audio_guide:    { label: 'Audio Guide', kind: 'audio_guide' },
  remarks:        { label: 'Remarks', kind: 'text', multiline: true, max: 4000, hint: OPEN },
  total_mats:     { label: 'Total Mats', kind: 'text', multiline: true, max: 500, hint: OPEN },
  prog_name:      { label: 'Prog Name / Project Title', kind: 'text', max: 300, hint: FROM_PSD },
  plug_type:      { label: 'Plug Type', kind: 'select', lookup: 'plug_type', max: 100 },
  // Audio sheet's Assigned / Done / Resched-cancelled tables: open columns you can type or paste into
  length:         { label: 'Length', kind: 'text', max: 100, hint: OPEN },
  others:         { label: 'Others', kind: 'text', multiline: true, max: 2000, hint: OPEN },
};
const COLS = Object.keys(FIELDS);

// Columns per tab, in the same order as the template's sheets ("main" for VGFX/VEDIT, "ojo" for Audio)
const MAIN_COLS = ['work_date', 'platform', 'billable_party', 'units_concerned', 'plug_id', 'psd', 'breakdate',
  'vo', 'script', 'art_stb', 'audio_guide', 'remarks', 'total_mats', 'prog_name', 'plug_type'];
const AUDIO_COLS = ['work_date', 'platform', 'billable_party', 'units_concerned', 'plug_id', 'psd', 'vo', 'script', 'remarks', 'length', 'others', 'plug_type'];
// Audio-only columns; any row that involves Audio (e.g. VGFX/VEDIT/Audio) also gets these in the form
const AUDIO_EXTRA = ['length', 'others'];
const VIEWS = {
  // All tab = every column (the template's main columns plus Length and Others), each in its own column
  ALL: [...MAIN_COLS.slice(0, -1), 'length', 'others', 'plug_type'],
  VGFX: MAIN_COLS,
  VEDIT: MAIN_COLS,
  AUDIO: AUDIO_COLS,
};
// Default Units Concerned when adding a row from a team tab
const TAB_DEFAULT_UNITS = { VGFX: 'VGFX Only', VEDIT: 'VEDIT Only', AUDIO: 'Audio - RADIO' };

// The template's Platform formula: first matching rule wins, tested against the whole Plug ID cell.
// platform: null means "no automatic value" (PD_ = digital: pick DIGITAL or INTL DIGITAL by hand).
const PLATFORM_RULES = [
  { pattern: 'PG_REGION_', platform: 'REG/TDMD (PG_REGIONAL AIRING)' },
  { pattern: 'PV_REGION_|PN_REGION_|MALSHO', platform: 'REG/TDMD (RTV LOCAL AIRING)' },
  { pattern: '_RATI', platform: 'REG/TDMD (RGMA)' },
  { pattern: 'GMUSIC|GRECOR', platform: 'REG/TDMD (GMA MUSIC)' },
  { pattern: 'GMAPIC', platform: 'REG/TDMD (GMA PICTURES)' },
  { pattern: 'MKTG26|MRCI', platform: 'INTL MKTG' },
  { pattern: 'SOCMED', platform: 'REG/TDMD (PSD-DIGITAL)' },
  { pattern: 'SPARKL|SPARTI', platform: 'REG/TDMD (SPARKLE)' },
  { pattern: 'PF_', platform: 'GNTV' },
  { pattern: 'PL_', platform: 'GLTV' },
  { pattern: 'PI_|PU_|PJ_', platform: 'GPTV' },
  { pattern: 'PD_', platform: null },
  { pattern: 'NC101', platform: 'REG/TDMD (SYNERGY)' },
  { pattern: 'PV_', platform: 'GMA' },
  { pattern: 'PN_', platform: 'GTV' },
  { pattern: 'PH_', platform: 'HOA' },
  { pattern: 'PW_', platform: 'IHM' },
];
const RULE_RES = PLATFORM_RULES.map((r) => ({ re: new RegExp(r.pattern, 'i'), platform: r.platform }));
function derivePlatform(plugId) {
  const text = String(plugId || '');
  for (const r of RULE_RES) if (r.re.test(text)) return r.platform;
  return null;
}

const MAX_BATCH = 200;
const SEARCH_COLS = ['plug_id', 'psd', 'prog_name', 'billable_party', 'remarks', 'vo', 'total_mats', 'audio_guide', 'length', 'others'];

router.get('/meta', (req, res) => res.json({
  ready: true, units: UNITS, unitTeams: UNIT_TEAMS, tabs: ['ALL', ...TEAMS].map((key) => ({ key, label: TAB_LABEL[key] })),
  tabDefaultUnits: TAB_DEFAULT_UNITS, audioExtra: AUDIO_EXTRA, fields: FIELDS, views: VIEWS, platformRules: PLATFORM_RULES,
}));

async function assertOption(client, category, value, field, current) {
  if (!value) return;
  if (current && current === value) return; // a value already stored on the row stays valid even if the option was deactivated since
  const { rows } = await client.query(
    'SELECT 1 FROM dropdown_options WHERE category=$1 AND value=$2 AND is_active', [category, value]
  );
  if (!rows.length) throw new HttpError(400, `${field} "${value}" is not a valid option`);
}

/** Audio Guide dropdown: "N/A" or a date (YYYY-MM-DD). A value already stored on the row is left alone. */
function parseAudioGuide(raw, current) {
  const s = v.str(raw, { field: 'Audio Guide', max: 100 });
  if (!s || s === 'N/A') return s;
  if (current && s === current) return s;
  if (!validator.isDate(s, { format: 'YYYY-MM-DD', strictMode: true })) {
    throw new HttpError(400, 'Audio Guide must be N/A or a date');
  }
  return s;
}

/** Date and time picked together: 'YYYY-MM-DDTHH:MM' (a bare date means 12:00 AM). Returns 'YYYY-MM-DD HH:MM:00' or null. */
function parseDateTime(raw, field) {
  const s = v.str(raw, { field, max: 30 });
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/.exec(s);
  if (!m || !validator.isDate(m[1], { format: 'YYYY-MM-DD', strictMode: true }) || (m[2] && (Number(m[2]) > 23 || Number(m[3]) > 59))) {
    throw new HttpError(400, `${field} must be a date and time`);
  }
  return `${m[1]} ${m[2] || '00'}:${m[3] || '00'}:00`;
}

/** Validate one row; returns the values to store. `current` = the stored row when updating. */
async function parseRow(client, body, current) {
  const cur = current || {};
  const rec = {};
  for (const k of COLS) {
    const f = FIELDS[k];
    if (k === 'audio_guide') rec[k] = parseAudioGuide(body[k], cur[k]);
    else if (f.kind === 'date') rec[k] = v.date(body[k], { field: f.label, required: !!f.required });
    else if (f.kind === 'datetime') rec[k] = parseDateTime(body[k], f.label);
    else if (k === 'units_concerned') rec[k] = v.oneOf(body[k], UNITS, { field: f.label });
    else rec[k] = v.str(body[k], { field: f.label, max: f.max, required: !!f.required });
  }
  // Platform follows the Plug ID prefix unless one was chosen (only if that option exists and is active)
  if (!rec.platform) {
    const auto = derivePlatform(rec.plug_id);
    if (auto) {
      const { rows } = await client.query(
        `SELECT 1 FROM dropdown_options WHERE category='workload_platform' AND value=$1 AND is_active`, [auto]
      );
      if (rows.length) rec.platform = auto;
    }
  }
  await assertOption(client, 'workload_platform', rec.platform, 'Platform', cur.platform);
  await assertOption(client, 'plug_type', rec.plug_type, 'Plug Type', cur.plug_type);
  return rec;
}

const colList = COLS.map((c) => `"${c}"`);
const CUR_COLS = 'platform, plug_type, audio_guide';

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
  if (query.team) {
    const team = v.oneOf(String(query.team), TEAMS, { field: 'team' });
    add('w.units_concerned = ANY(?::text[])', UNITS.filter((u) => UNIT_TEAMS[u].includes(team)));
  }
  if (query.units) add('w.units_concerned = ?', v.oneOf(String(query.units), UNITS, { field: 'units' }));
  if (query.platform) add('w.platform = ?', String(query.platform));
  if (query.plug_type) add('w.plug_type = ?', String(query.plug_type));
  if (query.from) add('w.work_date >= ?', v.date(query.from, { field: 'from' }));
  if (query.to) add('w.work_date <= ?', v.date(query.to, { field: 'to' }));
  if (query.q) {
    params.push(`%${String(query.q).slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`);
    const p = `$${params.length}`;
    where.push(`(${SEARCH_COLS.map((c) => `w.${c} ILIKE ${p}`).join(' OR ')})`);
  }
  return { where, params };
}
const whereSql = (where) => (where.length ? `WHERE ${where.join(' AND ')}` : '');

// Counts for the summary cards and tab badges: follows every active filter except the team tab.
// `today` comes from the browser so "Today" is the user's local date.
router.get('/stats', asyncH(async (req, res) => {
  const { where, params } = buildFilter({ ...req.query, team: undefined });
  const today = v.date(req.query.today, { field: 'today' }) || new Date().toISOString().slice(0, 10);
  const P = (val) => { params.push(val); return `$${params.length}`; };
  const team = (t) => `count(*) FILTER (WHERE w.units_concerned = ANY(${P(UNITS.filter((u) => UNIT_TEAMS[u].includes(t)))}::text[]))::int`;
  const { rows } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE w.work_date = ${P(today)})::int AS today,
            ${team('VGFX')} AS vgfx, ${team('VEDIT')} AS vedit, ${team('AUDIO')} AS audio
       FROM workload_items w ${whereSql(where)}`, params
  );
  res.json(rows[0]);
}));

router.get('/', asyncH(async (req, res) => {
  const { where, params } = buildFilter(req.query);
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, MAX_BATCH * 2);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const total = await db.query(`SELECT count(*)::int AS n FROM workload_items w ${whereSql(where)}`, params);
  const { rows } = await db.query(
    `${SELECT} ${whereSql(where)} ORDER BY w.work_date DESC NULLS LAST, w.id ASC LIMIT ${limit} OFFSET ${offset}`, params
  );
  res.json({ total: total.rows[0].n, rows });
}));

// Export (.xlsx) mirrors the template: sheet "MAIN" (rows that involve VGFX or VEDIT) and sheet "AUDIO"
// (rows that involve Audio). A VGFX/VEDIT/Audio row appears on both, like it does in the template.
// With ?team=VGFX|VEDIT|AUDIO only that team's sheet is written. exceljs is loaded lazily so the app
// still starts if `npm install` has not been run yet after pulling this change.
router.get('/export', asyncH(async (req, res) => {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch (e) {
    throw new HttpError(501, 'Excel export needs the "exceljs" package. Run "npm install" on the server, then restart.');
  }
  const { where, params } = buildFilter({ ...req.query, team: undefined });
  const { rows } = await db.query(
    `SELECT w.* FROM workload_items w ${whereSql(where)} ORDER BY w.work_date ASC, w.id ASC LIMIT 20000`, params
  );
  const involves = (r, teams) => teams.some((t) => (UNIT_TEAMS[r.units_concerned] || []).includes(t));
  const team = req.query.team ? v.oneOf(String(req.query.team), TEAMS, { field: 'team' }) : null;
  const sheets = team
    ? [{ name: TAB_LABEL[team].toUpperCase(), cols: VIEWS[team], pick: (r) => involves(r, [team]) }]
    : [
      { name: 'MAIN', cols: MAIN_COLS, pick: (r) => involves(r, ['VGFX', 'VEDIT']) },
      { name: 'AUDIO', cols: AUDIO_COLS, pick: (r) => involves(r, ['AUDIO']) },
    ];

  const wb = new ExcelJS.Workbook();
  wb.creator = 'PromoHub';
  const asDate = (s) => (s ? new Date(`${s}T00:00:00Z`) : null);
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name);
    ws.columns = sh.cols.map((k) => {
      const f = FIELDS[k];
      return { header: f.label, key: k, width: f.multiline ? 34 : f.kind === 'date' ? 14 : 22,
        style: f.kind === 'date' ? { numFmt: 'mmm d, yyyy' } : f.kind === 'datetime' ? { numFmt: 'mmm d, yyyy h:mm AM/PM' } : {} };
    });
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    rows.filter(sh.pick).forEach((r) => {
      const row = ws.addRow(sh.cols.reduce((o, k) => {
        const f = FIELDS[k];
        let val = r[k];
        if (f.kind === 'date') val = asDate(val);
        else if (f.kind === 'datetime') { const t = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(val || ''); val = t ? new Date(Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5])) : null; }
        else if (k === 'audio_guide' && /^\d{4}-\d{2}-\d{2}$/.test(val || '')) val = asDate(val);
        return { ...o, [k]: val };
      }, {}));
      row.alignment = { wrapText: true, vertical: 'top' };
      if (sh.cols.includes('audio_guide') && r.audio_guide && /^\d{4}-\d{2}-\d{2}$/.test(r.audio_guide)) {
        row.getCell('audio_guide').numFmt = 'mmm d, yyyy';
      }
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
          const cur = await c.query(`SELECT ${CUR_COLS} FROM workload_items WHERE id=$1 FOR UPDATE`, [id]);
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

// Save ONE field of a row (click-to-edit in the table). Only that column is written, so someone else's edit to a
// different field of the same row is never overwritten. The whole row is still validated, and Plug ID edits re-derive the
// Platform the same way the form does (only while Platform is empty or still the automatic one).
router.patch('/:id', requireAction('workload.write'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const field = String((req.body && req.body.field) || '');
  if (!COLS.includes(field)) throw new HttpError(400, 'Unknown field');
  const values = await db.tx(async (c) => {
    const found = await c.query('SELECT * FROM workload_items WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rows.length) throw new HttpError(404, 'Workload item not found');
    const cur = found.rows[0];
    const merged = {};
    COLS.forEach((k) => { merged[k] = cur[k]; });
    merged[field] = req.body.value;
    if (field === 'plug_id' && (!cur.platform || cur.platform === derivePlatform(cur.plug_id))) merged.platform = '';
    const rec = await parseRow(c, merged, cur);
    const changed = field === 'plug_id' ? ['plug_id', 'platform'] : [field];
    await c.query(
      `UPDATE workload_items SET ${changed.map((k, i) => `"${k}"=$${i + 2}`).join(', ')}, updated_by=$${changed.length + 2}, updated_at=now() WHERE id=$1`,
      [id, ...changed.map((k) => rec[k]), req.user.id]
    );
    await audit(req, 'workload.update', 'workload_item', id, { field, value: rec[field] }, c);
    // hand back values in the same shape the list uses ('YYYY-MM-DDTHH:MM' for Breakdate/Time)
    const shape = (k) => (FIELDS[k].kind === 'datetime' && rec[k] ? rec[k].slice(0, 16).replace(' ', 'T') : rec[k]);
    return Object.fromEntries(changed.map((k) => [k, shape(k)]));
  });
  res.json({ ok: true, values });
}));

router.put('/:id', requireAction('workload.write'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  await db.tx(async (c) => {
    const cur = await c.query(`SELECT ${CUR_COLS} FROM workload_items WHERE id=$1 FOR UPDATE`, [id]);
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
    'DELETE FROM workload_items WHERE id=$1 RETURNING work_date, units_concerned, plug_id', [id]
  );
  if (!rows.length) throw new HttpError(404, 'Workload item not found');
  await audit(req, 'workload.delete', 'workload_item', id, rows[0]);
  res.json({ ok: true });
}));

module.exports = router;
