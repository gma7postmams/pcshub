const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { HttpError } = require('../middleware');
const { audit } = require('../audit');
const { SCHEMA_VERSION, APP_VERSION } = require('../version');
const cfg = require('./config');
const pg = require('./pg');
const manifest = require('./manifest');
const { sha256File, walk, writeZip, scanZip } = require('./archive');

const TMP_DIR = path.join(cfg.BACKUP_DIR, '.tmp');
const COLS = `id, kind, status, progress, filename, size_bytes, sha256, schema_version, app_version, pg_version, signed, note,
  summary, error, verify_status, verify_report, verified_at, created_by, created_by_name, started_at, finished_at, created_at, deleted_at`;

const state = { busy: false };

// ---------- single-flight lock (in-process flag + PostgreSQL advisory lock for multi-instance safety) ----------
async function acquire() {
  if (state.busy) throw new HttpError(409, 'Another backup operation is already running');
  state.busy = true;
  let client;
  try {
    client = await db.pool.connect();
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [cfg.ADVISORY_LOCK_KEY]);
    if (!rows[0].ok) throw new HttpError(409, 'Another backup operation is already running');
  } catch (e) {
    if (client) client.release(true);
    state.busy = false;
    throw e;
  }
  return async () => {
    let broken = false;
    try { await client.query('SELECT pg_advisory_unlock($1)', [cfg.ADVISORY_LOCK_KEY]); } catch (_) { broken = true; }
    client.release(broken);
    state.busy = false;
  };
}

// ---------- environment / preview ----------
let envCache = { at: 0, value: null };

async function freeBytes(dir) {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch (_) { return null; }
}

async function environment() {
  if (envCache.value && Date.now() - envCache.at < 60000) return envCache.value;
  const [pgDump, pgRestore] = await Promise.all([pg.toolVersion(cfg.PG_DUMP_BIN), pg.toolVersion(cfg.PG_RESTORE_BIN)]);
  let writable = true;
  try { await fsp.mkdir(TMP_DIR, { recursive: true, mode: 0o700 }); await fsp.access(cfg.BACKUP_DIR, fs.constants.W_OK); } catch (_) { writable = false; }
  const value = {
    pgDump, pgRestore,
    signing: Boolean(cfg.SIGNING_KEY),
    storageWritable: writable,
    freeBytes: await freeBytes(cfg.BACKUP_DIR),
    limits: { maxBackups: cfg.MAX_BACKUPS, maxArchiveBytes: cfg.MAX_ARCHIVE_BYTES },
  };
  envCache = { at: Date.now(), value };
  return value;
}

async function collectCounts(runner = db) {
  const { rows } = await runner.query(`SELECT
    (SELECT count(*) FROM users)::int AS users,
    (SELECT count(*) FROM groups)::int AS groups,
    (SELECT count(*) FROM dropdown_options WHERE category = 'program')::int AS programs,
    (SELECT count(*) FROM dropdown_options WHERE category = 'platform')::int AS platforms,
    (SELECT count(*) FROM knowledge_docs)::int AS knowledge_docs,
    (SELECT count(*) FROM ingest_records)::int AS ingest_records,
    (SELECT count(*) FROM workload_items)::int AS workload_items,
    (SELECT count(*) FROM audit_logs)::int AS audit_logs`);
  return rows[0];
}

async function collectFiles() {
  const out = {};
  for (const c of cfg.UPLOAD_COMPONENTS) {
    const list = await walk(path.join(cfg.UPLOADS_ROOT, c));
    out[c] = { count: list.length, bytes: list.reduce((n, f) => n + f.size, 0) };
  }
  return out;
}

async function tableBytes() {
  const { rows } = await db.query(
    `SELECT COALESCE(sum(pg_table_size(c.oid)), 0)::text AS bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname <> 'user_sessions'`
  );
  return Number(rows[0].bytes);
}

