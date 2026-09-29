const express = require('express');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError, requireAction } = require('../middleware');
const { audit } = require('../audit');
const { notifyCapable } = require('../notify');

const router = express.Router();

const STATUSES = ['New', 'Pending Approval', 'Approved', 'Rejected'];
const EDITABLE = ['New', 'Rejected'];

const SELECT = `
  SELECT i.*, ru.full_name AS requested_by_name, cu.full_name AS created_by_name, uu.full_name AS updated_by_name,
         (SELECT row_to_json(a) FROM (
            SELECT ar.id, ar.status, ar.decision_note, ar.decided_at, du.full_name AS decided_by_name
              FROM approval_requests ar LEFT JOIN users du ON du.id = ar.decided_by
             WHERE ar.ingest_record_id = i.id ORDER BY ar.requested_at DESC LIMIT 1) a) AS last_approval
    FROM ingest_records i
    LEFT JOIN users ru ON ru.id = i.requested_by_user_id
    LEFT JOIN users cu ON cu.id = i.created_by
    LEFT JOIN users uu ON uu.id = i.updated_by`;

async function assertDropdown(client, category, value, field) {
  const { rows } = await client.query(
    'SELECT 1 FROM dropdown_options WHERE category=$1 AND value=$2 AND is_active', [category, value]
  );
  if (!rows.length) throw new HttpError(400, `${field} "${value}" is not a valid option`);
}

function episodeDateForText(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  try { return v.date(value, { field: 'Episode date' }); } catch (_) { return null; }
}

async function parseBody(client, body, current = null) {
  const hasEpisodeText = Object.prototype.hasOwnProperty.call(body, 'episode_break_date_text');
  let episode_break_date_text;
  let episode_date;
  if (hasEpisodeText) {
    episode_break_date_text = v.str(body.episode_break_date_text, { field: 'Episode / Break Date', max: 500 });
    episode_date = episodeDateForText(episode_break_date_text);
  } else {
    const hasLegacyDate = Object.prototype.hasOwnProperty.call(body, 'episode_date');
    const legacyDate = v.date(body.episode_date, { field: 'Episode date' });
    if (current && (!hasLegacyDate || legacyDate === current.episode_date_iso)) {
      // Older clients send the full form; preserve free-text values when its legacy date is unchanged.
      episode_break_date_text = current.episode_break_date_text;
      episode_date = current.episode_date;
    } else {
      episode_date = legacyDate;
      episode_break_date_text = legacyDate;
    }
  }
  const rec = {
    program: v.str(body.program, { field: 'Program', max: 200, required: true }),
    billable_party: v.str(body.billable_party, { field: 'Billable Party', max: 200 }),
    platform: v.str(body.platform, { field: 'Platform', max: 100, required: true }),
    episode_date,
    episode_break_date_text,
    materials_count: v.int(body.materials_count, { field: 'Materials count', min: 0 }),
    source: v.str(body.source, { field: 'Source', max: 500 }),
    destination_folder: v.str(body.destination_folder, { field: 'Destination folder', max: 1000 }),
    requested_by_user_id: v.int(body.requested_by_user_id, { field: 'Requested by', min: 1 }),
    requested_by_psd: v.str(body.requested_by_psd, { field: 'Requested by (PSD)', max: 200 }),
    remarks: v.str(body.remarks, { field: 'Remarks', max: 4000 }),
  };
  await assertDropdown(client, 'platform', rec.platform, 'Platform');
  if (rec.requested_by_user_id) {
    const { rows } = await client.query('SELECT 1 FROM users WHERE id=$1 AND is_active', [rec.requested_by_user_id]);
    if (!rows.length) throw new HttpError(400, 'Requested by must be an active user');
  }
  return rec;
}

router.get('/', asyncH(async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.status && STATUSES.includes(req.query.status)) add('i.status = ?', req.query.status);
  if (req.query.program) add('i.program = ?', String(req.query.program));
  if (req.query.platform) add('i.platform = ?', String(req.query.platform));
  if (req.query.from) add('i.episode_date >= ?', v.date(req.query.from, { field: 'from' }));
  if (req.query.to) add('i.episode_date <= ?', v.date(req.query.to, { field: 'to' }));
  if (req.query.q) {
    const q = `%${String(req.query.q).slice(0, 100).replace(/[%_\\]/g, '\\$&')}%`;
    params.push(q);
    const p = `$${params.length}`;
    where.push(`(i.program ILIKE ${p} OR i.billable_party ILIKE ${p} OR i.episode_break_date_text ILIKE ${p}
                 OR i.source ILIKE ${p} OR i.destination_folder ILIKE ${p}
                 OR i.remarks ILIKE ${p} OR i.requested_by_psd ILIKE ${p} OR ru.full_name ILIKE ${p})`);
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const countQ = await db.query(
    `SELECT count(*)::int AS n FROM ingest_records i LEFT JOIN users ru ON ru.id=i.requested_by_user_id ${whereSql}`, params
  );
  const { rows } = await db.query(
    `${SELECT} ${whereSql} ORDER BY i.created_at DESC, i.id DESC LIMIT ${limit} OFFSET ${offset}`, params
  );
  res.json({ total: countQ.rows[0].n, rows });
}));

