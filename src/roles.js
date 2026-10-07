const { applyRoles } = require('./permissions');

/** Load roles and their actions from the database into the live permission tables. Keeps the defaults if the tables are not there yet. */
async function loadRoles(db) {
  try {
    const { rows } = await db.query(
      `SELECT r.name, COALESCE(array_agg(a.action ORDER BY a.action) FILTER (WHERE a.action IS NOT NULL), '{}') AS actions
         FROM roles r LEFT JOIN role_actions a ON a.role = r.name GROUP BY r.name, r.rank ORDER BY r.rank DESC, r.name`
    );
    if (rows.length) applyRoles(rows);
  } catch (e) {
    console.error('[roles] using built-in defaults:', e.message);
  }
}

module.exports = { loadRoles };
