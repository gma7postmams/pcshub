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
  // Two separate times (the template lists both when a plug needs both teams)
  breakdate_vgfx: { label: 'Breakdate / Time (VGFX)', kind: 'datetime' },
  breakdate_vedit:{ label: 'Breakdate / Time (VEDIT)', kind: 'datetime' },
  vo:             { label: 'VO', kind: 'text', multiline: true, max: 1000, hint: OPEN },
  script:         { label: 'Script', kind: 'date' },
  art_stb:        { label: 'Artwork / STB', kind: 'date' },
  audio_guide:    { label: 'Audio Guide', kind: 'audio_guide' },
  remarks:        { label: 'Remarks', kind: 'text', multiline: true, max: 4000, hint: OPEN },
  total_mats:     { label: 'Total Mats', kind: 'text', multiline: true, max: 500, hint: OPEN },
  prog_name:      { label: 'Prog. Name / Project Title', kind: 'text', max: 300, hint: FROM_PSD },
  plug_type:      { label: 'Plug Type', kind: 'select', lookup: 'plug_type', max: 100 },
  // Audio sheet's Assigned / Done / Resched-cancelled tables: open columns you can type or paste into
  length:         { label: 'Length', kind: 'text', max: 100, hint: OPEN },
  others:         { label: 'Others', kind: 'text', multiline: true, max: 2000, hint: OPEN },
};
const COLS = Object.keys(FIELDS);