router.get('/:id', asyncH(async (req, res) => {
  const { rows } = await db.query(`${SELECT} WHERE i.id=$1`, [v.id(req.params.id)]);
  if (!rows.length) throw new HttpError(404, 'Ingest record not found');
  const hist = await db.query(
    `SELECT ar.id, ar.status, ar.requested_at, ar.decided_at, ar.decision_note,
            ru.full_name AS requested_by_name, du.full_name AS decided_by_name
       FROM approval_requests ar
       LEFT JOIN users ru ON ru.id = ar.requested_by
       LEFT JOIN users du ON du.id = ar.decided_by
      WHERE ar.ingest_record_id=$1 ORDER BY ar.requested_at DESC`, [rows[0].id]
  );
  res.json({ ...rows[0], approvals: hist.rows });
}));

// Create — status is always 'New' (never taken from the client)
router.post('/', requireAction('ingest.write'), asyncH(async (req, res) => {
  const created = await db.tx(async (c) => {
    const r = await parseBody(c, req.body);
    const { rows } = await c.query(
      `INSERT INTO ingest_records (program, billable_party, platform, episode_date, episode_break_date_text,
         materials_count, source, destination_folder, requested_by_user_id, requested_by_psd, remarks,
         status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'New',$12,$12) RETURNING id`,
      [r.program, r.billable_party, r.platform, r.episode_date, r.episode_break_date_text,
        r.materials_count, r.source, r.destination_folder, r.requested_by_user_id,
        r.requested_by_psd, r.remarks, req.user.id]
    );
    await audit(req, 'ingest.create', 'ingest_record', rows[0].id, r, c);
    return rows[0];
  });
  res.status(201).json({ ok: true, id: created.id });
}));

router.put('/:id', requireAction('ingest.write'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  await db.tx(async (c) => {
    const cur = await c.query(
      `SELECT status, episode_date, to_char(episode_date, 'YYYY-MM-DD') AS episode_date_iso,
              episode_break_date_text
         FROM ingest_records WHERE id=$1 FOR UPDATE`, [id]
    );
    if (!cur.rows.length) throw new HttpError(404, 'Ingest record not found');
    if (!EDITABLE.includes(cur.rows[0].status)) {
      throw new HttpError(409, `Record is "${cur.rows[0].status}" and can no longer be edited`);
    }
    const r = await parseBody(c, req.body, cur.rows[0]);
    await c.query(
      `UPDATE ingest_records SET program=$2, billable_party=$3, platform=$4, episode_date=$5,
         episode_break_date_text=$6, materials_count=$7, source=$8, destination_folder=$9,
         requested_by_user_id=$10, requested_by_psd=$11, remarks=$12, updated_by=$13, updated_at=now()
       WHERE id=$1`,
      [id, r.program, r.billable_party, r.platform, r.episode_date, r.episode_break_date_text,
        r.materials_count, r.source, r.destination_folder, r.requested_by_user_id,
        r.requested_by_psd, r.remarks, req.user.id]
    );
    await audit(req, 'ingest.update', 'ingest_record', id, r, c);
  });
  res.json({ ok: true });
}));

// Send for approval: New/Rejected -> Pending Approval, opens an approval_request
router.post('/:id/send', requireAction('ingest.write'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const result = await db.tx(async (c) => {
    const cur = await c.query('SELECT id, status, program, platform FROM ingest_records WHERE id=$1 FOR UPDATE', [id]);
    const rec = cur.rows[0];
    if (!rec) throw new HttpError(404, 'Ingest record not found');
    if (!EDITABLE.includes(rec.status)) throw new HttpError(409, `Record is "${rec.status}" and cannot be sent`);
    const ar = await c.query(
      `INSERT INTO approval_requests (ingest_record_id, requested_by) VALUES ($1,$2) RETURNING id`, [id, req.user.id]
    );
    await c.query(
      `UPDATE ingest_records SET status='Pending Approval', updated_by=$2, updated_at=now() WHERE id=$1`, [id, req.user.id]
    );
    await audit(req, 'ingest.send_for_approval', 'ingest_record', id, { approval_request_id: ar.rows[0].id }, c);
    await notifyCapable('approval.decide', {
      title: `Approval needed: ${rec.program}`,
      body: `${req.user.full_name} sent ingest #${id} (${rec.platform}) for approval.`,
      link: `/approval?id=${ar.rows[0].id}`,
    }, { excludeUserId: req.user.id }, c);
    return ar.rows[0];
  });
  res.json({ ok: true, approval_request_id: result.id });
}));

router.delete('/:id', requireAction('ingest.delete'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const { rows } = await db.query('DELETE FROM ingest_records WHERE id=$1 RETURNING program, status', [id]);
  if (!rows.length) throw new HttpError(404, 'Ingest record not found');
  await audit(req, 'ingest.delete', 'ingest_record', id, rows[0]);
  res.json({ ok: true });
}));

module.exports = router;
