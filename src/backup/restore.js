const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');
const db = require('../db');
const { HttpError } = require('../middleware');
const { audit } = require('../audit');
const { migrate } = require('../migrate');
const { SCHEMA_VERSION } = require('../version');
const cfg = require('./config');
const pg = require('./pg');
const svc = require('./service');
const analysis = require('./analysis');
const maintenance = require('./maintenance');
const { scanZip } = require('./archive');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sslOpt = process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined;
const trunc = (s) => String(s || '').slice(0, 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// DDL and restore need the owner login (BACKUP_DATABASE_URL), not the DML-only runtime login.
let ownerPool = null;
function owner() {
  if (!ownerPool) {
    ownerPool = new Pool({ connectionString: cfg.DATABASE_URL, ssl: sslOpt, max: 3 });
    ownerPool.on('error', (e) => console.error('[restore] owner pool error', e.message));
  }
  const pool = ownerPool;
  return {
    pool,
    query: (t, p) => pool.query(t, p),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(c);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { c.release(); }
    },
  };
}

// ---------- entry points ----------
async function start(req, analysisId) {
  const a = analysis.get(analysisId, req.user.id);
  if (a.status !== 'done' || !a.report) throw new HttpError(409, 'The analysis has not completed');
  const rep = a.report;
  if (rep.readiness.state === 'blocked' || rep.risk.blockers.length) throw new HttpError(409, 'Readiness checks failed; this backup cannot be restored');
  try { await fsp.stat(a.file); } catch (_) { throw new HttpError(410, 'The uploaded backup has expired. Upload and analyze it again.'); }
  clearTimeout(a.timer); // keep the uploaded file until the restore finishes
  return begin(req, {
    file: a.file, filename: a.filename, sizeBytes: a.sizeBytes, expectSha: a.sha256, risk: rep.risk.level,
    sourceBackupId: rep.backup && UUID.test(rep.backup.id) ? rep.backup.id : null,
    summaryBase: { analysisId: a.id, totals: rep.totals, riskReasons: rep.risk.reasons.map((r) => r.message).slice(0, 10) },
    onDone: () => analysis.discard(a),
  });
}

async function startRollback(req, restoreId) {
  const { rows } = await db.query(`SELECT id, status, summary FROM backup_jobs WHERE id=$1 AND kind='restore'`, [restoreId]);
  const failed = rows[0];
  if (!failed) throw new HttpError(404, 'Restore not found');
  if (failed.status !== 'failed') throw new HttpError(409, 'Only a failed restore can be rolled back');
  const preId = failed.summary && failed.summary.preRestoreBackupId;
  if (!preId) throw new HttpError(409, 'This restore has no pre-restore backup to roll back to');
  const { rows: pre } = await db.query(`SELECT * FROM backup_jobs WHERE id=$1 AND kind='create' AND status='succeeded' AND deleted_at IS NULL`, [preId]);
  if (!pre[0]) throw new HttpError(409, 'The pre-restore backup is no longer available');
  const file = svc.resolvePath(pre[0].rel_path);
  try { await fsp.stat(file); } catch (_) { throw new HttpError(404, 'The pre-restore backup file is missing from storage'); }
  return begin(req, {
    file, filename: pre[0].filename, sizeBytes: Number(pre[0].size_bytes), expectSha: pre[0].sha256, expectId: pre[0].id, risk: null,
    sourceBackupId: pre[0].id, skipPreBackup: true, rollbackOf: restoreId, summaryBase: { rollbackOf: restoreId },
  });
}

async function begin(req, ctx) {
  const release = await svc.acquire();
  let job;
  try {
    const { rows } = await db.query(
      `INSERT INTO backup_jobs (kind, status, progress, filename, size_bytes, sha256, risk_level, source_backup_id, note, summary, created_by, created_by_name, started_at)
       VALUES ('restore','running','Starting',$1,$2,$3,$4,$5,$6,$7,$8,$9,now()) RETURNING id`,
      [ctx.filename, ctx.sizeBytes, ctx.expectSha, ctx.risk, ctx.sourceBackupId, ctx.rollbackOf ? 'Rollback of a failed restore' : null,
        ctx.summaryBase || {}, req.user.id, req.user.username]
    );
    job = rows[0];
  } catch (e) { await release(); throw e; }
  maintenance.begin('Preparing restore');
  runRestore(job, req, ctx, release).catch((e) => console.error('[restore] crashed', e));
  return { id: job.id };
}