// Columns per tab, in the same order as the template's sheets ("main" for VGFX/VEDIT, "ojo" for Audio)
const MAIN_COLS = ['work_date', 'platform', 'billable_party', 'units_concerned', 'plug_id', 'psd',
  'breakdate_vgfx', 'breakdate_vedit',
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

// ---------- Custom columns ("Add Column"): stored in workload_custom_columns, values in workload_items.custom_fields ----------
// col_key is always 'custom_<id>' (not the label), so adding/removing/renaming a column never needs a schema change.
async function loadCustomCols(client) {
  const { rows } = await client.query('SELECT id, col_key, label, sort_order FROM workload_custom_columns ORDER BY sort_order, id');
  return rows;
}
/** FIELDS plus a plain-text entry for every custom column — the source of truth for a single request. */
function extendFields(customCols) {
  const ext = { ...FIELDS };
  customCols.forEach((c) => { ext[c.col_key] = { label: c.label, kind: 'text', multiline: true, max: 2000, custom: true }; });
  return ext;
}
/** Every view (All/VGFX/VEDIT/Audio) plus every custom column appended at the end — custom columns are not team-specific. */
function extendViews(customCols) {
  const keys = customCols.map((c) => c.col_key);
  const ext = {};
  Object.keys(VIEWS).forEach((tab) => { ext[tab] = [...VIEWS[tab], ...keys]; });
  return ext;
}
/** Validate the custom-column values present in `body`; returns {col_key: text}. Custom fields are always plain open text. */
function parseCustomFields(customCols, body) {
  const out = {};
  customCols.forEach((c) => { out[c.col_key] = v.str(body[c.col_key], { field: c.label, max: 2000 }); });
  return out;
}
/** Lift custom_fields (a JSONB object) to top-level keys on the row, so the client can read any field the same way. */
const flattenCustom = (row) => ({ ...row, ...(row.custom_fields || {}) });

// ---------- Date locks: an Admin can freeze a date range so its rows can't be edited/deleted, and no new row
// can be created dated inside it. The lock applies to everyone, Admins included; an Admin lifts it via Lock Dates → Unlock. ----------
async function loadLocks(client) {
  const { rows } = await client.query('SELECT id, from_date, to_date, note FROM workload_locks ORDER BY from_date DESC');
  return rows;
}
/** Throws if `dateStr` (a work_date, 'YYYY-MM-DD') falls in any lock (no role is exempt; unlock the range first). */
function assertNotLocked(locks, dateStr) {
  if (!dateStr) return;
  const hit = locks.find((l) => dateStr >= l.from_date && dateStr <= l.to_date);
  if (hit) throw new HttpError(423, `${dateStr} is in a locked period${hit.note ? ` (${hit.note})` : ''} and can't be edited. An Admin must unlock it first (Lock Dates).`);
}

router.get('/meta', asyncH(async (req, res) => {
  const customCols = await loadCustomCols(db);
  const locks = await loadLocks(db);
  res.json({
    ready: true, units: UNITS, unitTeams: UNIT_TEAMS, tabs: ['ALL', ...TEAMS].map((key) => ({ key, label: TAB_LABEL[key] })),
    tabDefaultUnits: TAB_DEFAULT_UNITS, audioExtra: AUDIO_EXTRA, fields: extendFields(customCols), views: extendViews(customCols),
    platformRules: PLATFORM_RULES, customColumns: customCols.map((c) => ({ id: c.id, key: c.col_key, label: c.label })),
    locks,
  });
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

/** Validate one row; returns the values to store. `current` = the stored row when updating. `customCols` = result of loadCustomCols. */
async function parseRow(client, body, current, customCols = []) {
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
  // Priority flag (not a template column, so it lives outside FIELDS): keep the stored value when the request doesn't mention it
  const p = body.is_priority;
  rec.is_priority = p === undefined || p === null ? !!cur.is_priority : (p === true || p === 'true' || p === 1 || p === '1');
  rec.custom_fields = parseCustomFields(customCols, body);
  return rec;
}

const colList = COLS.map((c) => `"${c}"`);
const CUR_COLS = 'platform, plug_type, audio_guide, work_date, is_priority';

async function insertRow(client, rec, userId) {
  const params = [...COLS.map((c) => rec[c]), !!rec.is_priority, JSON.stringify(rec.custom_fields || {}), userId];
  const { rows } = await client.query(
    `INSERT INTO workload_items (${colList.join(',')}, is_priority, custom_fields, created_by, updated_by)
     VALUES (${COLS.map((_, i) => `$${i + 1}`).join(',')}, $${COLS.length + 1}, $${COLS.length + 2}::jsonb, $${COLS.length + 3}, $${COLS.length + 3}) RETURNING id`,
    params
  );
  return rows[0].id;
}

async function updateRow(client, id, rec, userId) {
  const sets = COLS.map((c, i) => `"${c}"=$${i + 2}`).join(', ');
  const params = [id, ...COLS.map((c) => rec[c]), !!rec.is_priority, JSON.stringify(rec.custom_fields || {}), userId];
  await client.query(
    `UPDATE workload_items SET ${sets}, is_priority=$${COLS.length + 2}, custom_fields=$${COLS.length + 3}::jsonb, updated_by=$${COLS.length + 4}, updated_at=now() WHERE id=$1`, params
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
  res.json({ total: total.rows[0].n, rows: rows.map(flattenCustom) });
}));

// Export (.xlsx) mirrors the template: sheet "MAIN" (rows that involve VGFX or VEDIT) and sheet "AUDIO"
// (rows that involve Audio). A VGFX/VEDIT/Audio row appears on both, like it does in the template.
// With ?team=VGFX|VEDIT|AUDIO only that team's sheet is written. exceljs is loaded lazily so the app
// still starts if `npm install` has not been run yet after pulling this change.

// ---------- Excel export styling: mirror the web table's colours/pills/grid ----------
// Category colours are fixed regardless of the admin-selected theme (see client/src/app.css light-mode block);
// only the neutral tones (header/grid) pick up a touch of the org's theme tint, same as the web app.
const HUE_HEX = { blue: '1f6fc5', purple: '6d4fd1', teal: '0d8a84', orange: 'b95a12', green: '12805a', pink: 'b8326b', gray: '626b7a', red: 'c93838', amber: 'a4650a' };
const EXPORT_PALETTE = ['blue', 'green', 'pink', 'amber', 'red'];   // matches the web app's hash palette (Platform/Plug-Type-fallback/Units-fallback only)
const hueOf = (s) => EXPORT_PALETTE[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % EXPORT_PALETTE.length];
const TEAM_HUE = { VGFX: 'purple', VEDIT: 'orange', AUDIO: 'teal' };
const TYPE_HUE = { EPISODIC: 'blue', SEASONAL: 'pink', BUMPER: 'red', 'POP-UP/POP LOGO': 'blue', RADIO: 'green' };   // matches the web app; avoids purple/orange/teal (team colours)
const THEME_TINT = { midnight: '4f8cff', sunset: 'ff7a45', purple: '8b5cf6', ocean: '14b8c4', forest: '22c55e', rose: 'f43f5e', graphite: '94a3b8' };
const hex2rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (rgb) => rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
// Same blend CSS color-mix(in srgb, A pct%, B) uses: linear per-channel interpolation.
const mix = (aHex, pct, bHex) => { const a = hex2rgb(aHex); const b = hex2rgb(bHex); return rgb2hex(a.map((v, i) => v * (pct / 100) + b[i] * (1 - pct / 100))); };
const argb = (hex) => `FF${hex.toUpperCase()}`;
const oneLineText = (t) => String(t ?? '').replace(/\s*\n+\s*/g, ' \u00b7 ');   // matches the web table's " · " join for wrapped fields

async function exportPalette(db_) {
  const row = await db_.query("SELECT value FROM app_settings WHERE key='theme'");
  const tint = THEME_TINT[(row.rows[0] || {}).value] || THEME_TINT.midnight;
  const border = mix(tint, 8, 'e1e4ea');    // grid lines
  const headerFill = mix(tint, 9, 'e7eaef'); // header background, tinted like the web table's header
  const pillFg = (hue) => argb(HUE_HEX[hue]);
  return { gridBorder: argb(border), headerFill: argb(headerFill), black: argb('000000'), pillFg };
}

router.get('/export', asyncH(async (req, res) => {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch (e) {
    throw new HttpError(501, 'Excel export needs the "exceljs" package. Run "npm install" on the server, then restart.');
  }
  const customCols = await loadCustomCols(db);
  const fieldsExt = extendFields(customCols);
  const customKeys = customCols.map((c) => c.col_key);
  const { where, params } = buildFilter({ ...req.query, team: undefined });
  const { rows: rawRows } = await db.query(
    `SELECT w.* FROM workload_items w ${whereSql(where)} ORDER BY w.work_date ASC, w.id ASC LIMIT 20000`, params
  );
  const rows = rawRows.map(flattenCustom);
  const involves = (r, teams) => teams.some((t) => (UNIT_TEAMS[r.units_concerned] || []).includes(t));
  const team = req.query.team ? v.oneOf(String(req.query.team), TEAMS, { field: 'team' }) : null;
  const sheets = team
    ? [{ name: TAB_LABEL[team].toUpperCase(), cols: [...VIEWS[team], ...customKeys], pick: (r) => involves(r, [team]) }]
    : [
      { name: 'MAIN', cols: [...MAIN_COLS, ...customKeys], pick: (r) => involves(r, ['VGFX', 'VEDIT']) },
      { name: 'AUDIO', cols: [...AUDIO_COLS, ...customKeys], pick: (r) => involves(r, ['AUDIO']) },
    ];

  const pal = await exportPalette(db);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PromoHub';
  const asDate = (s) => (s ? new Date(`${s}T00:00:00Z`) : null);
  const thinGrid = { style: 'thin', color: { argb: pal.gridBorder } };
  const platformFamily = (v) => String(v || '').replace(/\s*\(.*\)\s*$/, '') || v;

  const cellText = (v) => {
    if (v == null) return '';
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v instanceof Date) return '';   // dates are sized by format below, not by scanning the stored Date value
    return String(v);
  };
  for (const sh of sheets) {
    const ws = wb.addWorksheet(sh.name);
    ws.columns = sh.cols.map((k) => {
      const f = fieldsExt[k];
      return { header: f.label, key: k, width: f.multiline ? 34 : f.kind === 'date' ? 14 : f.kind === 'datetime' ? 20 : 22,
        style: f.kind === 'date' ? { numFmt: 'mmm d, yyyy' } : f.kind === 'datetime' ? { numFmt: 'mmm d, yyyy h:mm AM/PM' } : {} };
    });
    // Header row: same fill/border treatment as the web table's header (Excel-mode style)
    ws.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: pal.black }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: pal.headerFill } };
      cell.border = { bottom: thinGrid, right: thinGrid };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    rows.filter(sh.pick).forEach((r) => {
      const row = ws.addRow(sh.cols.reduce((o, k) => {
        const f = fieldsExt[k];
        let val = r[k];
        if (f.kind === 'date') val = asDate(val);
        else if (f.kind === 'datetime') { const t = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(val || ''); val = t ? new Date(Date.UTC(+t[1], +t[2] - 1, +t[3], +t[4], +t[5])) : null; }
        else if (k === 'audio_guide' && /^\d{4}-\d{2}-\d{2}$/.test(val || '')) val = asDate(val);
        else if (k !== 'remarks') val = oneLineText(val);   // every field except Remarks is one line, like the web table
        return { ...o, [k]: val };
      }, {}));
      row.alignment = { wrapText: false, vertical: 'middle', horizontal: 'center' };

      sh.cols.forEach((k) => {
        const cell = row.getCell(k);
        const f = fieldsExt[k];
        cell.border = { right: thinGrid };   // vertical grid line, matching the web table
        if (k === 'audio_guide' && r.audio_guide && /^\d{4}-\d{2}-\d{2}$/.test(r.audio_guide)) cell.numFmt = 'mmm d, yyyy';

        if (f.kind === 'date' || f.kind === 'datetime' || k === 'audio_guide') {
          if (cell.value != null) cell.font = { color: { argb: pal.black } };
        } else if (k === 'platform' && r.platform) {
          cell.font = { bold: true, color: { argb: pal.black } };
        } else if (k === 'plug_type' && r.plug_type) {
          const hue = TYPE_HUE[r.plug_type] || hueOf(r.plug_type);
          cell.font = { bold: true, color: { argb: pal.pillFg(hue) } };
        } else if (k === 'units_concerned' && r.units_concerned) {
          // Excel can't give one cell several coloured pill backgrounds, so each team name is coloured text instead
          const teams = UNIT_TEAMS[r.units_concerned] || [];
          if (teams.length > 1) {
            cell.value = { richText: teams.flatMap((t, i) => [
              ...(i ? [{ text: ' / ', font: { color: { argb: pal.black } } }] : []),
              { text: t, font: { bold: true, color: { argb: pal.pillFg(TEAM_HUE[t]) } } },
            ]) };
          } else if (teams.length === 1) {
            cell.font = { bold: true, color: { argb: pal.pillFg(TEAM_HUE[teams[0]]) } };
          }
        } else if (k === 'plug_id' || k === 'prog_name') {
          cell.font = { bold: true };
        } else if (k === 'remarks') {
          cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
        }
      });
    });

    // Auto-size every column except Remarks (which wraps instead) so single-line values are never cropped.
    ws.columns.forEach((column) => {
      if (column.key === 'remarks') return;
      const f = fieldsExt[column.key];
      let max = String(f.label).length;
      if (f.kind === 'date') max = Math.max(max, 13);           // 'Sep 28, 2026'
      if (f.kind === 'datetime') max = Math.max(max, 22);       // 'Sep 28, 2026 11:45 PM'
      column.eachCell({ includeEmpty: false }, (cell) => {
        if ((f.kind === 'date' || f.kind === 'datetime') && cell.value instanceof Date) return; // already sized above
        if (column.key === 'audio_guide' && cell.value instanceof Date) { max = Math.max(max, 13); return; }
        max = Math.max(max, cellText(cell.value).length);
      });
      // +15% then +3: plain character-count math undershoots for this app's content, which is heavy with wide,
      // all-caps text (platform codes, plug IDs) — those render wider per character than Excel's column-width
      // unit assumes, so a flat "+3" isn't quite enough once the value gets some real length to it.
      column.width = Math.ceil(max * 1.15) + 3;   // no cap: the point is that nothing gets cropped
    });
  }
  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  const exportedAt = new Date();
  const stamp = `${MONTH_ABBR[exportedAt.getMonth()]}_${exportedAt.getFullYear()}`;   // month/year the export happened, not the data's date filter
  // Buffer the whole file and send it with an explicit Content-Length, rather than streaming it with chunked
  // transfer encoding straight to res: some reverse proxies (this app is commonly deployed behind one) can
  // truncate or mishandle a chunked response, which shows up as "the file format is invalid" when opened.
  const buffer = await wb.xlsx.writeBuffer();
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="Workload_${team || 'ALL'}_${stamp}.xlsx"`);
  res.set('Content-Length', String(buffer.length));
  res.end(buffer);
}));

router.post('/', requireAction('workload.write'), asyncH(async (req, res) => {
  const customCols = await loadCustomCols(db);
  const locks = await loadLocks(db);
  const id = await db.tx(async (c) => {
    const rec = await parseRow(c, req.body, null, customCols);
    assertNotLocked(locks, rec.work_date);
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
  const customCols = await loadCustomCols(db);
  const locks = await loadLocks(db);
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
          assertNotLocked(locks, cur.rows[0].work_date);
          const rec = await parseRow(c, row, cur.rows[0], customCols);
          assertNotLocked(locks, rec.work_date);
          await updateRow(c, id, rec, req.user.id);
          await audit(req, 'workload.update', 'workload_item', id, rec, c);
          updated++;
        } else {
          const rec = await parseRow(c, row, null, customCols);
          assertNotLocked(locks, rec.work_date);
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
  const customCols = await loadCustomCols(db);
  const customCol = customCols.find((c) => c.col_key === field);
  if (!COLS.includes(field) && !customCol) throw new HttpError(400, 'Unknown field');
  const locks = await loadLocks(db);
  if (customCol) {
    const curRow = await db.query('SELECT work_date FROM workload_items WHERE id=$1', [id]);
    if (!curRow.rows.length) throw new HttpError(404, 'Workload item not found');
    assertNotLocked(locks, curRow.rows[0].work_date);
    // Custom columns live in one shared JSONB blob; merge just this key so two people editing different
    // custom columns on the same row (or a custom column and a regular one) never overwrite each other.
    const value = v.str(req.body.value, { field: customCol.label, max: 2000 });
    const { rows } = await db.query(
      "UPDATE workload_items SET custom_fields = custom_fields || $2::jsonb, updated_by=$3, updated_at=now() WHERE id=$1 RETURNING id",
      [id, JSON.stringify({ [field]: value }), req.user.id]
    );
    if (!rows.length) throw new HttpError(404, 'Workload item not found');
    await audit(req, 'workload.update', 'workload_item', id, { field, value });
    return res.json({ ok: true, values: { [field]: value } });
  }
  const values = await db.tx(async (c) => {
    const found = await c.query('SELECT * FROM workload_items WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rows.length) throw new HttpError(404, 'Workload item not found');
    const cur = found.rows[0];
    assertNotLocked(locks, cur.work_date);
    const merged = {};
    COLS.forEach((k) => { merged[k] = cur[k]; });
    merged[field] = req.body.value;
    if (field === 'plug_id' && (!cur.platform || cur.platform === derivePlatform(cur.plug_id))) merged.platform = '';
    const rec = await parseRow(c, merged, cur, customCols);
    assertNotLocked(locks, rec.work_date);
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
  const customCols = await loadCustomCols(db);
  const locks = await loadLocks(db);
  await db.tx(async (c) => {
    const cur = await c.query(`SELECT ${CUR_COLS} FROM workload_items WHERE id=$1 FOR UPDATE`, [id]);
    if (!cur.rows.length) throw new HttpError(404, 'Workload item not found');
    assertNotLocked(locks, cur.rows[0].work_date);
    const rec = await parseRow(c, req.body, cur.rows[0], customCols);
    assertNotLocked(locks, rec.work_date);
    await updateRow(c, id, rec, req.user.id);
    await audit(req, 'workload.update', 'workload_item', id, rec, c);
  });
  res.json({ ok: true });
}));

router.delete('/:id', requireAction('workload.write'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const locks = await loadLocks(db);
  const cur = await db.query('SELECT work_date FROM workload_items WHERE id=$1', [id]);
  if (!cur.rows.length) throw new HttpError(404, 'Workload item not found');
  assertNotLocked(locks, cur.rows[0].work_date);
  const { rows } = await db.query(
    'DELETE FROM workload_items WHERE id=$1 RETURNING work_date, units_concerned, plug_id', [id]
  );
  if (!rows.length) throw new HttpError(404, 'Workload item not found');
  await audit(req, 'workload.delete', 'workload_item', id, rows[0]);
  res.json({ ok: true });
}));

// ---------- Import: reads a .xlsx shaped like this app's own Export (MAIN/AUDIO sheets, matching column
// headers) and creates rows from it. This is the reliable, testable round-trip case; importing the
// original per-day team template (a very different shape: one sheet per date per section) is not
// supported here — that needs its own dedicated pass against real sample files.
// A header that doesn't match any known field or existing custom column gets a new custom column created
// for it automatically, so nothing in the file is silently dropped.
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

router.post('/import', requireAction('workload.write'), upload.single('file'), asyncH(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch (e) {
    throw new HttpError(501, 'Import needs the "exceljs" package. Run "npm install" on the server, then restart.');
  }
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.file.buffer); } catch (e) {
    throw new HttpError(400, 'Could not read that file as an Excel workbook (.xlsx)');
  }
  // Sheet NAMES vary (MAIN/AUDIO for a full export, or just VGFX/VEDIT/AUDIO for a single-team export) but
  // every recognized sheet has the SAME shape: a header row of column labels. readSheet() below works from
  // the headers, not the sheet name, so every worksheet in the file is given a chance.

  let customCols = await loadCustomCols(db);
  let fieldsExt = extendFields(customCols);
  const labelToKey = {};
  Object.entries(fieldsExt).forEach(([k, f]) => { labelToKey[f.label.trim().toLowerCase()] = k; });
  const newColumns = [];

  async function keyForHeader(label) {
    const norm = label.trim().toLowerCase();
    if (labelToKey[norm]) return labelToKey[norm];
    const dupe = await db.query('SELECT col_key FROM workload_custom_columns WHERE lower(label)=$1', [norm]);
    let colKey;
    if (dupe.rows.length) {
      colKey = dupe.rows[0].col_key;
    } else {
      const created = await db.tx(async (c) => {
        const { rows: [{ id }] } = await c.query(
          'INSERT INTO workload_custom_columns (label, sort_order, created_by) VALUES ($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM workload_custom_columns), $2) RETURNING id',
          [label.trim(), req.user.id]
        );
        const { rows: [row] } = await c.query('UPDATE workload_custom_columns SET col_key=$2 WHERE id=$1 RETURNING col_key', [id, `custom_${id}`]);
        return row;
      });
      colKey = created.col_key;
      newColumns.push(label.trim());
    }
    labelToKey[norm] = colKey;
    fieldsExt[colKey] = { label: label.trim(), kind: 'text', multiline: true, max: 2000, custom: true };
    return colKey;
  }

  const cellText = (v) => (v && v.richText ? v.richText.map((t) => t.text).join('') : v);
  const isoDate = (d) => d.toISOString().slice(0, 10);
  const isoDateTime = (d) => d.toISOString().slice(0, 16);
  // A multi-team Units Concerned cell is exported as rich text ("VGFX / VEDIT", spaced for readability), which
  // doesn't match the exact stored value ("VGFX/VEDIT", no spaces). Reconstruct it from which team names appear,
  // rather than trusting the decorated text.
  function unitsFromCell(raw) {
    if (raw && raw.richText) {
      const teamNames = raw.richText.map((t) => t.text.trim()).filter((t) => TEAMS.includes(t));
      const hit = UNITS.find((u) => { const ts = UNIT_TEAMS[u]; return ts.length === teamNames.length && ts.every((t) => teamNames.includes(t)); });
      return hit || null;
    }
    return String(raw ?? '');
  }

  // A row that appears on both sheets (a VGFX/VEDIT/Audio plug is exported to both) is one logical row, keyed
  // by (Work Date, Plug ID) — merge instead of inserting it twice.
  const merged = new Map();
  async function readSheet(ws) {
    if (!ws || ws.rowCount < 2) return;
    const headerRow = ws.getRow(1);
    const colKeyAt = {};
    headerRow.eachCell((cell, colNumber) => {
      const label = String(cellText(cell.value) ?? '').trim();
      if (label && label.toLowerCase() !== 'actions') colKeyAt[colNumber] = null; // resolved below, after all headers are read
    });
    for (const colNumber of Object.keys(colKeyAt)) {
      const label = String(cellText(headerRow.getCell(Number(colNumber)).value) ?? '').trim();
      colKeyAt[colNumber] = await keyForHeader(label);
    }
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (row.cellCount === 0) continue;
      const obj = {};
      let hasAny = false;
      for (const [colNumber, key] of Object.entries(colKeyAt)) {
        let val = row.getCell(Number(colNumber)).value;
        if (val == null || val === '') continue;
        hasAny = true;
        const f = fieldsExt[key];
        if (key === 'units_concerned') obj[key] = unitsFromCell(val);
        else { val = cellText(val);
          if (f.kind === 'date') obj[key] = val instanceof Date ? isoDate(val) : String(val);
          else if (f.kind === 'datetime') obj[key] = val instanceof Date ? isoDateTime(val) : String(val);
          else if (key === 'audio_guide') obj[key] = val instanceof Date ? isoDate(val) : String(val);
          else obj[key] = String(val); }
      }
      if (!hasAny) continue;
      const rowKey = `${obj.work_date || ''}|||${String(obj.plug_id || '').split('\n')[0].trim()}`;
      merged.set(rowKey, { ...(merged.get(rowKey) || {}), ...obj });
    }
  }
  for (const ws of wb.worksheets) await readSheet(ws);
  if (merged.size === 0) {
    throw new HttpError(400, 'Nothing recognisable to import — expected column headers matching this app\'s '
      + 'fields (Work Date, Units Concerned, Plug ID, ...), the shape this app\'s own Export produces. '
      + 'Importing the original per-day team template is not supported yet.');
  }

  customCols = await loadCustomCols(db); // pick up anything auto-created above
  const locks = await loadLocks(db);
  let created = 0;
  const errors = [];
  await db.tx(async (c) => {
    for (const fields of merged.values()) {
      try {
        const rec = await parseRow(c, fields, null, customCols);
        assertNotLocked(locks, rec.work_date);
        const id = await insertRow(c, rec, req.user.id);
        await audit(req, 'workload.create', 'workload_item', id, { imported: true, plug_id: fields.plug_id }, c);
        created++;
      } catch (e) {
        errors.push(`${fields.plug_id || '(no Plug ID)'}: ${e instanceof HttpError ? e.message : 'unexpected error'}`);
      }
    }
  });
  res.json({ ok: true, created, skipped: errors.length, errors: errors.slice(0, 20), newColumns });
}));

module.exports = router;
