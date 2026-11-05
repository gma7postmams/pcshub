// Admin > Backup > Scheduled export. Mounted at /api/admin/exports behind the Admin page check; System Admin only (defence in depth).
const fs = require('fs');
const express = require('express');
const { asyncH, HttpError } = require('../middleware');
const { audit } = require('../audit');
const ex = require('../export-schedule');
const cfg = require('../backup/config');

const router = express.Router();
router.use((req, res, next) => (req.user && req.user.role === 'System Admin' ? next() : res.status(403).json({ error: 'System Admin role required' })));

const overview = async () => {
  const [settings, last, runs] = await Promise.all([ex.getSettings(), ex.getLast(), ex.list()]);
  const next = ex.nextRun(settings);
  return { settings, last, runs, next: next ? next.toISOString() : null, preview: ex.resolveRange(settings), running: ex.isRunning(), folder: `${cfg.BACKUP_DIR}/exports`, modules: ex.MODULES };
};

router.get('/', asyncH(async (req, res) => res.json(await overview())));

router.put('/', asyncH(async (req, res) => {
  let s;
  try { s = await ex.saveSettings(req.body || {}); } catch (e) { throw new HttpError(e.status || 400, e.message); }
  await audit(req, 'admin.export_schedule_save', 'export', null, { enabled: s.enabled, time: s.time, range: s.range, from: s.from || undefined, to: s.to || undefined, byDate: s.byDate, modules: s.modules, keep: s.keep });
  res.json(await overview());
}));

router.post('/run', asyncH(async (req, res) => {
  const result = await ex.run({ source: req.user.username, actor: req });
  if (!result.ok && !result.files.length) throw new HttpError(500, result.errors.map((e) => `${e.label ? `${e.label}: ` : ''}${e.error}`).join('; ') || result.error || 'The export did not run');
  res.json({ result, ...(await overview()) });
}));

router.get('/files/:run/:name', asyncH(async (req, res) => {
  const f = await ex.fileOf(req.params.run, req.params.name);
  if (!f) throw new HttpError(404, 'File not found');
  await audit(req, 'admin.export_download', 'export', null, { run: req.params.run, file: req.params.name, size: f.size });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Length': String(f.size), 'Content-Disposition': `attachment; filename="${req.params.name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(f.abs).on('error', () => res.destroy()).pipe(res);
}));

module.exports = router;
