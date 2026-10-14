// Clear data: an Admin picks areas (Ingest, Workload, Plug List, Audit Log, Notifications, User accounts, Groups) and a date range.
// Rows are written to a compressed archive (same folder and format as the retention archives) BEFORE they are deleted.
// Safe by design: System Admin accounts and the person running it are never removed; a group that still has users is kept.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const db = require('./db');
const { ARCHIVE_DIR } = require('./retention');

const CHUNK = 2000;
const KB_DIR = path.join(__dirname, '..', 'uploads', 'knowledge');
// $1 = from (date or null), $2 = to (date or null), $3 = the acting user's id (only where `self` is true)
const range = (expr) => `($1::date IS NULL OR ${expr} >= $1::date) AND ($2::date IS NULL OR ${expr} <= $2::date)`;
const AREAS = {
  ingest: { label: 'Ingest', basis: 'Episode date (or created date); every status, with its approval requests', table: 'ingest_records', date: 'COALESCE(episode_date, created_at::date)', children: [{ table: 'approval_requests', fk: 'ingest_record_id' }], live: 'ingest' },
  workload: { label: 'Workload', basis: 'Work date (or created date)', table: 'workload_items', date: 'COALESCE(work_date, created_at::date)', live: 'workload' },
  plugs: { label: 'PSD Daily Plug List', basis: 'Plug date', table: 'workload_plugs', date: 'plug_date', live: 'plugs' },
  knowledge: { label: 'Knowledge Base', basis: 'Date added; includes the Trash. The document files are deleted from the server too (only the list of items is archived)', table: 'knowledge_docs', date: 'created_at::date', files: 'stored_name' },
  audit: { label: 'Audit Log', basis: 'Entry date', table: 'audit_logs', date: 'created_at::date' },
  notifications: { label: 'Notifications', basis: 'Sent date', table: 'notifications', date: 'created_at::date' },
  users: {
    label: 'User access (accounts)', basis: 'Account created date. System Admins and you are never removed', table: 'users', date: 'created_at::date', self: true,
    extra: `role <> 'System Admin' AND id <> $3`, omit: ['password_hash', 'totp_secret', 'totp_last_step'],
  },
  groups: {
    label: 'Group access (groups and their pages)', basis: 'Group created date. A group that still has users is kept', table: 'groups', date: 'created_at::date',
    extra: 'NOT EXISTS (SELECT 1 FROM users u WHERE u.group_id = groups.id)', children: [{ table: 'group_permissions', fk: 'group_id' }],
  },
};
const ORDER = ['ingest', 'workload', 'plugs', 'knowledge', 'audit', 'notifications', 'users', 'groups'];   // users before groups, so emptied groups can go too

const where = (a) => [a.extra, range(a.date)].filter(Boolean).join(' AND ');
const args = (a, from, to, uid) => (a.self ? [from, to, uid] : [from, to]);

async function preview(from, to, uid) {
  const out = {};
  for (const k of ORDER) {
    const a = AREAS[k];
    const total = (await db.query(`SELECT count(*)::int AS n FROM ${a.table}`)).rows[0].n;
    const hit = (await db.query(`SELECT count(*)::int AS n FROM ${a.table} WHERE ${where(a)}`, args(a, from, to, uid))).rows[0].n;
    out[k] = { total, hit };
  }
  // groups: how many matching groups are being kept because people are still in them
  out.groups.kept = (await db.query(`SELECT count(*)::int AS n FROM groups WHERE ${range('created_at::date')} AND EXISTS (SELECT 1 FROM users u WHERE u.group_id = groups.id)`, [from, to])).rows[0].n;
  return out;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

async function clearArea(k, from, to, uid) {
  const a = AREAS[k];
  const p = args(a, from, to, uid);
  const total = (await db.query(`SELECT count(*)::int AS n FROM ${a.table} WHERE ${where(a)}`, p)).rows[0].n;
  if (!total) return { deleted: 0, file: null, bytes: 0 };
  await fsp.mkdir(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
  const file = `${k}-${stamp()}.jsonl.gz`;
  const abs = path.join(ARCHIVE_DIR, file);
  const gz = zlib.createGzip();
  const done = pipeline(gz, fs.createWriteStream(abs, { mode: 0o600 }));
  const write = (obj) => new Promise((resolve, reject) => { gz.write(`${JSON.stringify(obj)}\n`, (e) => (e ? reject(e) : resolve())); });
  const strip = (r) => { const c = { ...r }; for (const f of a.omit || []) delete c[f]; return c; };
  let deleted = 0;
  try {
    await write({ meta: { module: k, kind: 'clear', table: a.table, from, to, createdAt: new Date().toISOString(), rows: total, omitted: a.omit || undefined } });
    for (;;) {
      const key = a.table === 'group_permissions' ? 'group_id' : 'id';
      const { rows } = await db.query(`SELECT * FROM ${a.table} WHERE ${where(a)} ORDER BY ${key} LIMIT ${CHUNK}`, p);
      if (!rows.length) break;
      const ids = rows.map((r) => r[key]);
      for (const r of rows) await write({ t: a.table, row: strip(r) });
      for (const c of a.children || []) {
        const kids = await db.query(`SELECT * FROM ${c.table} WHERE ${c.fk} = ANY($1)`, [ids]);
        for (const r of kids.rows) await write({ t: c.table, row: r });
      }
      if (k === 'users') await db.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = ANY($1)`, [ids]);
      const res = await db.query(`DELETE FROM ${a.table} WHERE ${key} = ANY($${p.length + 1}) AND ${where(a)}${a.files ? ` RETURNING ${a.files}` : ''}`, [...p, ids]);
      deleted += res.rowCount;
      if (a.files) for (const r of res.rows) if (r[a.files]) fs.unlink(path.join(KB_DIR, path.basename(r[a.files])), () => {});
      if (rows.length < CHUNK) break;
    }
  } catch (e) { gz.end(); await done.catch(() => {}); throw e; }
  gz.end(); await done;
  return { deleted, file, bytes: (await fsp.stat(abs)).size };
}

let running = false;
async function run(areas, from, to, uid) {
  if (running) throw new Error('A clear-data run is already in progress');
  running = true;
  const results = {};
  try { for (const k of ORDER) if (areas.includes(k)) results[k] = await clearArea(k, from, to, uid); } finally { running = false; }
  require('./live').publish(ORDER.filter((k) => results[k] && AREAS[k].live).map((k) => AREAS[k].live));
  return results;
}

module.exports = { AREAS, ORDER, preview, run };
