// Main server: what the backup server pulls. Mounted at /api/node-sync BEFORE sign-in is required; it is protected by NODE_SYNC_TOKEN
// (sent as "Authorization: Bearer ..."), and answers 404 unless this server is the main one and the token is set.
// The token can only reach backups made for the backup server (note "Backup server sync"), never the regular backups.
const fs = require('fs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { asyncH, HttpError } = require('../middleware');
const svc = require('../backup/service');
const node = require('../node');
const { SCHEMA_VERSION } = require('../version');

const router = express.Router();
const SYSTEM = { user: { id: null, username: 'backup-server' }, ip: null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests.' } }));
router.use((req, res, next) => {
  if (node.isBackup() || !node.tokenOk()) return res.status(404).json({ error: 'Not found' });
  const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
  if (!node.tokenMatches(m && m[1])) return res.status(401).json({ error: 'Invalid token' });
  res.set('Cache-Control', 'no-store');
  return next();
});
router.param('id', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ error: 'Not found' })));

let lastNoted = 0;
const notePull = (req) => {   // so the main server's Backup Server tab can say "the backup server last called at ..."
  if (Date.now() - lastNoted < 30000) return;
  lastNoted = Date.now();
  try { node.save({ lastPull: { at: new Date().toISOString(), ip: req.ip || null } }); } catch (_) { /* shown nowhere else */ }
};

async function syncJob(id) {
  const j = await svc.getJob(id);
  if (j.note !== node.SYNC_NOTE) throw new HttpError(404, 'Not found');
  return j;
}

router.get('/info', (req, res) => { notePull(req); res.json({ role: node.role(), schema: SCHEMA_VERSION, now: new Date().toISOString() }); });

router.post('/snapshot', asyncH(async (req, res) => {
  notePull(req);
  // Keep only the newest earlier sync backup (the backup server may still be downloading it); older ones go.
  const db = require('../db');
  const { rows } = await db.query(
    `SELECT id FROM backup_jobs WHERE kind='create' AND status='succeeded' AND deleted_at IS NULL AND note=$1 ORDER BY created_at DESC OFFSET 1`, [node.SYNC_NOTE]
  );
  for (const r of rows) { try { await svc.remove(r.id, SYSTEM); } catch (e) { console.error('[node-sync] old snapshot', e.message); } }
  const job = await svc.startCreate(SYSTEM, { note: node.SYNC_NOTE });
  res.status(202).json({ id: job.id });
}));

router.get('/snapshot/:id', asyncH(async (req, res) => {
  const j = await syncJob(req.params.id);
  res.json({ id: j.id, status: j.status, progress: j.progress, error: j.error || null, size: j.size_bytes == null ? null : Number(j.size_bytes), sha256: j.sha256 || null, filename: j.filename || null });
}));

router.get('/snapshot/:id/download', asyncH(async (req, res) => {
  await syncJob(req.params.id);
  const d = await svc.prepareDownload(req.params.id);
  res.set({
    'Content-Type': 'application/zip', 'Content-Length': String(d.size), 'X-Content-Type-Options': 'nosniff',
    'X-Backup-SHA256': d.row.sha256, 'Content-Disposition': `attachment; filename="${d.row.filename}"`,
  });
  fs.createReadStream(d.abs).on('error', () => res.destroy()).pipe(res);
}));

module.exports = router;
