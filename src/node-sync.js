// Backup server: every NODE_SYNC_HOURS (and on "Sync now") pull a fresh backup from the main server and restore it over this one.
// Steps: ask the main server to make a backup -> wait for it -> download it (checked against its SHA-256) -> restore it
// (the same restore the Backup and Restore tab uses, without the questions) -> note the result in the role file.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const db = require('./db');
const cfg = require('./backup/config');
const node = require('./node');

const POLL_MS = 5000;
const SNAPSHOT_WAIT_MS = 45 * 60 * 1000;
const RESTORE_WAIT_MS = 90 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADERS = () => ({ Authorization: `Bearer ${node.token()}`, 'X-Requested-With': 'PromoHub' });

let running = null;   // { startedAt, step }
const isRunning = () => Boolean(running);
const progress = () => (running ? { startedAt: running.startedAt, step: running.step } : null);

async function call(method, urlPath, { timeout = 30000, raw = false } = {}) {
  const res = await fetch(`${node.mainUrl()}/api/node-sync${urlPath}`, { method, headers: HEADERS(), signal: AbortSignal.timeout(timeout), redirect: 'error' });
  if (raw) return res;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `The main server answered ${res.status}`);
  return body;
}

/** Can the main server be reached right now? Used by the tab and by Promote (never promote while the main one still answers). */
async function probeMain() {
  if (!node.mainUrl() || !node.tokenOk()) return { ok: false, error: 'NODE_MAIN_URL / NODE_SYNC_TOKEN are not set' };
  try { const r = await call('GET', '/info', { timeout: 4000 }); return { ok: true, schema: r.schema }; } catch (e) { return { ok: false, error: e.cause && e.cause.code ? e.cause.code : e.message }; }
}

async function syncOnce({ manual = false } = {}) {
  if (running) throw new Error('A sync is already running');
  if (!node.isBackup()) throw new Error('This server is the main server');
  if (!node.mainUrl() || !node.tokenOk()) throw new Error('Set NODE_MAIN_URL and NODE_SYNC_TOKEN (24+ characters) in .env first');
  const svc = require('./backup/service');
  if (svc.isBusy()) throw new Error('Another backup operation is running here');
  const t0 = Date.now();
  running = { startedAt: new Date(t0).toISOString(), step: 'Asking the main server for a backup' };
  node.save({ lastAttempt: { at: running.startedAt, manual } });
  let file = null;
  let result;
  try {
    const { id } = await call('POST', '/snapshot', { timeout: 60000 });
    let info;
    const until = Date.now() + SNAPSHOT_WAIT_MS;
    for (;;) {
      running.step = 'The main server is making the backup';
      info = await call('GET', `/snapshot/${id}`);
      if (info.status === 'succeeded') break;
      if (info.status === 'failed') throw new Error(`The main server could not make the backup: ${info.error || 'unknown error'}`);
      if (Date.now() > until) throw new Error('Timed out waiting for the main server to finish its backup');
      await sleep(POLL_MS);
    }

    running.step = 'Downloading the backup';
    await fsp.mkdir(path.join(cfg.BACKUP_DIR, '.tmp'), { recursive: true, mode: 0o700 });
    file = path.join(cfg.BACKUP_DIR, '.tmp', `node-sync-${id}.zip`);
    const res = await call('GET', `/snapshot/${id}/download`, { raw: true, timeout: SNAPSHOT_WAIT_MS });
    if (!res.ok || !res.body) throw new Error(`The download failed (${res.status})`);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const tap = new (require('stream').Transform)({ transform(chunk, enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); } });
    await pipeline(Readable.fromWeb(res.body), tap, fs.createWriteStream(file, { mode: 0o600 }));
    const sha = hash.digest('hex');
    if (info.sha256 && sha !== info.sha256) throw new Error('The downloaded backup does not match its checksum');
    if (info.size != null && bytes !== info.size) throw new Error('The downloaded backup is incomplete');

    running.step = 'Restoring the backup here';
    const restore = require('./backup/restore');
    const job = await restore.startNodeSync({ file, filename: info.filename || path.basename(file), sizeBytes: bytes, sha256: sha },
      () => { fsp.rm(file, { force: true }).catch(() => {}); });
    const stop = Date.now() + RESTORE_WAIT_MS;
    for (;;) {
      await sleep(POLL_MS);
      let row = null;
      try { row = (await db.query(`SELECT status, error FROM backup_jobs WHERE id=$1`, [job.id])).rows[0]; } catch (_) { /* the database is being replaced: ask again */ }
      if (row && row.status === 'succeeded') break;
      if (row && row.status === 'failed') throw new Error(`The restore failed: ${row.error || 'unknown error'}`);
      if (Date.now() > stop) throw new Error('Timed out waiting for the restore to finish');
    }
    result = { at: new Date().toISOString(), ok: true, durationMs: Date.now() - t0, sizeBytes: bytes, manual };
  } catch (e) {
    result = { at: new Date().toISOString(), ok: false, error: String(e.message || e).slice(0, 300), durationMs: Date.now() - t0, manual };
    console.error('[node-sync] failed:', e.message);
    if (file) fsp.rm(file, { force: true }).catch(() => {});
  } finally { running = null; }
  node.save({ ...(result.ok ? { lastSync: result } : {}), lastAttempt: result });   // lastSync = the last GOOD copy; lastAttempt = the latest try, good or not
  return result;
}

/** When the next automatic sync is due, or null when this server is not a backup server. */
function nextDue() {
  if (!node.isBackup()) return null;
  const s = node.get();
  const last = s.lastAttempt && !s.lastAttempt.ok ? new Date(s.lastAttempt.at).getTime() + RETRY_AFTER_FAILURE_MS
    : (s.lastSync && s.lastSync.ok ? new Date(s.lastSync.at).getTime() + node.syncHours() * 3600 * 1000 : 0);
  return new Date(Math.max(last, 0));
}

let timer = null;
function start() {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => {
    if (!node.isBackup() || running || !node.mainUrl() || !node.tokenOk()) return;
    if (Date.now() >= nextDue().getTime()) syncOnce().catch((e) => console.error('[node-sync]', e.message));
  }, 60 * 1000);
  timer.unref();
  // first sync shortly after start-up, not an hour later
  setTimeout(() => { if (node.isBackup() && !running && node.mainUrl() && node.tokenOk() && Date.now() >= nextDue().getTime()) syncOnce().catch((e) => console.error('[node-sync]', e.message)); }, 20000).unref();
}

module.exports = { syncOnce, probeMain, isRunning, progress, nextDue, start };
