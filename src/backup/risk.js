const cfg = require('./config');

const ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * Rule-based risk. "Removed" = rows that exist now but not in the backup (a restore would delete them);
 * audit_logs are excluded because the restore design keeps the live audit trail.
 * @returns {{level:'LOW'|'MEDIUM'|'HIGH', reasons:{level:string,message:string}[], blockers:string[]}}
 */
function assess({ verifyFailed, signature, compat, mode, tables, files, admins, backupMeta, ageDays, hostMatch, dbMatch, pgMajorMismatch, disallowed, knowledgeGaps }) {
  const reasons = [];
  const blockers = [];
  const add = (level, message) => reasons.push({ level, message });

  if (verifyFailed) blockers.push('The archive failed integrity or structure verification.');
  if (disallowed && disallowed.length) blockers.push(`The database dump contains unsupported objects: ${disallowed.join(', ')}.`);
  if (compat && compat.schema.status === 'newer') blockers.push(`Backup schema v${compat.schema.backup} is newer than this application (v${compat.schema.current}).`);
  if (admins && admins.backup === 0) blockers.push('The backup contains no active Admin account; restoring it would lock everyone out of administration.');

  if (compat && compat.schema.status === 'older') add('MEDIUM', `Backup schema v${compat.schema.backup} is older than v${compat.schema.current}; migrations would run after a restore.`);
  if (signature === 'unsigned') add('MEDIUM', 'The backup is unsigned, so its manifest cannot be proven authentic.');
  if (signature === 'no_key') add('MEDIUM', 'The backup is signed but BACKUP_SIGNING_KEY is not configured here, so authenticity could not be checked.');
  if (mode === 'counts-only') add('MEDIUM', 'Row-level comparison was unavailable; only record counts were compared.');
  if (pgMajorMismatch) add('MEDIUM', 'The backup was created on a different PostgreSQL major version.');
  if (hostMatch === false || dbMatch === false) add('MEDIUM', 'The backup came from a different host or database name.');
  if (knowledgeGaps) add('MEDIUM', `${knowledgeGaps} knowledge document record(s) had no file when the backup was made.`);
  if (admins && admins.current != null && admins.backup != null && admins.backup < admins.current) {
    add('HIGH', `Active Admin accounts would drop from ${admins.current} to ${admins.backup}.`);
  }

  if (ageDays != null) {
    if (ageDays > cfg.RISK.highAgeDays) add('HIGH', `The backup is ${Math.floor(ageDays)} days old.`);
    else if (ageDays > cfg.RISK.mediumAgeDays) add('MEDIUM', `The backup is ${Math.floor(ageDays)} days old.`);
  }

  let removedTotal = 0;
  for (const t of tables) {
    if (!t.detail || t.id === 'audit_logs') continue;
    removedTotal += t.removed;
    if (!t.removed) continue;
    const pct = t.current ? (t.removed / t.current) * 100 : 0;
    if (t.id === 'users') add('HIGH', `${t.removed} current user(s) are not in the backup and would lose access.`);
    else if (pct > cfg.RISK.highRemovedPct) add('HIGH', `${t.removed} ${t.label.toLowerCase()} (${Math.round(pct)}%) would be removed.`);
    else add('MEDIUM', `${t.removed} ${t.label.toLowerCase()} would be removed.`);
  }
  if (removedTotal > cfg.RISK.highRemovedTotal) add('HIGH', `${removedTotal} records in total would be removed.`);

  for (const t of tables) {
    if (t.detail && ['users', 'groups'].includes(t.id) && t.modified) add('MEDIUM', `${t.modified} ${t.label.toLowerCase()} would change (roles, groups or permissions).`);
  }
  for (const f of Object.values(files)) {
    if (f.removed) add('MEDIUM', `${f.removed} ${f.label.toLowerCase()} would be deleted from disk.`);
  }

  if (blockers.length) reasons.unshift({ level: 'HIGH', message: 'Restore is blocked until the issues below are resolved.' });
  let level = 'LOW';
  for (const r of reasons) if (ORDER[r.level] > ORDER[level]) level = r.level;
  return { level, reasons, blockers };
}

module.exports = { assess };
