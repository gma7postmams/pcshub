const { EventEmitter } = require('events');
const db = require('./db');

// Sign-ins, security blocks and admin actions are the trail an intruder would want gone. They are:
//  - kept for AUDIT_PROTECT_DAYS (default 365) even when an Admin runs Clear Data or the retention clean-up (PROTECTED_SQL), and
//  - also written to the server log (journalctl -u pcshub), which nobody can delete from inside the app.
const PROTECTED_RE = /^(auth|security|admin)\./;
const protectDays = () => {
  const n = parseInt(process.env.AUDIT_PROTECT_DAYS, 10);
  return Number.isFinite(n) && n >= 30 && n <= 3650 ? n : 365;
};
/** SQL condition (for audit_logs) that is true for lines that may be deleted. */
const deletableSql = () => `NOT (action ~ '^(auth|security|admin)\\.' AND created_at > now() - interval '${protectDays()} days')`;

// "A new audit line was written" signal; the Dashboard's Recent Activity stream listens to it. (Single Node process.)
const auditBus = new EventEmitter();
auditBus.setMaxListeners(0);

async function audit(req, action, entity, entityId, details, client) {
  const runner = client || db;
  try {
    await runner.query(
      `INSERT INTO audit_logs (user_id, username, action, entity, entity_id, details, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        req.user ? req.user.id : null,
        req.user ? req.user.username : (details && details.username) || null,
        action,
        entity || null,
        entityId != null ? String(entityId) : null,
        details ? JSON.stringify(details) : null,
        req.ip,
      ]
    );
    if (PROTECTED_RE.test(action)) {
      console.log(`[audit] ${JSON.stringify({ at: new Date().toISOString(), action, user: req.user ? req.user.username : (details && details.username) || null, ip: req.ip || null, entity: entity || null, id: entityId != null ? String(entityId) : null, details: details || null })}`.slice(0, 4000));
    }
    setTimeout(() => auditBus.emit('change'), 400);   // a little later, so a line written inside a transaction has been committed
  } catch (e) {
    console.error('[audit] failed', e.message);
    if (client) throw e;
  }
}

module.exports = { audit, auditBus, deletableSql, protectDays, PROTECTED_RE };
