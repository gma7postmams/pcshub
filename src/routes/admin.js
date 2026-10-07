const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const multer = require('multer');
const validator = require('validator');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError } = require('../middleware');
const { audit } = require('../audit');
const { THEME_KEYS } = require('../themes');
const { ROLES, CATALOG, FIXED_PAGES, ROLE_ACTIONS, ACTION_PAGE, ALL_ACTIONS, normalizeKeys } = require('../permissions');
const { loadRoles } = require('../roles');

// Mounted behind requirePageAccess('/admin') => Admin role only; the role is re-checked here as defence in depth.
const router = express.Router();
router.use((req, res, next) => (req.user && req.user.role === 'Admin' ? next() : res.status(403).json({ error: 'Admin role required' })));

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'branding');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DROPDOWN_CATEGORIES = ['program', 'platform', 'workload_platform', 'plug_type'];
// Which table/column each dropdown category is stored in (used for usage counts, rename propagation, delete guard)
const DROPDOWN_USAGE = Object.assign(Object.create(null), {
  program: [{ table: 'ingest_records', col: 'program' }, { table: 'workload_items', col: 'prog_name' }, { table: 'workload_plugs', col: 'prog_name' }],
  platform: { table: 'ingest_records', col: 'platform' },
  workload_platform: { table: 'workload_items', col: 'platform' },
  plug_type: { table: 'workload_items', col: 'plug_type' },
});

// ---------- Access model reference (catalog of assignable pages/sections + role actions) ----------
router.get('/access-model', (req, res) => {
  res.json({ roles: ROLES, catalog: CATALOG, fixedPages: FIXED_PAGES, roleActions: ROLE_ACTIONS, actionPage: ACTION_PAGE });
});

// ---------- Roles (what a user can DO). Admin is fixed; the others are edited here; custom roles can be added and removed ----------
router.get('/roles', asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT r.name, r.description, r.is_builtin,
            COALESCE((SELECT array_agg(a.action ORDER BY a.action) FROM role_actions a WHERE a.role = r.name), '{}') AS actions,
            (SELECT count(*)::int FROM users u WHERE u.role = r.name) AS users
       FROM roles r ORDER BY r.rank DESC, r.name`
  );
  res.json(rows.map((r) => (r.name === 'Admin' ? { ...r, actions: [...ALL_ACTIONS] } : r)));
}));

function parseRole(body) {
  const name = v.str(body.name, { field: 'Role name', max: 40, required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) throw new HttpError(400, 'Role name may use letters, numbers, spaces, - and _');
  const description = v.str(body.description, { field: 'Description', max: 300 });
  if (!Array.isArray(body.actions)) throw new HttpError(400, 'actions must be a list');
  const actions = [...new Set(body.actions.map(String))];
  const bad = actions.find((a) => !ALL_ACTIONS.includes(a) || a === 'admin');
  if (bad) throw new HttpError(400, `"${bad}" is not an action a role can be given`);
  return { name, description, actions };
}
async function saveRoleActions(c, name, actions) {
  await c.query('DELETE FROM role_actions WHERE role=$1', [name]);
  if (actions.length) await c.query('INSERT INTO role_actions (role, action) SELECT $1, unnest($2::text[])', [name, actions]);
}

router.post('/roles', asyncH(async (req, res) => {
  const b = parseRole(req.body || {});
  try {
    await db.tx(async (c) => {
      await c.query('INSERT INTO roles (name, description, rank, actions_seeded) VALUES ($1,$2,1,true)', [b.name, b.description]);
      await saveRoleActions(c, b.name, b.actions);
      await audit(req, 'admin.role_create', 'role', b.name, { name: b.name, actions: b.actions }, c);
    });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, `Role "${b.name}" already exists`);
    throw e;
  }
  await loadRoles(db);
  res.status(201).json({ ok: true });
}));

router.put('/roles/:name', asyncH(async (req, res) => {
  const old = req.params.name;
  const b = parseRole(req.body || {});
  const cur = await db.query('SELECT is_builtin FROM roles WHERE name=$1', [old]);
  if (!cur.rows.length) throw new HttpError(404, 'Role not found');
  if (old === 'Admin') throw new HttpError(400, 'The Admin role is fixed and cannot be changed');
  if (cur.rows[0].is_builtin && b.name !== old) throw new HttpError(400, 'Built-in roles cannot be renamed');
  const before = (await db.query('SELECT action FROM role_actions WHERE role=$1', [old])).rows.map((r) => r.action);
  const added = b.actions.filter((a) => !before.includes(a));
  const removed = before.filter((a) => !b.actions.includes(a));
  try {
    await db.tx(async (c) => {
      await c.query('UPDATE roles SET name=$2, description=$3 WHERE name=$1', [old, b.name, b.description]);   // users and role_actions follow a rename (ON UPDATE CASCADE)
      await saveRoleActions(c, b.name, b.actions);
      await audit(req, 'admin.role_update', 'role', b.name, { name: b.name, renamedFrom: old !== b.name ? old : undefined, added, removed }, c);
    });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, `Role "${b.name}" already exists`);
    throw e;
  }
  await loadRoles(db);
  res.json({ ok: true });
}));

router.delete('/roles/:name', asyncH(async (req, res) => {
  const name = req.params.name;
  const cur = await db.query('SELECT is_builtin, (SELECT count(*)::int FROM users WHERE role=$1) AS users FROM roles WHERE name=$1', [name]);
  if (!cur.rows.length) throw new HttpError(404, 'Role not found');
  if (cur.rows[0].is_builtin) throw new HttpError(400, 'Built-in roles cannot be deleted');
  if (cur.rows[0].users) throw new HttpError(409, `${cur.rows[0].users} user(s) have the "${name}" role. Move them to another role first.`);
  await db.query('DELETE FROM roles WHERE name=$1', [name]);
  await audit(req, 'admin.role_delete', 'role', name, { name });
  await loadRoles(db);
  res.json({ ok: true });
}));

// ---------- Groups (enrolment + page/section access) ----------
router.get('/groups', asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
            COALESCE((SELECT array_agg(gp.perm_key ORDER BY gp.perm_key) FROM group_permissions gp WHERE gp.group_id = g.id), '{}') AS perms,
            (SELECT count(*)::int FROM users u WHERE u.group_id = g.id) AS members
       FROM groups g ORDER BY lower(g.name)`
  );
  res.json(rows);
}));

