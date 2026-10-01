import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { del, get, post, put } from '../lib/api.js';
import { ago, fmtDateTime } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { PlusIcon } from '../components/Icons.jsx';
import { Empty, Modal, Options, Pill, useConfirm, useDebounced, useForm, useToast } from '../components/ui.jsx';

const STATUSES = ['New', 'Pending Approval', 'Approved', 'Rejected', 'DONE', 'NON-COMPLIANT'];
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
  const canCmComplete = s.can('ingest.cm_complete');

  const [lookups, setLookups] = useState(null);
  const [filt, setFilt] = useState({ q: '', status: params.get('status') || '', program: '', platform: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);     // null | {} (new) | record (edit)
  const [detail, setDetail] = useState(null); // record with approvals
  const q = useDebounced(filt.q, 300);

  useEffect(() => {
    get('/api/dropdowns?categories=platform').then(setLookups);
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

      <div className="card">
        <div className="filters">
          <input type="search" placeholder="Search program, billable party, episode / break date, source, folder, remarks…" value={filt.q} onChange={setF('q')} />
          <select value={filt.status} onChange={setF('status')}><Options list={STATUSES} blank="All statuses" /></select>
          <input type="text" placeholder="Program / Project (exact match)" value={filt.program} onChange={setF('program')} />
          <select value={filt.platform} onChange={setF('platform')}><Options list={lookups ? lookups.platform : []} blank="All platforms" /></select>
          <input type="date" title="Legacy episode date from (YYYY-MM-DD)" value={filt.from} onChange={setF('from')} />
          <input type="date" title="Legacy episode date to (YYYY-MM-DD)" value={filt.to} onChange={setF('to')} />
        </div>
        <div className="table-wrap" id="tbl">
          {!data ? <Empty>Loading…</Empty>
            : data.error ? <Empty>{data.error}</Empty>
              : !data.rows.length ? <Empty>No ingest records match these filters.</Empty>
                : (
                  <table className="t">
                    <thead><tr>
                      <th>#</th><th>Program / Project</th><th>Platform</th><th>Episode / Break Date</th><th>Source</th><th>Destination Folder</th>
                      <th>Requested By</th><th>Status</th><th>Updated</th>
                    </tr></thead>
                    <tbody>
                      {data.rows.map((r) => (
                        <tr key={r.id} className="clickable" onClick={() => openDetail(r.id)}>
                          <td className="dim mono">{r.id}</td>
                          <td><strong>{r.program}</strong></td>
                          <td>{r.platform}</td>
                          <td className="nowrap">{r.episode_break_date_text || r.episode_date || ''}</td>
                          <td className="cell-clip" title={r.source || ''}>{r.source}</td>
                          <td className="cell-clip mono" title={r.destination_folder || ''}>{r.destination_folder}</td>
                          <td>{r.requested_by_psd || ''}</td>
                          <td><Pill s={r.cm_status || r.status} /></td>
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
        <IngestForm rec={form.id ? form : null} lookups={lookups} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />
      ) : null}

      {detail ? (
        <IngestDetail
          r={detail}
          canWrite={canWrite}
          canDelete={canDelete}
          canCmComplete={canCmComplete}
          onClose={() => setDetail(null)}
          onEdit={() => { setForm(detail); setDetail(null); }}
          onSend={async () => {
            if (!(await confirm('Send for approval', `Send ingest #${detail.id} (${detail.program}) to Managers for approval? It will be locked from editing while pending.`, { okText: 'Send' }))) return;
            try { await post(`/api/ingest/${detail.id}/send`); toast('Sent for approval'); setDetail(null); load(); } catch (e) { toast(e.message, 'err'); }
          }}
          onCmDecision={async (decision) => {
            const result = await confirm(
              decision === 'DONE' ? 'Mark ingest DONE' : 'Mark ingest NON-COMPLIANT',
              decision === 'DONE'
                ? `Mark ingest #${detail.id} (${detail.program}) DONE? This is a final decision.`
                : `Mark ingest #${detail.id} (${detail.program}) NON-COMPLIANT? A reason is required.`,
              {
                okText: `Mark ${decision}`,
                danger: decision === 'NON-COMPLIANT',
                ...(decision === 'NON-COMPLIANT' ? { input: { label: 'Reason', required: true } } : {}),
              }
            );
            if (result === null) return;
            try {
              await post(`/api/ingest/${detail.id}/cm-decision`, {
                decision,
                reason: decision === 'NON-COMPLIANT' ? result.value : '',
              });
              toast(`Ingest marked ${decision}`);
              setDetail(null);
              load();
            } catch (e) { toast(e.message, 'err'); }
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

function IngestForm({ rec, lookups, onClose, onSaved }) {
  const toast = useToast();
  const r = rec || {};
  const initialEpisodeText = rec ? (r.episode_break_date_text || r.episode_date || '') : '';
  const [f, set] = useForm({
    program: r.program || '', platform: r.platform || '', billable_party: r.billable_party || '',
    episode_break_date_text: initialEpisodeText,
    materials_count: r.materials_count == null ? '' : String(r.materials_count),
    source: r.source || '',
    requested_by_user_id: r.requested_by_user_id ?? '',
    requested_by_psd: r.requested_by_psd || '', remarks: r.remarks || '',
  });
  const [busy, setBusy] = useState(false);

  const submit = async (send) => {
    if (!f.program || !f.platform) { toast('Program / Project and Platform are required', 'err'); return; }
    const materialsCount = f.materials_count === '' ? null : Number(f.materials_count);
    if (materialsCount !== null && (!Number.isInteger(materialsCount) || materialsCount < 0)) {
      toast('Number of Materials must be a nonnegative integer', 'err');
      return;
    }
    const payload = {
      ...f,
      materials_count: materialsCount,
      requested_by_user_id: f.requested_by_user_id || null,
    };
    // Omit an unchanged fallback value so older records keep their stored compatibility fields.
    if (rec && f.episode_break_date_text === initialEpisodeText) delete payload.episode_break_date_text;
    setBusy(true);
    try {
      let id = rec && rec.id;
      if (rec) await put(`/api/ingest/${rec.id}`, payload);
      else id = (await post('/api/ingest', payload)).id;
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
        <label className="f"><span>Program / Project <span className="req">*</span></span>
          <input name="program" maxLength={200} value={f.program} onChange={set('program')} /></label>
        <label className="f"><span>Platform <span className="req">*</span></span>
          <select name="platform" value={f.platform} onChange={set('platform')}><Options list={withCurrent(lookups.platform, r.platform)} blank="Select platform…" /></select></label>
        <label className="f"><span>Billable Party</span><input name="billable_party" maxLength={200} value={f.billable_party} onChange={set('billable_party')} /></label>
        <label className="f"><span>Episode / Break Date</span><input name="episode_break_date_text" maxLength={500} value={f.episode_break_date_text} onChange={set('episode_break_date_text')} placeholder="e.g. SEP 1, SEP 7-12, 2026-09-15" /></label>
        <label className="f"><span>Number of Materials</span><input type="number" name="materials_count" min="0" step="1" value={f.materials_count} onChange={set('materials_count')} /></label>
        <label className="f"><span>Source</span><input name="source" maxLength={500} value={f.source} onChange={set('source')} placeholder="e.g. Tape, drive, server path" /></label>
        <label className="f"><span>Requested By</span><input name="requested_by_psd" maxLength={200} value={f.requested_by_psd} onChange={set('requested_by_psd')} /></label>
        <label className="f full"><span>Remarks</span><textarea name="remarks" maxLength={4000} value={f.remarks} onChange={set('remarks')} /></label>
        {!rec ? <div className="full dim">Status will be set to <strong>New</strong>. Send it for approval when ready.</div> : null}
      </form>
    </Modal>
  );
}

const KV = ({ k, children }) => <><dt>{k}</dt><dd>{children || <span className="dim">—</span>}</dd></>;

function IngestDetail({ r, canWrite, canDelete, canCmComplete, onClose, onEdit, onSend, onCmDecision, onDelete }) {
  const editable = canWrite && EDITABLE.includes(r.status);
  const cmFinal = Boolean(r.cm_status);
  return (
    <Modal
      title={`Ingest #${r.id}`}
      onClose={onClose}
      footer={(
        <>
          {canDelete && !cmFinal ? <button type="button" className="btn danger" id="del" onClick={onDelete}>Delete</button> : null}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {editable ? <button type="button" className="btn" id="edit" onClick={onEdit}>Edit</button> : null}
          {editable ? <button type="button" className="btn primary" id="send" onClick={onSend}>{r.status === 'Rejected' ? 'Resubmit for Approval' : 'Send for Approval'}</button> : null}
          {canCmComplete && r.status === 'Approved' && !cmFinal ? <>
            <button type="button" className="btn success" id="cm-done" onClick={() => onCmDecision('DONE')}>Mark DONE</button>
            <button type="button" className="btn danger" id="cm-non-compliant" onClick={() => onCmDecision('NON-COMPLIANT')}>Mark NON-COMPLIANT</button>
          </> : null}
        </>
      )}
    >
      <div className="row mb-12"><Pill s={r.cm_status || r.status} /><span className="dim">Created {fmtDateTime(r.created_at)} by {r.created_by_name || '—'}</span></div>
      {r.status === 'Rejected' && r.last_approval && r.last_approval.decision_note
        ? <div className="alert err mb-12"><strong>Rejected:</strong> {r.last_approval.decision_note}</div> : null}
      <dl className="kv">
        <KV k="Program / Project">{r.program}</KV>
        <KV k="Platform">{r.platform}</KV>
        <KV k="Billable Party">{r.billable_party}</KV>
        <KV k="Episode / Break Date">{r.episode_break_date_text || r.episode_date}</KV>
        <KV k="Number of Materials">{r.materials_count != null ? String(r.materials_count) : null}</KV>
        <KV k="Source">{r.source}</KV>
        <KV k="Destination Folder">{r.destination_folder ? <span className="mono">{r.destination_folder}</span> : null}</KV>
        <KV k="Requested By">{r.requested_by_psd}</KV>
        {r.requested_by_name ? <KV k="Historical Requested By Account">{r.requested_by_name}</KV> : null}
        <KV k="Remarks">{r.remarks}</KV>
        <KV k="Last updated">{fmtDateTime(r.updated_at)}{r.updated_by_name ? ` by ${r.updated_by_name}` : ''}</KV>
        {r.cm_status ? <>
          <KV k="CM decision">{r.cm_status}</KV>
          <KV k="CM decision by">{r.cm_decided_by_name || '—'}</KV>
          <KV k="CM decision at">{fmtDateTime(r.cm_decided_at)}</KV>
          {r.cm_non_compliant_reason ? <KV k="Non-compliant reason">{r.cm_non_compliant_reason}</KV> : null}
        </> : null}
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
