const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) && parseInt(v, 10) > 0 ? parseInt(v, 10) : def);

module.exports = {
  ROOT,
  // Keep this outside the web root; backups hold password hashes and 2FA secrets.
  BACKUP_DIR: path.resolve(process.env.BACKUP_DIR || path.join(ROOT, 'backups')),
  UPLOADS_ROOT: path.join(ROOT, 'uploads'),
  UPLOAD_COMPONENTS: ['branding', 'knowledge'],

  // pg_dump needs read access to every table; restore (later phase) needs the owner login.
  DATABASE_URL: process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL,
  PG_DUMP_BIN: process.env.PG_DUMP_BIN || 'pg_dump',
  PG_RESTORE_BIN: process.env.PG_RESTORE_BIN || 'pg_restore',
  SIGNING_KEY: process.env.BACKUP_SIGNING_KEY || '',

  TIMEOUT_MS: int(process.env.BACKUP_TIMEOUT_MIN, 30) * 60 * 1000,
  MAX_BACKUPS: int(process.env.BACKUP_MAX_COUNT, 30),
  MAX_ARCHIVE_BYTES: int(process.env.BACKUP_MAX_MB, 20480) * 1024 * 1024,

  FORMAT_VERSION: 1,
  ADVISORY_LOCK_KEY: 727301,

  // Archive reader limits (zip-bomb / tamper guards)
  ZIP_MAX_ENTRIES: 20000,
  ZIP_MAX_UNCOMPRESSED: 20 * 1024 * 1024 * 1024,
  ZIP_MAX_RATIO: 100,
  ZIP_MAX_TEXT_BYTES: 5 * 1024 * 1024,

  DOWNLOAD_TOKEN_TTL_MS: 2 * 60 * 1000,

  // Restore analysis (uploaded archives wait here, untrusted, until discarded or expired)
  QUARANTINE_DIR: path.resolve(process.env.BACKUP_DIR || path.join(ROOT, 'backups'), 'quarantine'),
  ANALYSIS_TTL_MS: 30 * 60 * 1000,
  RISK: {
    highRemovedPct: 10, highRemovedTotal: 50, highAgeDays: 30, mediumAgeDays: 7,
  },
};