function parseGroup(body) {
  const name = v.str(body.name, { field: 'Group name', max: 80, required: true });
  const description = v.str(body.description, { field: 'Description', max: 300 });
  if (body.perms !== undefined && !Array.isArray(body.perms)) throw new HttpError(400, 'perms must be a list');
  const perms = normalizeKeys((body.perms || []).map(String));
  return { name, description, perms };
}

async function writePerms(c, groupId, perms) {
  await c.query('DELETE FROM group_permissions WHERE group_id=$1', [groupId]);
  if (perms.length) {
    await c.query(
      `INSERT INTO group_permissions (group_id, perm_key) SELECT $1, k FROM unnest($2::text[]) AS k`, [groupId, perms]
    );
  }
}

router.post('/groups', asyncH(async (req, res) => {
  const g = parseGroup(req.body);
  const id = await db.tx(async (c) => {
    let r;
    try {
      r = await c.query('INSERT INTO groups (name, description) VALUES ($1,$2) RETURNING id', [g.name, g.description]);
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, `Group "${g.name}" already exists`);
      throw e;
    }
    await writePerms(c, r.rows[0].id, g.perms);
    await audit(req, 'admin.group_create', 'group', r.rows[0].id, g, c);
    return r.rows[0].id;
  });
  res.status(201).json({ ok: true, id });
}));

router.put('/groups/:id', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const g = parseGroup(req.body);
  await db.tx(async (c) => {
    const cur = await c.query(
      `SELECT g.name, COALESCE((SELECT array_agg(perm_key ORDER BY perm_key) FROM group_permissions WHERE group_id=g.id), '{}') AS perms
         FROM groups g WHERE g.id=$1 FOR UPDATE`, [id]
    );
    if (!cur.rows.length) throw new HttpError(404, 'Group not found');
    try {
      await c.query('UPDATE groups SET name=$2, description=$3, updated_at=now() WHERE id=$1', [id, g.name, g.description]);
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, `Group "${g.name}" already exists`);
      throw e;
    }
    await writePerms(c, id, g.perms);
    await audit(req, 'admin.group_update', 'group', id, { from: cur.rows[0], to: g }, c);
  });
  res.json({ ok: true });
}));

