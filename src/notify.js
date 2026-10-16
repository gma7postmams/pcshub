const db = require('./db');
const { can, ROLE_ACTIONS, effectiveKeys } = require('./permissions');

async function notifyUsers(userIds, { title, body, link, kind }, client) {
  const ids = [...new Set((userIds || []).filter((x) => Number.isInteger(x)))];
  if (!ids.length) return;
  const runner = client || db;
  // People choose per kind of activity whether it shows in the bell and whether it is pushed to their phone (missing = on)
  let bellIds = ids, pushIds = ids;
  if (kind) {
    const { rows } = await runner.query('SELECT id, notif_prefs FROM users WHERE id = ANY($1::int[])', [ids]);
    const pref = new Map(rows.map((r) => [r.id, (r.notif_prefs && r.notif_prefs[kind]) || {}]));
    bellIds = ids.filter((i) => (pref.get(i) || {}).bell !== false);
    pushIds = ids.filter((i) => (pref.get(i) || {}).push !== false);
  }
  if (bellIds.length) {
    await runner.query(
      `INSERT INTO notifications (user_id, title, body, link)
       SELECT u, $2, $3, $4 FROM unnest($1::int[]) AS u`,
      [bellIds, title, body || null, link || null]
    );
    try { require('./live').publishNotif(bellIds); } catch (_) { /* live updates are a bonus */ }
  }
  // phones: after the caller's transaction (if any) is done; fire and forget
  if (pushIds.length) setTimeout(() => { try { require('./push').sendPush(pushIds, { title, body, link }); } catch (e) { console.warn('push unavailable:', e.message); } }, client ? 1500 : 0);
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
async function notifyPageUsers(pageKey, payload, { excludeUserId, linkIf } = {}, client) {
  const runner = client || db;
  const { rows } = await runner.query(
    `SELECT u.id, u.role,
            COALESCE((SELECT array_agg(gp.perm_key) FROM group_permissions gp WHERE gp.group_id = u.group_id), '{}') AS perms
       FROM users u
      WHERE u.is_active AND ($1::int IS NULL OR u.id <> $1)`,
    [excludeUserId || null]
  );
  const who = rows.filter((u) => effectiveKeys({ role: u.role, perms: u.perms }).has(pageKey));
  // `linkIf` { key, link }: people who can also open that page are taken there instead (e.g. new plugs are copied into Workload, so Workload is where they look)
  const alt = linkIf ? who.filter((u) => effectiveKeys({ role: u.role, perms: u.perms }).has(linkIf.key)) : [];
  const altIds = new Set(alt.map((u) => u.id));
  await notifyUsers(who.filter((u) => !altIds.has(u.id)).map((u) => u.id), payload, client);
  if (alt.length) await notifyUsers(alt.map((u) => u.id), { ...payload, link: linkIf.link }, client);
}

module.exports = { notifyPageUsers, notifyUsers, notifyCapable };
