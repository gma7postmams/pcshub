const db = require('./db');

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
  } catch (e) {
    console.error('[audit] failed', e.message);
    if (client) throw e;
  }
}

module.exports = { audit };
