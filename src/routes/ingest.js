const express = require('express');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError, requireAction } = require('../middleware');
const { audit } = require('../audit');
const { notifyUsers, notifyCapable } = require('../notify');

const router = express.Router();

const STATUSES = ['New', 'Pending Approval', 'Approved', 'Rejected'];
const CM_STATUSES = ['DONE', 'NON-COMPLIANT'];
const EDITABLE = ['New', 'Rejected'];

const SELECT = `
  SELECT i.*, ru.full_name AS requested_by_name, cu.full_name AS created_by_name,
         uu.full_name AS updated_by_name, cmu.full_name AS cm_decided_by_name,
         (SELECT row_to_json(a) FROM (
            SELECT ar.id, ar.status, ar.decision_note, ar.decided_at, du.full_name AS decided_by_name
              FROM approval_requests ar LEFT JOIN users du ON du.id = ar.decided_by
             WHERE ar.ingest_record_id = i.id ORDER BY ar.requested_at DESC LIMIT 1) a) AS last_approval
    FROM ingest_records i
    LEFT JOIN users ru ON ru.id = i.requested_by_user_id
    LEFT JOIN users cu ON cu.id = i.created_by
    LEFT JOIN users uu ON uu.id = i.updated_by
    LEFT JOIN users cmu ON cmu.id = i.cm_decided_by`;

async function assertDropdown(client, category, value, field) {
  const { rows } = await client.query(
    'SELECT 1 FROM dropdown_options WHERE category=$1 AND value=$2 AND is_active', [category, value]
  );
  if (!rows.length) throw new HttpError(400, `${field} "${value}" is not a valid option`);
}

async function parseBody(client, body, user, current = null) {
  const hasEpisodeText = Object.prototype.hasOwnProperty.call(body, 'episode_break_date_text');
  let episode_break_date_text;
  let episode_date;
  if (hasEpisodeText) {
    // Date picker: only a real calendar date (YYYY-MM-DD) or empty is accepted from the form.
    episode_date = v.date(body.episode_break_date_text, { field: 'Episode / Break Date' });
    episode_break_date_text = episode_date;
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
    // Destination Folder is assigned during the PCS approval step. Preserve legacy values
    // when a PSD edits an existing request, but never accept it from this endpoint.
    destination_folder: current ? current.destination_folder : null,
    // Requested By is never taken from the client: it is the signed-in user who creates the request
    // (kept as-is when someone else later edits it; legacy rows with no requester fall back to the editor).
    requested_by_user_id: current && (current.requested_by_user_id || current.requested_by_psd) ? current.requested_by_user_id : user.id,
    requested_by_psd: current && (current.requested_by_user_id || current.requested_by_psd) ? current.requested_by_psd : user.full_name,
    remarks: v.str(body.remarks, { field: 'Remarks', max: 4000 }),
  };
  await assertDropdown(client, 'platform', rec.platform, 'Platform');
  return rec;
}

