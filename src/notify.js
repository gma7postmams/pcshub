const db = require('./db');
const { can, ROLE_ACTIONS, effectiveKeys } = require('./permissions');

async function notifyUsers(userIds, { title, body, link }, client) {
  const ids = [...new Set((userIds || []).filter((x) => Number.isInteger(x)))];
  if (!ids.length) return;
  const runner = client || db;
  await runner.query(
    `INSERT INTO notifications (user_id, title, body, link)
     SELECT u, $2, $3, $4 FROM unnest($1::int[]) AS u`,
    [ids, title, body || null, link || null]
  );
  try { require('./live').publishNotif(ids); } catch (_) { /* live updates are a bonus */ }
  // phones: after the caller's transaction (if any) is done; fire and forget
  setTimeout(() => { try { require('./push').sendPush(ids, { title, body, link }); } catch (e) { console.warn('push unavailable:', e.message); } }, client ? 1500 : 0);
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

/** Notify every active user who may open the page `pageKey` (e.g. 'plugs'), whatever their role. */
async function notifyPageUsers(pageKey, payload, { excludeUserId } = {}, client) {
  const runner = client || db;
  const { rows } = await runner.query(
    `SELECT u.id, u.role,
            COALESCE((SELECT array_agg(gp.perm_key) FROM group_permissions gp WHERE gp.group_id = u.group_id), '{}') AS perms
       FROM users u
      WHERE u.is_active AND ($1::int IS NULL OR u.id <> $1)`,
    [excludeUserId || null]
  );
  await notifyUsers(rows.filter((u) => effectiveKeys({ role: u.role, perms: u.perms }).has(pageKey)).map((u) => u.id), payload, client);
}

/** Notify the Workload team users (VGFX / VEDIT / AUDIO) whose tab is in `teams`. Admins are left out (they open every tab); `excludeUserId` is the person who made the change. */
async function notifyWorkloadTeams(teams, payload, { excludeUserId } = {}, client) {
  const keys = [...new Set(teams)].map((t) => `workload.${String(t).toLowerCase()}`);
  if (!keys.length) return;
  const runner = client || db;
  const { rows } = await runner.query(
    `SELECT u.id, u.role,
            COALESCE((SELECT array_agg(gp.perm_key) FROM group_permissions gp WHERE gp.group_id = u.group_id), '{}') AS perms
       FROM users u
      WHERE u.is_active AND u.role NOT IN ('Admin', 'System Admin') AND ($1::int IS NULL OR u.id <> $1)`,
    [excludeUserId || null]
  );
  await notifyUsers(rows.filter((u) => { const eff = effectiveKeys({ role: u.role, perms: u.perms }); return keys.some((k) => eff.has(k)); }).map((u) => u.id), payload, client);
}

module.exports = { notifyPageUsers, notifyUsers, notifyCapable, notifyWorkloadTeams };
