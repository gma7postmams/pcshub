const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const db = require('../db');
const { HttpError } = require('../middleware');
const { audit } = require('../audit');
const cfg = require('./config');
const pg = require('./pg');
const svc = require('./service');
const { scanZip } = require('./archive');
const { compareTables, compareCounts, compareFiles } = require('./compare');
const { assess } = require('./risk');

const MAX_HELD = 3;
const analyses = new Map();
const sslOpt = process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined;
const trunc = (s) => String(s || '').slice(0, 300);
const major = (v) => String(v || '').split('.')[0];

const pub = (a) => ({
  id: a.id, status: a.status, stage: a.stage, filename: a.filename, sizeBytes: a.sizeBytes, sha256: a.sha256,
  error: a.error, createdAt: a.createdAt, expiresAt: a.expiresAt, report: a.report,
});

function discard(a) {
  clearTimeout(a.timer);
  analyses.delete(a.id);
  fsp.rm(a.file, { force: true }).catch(() => {});
}

function get(id, userId) {
  const a = analyses.get(id);
  if (!a || a.userId !== userId) throw new HttpError(404, 'Analysis not found or expired');
  return a;
}

const urlFor = (dbName) => {
  const u = new URL(cfg.DATABASE_URL);
  u.pathname = `/${encodeURIComponent(dbName)}`;
  return u.toString();
};
const connect = async (url) => { const c = new Client({ connectionString: url, ssl: sslOpt }); await c.connect(); return c; };

async function withAdminClient(fn) {
  const c = await connect(cfg.DATABASE_URL);
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}
const createScratch = async () => {
  const name = `pcshub_analyze_${crypto.randomBytes(6).toString('hex')}`;
  await withAdminClient((c) => c.query(`CREATE DATABASE "${name}"`));
  return name;
};
const dropScratch = (name) => withAdminClient((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));

const activeAdmins = async (runner) => (await runner.query(`SELECT count(*)::int AS n FROM users WHERE role = 'Admin' AND is_active`)).rows[0].n;

/** Called after the upload is on disk. Throws 409 when another backup operation holds the lock. */
async function start(req, file, originalName) {
  const head = Buffer.alloc(4);
  const fd = await fsp.open(file.path, 'r');
  try { await fd.read(head, 0, 4, 0); } finally { await fd.close(); }
  if (!head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new HttpError(400, 'The uploaded file is not a ZIP archive');

  const release = await svc.acquire();
  while (analyses.size >= MAX_HELD) discard(analyses.values().next().value);
  const now = Date.now();
  const a = {
    id: crypto.randomBytes(12).toString('hex'), userId: req.user.id, status: 'running', stage: 'Starting',
    file: file.path, filename: path.basename(originalName || 'backup.zip').replace(/[^\x20-\x7e]/g, '').slice(0, 120) || 'backup.zip',
    sizeBytes: file.size, sha256: null, error: null, report: null, createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + cfg.ANALYSIS_TTL_MS).toISOString(),
  };
  a.timer = setTimeout(() => discard(a), cfg.ANALYSIS_TTL_MS);
  a.timer.unref();
  analyses.set(a.id, a);
  run(a, req, release).catch((e) => console.error('[backup] analysis crashed', e));
  return pub(a);
}