router.delete('/groups/:id', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const m = await db.query('SELECT count(*)::int AS n FROM users WHERE group_id=$1', [id]);
  if (m.rows[0].n > 0) throw new HttpError(409, `Group has ${m.rows[0].n} member(s). Move them to another group first.`);
  const r = await db.query('DELETE FROM groups WHERE id=$1 RETURNING name', [id]);
  if (!r.rowCount) throw new HttpError(404, 'Group not found');
  await audit(req, 'admin.group_delete', 'group', id, { name: r.rows[0].name });
  res.json({ ok: true });
}));

// ---------- Users ----------
router.get('/users', asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.full_name, u.email, u.role, u.group_id, g.name AS group_name, u.is_active,
            u.totp_enabled, u.twofa_required, u.must_change_password, u.last_login_at, u.locked_until, u.created_at
       FROM users u LEFT JOIN groups g ON g.id = u.group_id
      ORDER BY u.is_active DESC, u.full_name`
  );
  res.json(rows);
}));

async function parseUser(body, { creating }) {
  const out = {
    full_name: v.str(body.full_name, { field: 'Full name', max: 120, required: true }),
    email: v.str(body.email, { field: 'Email', max: 200 }),
    role: v.oneOf(body.role, ROLES, { field: 'Role' }),
    group_id: v.int(body.group_id, { field: 'Group', min: 1 }),
    is_active: body.is_active === undefined ? true : !!body.is_active,
  };
  if (out.email && !validator.isEmail(out.email)) throw new HttpError(400, 'Invalid email');
  if (out.group_id) {
    const g = await db.query('SELECT 1 FROM groups WHERE id=$1', [out.group_id]);
    if (!g.rows.length) throw new HttpError(400, 'Group does not exist');
  }
  if (creating) {
    out.username = v.str(body.username, { field: 'Username', max: 60, required: true });
    if (!/^[A-Za-z0-9._-]{3,60}$/.test(out.username)) {
      throw new HttpError(400, 'Username must be 3–60 chars: letters, numbers, . _ -');
    }
    out.password = v.password(body.password, { username: out.username, fullName: out.full_name });
  }
  return out;
}

async function assertAnotherAdmin(c, excludingId) {
  const { rows } = await c.query(
    `SELECT count(*)::int AS n FROM users WHERE role='Admin' AND is_active AND id <> $1`, [excludingId]
  );
  if (rows[0].n === 0) throw new HttpError(400, 'At least one active Admin must remain');
}

router.post('/users', asyncH(async (req, res) => {
  const u = await parseUser(req.body, { creating: true });
  const hash = await bcrypt.hash(u.password, 12);
  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, full_name, email, password_hash, role, group_id, is_active, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE) RETURNING id`,
      [u.username, u.full_name, u.email, hash, u.role, u.group_id, u.is_active]
    );
    await audit(req, 'admin.user_create', 'user', rows[0].id, { username: u.username, role: u.role, group_id: u.group_id });
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Username already exists');
    throw e;
  }
}));

router.put('/users/:id', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const u = await parseUser(req.body, { creating: false });
  await db.tx(async (c) => {
    const cur = await c.query('SELECT username, full_name, email, role, group_id, is_active FROM users WHERE id=$1 FOR UPDATE', [id]);
    if (!cur.rows.length) throw new HttpError(404, 'User not found');
    const wasAdmin = cur.rows[0].role === 'Admin' && cur.rows[0].is_active;
    const staysAdmin = u.role === 'Admin' && u.is_active;
    if (wasAdmin && !staysAdmin) await assertAnotherAdmin(c, id);
    await c.query(
      `UPDATE users SET full_name=$2, email=$3, role=$4, group_id=$5, is_active=$6, updated_at=now() WHERE id=$1`,
      [id, u.full_name, u.email, u.role, u.group_id, u.is_active]
    );
    if (!u.is_active) {
      await c.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1`, [id]);
    }
    const old = cur.rows[0];
    const next = { full_name: u.full_name, email: u.email, role: u.role, group_id: u.group_id, is_active: u.is_active };
    const from = {};
    const to = {};
    for (const k of Object.keys(next)) {
      if ((old[k] ?? null) !== (next[k] ?? null)) { from[k] = old[k] ?? null; to[k] = next[k] ?? null; }
    }
    if ('group_id' in to) {
      const ids = [from.group_id, to.group_id].filter((x) => x != null);
      const names = ids.length
        ? (await c.query('SELECT id, name FROM groups WHERE id = ANY($1)', [ids])).rows : [];
      const nm = (gid) => (gid == null ? null : (names.find((r) => r.id === gid) || {}).name || `#${gid}`);
      from.group = nm(from.group_id);
      to.group = nm(to.group_id);
    }
    await audit(req, 'admin.user_update', 'user', id, { username: old.username, from, to }, c);
  });
  res.json({ ok: true });
}));

