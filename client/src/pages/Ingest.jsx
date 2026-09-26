import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { del, get, post, put } from '../lib/api.js';
import { ago, fmtDate, fmtDateTime } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { PlusIcon } from '../components/Icons.jsx';
import { Empty, Modal, Options, Pill, useConfirm, useDebounced, useForm, useToast } from '../components/ui.jsx';

const STATUSES = ['New', 'Pending Approval', 'Approved', 'Rejected'];
const EDITABLE = ['New', 'Rejected'];
const PAGE = 50;
const withCurrent = (list, v) => (v && !list.includes(v) ? [...list, v] : list);

export default function Ingest() {
  const s = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const canWrite = s.can('ingest.write');
  const canDelete = s.can('ingest.delete');

  const [lookups, setLookups] = useState(null);
  const [filt, setFilt] = useState({ q: '', status: params.get('status') || '', program: '', platform: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);     // null | {} (new) | record (edit)
  const [detail, setDetail] = useState(null); // record with approvals
  const q = useDebounced(filt.q, 300);

  useEffect(() => {
    Promise.all([get('/api/dropdowns?categories=program,platform'), get('/api/users/active')])
      .then(([dd, users]) => setLookups({ ...dd, users }));
  }, []);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ limit: PAGE, offset });
    Object.entries({ ...filt, q }).forEach(([k, v]) => { if (v) p.set(k, v); });
    try { setData(await get(`/api/ingest?${p}`)); } catch (e) { setData({ error: e.message, rows: [], total: 0 }); }
  }, [filt.status, filt.program, filt.platform, filt.from, filt.to, q, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const openDetail = useCallback(async (id) => {
    try { setDetail(await get(`/api/ingest/${id}`)); } catch (e) { toast(e.message, 'err'); }
  }, [toast]);

  useEffect(() => {
    if (params.get('new') && canWrite) setForm({});
    if (params.get('id')) openDetail(+params.get('id'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setF = (k) => (e) => { setFilt((f) => ({ ...f, [k]: e.target.value })); setOffset(0); };
  const total = data ? data.total : 0;

  return (
    <main className="container">
      <div className="page-head">
        <div><h1>Ingest Tracker</h1><div className="sub">Log ingest requests and send them for approval.</div></div>
        <div className="actions">
          {canWrite ? <button type="button" className="btn primary" id="new-btn" onClick={() => setForm({})}><PlusIcon /> New Ingest</button> : null}
        </div>
      </div>

      {lookups && !lookups.program.length ? (
        <div className="alert warn mb-12">
          No PROGRAM options exist yet.{' '}
          {s.canPage('/admin') ? <>Add them in <Link to="/admin#dropdowns">Admin → Dropdowns</Link>.</> : 'Ask an Admin to add them.'}
        </div>
      ) : null}

      <div className="card">
        <div className="filters">
          <input type="search" placeholder="Search program, source, folder, remarks…" value={filt.q} onChange={setF('q')} />
          <select value={filt.status} onChange={setF('status')}><Options list={STATUSES} blank="All statuses" /></select>
          <select value={filt.program} onChange={setF('program')}><Options list={lookups ? lookups.program : []} blank="All programs" /></select>
          <select value={filt.platform} onChange={setF('platform')}><Options list={lookups ? lookups.platform : []} blank="All platforms" /></select>
          <input type="date" title="Episode date from" value={filt.from} onChange={setF('from')} />
          <input type="date" title="Episode date to" value={filt.to} onChange={setF('to')} />
        </div>
        <div className="table-wrap" id="tbl">
          {!data ? <Empty>Loading…</Empty>
            : data.error ? <Empty>{data.error}</Empty>
              : !data.rows.length ? <Empty>No ingest records match these filters.</Empty>
                : (
                  <table className="t">
                    <thead><tr>
                      <th>#</th><th>Program</th><th>Platform</th><th>Episode Date</th><th>Source</th><th>Destination Folder</th>
                      <th>Requested By</th><th>Requested By (PSD)</th><th>Status</th><th>Updated</th>
                    </tr></thead>
                    <tbody>
                      {data.rows.map((r) => (
                        <tr key={r.id} className="clickable" onClick={() => openDetail(r.id)}>
                          <td className="dim mono">{r.id}</td>
                          <td><strong>{r.program}</strong></td>
                          <td>{r.platform}</td>
                          <td className="nowrap">{fmtDate(r.episode_date)}</td>
                          <td className="cell-clip" title={r.source || ''}>{r.source}</td>
                          <td className="cell-clip mono" title={r.destination_folder || ''}>{r.destination_folder}</td>
                          <td className="nowrap">{r.requested_by_name || ''}</td>
                          <td>{r.requested_by_psd || ''}</td>
                          <td><Pill s={r.status} /></td>
                          <td className="dim nowrap">{ago(r.updated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
        </div>
        <div className="pager">
          <span>{total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : ''}</span>
          <span className="grow" />
          <button type="button" className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <button type="button" className="btn sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>
      </div>

      {form && lookups ? (
        <IngestForm rec={form.id ? form : null} lookups={lookups} me={s.user} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />
      ) : null}

      {detail ? (
        <IngestDetail
          r={detail}
          canWrite={canWrite}
          canDelete={canDelete}
          onClose={() => setDetail(null)}
          onEdit={() => { setForm(detail); setDetail(null); }}
          onSend={async () => {
            if (!(await confirm('Send for approval', `Send ingest #${detail.id} (${detail.program}) to Managers for approval? It will be locked from editing while pending.`, { okText: 'Send' }))) return;
            try { await post(`/api/ingest/${detail.id}/send`); toast('Sent for approval'); setDetail(null); load(); } catch (e) { toast(e.message, 'err'); }
          }}
          onDelete={async () => {
            if (!(await confirm('Delete ingest record', `Permanently delete ingest #${detail.id} and its approval history?`, { okText: 'Delete', danger: true }))) return;
            try { await del(`/api/ingest/${detail.id}`); toast('Deleted'); setDetail(null); load(); } catch (e) { toast(e.message, 'err'); }
          }}
        />
      ) : null}
    </main>
  );
}

function IngestForm({ rec, lookups, me, onClose, onSaved }) {
  const toast = useToast();
  const r = rec || {};
  const [f, set] = useForm({
    program: r.program || '', platform: r.platform || '', episode_date: r.episode_date || '', source: r.source || '',
    destination_folder: r.destination_folder || '', requested_by_user_id: r.requested_by_user_id || (rec ? '' : me.id),
    requested_by_psd: r.requested_by_psd || '', remarks: r.remarks || '',
  });
  const [busy, setBusy] = useState(false);
  const userOpts = lookups.users.map((u) => ({ value: u.id, label: u.full_name }));

  const submit = async (send) => {
    if (!f.program || !f.platform) { toast('PROGRAM and Platform are required', 'err'); return; }
    setBusy(true);
    try {
      let id = rec && rec.id;
      if (rec) await put(`/api/ingest/${rec.id}`, f);
      else id = (await post('/api/ingest', f)).id;
      if (send) await post(`/api/ingest/${id}/send`);
      toast(send ? 'Saved and sent for approval' : 'Saved');
      onSaved();
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };

  return (
    <Modal
      title={rec ? `Edit Ingest #${rec.id}` : 'New Ingest'}
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {!rec ? <button type="button" className="btn" id="save-send" disabled={busy} onClick={() => submit(true)}>Save &amp; Send for Approval</button> : null}
          <button type="button" className="btn primary" id="save" disabled={busy} onClick={() => submit(false)}>Save</button>
        </>
      )}
    >
      <form id="ing-form" className="form-grid" noValidate onSubmit={(e) => e.preventDefault()}>
        <label className="f"><span>PROGRAM <span className="req">*</span></span>
          <select name="program" value={f.program} onChange={set('program')}><Options list={withCurrent(lookups.program, r.program)} blank="Select program…" /></select></label>
        <label className="f"><span>Platform <span className="req">*</span></span>
          <select name="platform" value={f.platform} onChange={set('platform')}><Options list={withCurrent(lookups.platform, r.platform)} blank="Select platform…" /></select></label>
        <label className="f"><span>Episode date</span><input type="date" name="episode_date" value={f.episode_date} onChange={set('episode_date')} /></label>
        <label className="f"><span>Source</span><input name="source" maxLength={500} value={f.source} onChange={set('source')} placeholder="e.g. Tape, drive, server path" /></label>
        <label className="f full"><span>Destination Folder</span><input name="destination_folder" maxLength={1000} className="mono" value={f.destination_folder} onChange={set('destination_folder')} placeholder="\\server\share\promos\…" /></label>
        <label className="f"><span>Requested by</span>
          <select name="requested_by_user_id" value={f.requested_by_user_id} onChange={set('requested_by_user_id')}><Options list={userOpts} blank="—" /></select></label>
        <label className="f"><span>Requested by (PSD)</span><input name="requested_by_psd" maxLength={200} value={f.requested_by_psd} onChange={set('requested_by_psd')} /></label>
        <label className="f full"><span>Remarks</span><textarea name="remarks" maxLength={4000} value={f.remarks} onChange={set('remarks')} /></label>
        {!rec ? <div className="full dim">Status will be set to <strong>New</strong>. Send it for approval when ready.</div> : null}
      </form>
    </Modal>
  );
}

const KV = ({ k, children }) => <><dt>{k}</dt><dd>{children || <span className="dim">—</span>}</dd></>;

function IngestDetail({ r, canWrite, canDelete, onClose, onEdit, onSend, onDelete }) {
  const editable = canWrite && EDITABLE.includes(r.status);
  return (
    <Modal
      title={`Ingest #${r.id}`}
      onClose={onClose}
      footer={(
        <>
          {canDelete ? <button type="button" className="btn danger" id="del" onClick={onDelete}>Delete</button> : null}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {editable ? <button type="button" className="btn" id="edit" onClick={onEdit}>Edit</button> : null}
          {editable ? <button type="button" className="btn primary" id="send" onClick={onSend}>{r.status === 'Rejected' ? 'Resubmit for Approval' : 'Send for Approval'}</button> : null}
        </>
      )}
    >
      <div className="row mb-12"><Pill s={r.status} /><span className="dim">Created {fmtDateTime(r.created_at)} by {r.created_by_name || '—'}</span></div>
      {r.status === 'Rejected' && r.last_approval && r.last_approval.decision_note
        ? <div className="alert err mb-12"><strong>Rejected:</strong> {r.last_approval.decision_note}</div> : null}
      <dl className="kv">
        <KV k="PROGRAM">{r.program}</KV>
        <KV k="Platform">{r.platform}</KV>
        <KV k="Episode date">{fmtDate(r.episode_date)}</KV>
        <KV k="Source">{r.source}</KV>
        <KV k="Destination Folder">{r.destination_folder ? <span className="mono">{r.destination_folder}</span> : null}</KV>
        <KV k="Requested by">{r.requested_by_name}</KV>
        <KV k="Requested by (PSD)">{r.requested_by_psd}</KV>
        <KV k="Remarks">{r.remarks}</KV>
        <KV k="Last updated">{fmtDateTime(r.updated_at)}{r.updated_by_name ? ` by ${r.updated_by_name}` : ''}</KV>
      </dl>
      {r.approvals.length ? (
        <>
          <h3 className="mt-16 mb-12">Approval history</h3>
          <div className="timeline">
            {r.approvals.map((a) => (
              <div className="ti" key={a.id}>
                <div><Pill s={a.status} /> <span className="dim">requested {fmtDateTime(a.requested_at)} by {a.requested_by_name || '—'}</span></div>
                {a.decided_at ? <div className="mt-6">{a.status} by {a.decided_by_name || '—'} · {fmtDateTime(a.decided_at)}</div> : null}
                {a.decision_note ? <div className="muted mt-6">“{a.decision_note}”</div> : null}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Modal>
  );
}