// ---------- workflow ----------
async function runRestore(job, req, ctx, release) {
  const t0 = Date.now();
  const id = job.id;
  const work = path.join(cfg.BACKUP_DIR, '.tmp', `restore-${id}`);
  const filesStage = path.join(cfg.UPLOADS_ROOT, `.restore-${id}`);
  const oldDir = path.join(cfg.UPLOADS_ROOT, `.restore-old-${id}`);
  const summary = { ...(ctx.summaryBase || {}), dbModified: false };
  const swapped = [];
  let snap = null;
  let jobsDropped = false;
  let historyRestored = false;
  let ownerDb = null;
  let meta = null;
  let outcome = 'failed';
  let errorMsg = null;
  const stage = (s) => maintenance.setStage(s);

  try {
    await sleep(1500); // let in-flight requests finish before anything is read or changed

    if (!ctx.skipPreBackup) {
      stage('Creating pre-restore backup');
      const pre = await createPreBackup(req, id);
      summary.preRestoreBackupId = pre.id;
      summary.preRestoreFilename = pre.filename;
    }

    stage('Validating manifest and checksums');
    const v = await svc.verifyFile(ctx.file, { id: ctx.expectId, sha256: ctx.expectSha });
    if (v.status !== 'ok') throw new Error(`Archive failed validation: ${v.checks.filter((c) => c.status === 'fail').map((c) => c.check).join(', ')}`);
    if (v.compat && v.compat.schema.status === 'newer') throw new Error('The backup schema is newer than this application');

    stage('Extracting archive');
    await fsp.mkdir(work, { recursive: true, mode: 0o700 });
    const first = await scanZip(ctx.file, { read: ['metadata.json', 'summary.json'] });
    meta = JSON.parse(first.texts['metadata.json']);
    const backupSummary = JSON.parse(first.texts['summary.json']);
    const extract = {};
    for (const e of first.entries) {
      let dest = null;
      if (e.name === 'database.dump') dest = path.join(work, 'database.dump');
      else if (e.name.startsWith('uploads/')) dest = path.join(filesStage, e.name.slice('uploads/'.length));
      if (!dest) continue;
      if (dest !== path.join(work, 'database.dump') && !dest.startsWith(filesStage + path.sep)) throw new Error('Unsafe path in archive');
      await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      extract[e.name] = dest;
    }
    for (const c of cfg.UPLOAD_COMPONENTS) await fsp.mkdir(path.join(filesStage, c), { recursive: true });
    const second = await scanZip(ctx.file, { extract });
    if (second.problems.length) throw new Error(`Extraction problems: ${second.problems[0]}`);
    const got = new Map(second.entries.map((e) => [e.name, e]));
    if (!got.has('database.dump') || got.get('database.dump').sha256 !== meta.dumpSha256) throw new Error('Extracted database dump does not match the manifest');
    for (const f of meta.files || []) {
      if (!got.has(f.path) || got.get(f.path).sha256 !== f.sha256) throw new Error(`Extracted file does not match the manifest: ${f.path}`);
    }
    const dumpPath = path.join(work, 'database.dump');
    const toc = await pg.inspectToc(dumpPath);
    if (toc.disallowed.length) throw new Error(`The dump contains unsupported objects: ${toc.disallowed.join(', ')}`);

    stage('Preserving audit trail and job history');
    snap = await takeSnapshot(work, req);
    const dumpTables = await pg.tocTables(dumpPath);
    ownerDb = owner();

    stage('Restoring database');
    if (!dumpTables.has('backup_jobs')) { // an older backup has no job table, and the live one blocks dropping users
      await ownerDb.query('DROP TABLE IF EXISTS backup_jobs');
      jobsDropped = true;
    }
    await pg.restoreLive(dumpPath);
    summary.dbModified = true;
    jobsDropped = true;

    stage('Applying schema upgrades');
    await migrate(ownerDb, { seed: false });

    stage('Re-applying audit trail and job history');
    await reinsertSnapshot(ownerDb, snap, req);
    historyRestored = true;
    await reapplyGrants(ownerDb);

    await fsp.mkdir(oldDir, { recursive: true });
    for (const comp of cfg.UPLOAD_COMPONENTS) {
      stage(`Restoring ${comp} files`);
      const live = path.join(cfg.UPLOADS_ROOT, comp);
      const parked = path.join(oldDir, comp);
      const hadLive = fs.existsSync(live);
      if (hadLive) await fsp.rename(live, parked);
      swapped.push({ comp, live, parked, hadLive });
      await fsp.rename(path.join(filesStage, comp), live);
    }

    stage('Running post-restore validation');
    const checks = await validate(ownerDb, backupSummary, meta);
    summary.validation = checks;
    const failed = checks.filter((c) => c.status === 'fail');
    if (failed.length) throw new Error(`Post-restore validation failed: ${failed.map((c) => c.check).join(', ')}`);
    outcome = 'succeeded';
  } catch (e) {
    errorMsg = trunc(e.message);
    console.error('[restore] failed:', e.message);
    // Put the previous files back if the swap only half happened; the database state is reported separately.
    for (const s of swapped.reverse()) {
      try {
        if (fs.existsSync(s.live)) await fsp.rm(s.live, { recursive: true, force: true });
        if (s.hadLive) await fsp.rename(s.parked, s.live); else await fsp.mkdir(s.live, { recursive: true });
      } catch (err) { console.error('[restore] could not restore previous files:', err.message); }
    }
    if (snap && jobsDropped && !historyRestored) {
      try { ownerDb = ownerDb || owner(); await migrate(ownerDb, { seed: false }); await reinsertSnapshot(ownerDb, snap, req); historyRestored = true; await reapplyGrants(ownerDb); } catch (err) { console.error('[restore] could not rebuild job history:', err.message); }
    }
  }

  const durationMs = Date.now() - t0;
  summary.durationMs = durationMs;
  try {
    ownerDb = ownerDb || owner();
    if (outcome === 'succeeded') {
      await ownerDb.query(
        `UPDATE backup_jobs SET status='succeeded', progress='Done', duration_ms=$2, summary=$3, finished_at=now() WHERE id=$1`, [id, durationMs, summary]);
      if (ctx.rollbackOf) await ownerDb.query(`UPDATE backup_jobs SET status='rolled_back' WHERE id=$1`, [ctx.rollbackOf]);
    } else {
      await ownerDb.query(`UPDATE backup_jobs SET status='failed', progress=NULL, error=$2, duration_ms=$3, summary=$4, finished_at=now() WHERE id=$1`, [id, errorMsg, durationMs, summary]);
    }
  } catch (e) { console.error('[restore] could not record the result:', e.message); }

  try {
    const auditReq = await safeAuditReq(req);
    await audit(auditReq, 'admin.backup_restore', 'backup', ctx.sourceBackupId || id, {
      outcome: outcome === 'succeeded' ? 'success' : 'failed', restoreJobId: id, filename: ctx.filename, sha256: ctx.expectSha,
      riskLevel: ctx.risk, preRestoreBackupId: summary.preRestoreBackupId || null, schemaFrom: meta ? meta.schemaVersion : null, schemaTo: SCHEMA_VERSION,
      impact: summary.totals || null, filesRestored: swapped.length > 0 && outcome === 'succeeded', dbModified: summary.dbModified,
      rollbackOf: ctx.rollbackOf || null, rolledBack: false, error: errorMsg, durationMs,
    });
  } catch (e) { console.error('[restore] audit failed:', e.message); }

  try {
    if (outcome === 'succeeded') await fsp.rm(oldDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(filesStage, { recursive: true, force: true }).catch(() => {});
    if (outcome !== 'succeeded' && summary.dbModified) {
      // Snapshots are the only copy of data that never made it back, so keep them out of the temp area that is wiped on boot.
      const keep = path.join(cfg.BACKUP_DIR, 'failed-restores', id);
      await fsp.mkdir(path.dirname(keep), { recursive: true, mode: 0o700 }).then(() => fsp.rename(work, keep)).catch(() => {});
    } else {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
    if (ownerPool) { const p = ownerPool; ownerPool = null; await p.end().catch(() => {}); }
  } finally {
    if (ctx.onDone) ctx.onDone();
    maintenance.end();
    await release();
  }
}

async function createPreBackup(req, restoreId) {
  const { rows } = await db.query(
    `INSERT INTO backup_jobs (kind, status, progress, note, created_by, created_by_name, started_at)
     VALUES ('create','running','Starting',$1,$2,$3,now()) RETURNING id`,
    [`Pre-restore backup (restore ${restoreId.slice(0, 8)})`, req.user.id, req.user.username]
  );
  const done = await svc.runCreate(rows[0], req, async () => {}); // the restore already holds the backup lock
  if (!done || done.status !== 'succeeded' || done.verify_status !== 'ok') throw new Error('The pre-restore backup failed, so the restore was aborted. Nothing was changed.');
  return done;
}

// ---------- preserved data ----------
async function takeSnapshot(work, req) {
  const jobs = (await db.query('SELECT to_jsonb(t) AS j FROM backup_jobs t')).rows.map((r) => r.j);
  const auditFile = path.join(work, 'snapshot-audit.jsonl');
  const out = fs.createWriteStream(auditFile, { mode: 0o600 });
  let last = 0; let count = 0;
  for (;;) {
    const { rows } = await db.query('SELECT id, to_jsonb(t) AS j FROM audit_logs t WHERE id > $1 ORDER BY id LIMIT 5000', [last]);
    if (!rows.length) break;
    for (const r of rows) { if (!out.write(`${JSON.stringify(r.j)}\n`)) await new Promise((res) => out.once('drain', res)); }
    last = Number(rows[rows.length - 1].id);
    count += rows.length;
  }
  await new Promise((res, rej) => { out.end(res); out.on('error', rej); });
  const sess = req.sessionID ? (await db.query('SELECT to_jsonb(s) AS j FROM user_sessions s WHERE sid=$1', [req.sessionID])).rows[0] : null;
  return { jobs, auditFile, auditCount: count, session: sess ? sess.j : null, adminId: req.user.id };
}

async function insertRows(ownerDb, table, rows, userCols, userIds) {
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000).map((r) => {
      const c = { ...r };
      for (const col of userCols) if (c[col] != null && !userIds.has(c[col])) c[col] = null;
      return c;
    });
    await ownerDb.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(null::${table}, $1::jsonb)`, [JSON.stringify(chunk)]);
  }
}

async function reinsertSnapshot(ownerDb, snap, req) {
  const userIds = new Set((await ownerDb.query('SELECT id FROM users')).rows.map((r) => r.id));
  await ownerDb.query('DELETE FROM backup_jobs');
  await insertRows(ownerDb, 'backup_jobs', snap.jobs, ['created_by', 'verified_by', 'deleted_by'], userIds);

  // The live audit trail always wins over the backup's copy.
  await ownerDb.query('DELETE FROM audit_logs');
  const lines = fs.createReadStream(snap.auditFile, { encoding: 'utf8' });
  let buf = ''; let batch = [];
  const flush = async () => { if (batch.length) { await insertRows(ownerDb, 'audit_logs', batch, ['user_id'], userIds); batch = []; } };
  for await (const chunk of lines) {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const p of parts) { if (p) batch.push(JSON.parse(p)); if (batch.length >= 2000) await flush(); }
  }
  if (buf) batch.push(JSON.parse(buf));
  await flush();
  await ownerDb.query(`SELECT setval(pg_get_serial_sequence('audit_logs','id'), m) FROM (SELECT max(id) AS m FROM audit_logs) x WHERE m IS NOT NULL`);

  // Only the acting admin's session survives, and only if that account still exists as an active Admin.
  if (snap.session) {
    const ok = await ownerDb.query(`SELECT 1 FROM users WHERE id=$1 AND role='Admin' AND is_active`, [snap.adminId]);
    if (ok.rowCount) await ownerDb.query('INSERT INTO user_sessions SELECT * FROM jsonb_populate_recordset(null::user_sessions, $1::jsonb) ON CONFLICT DO NOTHING', [JSON.stringify([snap.session])]);
  }
}

// Dropped and recreated tables lose their grants, which would lock a DML-only runtime login out.
async function reapplyGrants(ownerDb) {
  const rt = (await db.query('SELECT current_user AS u')).rows[0].u;
  const ow = (await ownerDb.query('SELECT current_user AS u')).rows[0].u;
  if (rt === ow) return;
  const q = (await ownerDb.query('SELECT quote_ident($1) AS q', [rt])).rows[0].q;
  for (const sql of [
    `GRANT USAGE ON SCHEMA public TO ${q}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${q}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${q}`,
    `REVOKE INSERT, UPDATE, DELETE ON roles FROM ${q}`,
    `REVOKE UPDATE, DELETE ON audit_logs FROM ${q}`,
  ]) await ownerDb.query(sql);
}

async function safeAuditReq(req) {
  try {
    const r = await db.query('SELECT 1 FROM users WHERE id=$1', [req.user.id]);
    if (r.rowCount) return req;
  } catch (_) { /* table may be unavailable */ }
  return { user: { id: null, username: req.user.username }, ip: req.ip };
}

// ---------- post-restore validation ----------
async function validate(ownerDb, backupSummary, meta) {
  const checks = [];
  const add = (check, status, detail) => checks.push({ check, status, detail });
  const tables = ['users', 'groups', 'dropdown_options', 'ingest_records', 'workload_items', 'knowledge_docs', 'audit_logs', 'app_settings', 'backup_jobs', 'roles'];
  const counts = {};
  try {
    for (const t of tables) counts[t] = (await ownerDb.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    add('Core tables readable', 'pass', `${tables.length} tables checked`);
  } catch (e) { add('Core tables readable', 'fail', trunc(e.message)); return checks; }

  const admins = (await ownerDb.query(`SELECT count(*)::int AS n FROM users WHERE role='Admin' AND is_active`)).rows[0].n;
  add('Administrator access', admins > 0 ? 'pass' : 'fail', `${admins} active Admin account(s)`);
  add('Roles present', counts.roles >= 4 ? 'pass' : 'fail', `${counts.roles} roles`);

  const ver = (await ownerDb.query('SELECT max(version) AS v FROM schema_migrations')).rows[0].v;
  add('Schema version', ver === SCHEMA_VERSION ? 'pass' : 'fail', `v${ver}, expected v${SCHEMA_VERSION}`);

  try {
    await db.query('SELECT count(*) FROM users');
    await db.query('SELECT count(*) FROM audit_logs');
    add('Application database access', 'pass', 'The runtime login can read the restored data');
  } catch (e) { add('Application database access', 'fail', trunc(e.message)); }

  const expected = backupSummary && backupSummary.tables ? backupSummary.tables : {};
  const live = { users: counts.users, groups: counts.groups, knowledge_docs: counts.knowledge_docs, ingest_records: counts.ingest_records, workload_items: counts.workload_items };
  const off = Object.keys(live).filter((k) => expected[k] != null && expected[k] !== live[k]);
  add('Record counts match the backup', off.length ? 'warn' : 'pass', off.length ? `Differences in ${off.join(', ')} (the backup counts were taken just before the dump)` : 'Counts agree with the backup summary');

  const { rows: docs } = await ownerDb.query('SELECT stored_name FROM knowledge_docs');
  const missing = docs.filter((d) => !fs.existsSync(path.join(cfg.UPLOADS_ROOT, 'knowledge', path.basename(d.stored_name)))).length;
  add('Knowledge files present', missing ? 'warn' : 'pass', missing ? `${missing} document record(s) have no file on disk` : `${docs.length} document file(s) found`);
  return checks;
}

module.exports = { start, startRollback };