async function preview() {
  const [counts, files, dbBytes, env] = await Promise.all([collectCounts(), collectFiles(), tableBytes(), environment()]);
  const fileBytes = Object.values(files).reduce((n, f) => n + f.bytes, 0);
  const fileCount = Object.values(files).reduce((n, f) => n + f.count, 0);
  const dumpBytes = Math.round(dbBytes * 0.4); // custom-format dumps are compressed; heuristic only
  return {
    counts, files,
    totals: { fileCount, fileBytes, databaseBytes: dbBytes, estimatedDumpBytes: dumpBytes, estimatedArchiveBytes: dumpBytes + fileBytes },
    environment: env,
  };
}

// ---------- create ----------
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
const sha256Text = (s) => crypto.createHash('sha256').update(s).digest('hex');
const trunc = (s) => String(s || '').slice(0, 500);

async function startCreate(req, { note }) {
  const env = await environment();
  if (!env.pgDump.ok) throw new HttpError(503, `Backups are unavailable: ${env.pgDump.error}`);
  if (!env.storageWritable) throw new HttpError(503, 'Backups are unavailable: the backup directory is not writable');

  const { rows: cnt } = await db.query(`SELECT count(*)::int AS n FROM backup_jobs WHERE kind='create' AND status='succeeded' AND deleted_at IS NULL`);
  if (cnt[0].n >= cfg.MAX_BACKUPS) throw new HttpError(409, `Backup limit reached (${cfg.MAX_BACKUPS}). Delete an old backup first.`);

  const [files, dbBytes] = await Promise.all([collectFiles(), tableBytes()]);
  const fileBytes = Object.values(files).reduce((n, f) => n + f.bytes, 0);
  const free = await freeBytes(cfg.BACKUP_DIR);
  const needed = (Math.round(dbBytes * 0.4) + fileBytes) * 2 + 50 * 1024 * 1024; // staging copy + archive
  if (free !== null && free < needed) throw new HttpError(507, 'Not enough free disk space in the backup directory');

  const release = await acquire();
  let job;
  try {
    const { rows } = await db.query(
      `INSERT INTO backup_jobs (kind, status, progress, note, created_by, created_by_name, started_at)
       VALUES ('create','running','Starting',$1,$2,$3,now()) RETURNING ${COLS}`,
      [note || null, req.user.id, req.user.username]
    );
    job = rows[0];
  } catch (e) { await release(); throw e; }

  runCreate(job, req, release).catch((e) => console.error('[backup] unexpected', e));
  return job;
}

