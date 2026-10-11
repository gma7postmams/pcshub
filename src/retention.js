// Data retention: how long the Audit Log, Ingest Tracker, Workload Tracker and PSD Daily Plug List keep their rows.
// Settings live in app_settings (ret_<module>_days, 0 = keep forever; ret_auto = 1 lets the daily scheduler apply them).
// Rows are written to a compressed archive file BEFORE they are deleted, so nothing disappears without a copy.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const db = require('./db');
const cfg = require('./backup/config');

const ARCHIVE_DIR = path.join(cfg.BACKUP_DIR, 'retention');
const CHUNK = 2000;
const MIN_DAYS = 30;       // the shortest period that can be set (0 = keep forever)
const MAX_DAYS = 3650;

// What "old" means for each module. A row must be old by its own date AND not touched since, so something still being worked on stays.
// `where` uses $1 = cutoff timestamp.
const MODULES = {
  audit: {
    label: 'Audit Log', table: 'audit_logs', basis: 'Entry date',
    where: 'created_at < $1', oldest: 'created_at',
  },
  ingest: {
    label: 'Ingest Tracker', table: 'ingest_records', basis: 'Episode date (or created date), and not edited since; only Approved or Rejected records',
    where: `status IN ('Approved','Rejected') AND COALESCE(episode_date, created_at::date) < $1::date AND updated_at < $1`,
    oldest: 'COALESCE(episode_date, created_at::date)',
    children: [{ table: 'approval_requests', fk: 'ingest_record_id' }],
  },
  workload: {
    label: 'Workload Tracker', table: 'workload_items', basis: 'Work date (or created date), and not edited since',
    where: 'COALESCE(work_date, created_at::date) < $1::date AND updated_at < $1', oldest: 'COALESCE(work_date, created_at::date)',
  },
  plugs: {
    label: 'PSD Daily Plug List', table: 'workload_plugs', basis: 'Plug date',
    where: 'plug_date < $1::date', oldest: 'plug_date',
  },
};
const KEY = (m) => `ret_${m}_days`;

async function getSettings() {
  const keys = [...Object.keys(MODULES).map(KEY), 'ret_auto'];
  const { rows } = await db.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [keys]);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = { auto: m.ret_auto === '1' };
  for (const k of Object.keys(MODULES)) {
    const n = parseInt(m[KEY(k)], 10);
    out[k] = Number.isFinite(n) && (n === 0 || (n >= MIN_DAYS && n <= MAX_DAYS)) ? n : 0;
  }
  return out;
}

async function saveSettings(s) {
  const rows = [...Object.keys(MODULES).map((k) => [KEY(k), String(s[k])]), ['ret_auto', s.auto ? '1' : '0']];
  for (const [key, value] of rows) {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, value]
    );
  }
}

const cutoffFor = (days) => new Date(Date.now() - days * 86400000);