// Delete one or several users. Their records stay (created-by / requested-by links are cleared), their sessions end,
// and the audit log keeps their user name. You cannot delete yourself or the last active Admin.
router.post('/users/delete', asyncH(async (req, res) => {
  const raw = req.body && req.body.ids;
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Choose at least one user');
  if (raw.length > 200) throw new HttpError(400, 'Delete at most 200 users at a time');
  const ids = [...new Set(raw.map((x) => v.id(x)))];
  if (ids.includes(req.user.id)) throw new HttpError(400, 'You cannot delete your own account');
  const gone = await db.tx(async (c) => {
    const { rows } = await c.query('SELECT id, username, full_name, role, is_active FROM users WHERE id = ANY($1::int[]) FOR UPDATE', [ids]);
    if (!rows.length) throw new HttpError(404, 'User not found');
    if (rows.some((u) => u.role === 'Admin' && u.is_active)) {
      const left = await c.query(`SELECT count(*)::int AS n FROM users WHERE role='Admin' AND is_active AND id <> ALL($1::int[])`, [rows.map((u) => u.id)]);
      if (left.rows[0].n === 0) throw new HttpError(400, 'At least one active Admin must remain');
    }
    await c.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = ANY($1::int[])`, [rows.map((u) => u.id)]);
    await c.query('DELETE FROM users WHERE id = ANY($1::int[])', [rows.map((u) => u.id)]);
    for (const u of rows) await audit(req, 'admin.user_delete', 'user', u.id, { username: u.username, full_name: u.full_name, role: u.role }, c);
    return rows.length;
  });
  res.json({ ok: true, deleted: gone });
}));

router.post('/users/:id/reset-password', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const target = (await db.query('SELECT username, full_name FROM users WHERE id=$1', [id])).rows[0];
  if (!target) throw new HttpError(404, 'User not found');
  const temp = req.body.password ? v.password(req.body.password, { username: target.username, fullName: target.full_name })
    : `${crypto.randomBytes(12).toString('base64url')}${crypto.randomInt(10, 99)}`;
  const hash = await bcrypt.hash(temp, 12);
  const r = await db.query(
    `UPDATE users SET password_hash=$2, must_change_password=TRUE, failed_attempts=0, locked_until=NULL, updated_at=now()
      WHERE id=$1`, [id, hash]
  );
  if (!r.rowCount) throw new HttpError(404, 'User not found');
  await db.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1`, [id]);
  await audit(req, 'admin.user_reset_password', 'user', id, { username: target.username });
  res.json({ ok: true, temporary_password: temp });
}));

// Only an Admin can turn 2FA on or off for an account. On: the user must enrol an authenticator at next use.
// Off: their authenticator is removed too, so they sign in with the password alone again.
router.post('/users/:id/2fa', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  if (typeof req.body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
  const enabled = req.body.enabled;
  if (!(await db.query('SELECT 1 FROM users WHERE id=$1', [id])).rowCount) throw new HttpError(404, 'User not found');
  const r = await db.query(
    enabled
      ? 'UPDATE users SET twofa_required=TRUE, updated_at=now() WHERE id=$1 RETURNING username'
      : 'UPDATE users SET twofa_required=FALSE, totp_secret=NULL, totp_enabled=FALSE, totp_last_step=NULL, updated_at=now() WHERE id=$1 RETURNING username',
    [id]
  );
  await audit(req, enabled ? 'admin.user_2fa_enable' : 'admin.user_2fa_disable', 'user', id, { username: r.rows[0].username });
  res.json({ ok: true });
}));

