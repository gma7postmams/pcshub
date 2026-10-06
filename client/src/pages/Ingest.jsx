import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { del, get, post, put } from '../lib/api.js';
import { ago, fmtDateTime } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { PlusIcon } from '../components/Icons.jsx';
import { Empty, Modal, Options, Pill, useConfirm, useDebounced, useForm, useToast } from '../components/ui.jsx';

// Status (CM) is blank (Pending) until CM picks one of these
const CM_OPTIONS = ['DONE', 'NON-COMPLIANT'];
const STATUS_FILTER = ['Pending', ...CM_OPTIONS];
const PAGE = 50;
const withCurrent = (list, v) => (v && !list.includes(v) ? [...list, v] : list);
const isoDate = (x) => (/^\d{4}-\d{2}-\d{2}/.test(x || '') ? String(x).slice(0, 10) : '');

// Status (CM) cell: the decision plus its audit-trail timestamp
const CmStatus = ({ r, inline }) => (r.cm_status
  ? (
    <div className={`stack${inline ? ' inline' : ''}`}>
      <Pill s={r.cm_status} />
      <span className="sub nowrap">{fmtDateTime(r.cm_decided_at)}{r.cm_decided_by_name ? ` · ${r.cm_decided_by_name}` : ''}</span>
      {r.cm_status === 'NON-COMPLIANT' && r.cm_non_compliant_reason ? <span className="sub" title={r.cm_non_compliant_reason}>{r.cm_non_compliant_reason}</span> : null}
    </div>
  )
  : <Pill s="Pending" />);

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
  const [detail, setDetail] = useState(null);
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
    <main className="container wide wl-page">
      <div className="page-head">
        <div><h1>Ingest Tracker</h1><div className="sub">Log ingest requests, set their destination and approval, and track the CM status.</div></div>
        <div className="actions">
          {canWrite ? <button type="button" className="btn primary" id="new-btn" onClick={() => setForm({})}><PlusIcon /> New Ingest</button> : null}
        </div>
      </div>

      <div className="card">
        <div className="filters">
          <input type="search" placeholder="Search program, billable party, episode / break date, source, folder, approved by, remarks…" value={filt.q} onChange={setF('q')} />
          <select value={filt.status} onChange={setF('status')}><Options list={STATUS_FILTER} blank="All statuses" /></select>
          <input type="text" placeholder="Program / Project (exact match)" value={filt.program} onChange={setF('program')} />
          <select value={filt.platform} onChange={setF('platform')}><Options list={lookups ? lookups.platform : []} blank="All platforms" /></select>
          <input type="date" title="Episode / Break date from" value={filt.from} onChange={setF('from')} />
          <input type="date" title="Episode / Break date to" value={filt.to} onChange={setF('to')} />
        </div>
        <div className="table-wrap" id="tbl">
          {!data ? <Empty>Loading…</Empty>
            : data.error ? <Empty>{data.error}</Empty>
              : !data.rows.length ? <Empty>No ingest records match these filters.</Empty>
                : (
                  <table className="t wl">
                    <thead><tr>
                      <th>NO</th><th>Program / Project</th><th>Platform</th><th>Billable Party</th><th>Episode / Break Date</th><th>Source</th>
                      <th>No. of Materials</th><th>Requested By</th><th>Destination Folder</th><th>Approved By</th><th>Status (CM)</th><th>Updated</th>
                    </tr></thead>
                    <tbody>
                      {data.rows.map((r) => (
                        <tr key={r.id} className="clickable" onClick={() => openDetail(r.id)}>
                          <td className="dim mono">{r.id}</td>
                          <td><strong>{r.program}</strong></td>
                          <td>{r.platform}</td>
                          <td>{r.billable_party}</td>
                          <td className="nowrap">{r.episode_break_date_text || r.episode_date || ''}</td>
                          <td className="cell-clip" title={r.source || ''}>{r.source}</td>
                          <td className="num">{r.materials_count != null ? r.materials_count : ''}</td>
                          <td>{r.requested_by_psd || r.requested_by_name || ''}</td>
                          <td className="cell-clip mono" title={r.destination_folder || ''}>{r.destination_folder}</td>
                          <td>{r.approved_by}</td>
                          <td><CmStatus r={r} /></td>
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
          canWrite={canWrite && (!detail.cm_status || s.can('ingest.cm_complete'))}
          canDelete={canDelete && !detail.cm_status}
          onClose={() => setDetail(null)}
          onEdit={() => { setForm(detail); setDetail(null); }}
          onDelete={async () => {
            if (!(await confirm('Delete ingest record', `Permanently delete ingest #${detail.id}?`, { okText: 'Delete', danger: true }))) return;
            try { await del(`/api/ingest/${detail.id}`); toast('Deleted'); setDetail(null); load(); } catch (e) { toast(e.message, 'err'); }
          }}
        />
      ) : null}
    </main>
  );
}

function IngestForm({ rec, lookups, onClose, onSaved }) {
  const toast = useToast();
  const confirm = useConfirm();
  const s = useSession();
  const canApprove = s.can('ingest.approve');   // Destination Folder + Approved By (PCS / OCS)
  const canCm = s.can('ingest.cm_complete');    // Status (CM)
  const r = rec || {};
  const initialEpisodeText = rec ? isoDate(r.episode_break_date_text) || isoDate(r.episode_date) : '';
  const requester = rec ? (r.requested_by_psd || r.requested_by_name || '') : (s.user.full_name || s.user.username);
  const initialForm = {
    program: r.program || '', platform: r.platform || '', billable_party: r.billable_party || '',
    episode_break_date_text: initialEpisodeText,
    materials_count: r.materials_count == null ? '' : String(r.materials_count),
    source: r.source || '',
    destination_folder: r.destination_folder || '',
    approved_by: r.approved_by || '',
    cm_status: r.cm_status || '',
    cm_reason: r.cm_non_compliant_reason || '',
    remarks: r.remarks || '',
  };
  const [f, set] = useForm(initialForm);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(initialForm);

  const requestClose = async () => {
    if (busy) return;
    if (!dirty) { onClose(); return; }
    const ok = await confirm(
      'Discard unsaved changes?',
      'Your changes have not been saved. Discard them and close this form?',
      { danger: true, okText: 'Discard' }
    );
    if (ok) onClose();
  };

  const submit = async () => {
    if (!f.program || !f.platform) { toast('Program / Project and Platform are required', 'err'); return; }
    const materialsCount = f.materials_count === '' ? null : Number(f.materials_count);
    if (materialsCount !== null && (!Number.isInteger(materialsCount) || materialsCount < 0)) {
      toast('Number of Materials must be a nonnegative integer', 'err');
      return;
    }
    const cmChanged = canCm && f.cm_status && (f.cm_status !== initialForm.cm_status || (f.cm_status === 'NON-COMPLIANT' && f.cm_reason !== initialForm.cm_reason));
    if (cmChanged && f.cm_status === 'NON-COMPLIANT' && !f.cm_reason.trim()) { toast('Enter the reason it is NON-COMPLIANT', 'err'); return; }
    const { cm_status: _s, cm_reason: _r, ...rest } = f;
    const payload = { ...rest, materials_count: materialsCount };
    // Omit an unchanged fallback value so older records keep their stored compatibility fields.
    if (rec && f.episode_break_date_text === initialEpisodeText) delete payload.episode_break_date_text;
    setBusy(true);
    try {
      let id = rec && rec.id;
      if (rec) await put(`/api/ingest/${rec.id}`, payload);
      else id = (await post('/api/ingest', payload)).id;
      if (cmChanged) await post(`/api/ingest/${id}/cm-decision`, { decision: f.cm_status, reason: f.cm_status === 'NON-COMPLIANT' ? f.cm_reason : '' });
      toast('Saved');
      onSaved();
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };

  return (
    <Modal
      title={rec ? `Edit Ingest #${rec.id}` : 'New Ingest'}
      onClose={requestClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={requestClose}>Cancel</button>
          <button type="button" className="btn primary" id="save" disabled={busy} onClick={submit}>Save</button>
        </>
      )}
    >
      <form id="ing-form" className="form-grid" noValidate onSubmit={(e) => e.preventDefault()}>
        <label className="f"><span>Program / Project <span className="req">*</span></span>
          <input name="program" maxLength={200} value={f.program} onChange={set('program')} /></label>
        <label className="f"><span>Platform <span className="req">*</span></span>
          <select name="platform" value={f.platform} onChange={set('platform')}><Options list={withCurrent(lookups.platform, r.platform)} blank="Select platform…" /></select></label>
        <label className="f"><span>Billable Party</span><input name="billable_party" maxLength={200} value={f.billable_party} onChange={set('billable_party')} /></label>
        <label className="f"><span>Episode / Break Date</span><input type="date" name="episode_break_date_text" value={f.episode_break_date_text} onChange={set('episode_break_date_text')} /></label>
        <label className="f"><span>Source</span><input name="source" maxLength={500} value={f.source} onChange={set('source')} placeholder="e.g. Tape, drive, server path" /></label>
        <label className="f"><span>Number of Materials</span><input type="number" name="materials_count" min="0" step="1" value={f.materials_count} onChange={set('materials_count')} /></label>
        <label className="f"><span>Requested By</span><input name="requested_by" value={requester} readOnly disabled /></label>
        <label className="f"><span>Approved By <span className="dim">— PCS / OCS</span></span>
          <input name="approved_by" maxLength={200} value={f.approved_by} onChange={set('approved_by')} disabled={!canApprove} /></label>
        <label className="f full"><span>Destination Folder <span className="dim">— PCS</span></span>
          <textarea name="destination_folder" className="mono" maxLength={1000} value={f.destination_folder} onChange={set('destination_folder')} disabled={!canApprove} /></label>
        <label className="f"><span>Status (CM)</span>
          <select name="cm_status" value={f.cm_status} onChange={set('cm_status')} disabled={!canCm}>
            <Options list={CM_OPTIONS} blank="Pending" />
          </select></label>
        {f.cm_status === 'NON-COMPLIANT' ? (
          <label className="f"><span>Reason <span className="req">*</span></span>
            <input name="cm_reason" maxLength={2000} value={f.cm_reason} onChange={set('cm_reason')} disabled={!canCm} /></label>
        ) : <div />}
        {rec && rec.cm_status ? <div className="full dim">Decided {fmtDateTime(rec.cm_decided_at)}{rec.cm_decided_by_name ? ` by ${rec.cm_decided_by_name}` : ''}. Changes are recorded in the audit trail.</div> : null}
        <label className="f full"><span>Remarks</span><textarea name="remarks" maxLength={4000} value={f.remarks} onChange={set('remarks')} /></label>
      </form>
    </Modal>
  );
}

const KV = ({ k, children }) => <><dt>{k}</dt><dd>{children || <span className="dim">—</span>}</dd></>;

function IngestDetail({ r, canWrite, canDelete, onClose, onEdit, onDelete }) {
  return (
    <Modal
      title={`Ingest #${r.id}`}
      onClose={onClose}
      footer={(
        <>
          {canDelete ? <button type="button" className="btn danger" id="del" onClick={onDelete}>Delete</button> : null}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {canWrite ? <button type="button" className="btn primary" id="edit" onClick={onEdit}>Edit</button> : null}
        </>
      )}
    >
      <div className="row mb-12"><CmStatus r={r} inline /><span className="dim">Created {fmtDateTime(r.created_at)} by {r.created_by_name || '—'}</span></div>
      <dl className="kv">
        <KV k="Program / Project">{r.program}</KV>
        <KV k="Platform">{r.platform}</KV>
        <KV k="Billable Party">{r.billable_party}</KV>
        <KV k="Episode / Break Date">{r.episode_break_date_text || r.episode_date}</KV>
        <KV k="Source">{r.source}</KV>
        <KV k="Number of Materials">{r.materials_count != null ? String(r.materials_count) : null}</KV>
        <KV k="Requested By">{r.requested_by_psd || r.requested_by_name}</KV>
        <KV k="Destination Folder">{r.destination_folder ? <span className="mono">{r.destination_folder}</span> : null}</KV>
        <KV k="Approved By">{r.approved_by}</KV>
        <KV k="Status (CM)">{r.cm_status || 'Pending'}</KV>
        {r.cm_status ? <>
          {r.cm_non_compliant_reason ? <KV k="Non-compliant reason">{r.cm_non_compliant_reason}</KV> : null}
        </> : null}
        <KV k="Remarks">{r.remarks}</KV>
        <KV k="Last updated">{fmtDateTime(r.updated_at)}{r.updated_by_name ? ` by ${r.updated_by_name}` : ''}</KV>
      </dl>
    </Modal>
  );
}
