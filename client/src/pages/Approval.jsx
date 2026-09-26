import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, post } from '../lib/api.js';
import { ago, fmtDate, fmtDateTime } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { Empty, Modal, Pill, useConfirm, useToast } from '../components/ui.jsx';

const SEGMENTS = [['Pending', 'Pending'], ['Approved', 'Approved'], ['Rejected', 'Rejected'], ['', 'All']];

export default function Approval() {
  const s = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const canDecide = s.can('approval.decide');
  const [status, setStatus] = useState(params.get('status') ?? (canDecide ? 'Pending' : ''));
  const [data, setData] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    setData(await get(`/api/approvals?${p}`));
  }, [status]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const id = params.get('id');
    if (id) get(`/api/approvals?id=${+id}`).then((d) => { if (d.rows[0]) setDetail(d.rows[0]); }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (r, decision) => {
    const res = await confirm(
      decision === 'Approved' ? 'Approve request' : 'Reject request',
      `${decision === 'Approved' ? 'Approve' : 'Reject'} ingest #${r.ingest_record_id} — ${r.program}?`,
      {
        okText: decision === 'Approved' ? 'Approve' : 'Reject',
        danger: decision === 'Rejected',
        input: { label: decision === 'Rejected' ? 'Reason for rejection' : 'Note (optional)', required: decision === 'Rejected' },
      }
    );
    if (!res) return;
    try {
      await post(`/api/approvals/${r.id}/decide`, { decision, note: res.value });
      toast(`Request ${decision.toLowerCase()}`);
      setDetail(null);
      load();
    } catch (e) { toast(e.message, 'err'); }
  };

  const counts = data ? data.counts : {};
  const all = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>Approval</h1>
          <div className="sub">{canDecide ? 'Review ingest requests and approve or reject them.' : 'View-only: approval decisions are made by Managers and Admins.'}</div>
        </div>
      </div>
      <div className="card">
        <div className="filters">
          <div className="segmented" id="seg">
            {SEGMENTS.map(([v, l]) => (
              <button key={l} type="button" className={status === v ? 'on' : ''} onClick={() => setStatus(v)}>
                {l} <span className="dim">{v ? (counts[v] || 0) : all}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="table-wrap" id="tbl">
          {!data ? <Empty>Loading…</Empty> : !data.rows.length ? <Empty>No {status ? status.toLowerCase() : ''} approval requests.</Empty> : (
            <table className="t">
              <thead><tr>
                <th>Req #</th><th>Ingest #</th><th>Program</th><th>Platform</th><th>Episode</th>
                <th>Sent by</th><th>Sent</th><th>Status</th><th>Decided by</th>{canDecide ? <th /> : null}
              </tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={(e) => { if (!e.target.closest('button')) setDetail(r); }}>
                    <td className="dim mono">{r.id}</td><td className="mono">{r.ingest_record_id}</td>
                    <td><strong>{r.program}</strong></td><td>{r.platform}</td>
                    <td className="nowrap">{fmtDate(r.episode_date)}</td>
                    <td className="nowrap">{r.requested_by_name || '—'}</td>
                    <td className="dim nowrap">{ago(r.requested_at)}</td>
                    <td><Pill s={r.status} /></td>
                    <td className="nowrap">{r.decided_by_name || ''}</td>
                    {canDecide ? (
                      <td className="nowrap right">
                        {r.status === 'Pending' ? (
                          <>
                            <button type="button" className="btn sm success" data-act="Approved" onClick={() => decide(r, 'Approved')}>Approve</button>{' '}
                            <button type="button" className="btn sm danger" data-act="Rejected" onClick={() => decide(r, 'Rejected')}>Reject</button>
                          </>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {detail ? (
        <Modal
          title={`Approval Request #${detail.id}`}
          onClose={() => setDetail(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setDetail(null)}>Close</button>
              {canDecide && detail.status === 'Pending' ? (
                <>
                  <button type="button" className="btn danger" id="rej" onClick={() => decide(detail, 'Rejected')}>Reject</button>
                  <button type="button" className="btn success" id="apr" onClick={() => decide(detail, 'Approved')}>Approve</button>
                </>
              ) : null}
            </>
          )}
        >
          <div className="row mb-12"><Pill s={detail.status} /><span className="dim">Sent {fmtDateTime(detail.requested_at)} by {detail.requested_by_name || '—'}</span></div>
          <dl className="kv">
            <dt>Ingest record</dt><dd>#{detail.ingest_record_id}{s.canPage('/ingest') ? <> · <Link to={`/ingest?id=${detail.ingest_record_id}`}>open</Link></> : null}</dd>
            <dt>PROGRAM</dt><dd>{detail.program}</dd>
            <dt>Platform</dt><dd>{detail.platform}</dd>
            <dt>Episode date</dt><dd>{fmtDate(detail.episode_date) || <span className="dim">—</span>}</dd>
            <dt>Source</dt><dd>{detail.source || <span className="dim">—</span>}</dd>
            <dt>Destination Folder</dt><dd>{detail.destination_folder ? <span className="mono">{detail.destination_folder}</span> : <span className="dim">—</span>}</dd>
            <dt>Requested by</dt><dd>{detail.ingest_requested_by_name || <span className="dim">—</span>}</dd>
            <dt>Requested by (PSD)</dt><dd>{detail.requested_by_psd || <span className="dim">—</span>}</dd>
            <dt>Remarks</dt><dd>{detail.remarks || <span className="dim">—</span>}</dd>
            {detail.decided_at ? <><dt>Decision</dt><dd>{detail.status} by {detail.decided_by_name || '—'} · {fmtDateTime(detail.decided_at)}</dd></> : null}
            {detail.decision_note ? <><dt>Note</dt><dd>{detail.decision_note}</dd></> : null}
          </dl>
        </Modal>
      ) : null}
    </main>
  );
}
