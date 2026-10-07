const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const v = require('../validate');
const stepUp = require('../reauth');
const { asyncH, HttpError } = require('../middleware');
const { audit } = require('../audit');
const svc = require('../backup/service');
const analysis = require('../backup/analysis');
const restore = require('../backup/restore');
const cfg = require('../backup/config');

// Mounted behind requirePageAccess('/admin'); the role is re-checked here as defence in depth.
const router = express.Router();
router.use((req, res, next) => (req.user && req.user.role === 'Admin' ? next() : res.status(403).json({ error: 'Admin role required' })));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ error: 'Backup not found' })));

const limiter = (limit) => rateLimit({
  windowMs: 10 * 60 * 1000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `u${req.user.id}`,
  message: { error: 'Too many backup requests, try again later.' },
});
const createLimiter = limiter(10);
const sensitiveLimiter = limiter(20);
const analyzeLimiter = limiter(5);

/** Password (plus the current 2FA code when enabled) must be re-entered every time for restore, delete and download. */
const reauth = (req, action, id) => stepUp.verify(req, { action, entity: 'backup', id }, req.body);

router.get('/preview', asyncH(async (req, res) => res.json(await svc.preview())));

router.get('/', asyncH(async (req, res) => {
  const { limit, offset } = v.paging(req.query, { def: 25, max: 100 });
  const type = ['all', 'backup', 'restore'].includes(req.query.type) ? req.query.type : 'all';
  res.json(await svc.list({ limit, offset, type, deleted: req.query.deleted === '1' }));
}));

router.post('/', createLimiter, asyncH(async (req, res) => {
  const note = v.str(req.body.note, { field: 'Note', max: 200 }) || '';
  const job = await svc.startCreate(req, { note });
  res.status(202).json({ job });
}));

router.get('/jobs/:id', asyncH(async (req, res) => res.json({ job: await svc.getJob(req.params.id) })));

// ---------- Restore execution (only from a completed analysis; rollback only from a failed restore) ----------
const restoreLimiter = limiter(5);

router.post('/restore', restoreLimiter, asyncH(async (req, res) => {
  const aid = typeof req.body.analysisId === 'string' ? req.body.analysisId : '';
  if (!/^[0-9a-f]{24}$/.test(aid)) throw new HttpError(400, 'Analyze a backup before restoring it');
  const a = analysis.get(aid, req.user.id);
  const risk = a.report && a.report.risk.level;
  if (req.body.confirm !== 'RESTORE') throw new HttpError(400, 'Type RESTORE to confirm');
  if (risk === 'HIGH' && req.body.acknowledgeRisk !== true) throw new HttpError(400, 'Acknowledge the HIGH risk level to continue');
  await reauth(req, 'admin.backup_restore', aid);
  try {
    res.status(202).json({ job: await restore.start(req, aid) });
  } catch (e) {
    await audit(req, 'admin.backup_restore', 'backup', aid, { outcome: 'failed', riskLevel: risk, error: String(e.message).slice(0, 300), dbModified: false });
    throw e;
  }
}));

router.post('/:id/rollback', restoreLimiter, asyncH(async (req, res) => {
  const id = req.params.id;
  if (req.body.confirm !== 'ROLLBACK') throw new HttpError(400, 'Type ROLLBACK to confirm');
  await reauth(req, 'admin.backup_restore', id);
  try {
    res.status(202).json({ job: await restore.startRollback(req, id) });
  } catch (e) {
    await audit(req, 'admin.backup_restore', 'backup', id, { outcome: 'failed', rollbackOf: id, error: String(e.message).slice(0, 300), dbModified: false });
    throw e;
  }
}));

// ---------- Restore analysis (read-only: nothing is restored) ----------
router.param('aid', (req, res, next, aid) => (/^[0-9a-f]{24}$/.test(aid) ? next() : res.status(404).json({ error: 'Analysis not found or expired' })));

const uploadZip = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => fsp.mkdir(cfg.QUARANTINE_DIR, { recursive: true, mode: 0o700 }).then(() => cb(null, cfg.QUARANTINE_DIR), cb),
    filename: (req, file, cb) => cb(null, `${crypto.randomBytes(12).toString('hex')}.zip`),
  }),
  limits: { fileSize: cfg.MAX_ARCHIVE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => (path.extname(file.originalname).toLowerCase() === '.zip' ? cb(null, true) : cb(new HttpError(400, 'Choose a .zip backup file'))),
});
const receive = (req, res, next) => {
  if (svc.isBusy()) return next(new HttpError(409, 'Another backup operation is already running'));
  return uploadZip.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'Backup file is larger than the allowed size'));
    return next(err.code && String(err.code).startsWith('LIMIT_') ? new HttpError(400, 'Upload a single ZIP file') : err);
  });
};