async function run(a, req, release) {
  const t0 = Date.now();
  const work = path.join(cfg.QUARANTINE_DIR, `${a.id}.work`);
  let scratch = null;
  let bakDb = null;
  let meta = null;
  let report = null;
  try {
    await fsp.mkdir(work, { recursive: true, mode: 0o700 });
    a.stage = 'Verifying archive structure';
    const verify = await svc.verifyFile(a.file, {});
    a.sha256 = verify.sha256 || null;
    const verifyFailed = verify.status === 'failed';

    const [currentCounts, env, serverVer] = await Promise.all([svc.collectCounts(), svc.environment(), db.query('SHOW server_version')]);
    const currentPg = serverVer.rows[0].server_version;
    const dumpPath = path.join(work, 'database.dump');
    let summary = null;
    let tables = null;
    let files = {};
    let mode = 'counts-only';
    let modeReason = verifyFailed ? 'The archive failed verification, so its contents were not opened.' : null;
    let disallowed = [];
    let dumpChecked = false;
    let adminsBackup = null;

    if (!verifyFailed) {
      a.stage = 'Reading manifest';
      const scan = await scanZip(a.file, { read: ['metadata.json', 'summary.json'], extract: { 'database.dump': dumpPath } });
      meta = JSON.parse(scan.texts['metadata.json']);
      summary = JSON.parse(scan.texts['summary.json']);

      if (env.pgRestore.ok) {
        a.stage = 'Checking dump contents';
        disallowed = (await pg.inspectToc(dumpPath)).disallowed;
        dumpChecked = true;
      } else modeReason = 'pg_restore is not available on this host.';

      if (dumpChecked && !disallowed.length) {
        a.stage = 'Restoring into a scratch database';
        try {
          scratch = await createScratch();
          await pg.restoreInto(dumpPath, scratch);
          bakDb = await connect(urlFor(scratch));
          a.stage = 'Comparing database records';
          tables = await compareTables(db, bakDb);
          adminsBackup = await activeAdmins(bakDb);
          mode = 'full';
        } catch (e) {
          tables = null;
          modeReason = `Scratch comparison unavailable: ${trunc(e.message)}`;
        }
      }
      a.stage = 'Comparing files';
      files = await compareFiles(meta.files);
    }
    if (!tables) tables = compareCounts(currentCounts, summary && summary.tables);

    a.stage = 'Assessing risk';
    const adminsCurrent = await activeAdmins(db);
    const compat = verify.compat;
    const ageDays = meta ? (Date.now() - new Date(meta.createdAt).getTime()) / 86400000 : null;
    const risk = assess({
      verifyFailed, signature: verify.signature, compat, mode, tables, files,
      admins: { current: adminsCurrent, backup: adminsBackup },
      ageDays, hostMatch: meta ? meta.hostname === os.hostname() : null, dbMatch: meta ? meta.databaseName === pg.databaseName() : null,
      pgMajorMismatch: meta ? major(meta.pgServerVersion) !== major(currentPg) : false,
      disallowed, knowledgeGaps: meta && meta.reconciliation ? meta.reconciliation.knowledgeRowsWithoutFile : 0,
    });

    const free = env.freeBytes;
    const { rows: stored } = await db.query(`SELECT count(*)::int AS n FROM backup_jobs WHERE kind='create' AND status='succeeded' AND deleted_at IS NULL`);
    const sig = {
      valid: ['pass', 'Signature verified'], unsigned: ['warn', 'Backup is unsigned'],
      no_key: ['warn', 'Signed, but no signing key is configured here'], invalid: ['fail', 'Signature does not match'],
    }[verify.signature] || ['warn', 'Not checked'];
    const readinessChecks = [
      { check: 'Archive integrity', status: verifyFailed ? 'fail' : 'pass', detail: verifyFailed ? 'Verification failed; see Structure Verification' : 'Structure, hashes and manifest are valid' },
      { check: 'Signature', status: sig[0], detail: sig[1] },
      { check: 'Dump contents', status: disallowed.length ? 'fail' : dumpChecked ? 'pass' : 'warn', detail: disallowed.length ? `Unsupported objects: ${disallowed.join(', ')}` : dumpChecked ? 'Only expected table, index and sequence objects' : 'Not inspected' },
      { check: 'Schema compatibility', status: !compat ? 'warn' : compat.schema.status === 'same' ? 'pass' : compat.schema.status === 'older' ? 'warn' : 'fail', detail: compat ? `Backup v${compat.schema.backup}, application v${compat.schema.current}` : 'Unknown' },
      { check: 'Row-level comparison', status: mode === 'full' ? 'pass' : 'warn', detail: mode === 'full' ? 'Compared against a scratch copy of the backup' : modeReason || 'Counts only' },
      { check: 'Administrator access', status: adminsBackup === null ? 'warn' : adminsBackup > 0 ? 'pass' : 'fail', detail: adminsBackup === null ? 'Could not be determined' : `${adminsBackup} active Admin account(s) in the backup` },
      { check: 'Disk space', status: free == null ? 'warn' : free >= a.sizeBytes * 3 ? 'pass' : 'fail', detail: free == null ? 'Free space unknown' : `${Math.round(free / 1048576)} MB free; about 3x the archive size is needed` },
      { check: 'Pre-restore backup capacity', status: stored[0].n < cfg.MAX_BACKUPS ? 'pass' : 'warn', detail: `${stored[0].n} of ${cfg.MAX_BACKUPS} backup slots used` },
    ];
    const blocked = risk.blockers.length > 0 || readinessChecks.some((c) => c.status === 'fail');
    const state = blocked ? 'blocked' : (risk.level !== 'LOW' || readinessChecks.some((c) => c.status === 'warn')) ? 'caution' : 'ready';

    const totals = { added: 0, removed: 0, modified: 0 };
    for (const t of [...tables, ...Object.values(files)]) {
      if (!t.detail) continue;
      totals.added += t.added; totals.removed += t.removed; totals.modified += t.modified;
    }
    report = {
      source: { filename: a.filename, sizeBytes: a.sizeBytes, sha256: a.sha256 },
      backup: meta && {
        id: meta.backupId, createdAt: meta.createdAt, createdBy: meta.createdBy && meta.createdBy.username, appVersion: meta.app && meta.app.version,
        schemaVersion: meta.schemaVersion, pgServerVersion: meta.pgServerVersion, hostname: meta.hostname, databaseName: meta.databaseName,
        signature: verify.signature, ageDays: Math.floor(ageDays),
      },
      current: { appVersion: require('../version').APP_VERSION, schemaVersion: require('../version').SCHEMA_VERSION, pgServerVersion: currentPg, hostname: os.hostname(), databaseName: pg.databaseName() },
      structure: verify.checks, mode, modeReason, tables, files: Object.values(files), totals,
      risk, readiness: { state, checks: readinessChecks, restoreAvailable: false },
    };
    a.report = report;
    a.status = 'done';
    a.stage = 'Done';
    await audit(req, 'admin.backup_analyze', 'backup', (meta && meta.backupId) || a.id, {
      source: 'upload', analysisId: a.id, filename: a.filename, sizeBytes: a.sizeBytes, sha256: a.sha256,
      signature: verify.signature, signatureValid: verify.signature === 'valid', checksumsValid: verify.checksumsValid,
      compatibility: compat, mode, riskLevel: risk.level, readiness: state, blockers: risk.blockers,
      impact: Object.fromEntries([...tables, ...Object.values(files)].map((t) => [t.id, { current: t.current, backup: t.backup, added: t.added ?? null, removed: t.removed ?? null, modified: t.modified ?? null }])),
      outcome: blocked ? 'failed' : 'success', durationMs: Date.now() - t0,
    });
  } catch (e) {
    console.error('[backup] analysis failed:', e.message);
    a.status = 'failed';
    a.error = trunc(e.message);
    fsp.rm(a.file, { force: true }).catch(() => {}); // the failure stays visible for polling until the TTL
    await audit(req, 'admin.backup_analyze', 'backup', (meta && meta.backupId) || a.id, {
      source: 'upload', analysisId: a.id, filename: a.filename, sizeBytes: a.sizeBytes, outcome: 'failed', error: a.error, durationMs: Date.now() - t0,
    });
  } finally {
    if (bakDb) await bakDb.end().catch(() => {});
    if (scratch) await dropScratch(scratch).catch((e) => console.warn('[backup] could not drop scratch db:', e.message));
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    await release();
  }
}

/** On boot: clear leftover uploads and any scratch databases from an interrupted analysis. */
async function startupCleanup() {
  try {
    await fsp.mkdir(cfg.QUARANTINE_DIR, { recursive: true, mode: 0o700 });
    for (const n of await fsp.readdir(cfg.QUARANTINE_DIR)) await fsp.rm(path.join(cfg.QUARANTINE_DIR, n), { recursive: true, force: true });
    const { rows } = await db.query(`SELECT datname FROM pg_database WHERE datname LIKE 'pcshub\\_analyze\\_%'`);
    for (const r of rows) await dropScratch(r.datname).catch(() => {});
  } catch (e) {
    console.warn('[backup] quarantine cleanup skipped:', e.message);
  }
}

module.exports = { start, get, pub, discard, startupCleanup };
