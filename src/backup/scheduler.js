// Automatic backups. The schedule lives in app_settings (so Admin can change it without a restart):
//   backup_schedule  'off' | 'daily' | 'weekly'      backup_time 'HH:MM' (server time)
//   backup_weekday   0-6 (0 = Sunday, weekly only)   backup_keep  how many backups to keep (oldest are removed)
// A tick runs every minute; a backup is started once per due day. Single Node process, like the rest of the app.
const db = require('../db');
const cfg = require('./config');
const svc = require('./service');
const { audit } = require('../audit');

const KEYS = ['backup_schedule', 'backup_time', 'backup_weekday', 'backup_keep'];
const STALE_DAYS = 2;
const SYSTEM = { user: { id: null, username: 'scheduler' }, ip: null };

async function getSchedule() {
  const { rows } = await db.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [KEYS]);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const keep = parseInt(m.backup_keep, 10);
  const day = parseInt(m.backup_weekday, 10);
  return {
    mode: ['daily', 'weekly'].includes(m.backup_schedule) ? m.backup_schedule : 'off',
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(m.backup_time || '') ? m.backup_time : '02:00',
    weekday: day >= 0 && day <= 6 ? day : 0,
    keep: keep >= 1 ? Math.min(keep, cfg.MAX_BACKUPS) : Math.min(14, cfg.MAX_BACKUPS),
  };
}

async function saveSchedule(s) {
  const vals = { backup_schedule: s.mode, backup_time: s.time, backup_weekday: String(s.weekday), backup_keep: String(s.keep) };
  for (const [key, value] of Object.entries(vals)) {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, value]
    );
  }
}

/** When the next automatic backup is due (a Date), or null when switched off. */
function nextRun(s, from = new Date()) {
  if (s.mode === 'off') return null;
  const [h, m] = s.time.split(':').map(Number);
  const d = new Date(from); d.setHours(h, m, 0, 0);
  for (let i = 0; i < 9; i++) {
    if (d > from && (s.mode === 'daily' || d.getDay() === s.weekday)) return d;
    d.setDate(d.getDate() + 1);
  }
  return null;
}

/** Last successful backup and whether it is too old to trust. */
async function status() {
  const s = await getSchedule();
  const [last, fail, count] = await Promise.all([
    db.query(`SELECT id, COALESCE(finished_at, created_at) AS at, size_bytes, created_by_name FROM backup_jobs
               WHERE kind='create' AND status='succeeded' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`),
    db.query(`SELECT COALESCE(finished_at, created_at) AS at, error FROM backup_jobs
               WHERE kind='create' AND status='failed' ORDER BY created_at DESC LIMIT 1`),
    db.query(`SELECT count(*)::int AS n FROM backup_jobs WHERE kind='create' AND status='succeeded' AND deleted_at IS NULL`),
  ]);
  const l = last.rows[0] || null;
  const ageMs = l ? Date.now() - new Date(l.at).getTime() : null;
  const f = fail.rows[0] || null;
  return {
    schedule: s, next: nextRun(s), count: count.rows[0].n, maxBackups: cfg.MAX_BACKUPS, staleDays: STALE_DAYS,
    last: l ? { id: l.id, at: l.at, size: l.size_bytes == null ? null : Number(l.size_bytes), by: l.created_by_name } : null,
    stale: !l || ageMs > STALE_DAYS * 86400000,
    lastFailure: f && (!l || new Date(f.at) > new Date(l.at)) ? { at: f.at, error: String(f.error || '').slice(0, 200) } : null,
  };
}

async function applyRetention(keep) {
  const { rows } = await db.query(
    `SELECT id FROM backup_jobs WHERE kind='create' AND status='succeeded' AND deleted_at IS NULL
      ORDER BY created_at DESC OFFSET $1`, [keep]
  );
  for (const r of rows) {
    try {
      await svc.remove(r.id, SYSTEM);
      await audit(SYSTEM, 'admin.backup_delete', 'backup', r.id, { reason: 'retention', keep });
    } catch (e) { console.error('[backup] retention', e.message); }
  }
  return rows.length;
}

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const s = await getSchedule();
    if (s.mode === 'off') return;
    await applyRetention(s.keep);
    const now = new Date();
    if (s.mode === 'weekly' && now.getDay() !== s.weekday) return;
    const [h, m] = s.time.split(':').map(Number);
    const due = new Date(now); due.setHours(h, m, 0, 0);
    if (now < due) return;
    // Once per due time: skip when anything (manual or automatic) was started since then.
    const { rows } = await db.query(`SELECT 1 FROM backup_jobs WHERE kind='create' AND created_at >= $1 LIMIT 1`, [due]);
    if (rows.length) return;
    await applyRetention(Math.max(1, s.keep - 1));    // room for the new one
    try {
      const job = await svc.startCreate(SYSTEM, { note: 'Scheduled backup' });
      await audit(SYSTEM, 'admin.backup_scheduled', 'backup', job.id, { mode: s.mode, time: s.time });
    } catch (e) {
      // Record the failure once for today, so the banner and the audit log show it (the guard above stops a retry storm).
      await db.query(
        `INSERT INTO backup_jobs (kind, status, note, error, created_by_name, started_at, finished_at)
         VALUES ('create','failed','Scheduled backup',$1,'scheduler',now(),now())`, [String(e.message).slice(0, 500)]
      );
      await audit(SYSTEM, 'admin.backup_scheduled', 'backup', null, { outcome: 'failed', error: String(e.message).slice(0, 300) });
    }
  } catch (e) {
    console.error('[backup] scheduler', e.message);
  } finally { busy = false; }
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(tick, 60 * 1000);
  timer.unref();
}

module.exports = { getSchedule, saveSchedule, nextRun, status, start, tick, STALE_DAYS };