router.post('/users/:id/reset-2fa', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  if (!(await db.query('SELECT 1 FROM users WHERE id=$1', [id])).rowCount) throw new HttpError(404, 'User not found');
  const r = await db.query(
    `UPDATE users SET totp_secret=NULL, totp_enabled=FALSE, totp_last_step=NULL, updated_at=now() WHERE id=$1 RETURNING username`, [id]
  );
  if (!r.rowCount) throw new HttpError(404, 'User not found');
  await audit(req, 'admin.user_reset_2fa', 'user', id, { username: r.rows[0].username });
  res.json({ ok: true });
}));

router.post('/users/:id/unlock', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const cur = await db.query(
    'SELECT username FROM users WHERE id=$1',
    [id]
  );

  if (!cur.rows.length) throw new HttpError(404, 'User not found');

  await db.query(
    'UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=$1',
    [id]
  );

  await audit(req, 'admin.user_unlock', 'user', id, {
    username: cur.rows[0].username
  });
  res.json({ ok: true });
}));

// ---------- Dropdowns ----------
router.get('/dropdowns', asyncH(async (req, res) => {
  const { rows } = await db.query(
    `SELECT d.*, (
              (SELECT count(*)::int FROM ingest_records i
                WHERE (d.category='program' AND i.program=d.value) OR (d.category='platform' AND i.platform=d.value))
            + (SELECT count(*)::int FROM workload_items w
                WHERE (d.category='workload_platform' AND w.platform=d.value)
                   OR (d.category='plug_type' AND w.plug_type=d.value))) AS usage
       FROM dropdown_options d ORDER BY category, sort_order, value`
  );
  res.json({ categories: DROPDOWN_CATEGORIES, rows });
}));

router.post('/dropdowns', asyncH(async (req, res) => {
  const category = v.oneOf(req.body.category, DROPDOWN_CATEGORIES, { field: 'Category' });
  const value = v.str(req.body.value, { field: 'Value', max: 200, required: true });
  try {
    // New options go to the end of their list
    const { rows } = await db.query(
      `INSERT INTO dropdown_options (category, value, sort_order)
       VALUES ($1, $2, COALESCE((SELECT max(sort_order) FROM dropdown_options WHERE category = $1), 0) + 1) RETURNING id`,
      [category, value]
    );
    await audit(req, 'admin.dropdown_create', 'dropdown_option', rows[0].id, { category, value });
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, `"${value}" already exists in ${category}`);
    throw e;
  }
}));

