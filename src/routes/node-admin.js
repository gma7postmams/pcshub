// Administration → Backup Server (System Admin): status, Sync now, Promote to main, Stop being a backup server (standalone), Demote to backup.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { asyncH, HttpError } = require('../middleware');
const { audit } = require('../audit');
const stepUp = require('../reauth');
const node = require('../node');
const sync = require('../node-sync');
const { SCHEMA_VERSION } = require('../version');

const router = express.Router();
router.use((req, res, next) => (req.user && req.user.role === 'System Admin' ? next() : res.status(403).json({ error: 'System Admin role required' })));
const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => `u${req.user.id}`, message: { error: 'Too many requests, try again later.' } });

let probe = { at: 0, v: null };
async function mainReachable() {   // asked at most every 15 s however often the tab refreshes
  if (Date.now() - probe.at < 15000 && probe.v) return probe.v;
  probe = { at: Date.now(), v: await sync.probeMain() };
  return probe.v;
}

async function status() {
  const s = node.get();
  const backup = node.isBackup();
  const due = sync.nextDue();
  return {
    role: node.role(), envRole: node.envRole(), schema: SCHEMA_VERSION,
    mainUrl: node.mainUrl() || null, tokenSet: node.tokenOk(), syncHours: node.syncHours(),
    lastSync: s.lastSync || null, lastAttempt: s.lastAttempt || null, running: sync.progress(),
    nextSyncAt: backup && due && node.mainUrl() && node.tokenOk() ? due.toISOString() : null,
    mainReachable: backup ? await mainReachable() : null,
    lastPull: !backup ? s.lastPull || null : null,
    promotedAt: s.promotedAt || null, standaloneAt: s.standaloneAt || null, demotedAt: s.demotedAt || null,
  };
}

router.get('/', asyncH(async (req, res) => res.json(await status())));

router.post('/sync', limiter, asyncH(async (req, res) => {
  if (!node.isBackup()) throw new HttpError(409, 'This server is the main server');
  if (sync.isRunning()) throw new HttpError(409, 'A sync is already running');
  if (!node.mainUrl() || !node.tokenOk()) throw new HttpError(400, 'Set NODE_MAIN_URL and NODE_SYNC_TOKEN (24+ characters) in .env first');
  sync.syncOnce({ manual: true }).catch((e) => console.error('[node-sync]', e.message));   // runs on; the tab polls the status
  await audit(req, 'admin.node_sync', 'node', null, { manual: true });
  res.status(202).json(await status());
}));

router.post('/promote', limiter, asyncH(async (req, res) => {
  if (!node.isBackup()) throw new HttpError(409, 'This server is already the main server');
  if (req.body.confirm !== 'PROMOTE') throw new HttpError(400, 'Type PROMOTE to confirm');
  if (sync.isRunning()) throw new HttpError(409, 'A sync is running right now. Wait for it to finish (it replaces all data here), then promote.');
  await stepUp.verify(req, { action: 'admin.node_promote', entity: 'node', id: null }, req.body);
  const reach = await sync.probeMain();
  if (reach.ok && req.body.force !== true) {
    throw new HttpError(409, 'The main server still answers. Promoting now would leave two main servers. Stop the main server first, or confirm that you want to go ahead anyway.', { mainReachable: true });
  }
  const last = node.get().lastSync;
  node.save({ role: 'main', promotedAt: new Date().toISOString(), lastAttempt: null });
  await audit(req, 'admin.node_promote', 'node', null, { mainReachable: reach.ok, forced: req.body.force === true, dataAsOf: last && last.at || null });
  res.json(await status());
}));

// Leave the main / backup pair for good: no failover, no check that the main server is down. This server stops copying and becomes an ordinary main
// server on its own data (as of the last copy). Nothing on the other server is touched.
router.post('/standalone', limiter, asyncH(async (req, res) => {
  if (!node.isBackup()) throw new HttpError(409, 'This server is not a backup server');
  if (req.body.confirm !== 'STANDALONE') throw new HttpError(400, 'Type STANDALONE to confirm');
  if (sync.isRunning()) throw new HttpError(409, 'A copy is running right now. Wait for it to finish (it replaces all data here), then try again.');
  await stepUp.verify(req, { action: 'admin.node_standalone', entity: 'node', id: null }, req.body);
  const last = node.get().lastSync;
  node.save({ role: 'main', standaloneAt: new Date().toISOString(), lastAttempt: null });   // the saved role wins over NODE_ROLE in .env
  await audit(req, 'admin.node_standalone', 'node', null, { mainUrl: node.mainUrl() || null, dataAsOf: last && last.at || null });
  res.json(await status());
}));

router.post('/demote', limiter, asyncH(async (req, res) => {
  if (node.isBackup()) throw new HttpError(409, 'This server is already a backup server');
  if (req.body.confirm !== 'DEMOTE') throw new HttpError(400, 'Type DEMOTE to confirm');
  if (!node.mainUrl() || !node.tokenOk()) throw new HttpError(400, 'Set NODE_MAIN_URL (the other server) and NODE_SYNC_TOKEN (24+ characters) in .env, restart, then try again');
  await stepUp.verify(req, { action: 'admin.node_demote', entity: 'node', id: null }, req.body);
  await audit(req, 'admin.node_demote', 'node', null, { mainUrl: node.mainUrl() });
  node.save({ role: 'backup', demotedAt: new Date().toISOString(), lastSync: null, lastAttempt: null });   // the next sync replaces ALL data here with the other server's
  res.json(await status());
}));

module.exports = router;
