// Scheduled Excel export of the PSD Daily Plug List, Ingest Tracker and Workload Tracker.
//
// Each run produces the same workbooks as the pages' own Export buttons (it calls those very routes, so the look, columns and "separate tabs by date"
// behave exactly the same) and saves them in BACKUP_DIR/exports/<run>/. Admin > Backup > Scheduled export sets it up and lists / downloads the files.
//
// Settings (app_settings key `export_sched`, JSON):
//   enabled   boolean
//   time      'HH:MM' server time
//   range     'yesterday' | 'last_week' | 'last_month' | 'custom'
//   from, to  'YYYY-MM-DD' (custom only)
//   byDate    true = one tab per date ("separate data by date into tabs"), false = one tab per sheet as the Export button does by default
//   modules   { plugs, ingest, workload } which workbooks to make
//   keep      how many runs to keep on disk (older folders are removed)
// How often it runs follows the range: yesterday = every day, last week = every Monday, last month = the 1st, custom = every day (a fresh copy of that range).
// Last result: app_settings key `export_last` ({ at, runDate, ok, files, error, range }).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const db = require('./db');
const cfg = require('./backup/config');
const node = require('./node');

const KEY = 'export_sched';
const LAST = 'export_last';
const RANGES = ['yesterday', 'last_week', 'last_month', 'custom'];
const MODULES = [
  { key: 'plugs', label: 'PSD Daily Plug List' },
  { key: 'ingest', label: 'Ingest Tracker' },
  { key: 'workload', label: 'Workload Tracker' },
];
const DEFAULTS = { enabled: false, time: '06:00', range: 'yesterday', from: '', to: '', byDate: false, modules: { plugs: true, ingest: true, workload: true }, keep: 14 };
const DIR = () => path.join(cfg.BACKUP_DIR, 'exports');
const RUN_RE = /^\d{4}-\d{2}-\d{2}_\d{4}(?:-\d+)?$/;
const FILE_RE = /^[A-Za-z0-9_.\- ]{1,150}\.xlsx$/;
const SYSTEM = { user: { id: null, username: 'scheduler' }, ip: null };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(new Date(`${s}T00:00:00`).getTime()) && iso(new Date(`${s}T00:00:00`)) === s;

/** What the saved/entered values mean: always a complete, valid settings object (throws on bad input when `strict`). */
function normalize(raw, strict = false) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const bad = (m) => { if (strict) { const e = new Error(m); e.status = 400; throw e; } };
  const out = { ...DEFAULTS, modules: { ...DEFAULTS.modules } };
  out.enabled = r.enabled === true || r.enabled === 'true';
  if (r.time != null) { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.time))) out.time = String(r.time); else bad('Time must look like 06:00'); }
  if (r.range != null) { if (RANGES.includes(r.range)) out.range = r.range; else bad('Choose Yesterday, Last week, Last month or Custom'); }
  out.byDate = r.byDate === true || r.byDate === 'true';
  if (r.modules && typeof r.modules === 'object') for (const m of MODULES) if (m.key in r.modules) out.modules[m.key] = r.modules[m.key] === true || r.modules[m.key] === 'true';
  if (!Object.values(out.modules).some(Boolean)) bad('Choose at least one list to export');
  if (r.keep != null) {
    const n = parseInt(r.keep, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 120) out.keep = n; else bad('Keep between 1 and 120 exports');
  }
  if (out.range === 'custom') {
    out.from = String(r.from || ''); out.to = String(r.to || '');
    if (!isDate(out.from) || !isDate(out.to)) bad('Custom needs a From and a To date');
    else if (out.from > out.to) bad('From must not be after To');
    else if ((new Date(`${out.to}T00:00:00Z`) - new Date(`${out.from}T00:00:00Z`)) / 86400000 > 366) bad('Custom range can be at most one year');
  }
  return out;
}

/** The dates a range means on `now`: yesterday; last week = the Monday-Sunday before this one; last month = the calendar month before this one. */
function resolveRange(s, now = new Date()) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (s.range === 'custom') return { from: s.from, to: s.to };
  if (s.range === 'yesterday') { const y = new Date(day); y.setDate(y.getDate() - 1); return { from: iso(y), to: iso(y) }; }
  if (s.range === 'last_week') {
    const mon = new Date(day); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) - 7);
    const sun = new Date(mon); sun.setDate(sun.getDate() + 6);
    return { from: iso(mon), to: iso(sun) };
  }
  return { from: iso(new Date(day.getFullYear(), day.getMonth() - 1, 1)), to: iso(new Date(day.getFullYear(), day.getMonth(), 0)) };
}