router.post('/analyze', analyzeLimiter, receive, asyncH(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  try {
    res.status(202).json({ analysis: await analysis.start(req, req.file, req.file.originalname) });
  } catch (e) {
    await fsp.rm(req.file.path, { force: true });
    throw e;
  }
}));

router.get('/analyses/:aid', asyncH(async (req, res) => res.json({ analysis: analysis.pub(analysis.get(req.params.aid, req.user.id)) })));

router.delete('/analyses/:aid', asyncH(async (req, res) => {
  analysis.discard(analysis.get(req.params.aid, req.user.id));
  res.json({ ok: true });
}));

router.post('/:id/verify', sensitiveLimiter, asyncH(async (req, res) => {
  const t0 = Date.now();
  let out;
  try {
    out = await svc.verify(req.params.id, req);
  } catch (e) {
    if (e.status !== 409 && e.status !== 404 && e.status !== 410) await audit(req, 'admin.backup_verify', 'backup', req.params.id, { source: 'stored', outcome: 'failed', error: String(e.message).slice(0, 300), durationMs: Date.now() - t0 });
    throw e;
  }
  const { job, report } = out;
  await audit(req, 'admin.backup_verify', 'backup', job.id, {
    source: 'stored', backupId: job.id, filename: job.filename, sizeBytes: report.sizeBytes, sha256: report.sha256,
    signatureValid: report.signature === 'valid', signature: report.signature, checksumsValid: report.checksumsValid,
    compatibility: report.compat, riskLevel: null,
    failedChecks: report.checks.filter((c) => c.status === 'fail').map((c) => c.check),
    outcome: report.status === 'ok' ? 'success' : 'failed', durationMs: Date.now() - t0,
  });
  res.json({ job, report });
}));

// Step 1 of a download: re-authenticate and receive a single-use, short-lived link token.
router.post('/:id/download-token', sensitiveLimiter, asyncH(async (req, res) => {
  await reauth(req, 'admin.backup_download', req.params.id);
  await svc.prepareDownload(req.params.id);
  res.json({ token: svc.issueDownloadToken(req.user.id, req.params.id) });
}));

router.get('/:id/download', sensitiveLimiter, asyncH(async (req, res) => {
  const id = req.params.id;
  if (!svc.consumeDownloadToken(req.query.t, req.user.id, id)) {
    await audit(req, 'admin.backup_download', 'backup', id, { outcome: 'denied', reason: 'invalid_or_expired_token' });
    throw new HttpError(403, 'Download link expired. Request a new one.');
  }
  let d;
  try {
    d = await svc.prepareDownload(id);
  } catch (e) {
    await audit(req, 'admin.backup_download', 'backup', id, { outcome: 'failed', error: String(e.message).slice(0, 300) });
    throw e;
  }
  await audit(req, 'admin.backup_download', 'backup', id, {
    outcome: 'success', backupId: id, filename: d.row.filename, sizeBytes: d.size, sha256: d.row.sha256,
  });
  res.set({
    'Content-Type': 'application/zip',
    'Content-Length': String(d.size),
    'Content-Disposition': `attachment; filename="${d.row.filename}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Backup-SHA256': d.row.sha256,
  });
  fs.createReadStream(d.abs).on('error', () => res.destroy()).pipe(res);
}));

router.delete('/:id', sensitiveLimiter, asyncH(async (req, res) => {
  const id = req.params.id;
  if (req.body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm');
  await reauth(req, 'admin.backup_delete', id);
  let row;
  try {
    row = await svc.remove(id, req);
  } catch (e) {
    await audit(req, 'admin.backup_delete', 'backup', id, { outcome: 'failed', error: String(e.message).slice(0, 300) });
    throw e;
  }
  await audit(req, 'admin.backup_delete', 'backup', id, {
    outcome: 'success', backupId: id, filename: row.filename, sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    createdAt: row.created_at, createdBy: row.created_by_name,
  });
  res.json({ ok: true });
}));

module.exports = router;
