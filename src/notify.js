const db = require('./db');
const { can, ROLE_ACTIONS } = require('./permissions');

async function notifyUsers(userIds, { title, body, link }, client) {
  const ids = [...new Set((userIds || []).filter((x) => Number.isInteger(x)))];
  if (!ids.length) return;
  const runner = client || db;
  await runner.query(
    `INSERT INTO notifications (user_id, title, body, link)
     SELECT u, $2, $3, $4 FROM unnest($1::int[]) AS u`,
    [ids, title, body || null, link || null]
  );
}

/** Notify every active user who can perform `action` (role grants it AND their group opens its page). */
async function notifyCapable(action, payload, { excludeUserId } = {}, client) {
  const roles = Object.keys(ROLE_ACTIONS).filter((r) => ROLE_ACTIONS[r].includes(action));
  const runner = client || db;
  const { rows } = await runner.query(
    `SELECT u.id, u.role,
            COALESCE((SELECT array_agg(gp.perm_key) FROM group_permissions gp WHERE gp.group_id = u.group_id), '{}') AS perms
       FROM users u
      WHERE u.is_active AND u.role = ANY($1::text[]) AND ($2::int IS NULL OR u.id <> $2)`,
    [roles, excludeUserId || null]
  );
  await notifyUsers(rows.filter((u) => can(u, action)).map((u) => u.id), payload, client);
}

module.exports = { notifyUsers, notifyCapable };
