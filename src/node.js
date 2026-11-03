// Main / backup server role.
//
//   NODE_ROLE        main (default) | backup     what this server is when it first starts
//   NODE_MAIN_URL    https://pulse-main.lan      backup server only: where the main server is
//   NODE_SYNC_TOKEN  a long random secret        the same value on BOTH servers: the backup server uses it to pull from the main one
//   NODE_SYNC_HOURS  4                           backup server only: how often it copies the main server (1 to 24)
//
// A backup server is a full copy of the app that is kept read-only. Every few hours it asks the main server for a fresh backup
// (the same archive Administration → Backup and Restore makes: database + uploaded files) and restores it over itself.
// "Promote to main" (Administration → Backup Server) turns it into the main server when the real one is gone.
//
// The role lives in env, but Promote / Demote must survive a restore and a restart, so the live role is kept in a small file next
// to the backups (NOT in the database, which is replaced on every sync). The file wins over NODE_ROLE once it exists.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./backup/config');

const SYNC_NOTE = 'Backup server sync';   // marks the backups made for the backup server: they are kept apart from the real ones
const STATE_FILE = path.join(cfg.BACKUP_DIR, 'node-state.json');
const ROLES = ['main', 'backup'];

let state = null;

function load() {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch (_) { state = {}; }
  return state;
}
const get = () => state || load();

function save(patch) {
  state = { ...get(), ...patch };
  try {
    fs.mkdirSync(cfg.BACKUP_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error('[node] could not save the role file:', e.message); throw e; }
  return state;
}

const envRole = () => (ROLES.includes(String(process.env.NODE_ROLE || '').toLowerCase()) ? String(process.env.NODE_ROLE).toLowerCase() : 'main');
const role = () => (ROLES.includes(get().role) ? get().role : envRole());
const isBackup = () => role() === 'backup';

const mainUrl = () => String(process.env.NODE_MAIN_URL || '').trim().replace(/\/+$/, '');
const token = () => String(process.env.NODE_SYNC_TOKEN || '').trim();
const syncHours = () => {
  const n = Number(process.env.NODE_SYNC_HOURS);
  return Number.isFinite(n) && n >= 1 && n <= 24 ? n : 4;
};

/** The shared secret is long enough to mean something (the check also keeps an empty value from matching an empty header). */
const tokenOk = () => token().length >= 24;

/** Constant-time comparison of a presented token with NODE_SYNC_TOKEN. */
function tokenMatches(presented) {
  if (!tokenOk() || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(token()).digest();
  return crypto.timingSafeEqual(a, b);
}

/** What the page and the admin tab get to see (never the token). */
function publicInfo() {
  const s = get();
  return {
    role: role(),
    readOnly: isBackup(),
    lastSyncAt: s.lastSync && s.lastSync.ok ? s.lastSync.at : null,
    promotedAt: s.promotedAt || null,
  };
}

/**
 * While this server is a backup server nothing may be written: whatever someone changed here would be lost at the next sync, and
 * worse, people would believe it was saved. Signing in/out, the live-update pings and the Backup Server tab itself stay open.
 */
const WRITE_OK = [/^\/api\/auth(\/|$)/, /^\/api\/admin\/node(\/|$)/, /^\/api\/presence(\/|$)/, /^\/api\/live(\/|$)/];
function readOnlyGuard(req, res, next) {
  if (!isBackup() || /^(GET|HEAD|OPTIONS)$/.test(req.method)) return next();
  const p = `${req.baseUrl || ''}${req.path}`;   // mounted under /api, so req.path alone is relative
  if (WRITE_OK.some((re) => re.test(p))) return next();
  return res.status(503).json({
    error: 'This is the backup server: it is read-only. Use the main server to make changes.',
    readOnlyNode: true,
  });
}

module.exports = {
  SYNC_NOTE, STATE_FILE, load, get, save, role, isBackup, envRole, mainUrl, token, tokenOk, tokenMatches, syncHours, publicInfo, readOnlyGuard, WRITE_OK,
};