/** Does a run belong on this day? yesterday / custom: every day; last week: Mondays; last month: the 1st. */
const runsOn = (s, d) => (s.range === 'last_week' ? d.getDay() === 1 : s.range === 'last_month' ? d.getDate() === 1 : true);

function nextRun(s, from = new Date()) {
  if (!s.enabled) return null;
  const [h, m] = s.time.split(':').map(Number);
  const d = new Date(from); d.setHours(h, m, 0, 0);
  for (let i = 0; i < 40; i++) {
    if (d > from && runsOn(s, d)) return d;
    d.setDate(d.getDate() + 1); d.setHours(h, m, 0, 0);
  }
  return null;
}

async function getSettings() {
  const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [KEY]);
  try { return normalize(rows[0] ? JSON.parse(rows[0].value) : {}); } catch (_) { return normalize({}); }
}
async function saveSettings(raw) {
  const s = normalize(raw, true);
  await db.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [KEY, JSON.stringify(s)]);
  return s;
}
async function getLast() {
  const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [LAST]);
  try { return rows[0] ? JSON.parse(rows[0].value) : null; } catch (_) { return null; }
}
const setLast = (v) => db.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [LAST, JSON.stringify(v)]);

// ---- Running the pages' own Export routes without a browser ----
let routers = null;
function loadRouters() {
  if (routers) return routers;
  const workload = require('./routes/workload');
  routers = { workload, ingest: require('./routes/ingest'), plugs: require('./routes/plugs')(workload.helpers) };
  return routers;
}

/** Call a router's GET /export with these query values as a system user (full access) and return { buffer, filename }. */
function callExport(router, query) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const req = {
      method: 'GET', url: '/export', originalUrl: '/export', baseUrl: '', path: '/export', query, params: {}, headers: {}, body: {}, session: {}, cookies: {},
      user: { id: null, username: 'scheduler', role: 'System Admin', full_name: 'Scheduled export' }, ip: null, ips: [], socket: {}, connection: {},
      get() { return ''; }, header() { return ''; },
    };
    const res = {
      statusCode: 200, headersSent: false, locals: {},
      set(k, v) { if (k && typeof k === 'object') Object.assign(headers, k); else headers[String(k).toLowerCase()] = v; return res; },
      setHeader(k, v) { return res.set(String(k).toLowerCase(), v); },
      getHeader(k) { return headers[String(k).toLowerCase()]; },
      status(c) { res.statusCode = c; return res; },
      json(o) { reject(Object.assign(new Error((o && o.error) || 'Export failed'), { status: res.statusCode })); },
      send(b) { done(b); },
      end(b) { done(b); },
    };
    const done = (b) => {
      const cd = String(headers['content-disposition'] || headers['Content-Disposition'] || '');
      const m = /filename="([^"]+)"/.exec(cd);
      if (res.statusCode >= 400 || !b || !m) return reject(new Error(res.statusCode >= 400 ? `Export refused (${res.statusCode})` : 'Export returned no file'));
      return resolve({ buffer: Buffer.isBuffer(b) ? b : Buffer.from(b), filename: m[1] });
    };
    try { router.handle(req, res, (err) => reject(err || new Error('Export route not found'))); } catch (e) { reject(e); }
  });
}

let running = false;
/**
 * Make the exports now. `source` is 'scheduled' or the Admin's username for "Run now". Returns the result that is also stored as the last run.
 * Never throws: a failure is recorded and reported in the result.
 */