/** What would go for each module at the given number of days (0 = nothing). */
async function preview(days) {
  const out = {};
  for (const [k, spec] of Object.entries(MODULES)) {
    const n = days[k] || 0;
    const total = (await db.query(`SELECT count(*)::int AS n FROM ${spec.table}`)).rows[0].n;
    const row = { total, days: n, due: 0, oldest: null };
    row.oldest = (await db.query(`SELECT min(${spec.oldest})::text AS d FROM ${spec.table}`)).rows[0].d;
    if (n > 0) row.due = (await db.query(`SELECT count(*)::int AS n FROM ${spec.table} WHERE ${spec.where}`, [cutoffFor(n)])).rows[0].n;
    out[k] = row;
  }
  return out;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

/** Archive then delete the rows of one module that are older than `days`. Returns { deleted, file, bytes }. */
async function runModule(k, days) {
  const spec = MODULES[k];
  if (!spec || !(days >= MIN_DAYS)) throw new Error('Retention period is not set');
  const cutoff = cutoffFor(days);
  const total = (await db.query(`SELECT count(*)::int AS n FROM ${spec.table} WHERE ${spec.where}`, [cutoff])).rows[0].n;
  if (!total) return { deleted: 0, file: null, bytes: 0 };

  await fsp.mkdir(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
  const file = `${k}-${stamp()}.jsonl.gz`;
  const abs = path.join(ARCHIVE_DIR, file);
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(abs, { mode: 0o600 });
  const done = pipeline(gz, out);
  const write = (obj) => new Promise((resolve, reject) => { gz.write(`${JSON.stringify(obj)}\n`, (e) => (e ? reject(e) : resolve())); });
  let deleted = 0;
  try {
    await write({ meta: { module: k, table: spec.table, cutoff: cutoff.toISOString(), days, createdAt: new Date().toISOString(), rows: total } });
    for (;;) {
      const { rows } = await db.query(`SELECT * FROM ${spec.table} WHERE ${spec.where} ORDER BY id LIMIT ${CHUNK}`, [cutoff]);
      if (!rows.length) break;
      const ids = rows.map((r) => r.id);
      for (const r of rows) await write({ t: spec.table, row: r });
      for (const c of spec.children || []) {
        const kids = await db.query(`SELECT * FROM ${c.table} WHERE ${c.fk} = ANY($1)`, [ids]);
        for (const r of kids.rows) await write({ t: c.table, row: r });
      }
      const res = await db.query(`DELETE FROM ${spec.table} WHERE id = ANY($2) AND ${spec.where}`, [cutoff, ids]);
      deleted += res.rowCount;
      if (rows.length < CHUNK) break;
    }
  } catch (e) {
    gz.end(); await done.catch(() => {});
    throw e;
  }
  gz.end();
  await done;
  const st = await fsp.stat(abs);
  return { deleted, file, bytes: st.size };
}

let running = false;
/** Apply the saved settings. `only` limits it to some modules. Returns per-module results. */
async function runAll(settings, only) {
  if (running) throw new Error('A retention run is already in progress');
  running = true;
  const results = {};
  try {
    for (const k of Object.keys(MODULES)) {
      if (only && !only.includes(k)) continue;
      if (!(settings[k] >= MIN_DAYS)) continue;
      results[k] = await runModule(k, settings[k]);
    }
  } finally { running = false; }
  require('./live').publish(Object.keys(results).filter((k) => k !== 'audit'));   // open trackers drop the rows that were just archived
  return results;
}

async function listArchives() {
  let names = [];
  try { names = await fsp.readdir(ARCHIVE_DIR); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const out = [];
  for (const n of names) {
    if (!/^[a-z]+-\d{8}-\d{6}\.jsonl\.gz$/.test(n)) continue;
    const st = await fsp.stat(path.join(ARCHIVE_DIR, n));
    out.push({ name: n, module: n.split('-')[0], bytes: st.size, at: st.mtime });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 100);
}

const archivePath = (name) => (/^[a-z]+-\d{8}-\d{6}\.jsonl\.gz$/.test(name) ? path.join(ARCHIVE_DIR, name) : null);

const { audit } = require('./audit');
const SYSTEM = { user: { id: null, username: 'scheduler' }, ip: null };
let lastAutoDay = '';
/** Called every minute by the scheduler; applies the saved settings once a day (after 03:00 server time) when automatic is on. */
async function autoTick() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (day === lastAutoDay || now.getHours() < 3) return;
  const s = await getSettings();
  if (!s.auto) return;
  lastAutoDay = day;
  try {
    const results = await runAll(s);
    if (Object.values(results).some((r) => r.deleted)) await audit(SYSTEM, 'admin.retention_run', 'retention', null, { trigger: 'scheduled', settings: s, results });
  } catch (e) { console.error('[retention]', e.message); }
}

module.exports = { autoTick, MODULES, MIN_DAYS, MAX_DAYS, getSettings, saveSettings, preview, runAll, listArchives, archivePath, ARCHIVE_DIR };