async function runCreate(job, req, release) {
  const t0 = Date.now();
  const stage = path.join(TMP_DIR, job.id);
  const tmpZip = path.join(TMP_DIR, `${job.id}.zip`);
  let finalAbs = null;
  const progress = (p) => db.query('UPDATE backup_jobs SET progress=$2 WHERE id=$1', [job.id, p]).catch(() => {});
  try {
    await fsp.mkdir(path.join(stage, 'uploads'), { recursive: true, mode: 0o700 });

    await progress('Counting records');
    const counts = await collectCounts();
    const [dbInfo, dumpVer] = await Promise.all([db.query('SHOW server_version'), pg.toolVersion(cfg.PG_DUMP_BIN)]);
    const pgServerVersion = dbInfo.rows[0].server_version;

    await progress('Dumping database');
    const dumpPath = path.join(stage, 'database.dump');
    await pg.dump(dumpPath);

    await progress('Copying files');
    const fileList = [];
    const summaryFiles = {};
    for (const comp of cfg.UPLOAD_COMPONENTS) {
      const list = await walk(path.join(cfg.UPLOADS_ROOT, comp));
      let n = 0; let bytes = 0;
      for (const f of list) {
        const dest = path.join(stage, 'uploads', comp, ...f.rel.split('/'));
        await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        try { await fsp.copyFile(f.abs, dest); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        const st = await fsp.stat(dest);
        fileList.push({ path: `uploads/${comp}/${f.rel}`, size: st.size, sha256: await sha256File(dest), abs: dest });
        n++; bytes += st.size;
      }
      summaryFiles[comp] = { count: n, bytes };
    }

    await progress('Building archive');
    const dumpStat = await fsp.stat(dumpPath);
    const dumpSha = await sha256File(dumpPath);
    const { rows: docs } = await db.query('SELECT stored_name FROM knowledge_docs');
    const onDisk = new Set(fileList.filter((f) => f.path.startsWith('uploads/knowledge/')).map((f) => f.path.slice('uploads/knowledge/'.length)));
    const known = new Set(docs.map((d) => d.stored_name));

    const createdAt = new Date();
    const meta = manifest.sign({
      formatVersion: cfg.FORMAT_VERSION,
      backupId: job.id,
      createdAt: createdAt.toISOString(),
      createdBy: { id: req.user.id, username: req.user.username },
      app: { name: 'pcshub', version: APP_VERSION },
      schemaVersion: SCHEMA_VERSION,
      pgServerVersion,
      pgDumpVersion: dumpVer.version || null,
      nodeVersion: process.version,
      databaseName: pg.databaseName(),
      hostname: os.hostname(),
      encrypted: false,
      components: { database: true, branding: true, knowledge: true },
      dumpSha256: dumpSha,
      files: fileList.map(({ path: p, size, sha256 }) => ({ path: p, size, sha256 })),
      reconciliation: {
        knowledgeRowsWithoutFile: [...known].filter((n) => !onDisk.has(n)).length,
        knowledgeFilesWithoutRow: [...onDisk].filter((n) => !known.has(n)).length,
      },
    });
    const summary = {
      tables: counts,
      files: summaryFiles,
      totals: {
        databaseDumpBytes: dumpStat.size,
        fileBytes: Object.values(summaryFiles).reduce((n, f) => n + f.bytes, 0),
        fileCount: fileList.length,
      },
    };
    const metaStr = `${JSON.stringify(meta, null, 2)}\n`;
    const sumStr = `${JSON.stringify(summary, null, 2)}\n`;
    const checksums = manifest.checksumsText([
      { path: 'database.dump', sha256: dumpSha },
      { path: 'metadata.json', sha256: sha256Text(metaStr) },
      { path: 'summary.json', sha256: sha256Text(sumStr) },
      ...fileList,
    ]);
    await writeZip(
      tmpZip,
      [{ abs: dumpPath, name: 'database.dump', store: true }, ...fileList.map((f) => ({ abs: f.abs, name: f.path }))],
      { 'metadata.json': metaStr, 'summary.json': sumStr, 'checksums.sha256': checksums }
    );

    const zipStat = await fsp.stat(tmpZip);
    if (zipStat.size > cfg.MAX_ARCHIVE_BYTES) throw new Error('Backup exceeds the maximum allowed archive size');
    const zipSha = await sha256File(tmpZip);

    await progress('Verifying archive');
    const verify = await verifyFile(tmpZip, { id: job.id, sha256: zipSha });
    if (verify.status !== 'ok') throw new Error('Archive failed post-creation verification');

    const filename = `pcshub-backup-${stamp(createdAt)}-${job.id.slice(0, 8)}.zip`;
    const rel = `${createdAt.getUTCFullYear()}/${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}/${filename}`;
    finalAbs = path.join(cfg.BACKUP_DIR, ...rel.split('/'));
    await fsp.mkdir(path.dirname(finalAbs), { recursive: true, mode: 0o700 });
    await fsp.rename(tmpZip, finalAbs);

    const { rows } = await db.query(
      `UPDATE backup_jobs SET status='succeeded', progress='Done', filename=$2, rel_path=$3, size_bytes=$4, sha256=$5,
              schema_version=$6, app_version=$7, pg_version=$8, signed=$9, summary=$10,
              verify_status='ok', verify_report=$11, verified_at=now(), verified_by=$12, finished_at=now()
        WHERE id=$1 RETURNING ${COLS}`,
      [job.id, filename, rel, zipStat.size, zipSha, SCHEMA_VERSION, APP_VERSION, pgServerVersion, Boolean(meta.signature),
        summary, { checks: verify.checks }, req.user.id]
    );
    await audit(req, 'admin.backup_create', 'backup', job.id, {
      outcome: 'success', backupId: job.id, filename, sizeBytes: zipStat.size, sha256: zipSha,
      schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, components: Object.keys(meta.components),
      counts, files: summaryFiles, signed: Boolean(meta.signature), encrypted: false, durationMs: Date.now() - t0,
    });
    return rows[0];
  } catch (e) {
    console.error('[backup] create failed:', e.message);
    if (finalAbs) await fsp.rm(finalAbs, { force: true }).catch(() => {});
    await db.query(`UPDATE backup_jobs SET status='failed', progress=NULL, error=$2, finished_at=now() WHERE id=$1`, [job.id, trunc(e.message)]).catch(() => {});
    await audit(req, 'admin.backup_create', 'backup', job.id, { outcome: 'failed', backupId: job.id, error: trunc(e.message), durationMs: Date.now() - t0 });
    return null;
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(tmpZip, { force: true }).catch(() => {});
    await release();
  }
}

// ---------- verify ----------
async function verifyFile(abs, expect) {
  const checks = [];
  const add = (check, status, detail) => checks.push({ check, status, detail });
  const result = { checks, signature: null, checksumsValid: false, compat: null };
  const finish = () => {
    result.status = checks.some((c) => c.status === 'fail') ? 'failed' : 'ok';
    return result;
  };

  let st;
  try { st = await fsp.stat(abs); } catch (_) { add('File present', 'fail', 'Backup file is missing from storage'); return finish(); }
  add('File present', 'pass', `${st.size} bytes`);
  result.sizeBytes = st.size;

  const sha = await sha256File(abs);
  result.sha256 = sha;
  if (expect.sha256) add('Archive hash', sha === expect.sha256 ? 'pass' : 'fail', sha === expect.sha256 ? 'Matches the hash recorded at creation' : 'Differs from the hash recorded at creation (modified on disk)');

  const tmpDump = path.join(TMP_DIR, `verify-${crypto.randomBytes(6).toString('hex')}.dump`);
  await fsp.mkdir(TMP_DIR, { recursive: true, mode: 0o700 });
  try {
    const scan = await scanZip(abs, { read: ['metadata.json', 'summary.json', 'checksums.sha256'], extract: { 'database.dump': tmpDump } });
    if (scan.problems.length) {
      add('Archive structure', 'fail', scan.problems.slice(0, 5).join('; ') + (scan.problems.length > 5 ? ` (+${scan.problems.length - 5} more)` : ''));
    } else {
      add('Archive structure', 'pass', `${scan.entries.length} entries, no unexpected paths`);
    }
    const byName = new Map(scan.entries.map((e) => [e.name, e]));
    const missing = ['metadata.json', 'summary.json', 'database.dump', 'checksums.sha256'].filter((n) => !byName.has(n));
    add('Required entries', missing.length ? 'fail' : 'pass', missing.length ? `Missing: ${missing.join(', ')}` : 'All present');

    let meta = null;
    try { meta = JSON.parse(scan.texts['metadata.json']); } catch (_) { /* reported below */ }
    if (!meta) {
      add('Manifest', 'fail', 'metadata.json is missing or not valid JSON');
    } else {
      const okFmt = meta.formatVersion === cfg.FORMAT_VERSION;
      add('Manifest', okFmt && (!expect.id || meta.backupId === expect.id) ? 'pass' : 'fail',
        !okFmt ? `Unsupported format version ${meta.formatVersion}` : (!expect.id || meta.backupId === expect.id) ? `Format v${meta.formatVersion}` : 'Backup id does not match this record');

      result.signature = manifest.checkSignature(meta);
      const sigMsg = {
        valid: ['pass', 'HMAC signature is valid'],
        unsigned: ['warn', 'Backup is unsigned (BACKUP_SIGNING_KEY was not set at creation)'],
        no_key: ['warn', 'Signed backup, but BACKUP_SIGNING_KEY is not configured here'],
        invalid: ['fail', 'Signature does not match: manifest was altered or signed with a different key'],
      }[result.signature];
      add('Signature', sigMsg[0], sigMsg[1]);

      const dumpOk = byName.has('database.dump') && byName.get('database.dump').sha256 === meta.dumpSha256;
      const listed = new Map((meta.files || []).map((f) => [f.path, f]));
      const upload = scan.entries.filter((e) => e.name.startsWith('uploads/'));
      const badFiles = upload.filter((e) => !listed.has(e.name) || listed.get(e.name).sha256 !== e.sha256 || listed.get(e.name).size !== e.size).length
        + [...listed.keys()].filter((p) => !byName.has(p)).length;
      add('Manifest file hashes', dumpOk && !badFiles ? 'pass' : 'fail',
        dumpOk && !badFiles ? `${upload.length + 1} files match the manifest` : `${!dumpOk ? 'Database dump hash differs; ' : ''}${badFiles ? `${badFiles} upload file(s) differ from the manifest` : ''}`.trim());

      const cur = SCHEMA_VERSION;
      const schemaStatus = meta.schemaVersion === cur ? 'same' : meta.schemaVersion < cur ? 'older' : 'newer';
      result.compat = { schema: { backup: meta.schemaVersion, current: cur, status: schemaStatus }, app: { backup: meta.app && meta.app.version, current: APP_VERSION }, pg: { backup: meta.pgServerVersion, dump: meta.pgDumpVersion } };
      add('Compatibility', schemaStatus === 'same' ? 'pass' : 'warn',
        schemaStatus === 'same' ? `Schema v${cur}` : schemaStatus === 'older' ? `Schema v${meta.schemaVersion} is older than v${cur}; a restore would need migration` : `Schema v${meta.schemaVersion} is newer than this app (v${cur}); cannot be restored here`);
    }

    const sums = scan.texts['checksums.sha256'] ? manifest.parseChecksums(scan.texts['checksums.sha256']) : null;
    if (!sums) {
      add('Checksums', 'fail', 'checksums.sha256 is missing or malformed');
    } else {
      const actual = scan.entries.filter((e) => e.name !== 'checksums.sha256');
      const bad = actual.filter((e) => sums.get(e.name) !== e.sha256).length + [...sums.keys()].filter((n) => !byName.has(n)).length;
      result.checksumsValid = bad === 0;
      add('Checksums', bad ? 'fail' : 'pass', bad ? `${bad} file(s) do not match checksums.sha256` : `${actual.length} files verified`);
    }

    if (byName.has('database.dump') && !scan.problems.length) {
      try {
        const n = await pg.listDump(tmpDump);
        add('Database dump readable', n > 0 ? 'pass' : 'fail', n > 0 ? `${n} objects listed by pg_restore` : 'Dump contains no objects');
      } catch (e) {
        add('Database dump readable', /not found/.test(e.message) ? 'warn' : 'fail', trunc(e.message));
      }
    }
  } finally {
    await fsp.rm(tmpDump, { force: true }).catch(() => {});
  }
  return finish();
}

async function verify(id, req) {
  const row = await getLive(id);
  if (row.status !== 'succeeded') throw new HttpError(409, 'Only completed backups can be verified');
  const release = await acquire();
  try {
    const report = await verifyFile(resolvePath(row.rel_path), { id: row.id, sha256: row.sha256 });
    const { rows } = await db.query(
      `UPDATE backup_jobs SET verify_status=$2, verify_report=$3, verified_at=now(), verified_by=$4 WHERE id=$1 RETURNING ${COLS}`,
      [id, report.status === 'ok' ? 'ok' : 'failed', { checks: report.checks }, req.user.id]
    );
    return { job: rows[0], report };
  } finally { await release(); }
}

// ---------- read / delete / download ----------
function resolvePath(rel) {
  const abs = path.resolve(cfg.BACKUP_DIR, rel || '');
  if (!rel || !abs.startsWith(cfg.BACKUP_DIR + path.sep)) throw new HttpError(500, 'Invalid backup path');
  return abs;
}

// Unified Backup + Restore history. Restore rows are written by the restore engine in a later phase.
async function list({ limit, offset, type = 'all', deleted = false }) {
  const kinds = { all: "kind IN ('create','restore')", backup: "kind = 'create'", restore: "kind = 'restore'" }[type];
  const [rows, tot] = await Promise.all([
    db.query(`SELECT ${COLS}, risk_level,
                     COALESCE(duration_ms, (EXTRACT(EPOCH FROM finished_at - started_at) * 1000)::int) AS duration_ms
                FROM backup_jobs WHERE ${kinds} AND ($3::boolean OR deleted_at IS NULL)
               ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset, deleted]),
    db.query(`SELECT count(*) FILTER (WHERE kind='create' AND ($1::boolean OR deleted_at IS NULL))::int AS backups,
                     count(*) FILTER (WHERE kind='restore')::int AS restores,
                     count(*) FILTER (WHERE kind='create' AND status='succeeded' AND deleted_at IS NULL)::int AS stored,
                     count(*) FILTER (WHERE kind='create' AND deleted_at IS NOT NULL)::int AS deleted,
                     count(*) FILTER (WHERE kind='create' AND status IN ('queued','running'))::int AS running,
                     COALESCE(sum(size_bytes) FILTER (WHERE kind='create' AND status='succeeded' AND deleted_at IS NULL), 0)::text AS bytes
                FROM backup_jobs`, [deleted]),
  ]);
  const t = tot.rows[0];
  const counts = { backups: t.backups, restores: t.restores, deleted: t.deleted };
  const total = { all: t.backups + t.restores, backup: t.backups, restore: t.restores }[type];
  return { rows: rows.rows, total, counts, stored: t.stored, running: t.running > 0, storedBytes: Number(t.bytes) };
}

async function getJob(id) {
  const { rows } = await db.query(`SELECT ${COLS}, risk_level, duration_ms FROM backup_jobs WHERE id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Backup not found');
  return rows[0];
}

async function getLive(id) {
  const { rows } = await db.query('SELECT * FROM backup_jobs WHERE id=$1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Backup not found');
  if (rows[0].deleted_at) throw new HttpError(410, 'Backup was deleted');
  return rows[0];
}

async function remove(id, req) {
  const row = await getLive(id);
  if (row.status === 'queued' || row.status === 'running') throw new HttpError(409, 'Backup is still running');
  if (row.rel_path) {
    try { await fsp.unlink(resolvePath(row.rel_path)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await db.query('UPDATE backup_jobs SET deleted_at=now(), deleted_by=$2 WHERE id=$1', [id, req.user.id]);
  return row;
}

async function prepareDownload(id) {
  const row = await getLive(id);
  if (row.status !== 'succeeded') throw new HttpError(409, 'Backup is not available for download');
  const abs = resolvePath(row.rel_path);
  let st;
  try { st = await fsp.stat(abs); } catch (_) { throw new HttpError(404, 'Backup file is missing from storage'); }
  if (Number(row.size_bytes) !== st.size) throw new HttpError(409, 'Backup file size differs from its record. Run Verify before downloading.');
  return { row, abs, size: st.size };
}

// One-time download tokens (issued after re-authentication; bound to user + backup; in-memory, single process).
const tokens = new Map();
function issueDownloadToken(userId, backupId) {
  const now = Date.now();
  for (const [k, t] of tokens) if (t.exp < now) tokens.delete(k);
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { userId, backupId, exp: now + cfg.DOWNLOAD_TOKEN_TTL_MS });
  return token;
}
function consumeDownloadToken(token, userId, backupId) {
  const t = typeof token === 'string' ? tokens.get(token) : null;
  if (t) tokens.delete(token);
  return Boolean(t && t.exp > Date.now() && t.userId === userId && t.backupId === backupId);
}

// ---------- startup ----------
async function recoverStale() {
  try {
    await fsp.mkdir(TMP_DIR, { recursive: true, mode: 0o700 });
    for (const name of await fsp.readdir(TMP_DIR)) await fsp.rm(path.join(TMP_DIR, name), { recursive: true, force: true });
    const r = await db.query(`UPDATE backup_jobs SET status='failed', progress=NULL, error='Interrupted by a server restart', finished_at=now() WHERE status IN ('queued','running')`);
    if (r.rowCount) console.warn(`[backup] marked ${r.rowCount} interrupted job(s) as failed`);
  } catch (e) {
    console.warn('[backup] startup recovery skipped:', e.message);
  }
}

module.exports = {
  preview, startCreate, list, getJob, verify, remove, prepareDownload, issueDownloadToken, consumeDownloadToken, recoverStale, environment,
  acquire, verifyFile, collectCounts, isBusy: () => state.busy, runCreate, resolvePath,
};
