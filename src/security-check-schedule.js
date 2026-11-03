// Runs the security self-check by itself (every SECURITY_CHECK_HOURS, default 24; 0 = off) and tells the System Admins when something NEW is wrong.
//
// The last result is kept in app_settings ("sec_check_last"), so the Security page shows it without a new run, and every run, scheduled or by hand,
// is compared with the one before: an alert is sent only for a check that was fine (or not there) last time and is now "Fix now" or "Should fix",
// or one that got worse. A problem that was already known does not nag again. The first run on a new server alerts only if something needs fixing now.
const db = require('./db');

const KEY = 'sec_check_last';
const TICK_MS = 10 * 60 * 1000;
const hours = () => { const n = parseInt(process.env.SECURITY_CHECK_HOURS, 10); return Number.isFinite(n) && n >= 0 && n <= 720 ? n : 24; };
const RANK = { ok: 0, info: 0, warn: 1, fail: 2 };
const problems = (r) => Object.fromEntries(((r && r.checks) || []).filter((c) => RANK[c.status] > 0).map((c) => [c.id, c.status]));

async function last() {
  try {
    const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [KEY]);
    return rows[0] ? JSON.parse(rows[0].value) : null;
  } catch (_) { return null; }
}

/** Checks that are worse than in the previous result: [{ check, was }] (was = null when the check was fine or absent). */
function newProblems(prev, cur) {
  const before = prev ? problems(prev.result) : null;
  return cur.checks.filter((c) => RANK[c.status] > 0 && (!before || RANK[c.status] > (RANK[before[c.id]] || 0))).map((c) => ({ check: c, was: before ? before[c.id] || null : null }));
}

/** Keep this result as the one to compare with. Returns the checks that are newly wrong. `alert: false` for a run an Admin watched on screen. */
async function record(result, { source = 'auto', alert = true } = {}) {
  const prev = await last();
  const fresh = newProblems(prev, result);
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify({ at: result.at, source, result })]
  );
  // First run ever: only "fix now" items are worth an alert; later runs: anything that got worse.
  const worth = fresh.filter((f) => prev || f.check.status === 'fail');
  if (alert && worth.length) require('./security-watch').checkAlert(worth.map((f) => f.check), result);
  return fresh;
}

let running = false;
async function tick(force = false) {
  if (running || (!force && !hours())) return;
  if (require('./node').isBackup()) return;   // a backup server is read-only and mirrors the main one
  try {
    const prev = await last();
    if (!force && prev && Date.now() - new Date(prev.at).getTime() < hours() * 3600 * 1000) return;
    running = true;
    const result = await require('./security-check').run();
    await record(result, { source: 'auto' });
    console.log(`[security-check] scheduled run: ${result.fail} to fix now, ${result.warn} should fix, ${result.ok} ok`);
  } catch (e) { console.error('[security-check] scheduled run failed:', e.message); } finally { running = false; }
}

function start() {
  if (!hours()) { console.log('[security-check] automatic run is off (SECURITY_CHECK_HOURS=0)'); return; }
  setTimeout(() => tick(), 2 * 60 * 1000).unref();   // soon after start-up (only if the last run is old enough), then on a slow tick
  setInterval(() => tick(), TICK_MS).unref();
}

module.exports = { start, tick, record, last, newProblems, hours, KEY };
