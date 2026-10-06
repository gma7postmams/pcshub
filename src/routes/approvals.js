const express = require('express');
const db = require('../db');
const v = require('../validate');
const { asyncH, HttpError, requireAction } = require('../middleware');
const { audit } = require('../audit');
const { notifyUsers, notifyCapable } = require('../notify');

const router = express.Router();

const SELECT = `
  SELECT ar.*, i.program, i.platform, i.episode_date, i.episode_break_date_text,
         i.source, i.destination_folder, i.requested_by_psd, i.remarks,
         i.status AS ingest_status, rbu.full_name AS ingest_requested_by_name,
         ru.full_name AS requested_by_name, du.full_name AS decided_by_name
    FROM approval_requests ar
    JOIN ingest_records i ON i.id = ar.ingest_record_id
    LEFT JOIN users rbu ON rbu.id = i.requested_by_user_id
    LEFT JOIN users ru ON ru.id = ar.requested_by
    LEFT JOIN users du ON du.id = ar.decided_by`;

router.get('/', asyncH(async (req, res) => {
  const params = [];
  const where = [];
  if (['Pending', 'Approved', 'Rejected'].includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`ar.status = $${params.length}`);
  }
  if (req.query.id) {
    params.push(v.id(req.query.id));
    where.push(`ar.id = $${params.length}`);
  }
  const { limit } = v.paging(req.query, { def: 100, max: 300 });
  const { rows } = await db.query(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (ar.status='Pending') DESC, ar.requested_at DESC LIMIT ${limit}`, params
  );
  const counts = await db.query(`SELECT status, count(*)::int AS n FROM approval_requests GROUP BY status`);
  res.json({ rows, counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])) });
}));

router.post('/:id/decide', requireAction('approval.decide'), asyncH(async (req, res) => {
  const id = v.id(req.params.id);
  const decision = v.oneOf(req.body.decision, ['Approved', 'Rejected'], { field: 'Decision' });
  const note = v.str(req.body.note, { field: 'Note', max: 2000 });
  const hasDestinationFolder = Object.prototype.hasOwnProperty.call(req.body, 'destination_folder');
  const destinationFolder = decision === 'Approved' && hasDestinationFolder
    ? v.str(req.body.destination_folder, { field: 'Destination Folder', max: 1000 })
    : null;
  if (decision === 'Rejected' && !note) throw new HttpError(400, 'A reason is required when rejecting');

  await db.tx(async (c) => {
    const cur = await c.query(
      `SELECT ar.*, i.program, i.created_by AS ingest_created_by, i.requested_by_user_id
         FROM approval_requests ar JOIN ingest_records i ON i.id = ar.ingest_record_id
        WHERE ar.id=$1 FOR UPDATE OF ar, i`, [id]
    );
    const ar = cur.rows[0];
    if (!ar) throw new HttpError(404, 'Approval request not found');
    if (ar.status !== 'Pending') throw new HttpError(409, `Already ${ar.status.toLowerCase()}`);

    await c.query(
      `UPDATE approval_requests SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`,
      [id, decision, req.user.id, note]
    );
    await c.query(
      `UPDATE ingest_records
          SET status=$2,
              destination_folder=CASE WHEN $4::boolean THEN $5 ELSE destination_folder END,
              updated_by=$3, updated_at=now()
        WHERE id=$1`,
      [ar.ingest_record_id, decision, req.user.id, decision === 'Approved' && hasDestinationFolder, destinationFolder]
    );
    await audit(req, `approval.${decision.toLowerCase()}`, 'approval_request', id,
      { ingest_record_id: ar.ingest_record_id, note,
        ...(decision === 'Approved' && hasDestinationFolder ? { destination_folder: destinationFolder } : {}) }, c);
    await notifyUsers(
      [ar.requested_by, ar.ingest_created_by, ar.requested_by_user_id].filter((x) => x && x !== req.user.id),
      {
        title: `Ingest ${decision.toLowerCase()}: ${ar.program}`,
        body: `${req.user.full_name} ${decision.toLowerCase()} ingest #${ar.ingest_record_id}${note ? ` — ${note}` : ''}`,
        link: `/ingest?id=${ar.ingest_record_id}`,
      }, c
    );
    if (decision === 'Approved') {
      await notifyCapable('ingest.cm_complete', {
        title: `Ready for CM: ${ar.program}`,
        body: `Ingest #${ar.ingest_record_id} (${ar.program}) was approved by ${req.user.full_name}.`,
        link: `/ingest?id=${ar.ingest_record_id}`,
      }, { excludeUserId: req.user.id }, c);
    }
  });
  res.json({ ok: true });
}));

module.exports = router;
