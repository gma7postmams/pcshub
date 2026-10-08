const { EventEmitter } = require('events');
const db = require('./db');

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
    setTimeout(() => auditBus.emit('change'), 400);   // a little later, so a line written inside a transaction has been committed
  } catch (e) {
    console.error('[audit] failed', e.message);
    if (client) throw e;
  }
}

module.exports = { audit, auditBus };
