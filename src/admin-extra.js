// Admin additions: bulk user actions, sign-out, security overview, Admin home numbers, dropdown merge / bulk add, audit export.
// Mounted from routes/admin.js, so every route here is behind the Admin-only check.
const ExcelJS = require('exceljs');
const db = require('./db');
const v = require('./validate');
const { asyncH, HttpError } = require('./middleware');
const { audit } = require('./audit');
const { ROLES } = require('./permissions');

const settings = require('./security-settings');

module.exports = function mount(router, { DROPDOWN_CATEGORIES, DROPDOWN_USAGE, auditWhere }) {
  // ---------- Users: one action for many people ----------
  const BULK = ['activate', 'deactivate', 'role', 'group', 'reset-2fa', 'sign-out', 'unlock'];
  router.post('/users/bulk', asyncH(async (req, res) => {
    const raw = req.body && req.body.ids;
    if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Choose at least one user');
    if (raw.length > 200) throw new HttpError(400, 'Change at most 200 users at a time');
    const ids = [...new Set(raw.map((x) => v.id(x)))];
    const action = v.oneOf(req.body.action, BULK, { field: 'Action' });
    let role = null; let groupId = null;
    if (action === 'role') role = v.oneOf(req.body.value, ROLES, { field: 'Role' });
    if (action === 'group') {
      groupId = req.body.value === '' || req.body.value == null ? null : v.int(req.body.value, { field: 'Group', min: 1 });
      if (groupId && !(await db.query('SELECT 1 FROM groups WHERE id=$1', [groupId])).rowCount) throw new HttpError(400, 'Group does not exist');
    }
    if (['deactivate', 'role'].includes(action) && ids.includes(req.user.id)) throw new HttpError(400, 'You cannot do that to your own account — pick the other users');
    const out = await db.tx(async (c) => {
      const { rows } = await c.query('SELECT id, username, full_name, role, is_active FROM users WHERE id = ANY($1::int[]) FOR UPDATE', [ids]);
      if (!rows.length) throw new HttpError(404, 'User not found');
      // At least one active Admin must stay after the change.
      const loses = rows.filter((u) => u.role === 'Admin' && u.is_active && (action === 'deactivate' || (action === 'role' && role !== 'Admin')));
      if (loses.length) {
        const left = await c.query(`SELECT count(*)::int AS n FROM users WHERE role='Admin' AND is_active AND id <> ALL($1::int[])`, [loses.map((u) => u.id)]);
        if (!left.rows[0].n) throw new HttpError(400, 'At least one active Admin must remain');
      }
      const target = rows.map((u) => u.id);
      if (action === 'activate') await c.query('UPDATE users SET is_active=TRUE, updated_at=now() WHERE id = ANY($1::int[])', [target]);
      if (action === 'deactivate') {
        await c.query('UPDATE users SET is_active=FALSE, updated_at=now() WHERE id = ANY($1::int[])', [target]);
        await c.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = ANY($1::int[])`, [target]);
      }
      if (action === 'role') await c.query('UPDATE users SET role=$2, updated_at=now() WHERE id = ANY($1::int[])', [target, role]);
      if (action === 'group') await c.query('UPDATE users SET group_id=$2, updated_at=now() WHERE id = ANY($1::int[])', [target, groupId]);
      if (action === 'reset-2fa') await c.query('UPDATE users SET totp_secret=NULL, totp_enabled=FALSE, totp_last_step=NULL, updated_at=now() WHERE id = ANY($1::int[])', [target]);
      if (action === 'sign-out') await c.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = ANY($1::int[])`, [target]);
      if (action === 'unlock') await c.query('UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id = ANY($1::int[])', [target]);
      await audit(req, 'admin.user_bulk', 'user', null, {
        action, role, group_id: groupId, count: rows.length, users: rows.map((u) => u.username),
      }, c);
      return rows.length;
    });
    res.json({ ok: true, changed: out });
  }));

  // Sign one person out of every device (their sessions end; they sign in again with their password).
  router.post('/users/:id/sign-out', asyncH(async (req, res) => {
    const id = v.id(req.params.id);
    const u = (await db.query('SELECT username FROM users WHERE id=$1', [id])).rows[0];
    if (!u) throw new HttpError(404, 'User not found');
    const r = await db.query(`DELETE FROM user_sessions WHERE (sess->>'userId')::int = $1`, [id]);
    await audit(req, 'admin.user_signout', 'user', id, { username: u.username, sessions: r.rowCount });
    res.json({ ok: true, sessions: r.rowCount });
  }));

  // ---------- Security: the rules in force and what has been happening ----------
  router.get('/security', asyncH(async (req, res) => {
    const [users, events, failed] = await Promise.all([
      db.query(`SELECT count(*) FILTER (WHERE is_active)::int AS active,
                       count(*) FILTER (WHERE is_active AND totp_enabled)::int AS twofa_on,
                       count(*) FILTER (WHERE is_active AND (twofa_required OR (role='Admin' AND $1::boolean)) AND NOT totp_enabled)::int AS twofa_pending,
                       count(*) FILTER (WHERE is_active AND role='Admin' AND NOT totp_enabled)::int AS admins_without_2fa,
                       count(*) FILTER (WHERE locked_until > now())::int AS locked,
                       count(*) FILTER (WHERE must_change_password)::int AS must_change
                  FROM users`, [settings.get().requireAdmin2fa]),
      db.query(`SELECT id, created_at, username, action, ip FROM audit_logs
                 WHERE action IN ('auth.login_failed','auth.locked','auth.login_blocked_locked','auth.2fa_failed','auth.reauth_failed','admin.user_signout','admin.user_reset_password','admin.user_reset_2fa')
                 ORDER BY created_at DESC, id DESC LIMIT 15`),
      db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('auth.login_failed','auth.locked') AND created_at > now() - interval '7 days'`),
    ]);
    const sessions = await db.query(`SELECT count(*)::int AS n FROM user_sessions WHERE expire > now()`).catch(() => ({ rows: [{ n: null }] }));
    res.json({
      policy: {
        ...settings.get(), passwordRules: 'Letters and numbers, not a common password, no username or name inside it',
        loginRateLimit: parseInt(process.env.LOGIN_RATE_LIMIT, 10) || 20,
      },
      limits: Object.fromEntries(Object.entries(settings.FIELDS).map(([k, f]) => [k, { min: f.min, max: f.max, def: f.def }])),
      users: users.rows[0], failedLogins7d: failed.rows[0].n, openSessions: sessions.rows[0].n, events: events.rows,
    });
  }));

  const LABEL = { minPasswordLength: 'Minimum password length', lockAfterFailures: 'Lock after wrong passwords', lockMinutes: 'Lock duration', idleSignOutHours: 'Idle sign-out', maxSessionHours: 'Longest session' };
  // Change the rules. Every field is range-checked; the change is audited with before and after.
  router.put('/security/settings', asyncH(async (req, res) => {
    const b = req.body || {};
    const prev = settings.get();
    const next = {};
    for (const [k, f] of Object.entries(settings.FIELDS)) {
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < f.min || n > f.max) throw new HttpError(400, `${LABEL[k]} must be a whole number from ${f.min} to ${f.max}`);
      next[k] = n;
    }
    next.requireAdmin2fa = b.requireAdmin2fa === true;
    // Turning it on while you have no 2FA yourself would lock you out of this very page.
    if (next.requireAdmin2fa && !prev.requireAdmin2fa && !req.user.totp_enabled) {
      throw new HttpError(400, 'Set up 2FA on your own account first (Profile), then turn this on');
    }
    if (next.maxSessionHours < next.idleSignOutHours) throw new HttpError(400, 'The longest session cannot be shorter than the idle sign-out time');
    await db.tx(async (c) => {
      await settings.save(next, c);
      await audit(req, 'admin.security_update', 'app_settings', null, { from: prev, to: next }, c);
    });
    settings.apply(next);
    res.json({ ok: true, policy: settings.get() });
  }));

  // Everyone except the person pressing the button must choose a new password at their next sign-in.
  router.post('/security/force-password-change', asyncH(async (req, res) => {
    const r = await db.query('UPDATE users SET must_change_password=TRUE, updated_at=now() WHERE is_active AND id <> $1', [req.user.id]);
    await audit(req, 'admin.force_password_change', 'user', null, { users: r.rowCount });
    res.json({ ok: true, users: r.rowCount });
  }));

  // ---------- Admin home ----------
  router.get('/overview', asyncH(async (req, res) => {
    const [u, pending, failed, backup, online] = await Promise.all([
      db.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE is_active)::int AS active, count(*) FILTER (WHERE locked_until > now())::int AS locked,
                       count(*) FILTER (WHERE is_active AND totp_enabled)::int AS twofa_on FROM users`),
      db.query(`SELECT count(*)::int AS n FROM ingest_records WHERE approved_at IS NULL AND COALESCE(btrim(approved_by), '') = ''`),
      db.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('auth.login_failed','auth.locked') AND created_at > now() - interval '7 days'`),
      db.query(`SELECT id, created_at, finished_at, size_bytes, note FROM backup_jobs WHERE kind='create' AND status='succeeded' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`),
      db.query(`SELECT count(*)::int AS n FROM user_presence WHERE last_active_at > now() - interval '3 minutes'`).catch(() => ({ rows: [{ n: 0 }] })),
    ]);
    const last = backup.rows[0] || null;
    res.json({
      users: u.rows[0], online: online.rows[0].n, pendingApproval: pending.rows[0].n, failedLogins7d: failed.rows[0].n,
      lastBackup: last ? { id: last.id, at: last.finished_at || last.created_at, size: last.size_bytes == null ? null : Number(last.size_bytes), note: last.note } : null,
    });
  }));

  // ---------- Dropdowns: merge one option into another, add many at once ----------
  // Merge: every record that uses the "from" option is changed to the "into" option (same list), then "from" is removed.
  router.post('/dropdowns/merge', asyncH(async (req, res) => {
    const fromId = v.id(req.body.from_id); const intoId = v.id(req.body.into_id);
    if (fromId === intoId) throw new HttpError(400, 'Pick two different options');
    const out = await db.tx(async (c) => {
      const { rows } = await c.query('SELECT * FROM dropdown_options WHERE id = ANY($1::int[]) FOR UPDATE', [[fromId, intoId]]);
      const from = rows.find((r) => r.id === fromId); const into = rows.find((r) => r.id === intoId);
      if (!from || !into) throw new HttpError(404, 'Option not found');
      if (from.category !== into.category) throw new HttpError(400, 'Both options must be in the same list');
      let moved = 0;
      for (const u of [].concat(DROPDOWN_USAGE[from.category] || [])) {
        const r = await c.query(`UPDATE ${u.table} SET ${u.col}=$2 WHERE ${u.col}=$1`, [from.value, into.value]);
        moved += r.rowCount;
      }
      await c.query('DELETE FROM dropdown_options WHERE id=$1', [fromId]);
      await audit(req, 'admin.dropdown_merge', 'dropdown_option', intoId, { category: from.category, from: from.value, into: into.value, moved }, c);
      return { moved, from: from.value, into: into.value };
    });
    res.json({ ok: true, ...out });
  }));

  // Add many: one option per line (blank lines and repeats are skipped; options that already exist are reported).
  router.post('/dropdowns/bulk', asyncH(async (req, res) => {
    const category = v.oneOf(req.body.category, DROPDOWN_CATEGORIES, { field: 'Category' });
    const text = typeof req.body.text === 'string' ? req.body.text : '';
    const seen = new Set();
    const values = [];
    for (const line of text.split(/\r?\n/)) {
      const value = line.replace(/\s+/g, ' ').trim();
      if (!value || seen.has(value.toLowerCase())) continue;
      if (value.length > 200) throw new HttpError(400, `"${value.slice(0, 30)}…" is longer than 200 characters`);
      seen.add(value.toLowerCase());
      values.push(value);
    }
    if (!values.length) throw new HttpError(400, 'Paste at least one option (one per line)');
    if (values.length > 500) throw new HttpError(400, 'Add at most 500 options at a time');
    const out = await db.tx(async (c) => {
      const have = new Set((await c.query('SELECT lower(value) AS v FROM dropdown_options WHERE category=$1', [category])).rows.map((r) => r.v));
      const added = []; const skipped = [];
      for (const value of values) {
        if (have.has(value.toLowerCase())) { skipped.push(value); continue; }
        await c.query(
          `INSERT INTO dropdown_options (category, value, sort_order)
           VALUES ($1, $2, COALESCE((SELECT max(sort_order) FROM dropdown_options WHERE category = $1), 0) + 1)`, [category, value]
        );
        added.push(value);
      }
      await audit(req, 'admin.dropdown_bulk_add', 'dropdown_option', null, { category, added: added.length, skipped: skipped.length }, c);
      return { added, skipped };
    });
    res.json({ ok: true, added: out.added.length, skipped: out.skipped });
  }));

  // ---------- Audit log: Excel export of what the filters on screen show ----------
  router.get('/audit/export', asyncH(async (req, res) => {
    const { whereSql, params } = auditWhere(req.query);
    const LIMIT = 20000;
    const { rows } = await db.query(`SELECT created_at, username, action, entity, entity_id, details, ip FROM audit_logs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ${LIMIT}`, params);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Audit Log');
    ws.columns = [
      { header: 'Time', key: 'time', width: 20 }, { header: 'User', key: 'user', width: 18 }, { header: 'Action', key: 'action', width: 28 },
      { header: 'Entity', key: 'entity', width: 18 }, { header: 'Record', key: 'record', width: 10 }, { header: 'Details', key: 'details', width: 90 }, { header: 'IP', key: 'ip', width: 16 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    rows.forEach((r) => ws.addRow({
      time: r.created_at, user: r.username || '', action: r.action, entity: r.entity || '', record: r.entity_id || '',
      details: r.details ? JSON.stringify(r.details) : '', ip: r.ip || '',
    }));
    ws.getColumn('time').numFmt = 'yyyy-mm-dd hh:mm:ss';
    await audit(req, 'admin.audit_export', 'audit_log', null, { rows: rows.length, truncated: rows.length >= LIMIT });
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="Audit_Log_${new Date().toISOString().slice(0, 10)}.xlsx"`,
      'Cache-Control': 'no-store',
    });
    await wb.xlsx.write(res);
    res.end();
  }));
};