async function run({ source = 'scheduled', actor = SYSTEM } = {}) {
  if (running) return { ok: false, error: 'An export is already running' };
  running = true;
  const started = new Date();
  const s = await getSettings();
  const range = resolveRange(s, started);
  const result = { at: started.toISOString(), runDate: iso(started), source, ok: true, range: { kind: s.range, ...range }, byDate: s.byDate, files: [], errors: [] };
  try {
    let runId = `${iso(started)}_${String(started.getHours()).padStart(2, '0')}${String(started.getMinutes()).padStart(2, '0')}`;
    await fsp.mkdir(DIR(), { recursive: true, mode: 0o700 });
    for (let n = 2; fs.existsSync(path.join(DIR(), runId)); n++) runId = `${runId.replace(/-\d+$/, '')}-${n}`;
    const folder = path.join(DIR(), runId);
    await fsp.mkdir(folder, { mode: 0o700 });
    result.run = runId;
    const r = loadRouters();
    const query = { from: range.from, to: range.to, ...(s.byDate ? { by_date: '1' } : {}) };
    for (const m of MODULES.filter((x) => s.modules[x.key])) {
      try {
        const { buffer, filename } = await callExport(r[m.key], { ...query });
        const safe = FILE_RE.test(filename) ? filename : `${m.key}.xlsx`;
        await fsp.writeFile(path.join(folder, safe), buffer, { mode: 0o600 });
        result.files.push({ module: m.key, label: m.label, name: safe, size: buffer.length });
      } catch (e) {
        result.errors.push({ module: m.key, label: m.label, error: String(e.message || e).slice(0, 200) });
      }
    }
    result.ok = result.errors.length === 0 && result.files.length > 0;
    if (!result.files.length) { await fsp.rmdir(folder).catch(() => {}); delete result.run; }
    await prune(s.keep);
  } catch (e) {
    result.ok = false; result.errors.push({ error: String(e.message || e).slice(0, 200) });
  }
  try { await setLast(result); } catch (_) { /* best effort */ }
  try {
    await require('./audit').audit(actor, 'admin.export_scheduled', 'export', null, { source, ok: result.ok, range: result.range, files: result.files.map((f) => f.name), errors: result.errors.map((e) => `${e.label || ''} ${e.error}`.trim()) });
  } catch (_) { /* best effort */ }
  running = false;
  return result;
}

/** The saved runs, newest first: [{ id, at, files: [{ name, size }] }] */
async function list() {
  let dirs = [];
  try { dirs = (await fsp.readdir(DIR(), { withFileTypes: true })).filter((d) => d.isDirectory() && RUN_RE.test(d.name)).map((d) => d.name); } catch (_) { return []; }
  dirs.sort().reverse();
  const out = [];
  for (const id of dirs) {
    const files = [];
    try {
      for (const f of await fsp.readdir(path.join(DIR(), id))) {
        if (!FILE_RE.test(f)) continue;
        const st = await fsp.stat(path.join(DIR(), id, f));
        files.push({ name: f, size: st.size, at: st.mtime.toISOString() });
      }
    } catch (_) { continue; }
    out.push({ id, at: files[0] ? files.reduce((a, f) => (f.at > a ? f.at : a), files[0].at) : null, files: files.sort((a, b) => a.name.localeCompare(b.name)) });
  }
  return out;
}

/** Absolute path of one saved file, or null (the names must match what is on disk: nothing from the URL is joined unchecked). */
async function fileOf(runId, name) {
  if (!RUN_RE.test(String(runId)) || !FILE_RE.test(String(name))) return null;
  const run = (await list()).find((r) => r.id === runId);
  const f = run && run.files.find((x) => x.name === name);
  return f ? { abs: path.join(DIR(), runId, name), size: f.size } : null;
}

async function prune(keep) {
  const runs = await list();
  for (const r of runs.slice(keep)) await fsp.rm(path.join(DIR(), r.id), { recursive: true, force: true }).catch(() => {});
}

let busyTick = false;
async function tick(now = new Date()) {
  if (busyTick || running || node.isBackup()) return false;
  busyTick = true;
  try {
    const s = await getSettings();
    if (!s.enabled || !runsOn(s, now)) return false;
    const [h, m] = s.time.split(':').map(Number);
    const due = new Date(now); due.setHours(h, m, 0, 0);
    if (now < due) return false;
    const last = await getLast();
    if (last && last.runDate === iso(now)) return false;   // once per day, even after a restart or a failed attempt
    await run({ source: 'scheduled' });
    return true;
  } catch (e) { console.error('[export-schedule]', e.message); return false; } finally { busyTick = false; }
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => { tick(); }, 60 * 1000);
  timer.unref();
}

module.exports = { MODULES, RANGES, DEFAULTS, normalize, resolveRange, runsOn, nextRun, getSettings, saveSettings, getLast, run, list, fileOf, prune, tick, start, isRunning: () => running };