// Export every dropdown list as JSON (list order is kept: options appear in the order they are shown in forms).
router.get('/dropdowns/export', asyncH(async (req, res) => {
  const { rows } = await db.query('SELECT category, value, is_active FROM dropdown_options ORDER BY category, sort_order, value');
  const lists = Object.fromEntries(DROPDOWN_CATEGORIES.map((c) => [c, []]));
  rows.forEach((r) => { if (lists[r.category]) lists[r.category].push({ value: r.value, active: r.is_active }); });
  const body = JSON.stringify({ app: 'promo-hub', type: 'dropdowns', version: 1, exported_at: new Date().toISOString(), dropdowns: lists }, null, 2);
  await audit(req, 'admin.dropdown_export', 'dropdown_option', null, { options: rows.length });
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="dropdowns-${new Date().toISOString().slice(0, 10)}.json"`,
    'Cache-Control': 'no-store',
  });
  res.send(body);
}));

// Import a JSON file made by the export: options that are missing are added (at the end of their list), existing ones
// only have their Active flag updated. Nothing is deleted or renamed, so records that use an option are never affected.
router.post('/dropdowns/import', asyncH(async (req, res) => {
  const src = req.body && req.body.dropdowns;
  if (!src || typeof src !== 'object' || Array.isArray(src)) throw new HttpError(400, 'Not a dropdown export file (missing "dropdowns")');
  const unknown = Object.keys(src).filter((k) => !DROPDOWN_CATEGORIES.includes(k));
  if (unknown.length) throw new HttpError(400, `Unknown dropdown list: ${unknown.slice(0, 3).join(', ')}`);
  const plan = [];
  for (const cat of DROPDOWN_CATEGORIES) {
    const list = src[cat];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new HttpError(400, `"${cat}" must be a list`);
    if (list.length > 2000) throw new HttpError(400, `"${cat}" has too many entries (max 2000)`);
    const seen = new Set();
    for (const item of list) {
      const raw = typeof item === 'string' ? item : item && item.value;
      if (typeof raw !== 'string') throw new HttpError(400, `"${cat}" has an entry without a value`);
      const value = v.str(raw, { field: `${cat} value`, max: 200, required: true });
      if (seen.has(value)) continue;
      seen.add(value);
      plan.push({ cat, value, active: item && typeof item === 'object' && item.active === false ? false : true });
    }
  }
  const out = { added: 0, updated: 0, unchanged: 0 };
  await db.tx(async (c) => {
    for (const p of plan) {
      const cur = await c.query('SELECT id, is_active FROM dropdown_options WHERE category=$1 AND value=$2', [p.cat, p.value]);
      if (!cur.rows.length) {
        await c.query(
          `INSERT INTO dropdown_options (category, value, is_active, sort_order)
           VALUES ($1, $2, $3, COALESCE((SELECT max(sort_order) FROM dropdown_options WHERE category = $1), 0) + 1)`,
          [p.cat, p.value, p.active]
        );
        out.added += 1;
      } else if (cur.rows[0].is_active !== p.active) {
        await c.query('UPDATE dropdown_options SET is_active=$2 WHERE id=$1', [cur.rows[0].id, p.active]);
        out.updated += 1;
      } else out.unchanged += 1;
    }
    await audit(req, 'admin.dropdown_import', 'dropdown_option', null, out, c);
  });
  res.json({ ok: true, ...out });
}));

router.put('/dropdowns/:id', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const value = v.str(req.body.value, { field: 'Value', max: 200, required: true });
  const is_active = !!req.body.is_active;
  await db.tx(async (c) => {
    const cur = await c.query('SELECT * FROM dropdown_options WHERE id=$1 FOR UPDATE', [id]);
    if (!cur.rows.length) throw new HttpError(404, 'Option not found');
    const old = cur.rows[0];
    try {
      await c.query('UPDATE dropdown_options SET value=$2, is_active=$3 WHERE id=$1', [id, value, is_active]);
    } catch (e) {
      if (e.code === '23505') throw new HttpError(409, `"${value}" already exists`);
      throw e;
    }
    // Renaming propagates to existing records so filters and counts stay consistent
    if (old.value !== value) {
      for (const u of [].concat(DROPDOWN_USAGE[old.category])) {
        await c.query(`UPDATE ${u.table} SET ${u.col}=$2 WHERE ${u.col}=$1`, [old.value, value]);
      }
    }
    await audit(req, 'admin.dropdown_update', 'dropdown_option', id,
      { from: { value: old.value, is_active: old.is_active }, to: { value, is_active } }, c);
  });
  res.json({ ok: true });
}));

// Delete several options at once. Options still in use are kept (and reported), like the single delete.
router.post('/dropdowns/delete', asyncH(async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 500);
  if (!ids.length) throw new HttpError(400, 'Choose at least one option');
  const { rows } = await db.query('SELECT id, category, value FROM dropdown_options WHERE id = ANY($1::int[])', [ids]);
  const deleted = []; const kept = [];
  for (const o of rows) {
    let n = 0;
    for (const u of [].concat(DROPDOWN_USAGE[o.category])) {
      n += (await db.query(`SELECT count(*)::int AS n FROM ${u.table} WHERE ${u.col}=$1`, [o.value])).rows[0].n;
    }
    if (n > 0) { kept.push({ id: o.id, value: o.value, used: n }); continue; }
    await db.query('DELETE FROM dropdown_options WHERE id=$1', [o.id]);
    await audit(req, 'admin.dropdown_delete', 'dropdown_option', o.id, { category: o.category, value: o.value });
    deleted.push(o.id);
  }
  res.json({ ok: true, deleted: deleted.length, kept });
}));

router.delete('/dropdowns/:id', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const cur = await db.query('SELECT * FROM dropdown_options WHERE id=$1', [id]);
  if (!cur.rows.length) throw new HttpError(404, 'Option not found');
  const o = cur.rows[0];
  const parts = [];
  for (const u of [].concat(DROPDOWN_USAGE[o.category])) {
    const used = await db.query(`SELECT count(*)::int AS n FROM ${u.table} WHERE ${u.col}=$1`, [o.value]);
    const n = used.rows[0].n;
    if (n > 0) parts.push(`${n} ${u.table === 'workload_items' ? 'workload item(s)' : u.table === 'workload_plugs' ? 'plug list entr(ies)' : 'ingest record(s)'}`);
  }
  if (parts.length) throw new HttpError(409, `"${o.value}" is used by ${parts.join(', ')}. Deactivate it instead.`);
  await db.query('DELETE FROM dropdown_options WHERE id=$1', [id]);
  await audit(req, 'admin.dropdown_delete', 'dropdown_option', id, { category: o.category, value: o.value });
  res.json({ ok: true });
}));

// ---------- Workload Tracker: custom columns (Add Column, in both Table and Excel modes) ----------
const shapeCol = (r) => ({ id: r.id, key: r.col_key, label: r.label, sort_order: r.sort_order });
router.get('/workload-columns', asyncH(async (req, res) => {
  const { rows } = await db.query('SELECT id, col_key, label, sort_order FROM workload_custom_columns ORDER BY sort_order, id');
  res.json({ columns: rows.map(shapeCol) });
}));

router.post('/workload-columns', asyncH(async (req, res) => {
  const label = v.str(req.body.label, { field: 'Column name', max: 60, required: true });
  const dupe = await db.query('SELECT 1 FROM workload_custom_columns WHERE lower(label)=lower($1)', [label]);
  if (dupe.rows.length) throw new HttpError(409, `A column named "${label}" already exists`);
  const col = await db.tx(async (c) => {
    const { rows: [{ id }] } = await c.query(
      'INSERT INTO workload_custom_columns (label, sort_order, created_by) VALUES ($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM workload_custom_columns), $2) RETURNING id',
      [label, req.user.id]
    );
    const { rows: [row] } = await c.query('UPDATE workload_custom_columns SET col_key=$2 WHERE id=$1 RETURNING id, col_key, label, sort_order', [id, `custom_${id}`]);
    return row;
  });
  await audit(req, 'admin.workload_column_add', 'workload_custom_column', col.id, { label });
  res.status(201).json({ ok: true, column: shapeCol(col) });
}));

router.delete('/workload-columns/:id', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const cur = await db.query('SELECT * FROM workload_custom_columns WHERE id=$1', [id]);
  if (!cur.rows.length) throw new HttpError(404, 'Column not found');
  await db.query('DELETE FROM workload_custom_columns WHERE id=$1', [id]);
  // Values already entered under this column are left in place in custom_fields (harmless, just orphaned/hidden)
  // rather than rewriting every row — removing the column definition is enough to hide it going forward.
  await audit(req, 'admin.workload_column_delete', 'workload_custom_column', id, { label: cur.rows[0].label });
  res.json({ ok: true });
}));

// ---------- Workload Tracker: date locks (freeze a period so its rows can't be edited/deleted/created) ----------
router.get('/workload-locks', asyncH(async (req, res) => {
  const { rows } = await db.query('SELECT id, from_date, to_date, note FROM workload_locks ORDER BY from_date DESC');
  res.json({ locks: rows });
}));

router.post('/workload-locks', asyncH(async (req, res) => {
  const from_date = v.date(req.body.from_date, { field: 'From date', required: true });
  const to_date = v.date(req.body.to_date, { field: 'To date', required: true });
  if (to_date < from_date) throw new HttpError(400, 'To date must be on or after From date');
  const note = v.str(req.body.note, { field: 'Note', max: 200 });
  const { rows: [lock] } = await db.query(
    'INSERT INTO workload_locks (from_date, to_date, note, created_by) VALUES ($1, $2, $3, $4) RETURNING id, from_date, to_date, note',
    [from_date, to_date, note, req.user.id]
  );
  await audit(req, 'admin.workload_lock_add', 'workload_lock', lock.id, { from_date, to_date, note });
  res.status(201).json({ ok: true, lock });
}));

router.delete('/workload-locks/:id', asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const cur = await db.query('SELECT * FROM workload_locks WHERE id=$1', [id]);
  if (!cur.rows.length) throw new HttpError(404, 'Lock not found');
  await db.query('DELETE FROM workload_locks WHERE id=$1', [id]);
  await audit(req, 'admin.workload_lock_delete', 'workload_lock', id, { from_date: cur.rows[0].from_date, to_date: cur.rows[0].to_date });
  res.json({ ok: true });
}));

// ---------- Branding ----------
router.put('/branding', asyncH(async (req, res) => {
  const app_name = v.str(req.body.app_name, { field: 'App name', max: 80, required: true });
  const tagline = v.str(req.body.tagline, { field: 'Tagline', max: 120 }) || '';
  const theme = v.oneOf(req.body.theme, THEME_KEYS, { field: 'Theme', def: 'midnight' });
  const accent_color = v.str(req.body.accent_color, { field: 'Accent color', max: 7 }) || '';
  if (accent_color && !/^#[0-9a-fA-F]{6}$/.test(accent_color)) throw new HttpError(400, 'Accent color must be a hex value like #4f8cff (or empty to use the theme accent)');
  await db.tx(async (c) => {
    const next = { app_name, tagline, theme, accent_color };
    const { rows: curRows } = await c.query(
      'SELECT key, value FROM app_settings WHERE key = ANY($1)', [Object.keys(next)]
    );
    const old = Object.fromEntries(curRows.map((r) => [r.key, r.value]));
    const from = {};
    const to = {};
    for (const k of Object.keys(next)) {
      if ((old[k] ?? '') !== next[k]) { from[k] = old[k] ?? ''; to[k] = next[k]; }
    }
    for (const [k, val] of Object.entries(next)) {
      await c.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,now())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [k, val]
      );
    }
    if (Object.keys(to).length) {
      await audit(req, 'admin.branding_update', 'app_settings', null, { from, to }, c);
    }
  });
  res.json({ ok: true });
}));

const ALLOWED_LOGO = Object.assign(Object.create(null), { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `logo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ALLOWED_LOGO[file.mimetype]}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_LOGO[file.mimetype]) return cb(null, true);
    cb(new HttpError(400, 'Logo must be PNG, JPEG or WebP'));
  },
});