router.get('/', asyncH(async (req, res) => {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
  if (req.query.status && CM_STATUSES.includes(req.query.status)) add('i.cm_status = ?', req.query.status);
  else if (req.query.status && STATUSES.includes(req.query.status)) add('i.status = ?', req.query.status);
  if (req.query.program) add('i.program = ?', String(req.query.program));
  if (req.query.platform) add('i.platform = ?', String(req.query.platform));
  if (req.query.from) add('i.episode_date >= ?', v.date(req.query.from, { field: 'from' }));
  if (req.query.to) add('i.episode_date <= ?', v.date(req.query.to, { field: 'to' }));
  if (req.query.q) {
    params.push(v.like(req.query.q, 100));
    const p = `$${params.length}`;
    where.push(`(i.program ILIKE ${p} OR i.billable_party ILIKE ${p} OR i.episode_break_date_text ILIKE ${p}
                 OR i.source ILIKE ${p} OR i.destination_folder ILIKE ${p}
                 OR i.remarks ILIKE ${p} OR i.requested_by_psd ILIKE ${p} OR ru.full_name ILIKE ${p})`);
  }
  const { limit, offset } = v.paging(req.query, { def: 50, max: 200 });
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
    const r = await parseBody(c, req.body, req.user);
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
              episode_break_date_text, destination_folder, requested_by_user_id, requested_by_psd
         FROM ingest_records WHERE id=$1 FOR UPDATE`, [id]
    );
    if (!cur.rows.length) throw new HttpError(404, 'Ingest record not found');
    if (!EDITABLE.includes(cur.rows[0].status)) {
      throw new HttpError(409, `Record is "${cur.rows[0].status}" and can no longer be edited`);
    }
    const r = await parseBody(c, req.body, req.user, cur.rows[0]);
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

router.post('/:id/cm-decision', requireAction('ingest.cm_complete'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const decision = v.oneOf(req.body.decision, CM_STATUSES, { field: 'CM decision' });
  const reason = v.str(req.body.reason, { field: 'Non-compliant reason', max: 2000 });
  if (decision === 'NON-COMPLIANT' && !reason) throw new HttpError(400, 'A reason is required for NON-COMPLIANT');

  await db.tx(async (c) => {
    const cur = await c.query(
      `SELECT i.id, i.status, i.cm_status, i.program, i.created_by, i.requested_by_user_id,
              ar.requested_by AS submitted_by, ar.decided_by AS approved_by
         FROM ingest_records i
         LEFT JOIN LATERAL (
           SELECT requested_by, decided_by FROM approval_requests
            WHERE ingest_record_id=i.id AND status='Approved'
            ORDER BY decided_at DESC NULLS LAST, id DESC LIMIT 1
         ) ar ON TRUE
        WHERE i.id=$1 FOR UPDATE OF i`, [id]
    );
    const r = cur.rows[0];
    if (!r) throw new HttpError(404, 'Ingest record not found');
    if (r.status !== 'Approved') throw new HttpError(409, 'Only approved requests can be completed by CM');
    if (r.cm_status) throw new HttpError(409, `Already marked ${r.cm_status}`);

    await c.query(
      `UPDATE ingest_records
          SET cm_status=$2, cm_decided_by=$3, cm_decided_at=now(), cm_non_compliant_reason=$4,
              updated_by=$3, updated_at=now()
        WHERE id=$1`,
      [id, decision, req.user.id, decision === 'NON-COMPLIANT' ? reason : null]
    );
    await audit(req, decision === 'DONE' ? 'ingest.cm_done' : 'ingest.cm_non_compliant',
      'ingest_record', id, { decision, reason: decision === 'NON-COMPLIANT' ? reason : null }, c);

    const participants = [r.approved_by, r.submitted_by, r.created_by, r.requested_by_user_id]
      .filter((uid) => uid && uid !== req.user.id);
    const reasonSuffix = decision === 'NON-COMPLIANT' ? ` — ${reason}` : '';
    await notifyUsers(participants, {
      title: `Ingest ${decision}: ${r.program}`,
      body: `${req.user.full_name} marked ingest #${id} ${decision}${reasonSuffix}`,
      link: `/ingest?id=${id}`,
    }, c);
  });
  res.json({ ok: true, status: decision });
}));

router.delete('/:id', requireAction('ingest.delete'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  await db.tx(async (c) => {
    const cur = await c.query('SELECT program, status, cm_status FROM ingest_records WHERE id=$1 FOR UPDATE', [id]);
    if (!cur.rows.length) throw new HttpError(404, 'Ingest record not found');
    if (cur.rows[0].cm_status) throw new HttpError(409, 'CM-completed requests are preserved as historical records');
    await c.query('DELETE FROM ingest_records WHERE id=$1', [id]);
    await audit(req, 'ingest.delete', 'ingest_record', id, cur.rows[0], c);
  });
  res.json({ ok: true });
}));

module.exports = router;