// Verify magic bytes so a renamed file cannot slip through
function sniff(buf) {
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

router.post('/branding/logo', upload.single('logo'), asyncH(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  const fd = fs.openSync(req.file.path, 'r');
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  if (sniff(head) !== req.file.mimetype) {
    fs.unlinkSync(req.file.path);
    throw new HttpError(400, 'File content does not match its type');
  }
  const url = `/uploads/branding/${req.file.filename}`;
  const prev = await db.query(`SELECT value FROM app_settings WHERE key='logo_path'`);
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('logo_path',$1,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [url]
  );
  removeOldLogo(prev.rows[0] && prev.rows[0].value);
  await audit(req, 'admin.branding_logo', 'app_settings', null, { file: req.file.filename, size: req.file.size });
  res.json({ ok: true, logo_url: url });
}));

router.delete('/branding/logo', asyncH(async (req, res) => {
  const prev = await db.query(`SELECT value FROM app_settings WHERE key='logo_path'`);
  await db.query(`UPDATE app_settings SET value='', updated_at=now() WHERE key='logo_path'`);
  removeOldLogo(prev.rows[0] && prev.rows[0].value);
  await audit(req, 'admin.branding_logo_remove', 'app_settings', null);
  res.json({ ok: true });
}));

function removeOldLogo(url) {
  if (!url || !url.startsWith('/uploads/branding/')) return;
  const file = path.join(UPLOAD_DIR, path.basename(url));
  fs.unlink(file, () => {});
}

// ---------- Audit ----------
router.get('/audit', asyncH(async (req, res) => {
  const params = [];
  const where = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.action) add('action ILIKE ?', v.like(req.query.action, 60));
  if (req.query.user) add('username ILIKE ?', v.like(req.query.user, 60));
  if (req.query.from) add('created_at >= ?::date', v.date(req.query.from, { field: 'From' }));
  if (req.query.to) add(`created_at < (?::date + 1)`, v.date(req.query.to, { field: 'To' }));
  const { limit, offset } = v.paging(req.query, { def: 50, max: 200 });
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [cnt, list] = await Promise.all([
    db.query(`SELECT count(*)::int AS n FROM audit_logs ${whereSql}`, params),
    db.query(`SELECT * FROM audit_logs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`, params),
  ]);
  res.json({ total: cnt.rows[0].n, rows: list.rows });
}));

module.exports = router;
