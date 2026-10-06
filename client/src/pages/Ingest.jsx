import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { del, get, patch, post, put } from '../lib/api.js';
import { ago, fmtDate, fmtDateTime } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { PlusIcon, SearchIcon } from '../components/Icons.jsx';
import { Chip, DateChip, DateRange, FilterSelect, Pager, PlatformCell } from '../components/wl.jsx';
import { Empty, Modal, Options, useConfirm, useDebounced, useForm, useToast } from '../components/ui.jsx';

// Status (CM) is blank (Pending) until CM picks one of these
const CM_OPTIONS = ['DONE', 'NON-COMPLIANT'];
const STATUS_FILTER = ['PENDING', ...CM_OPTIONS];
const PAGE = 50;
const withCurrent = (list, v) => (v && !list.includes(v) ? [...list, v] : list);
const isoDate = (x) => (/^\d{4}-\d{2}-\d{2}/.test(x || '') ? String(x).slice(0, 10) : '');

// Status (CM) cell: the decision plus its audit-trail timestamp. Same chips as the Workload Tracker (soft colour + dot).
const CM_HUE = { DONE: 'green', 'NON-COMPLIANT': 'red', PENDING: 'amber' };
const CmChip = ({ s }) => <Chip hue={CM_HUE[s] || 'amber'} dot>{s}</Chip>;
const CmStatus = ({ r, inline }) => (r.cm_status
  ? (
    <div className={`stack${inline ? ' inline' : ''}`}>
      <CmChip s={r.cm_status} />
      <span className="sub nowrap">{fmtDateTime(r.cm_decided_at)}{r.cm_decided_by_name ? ` · ${r.cm_decided_by_name}` : ''}</span>
      {r.cm_status === 'NON-COMPLIANT' && r.cm_non_compliant_reason ? <span className="sub" title={r.cm_non_compliant_reason}>{r.cm_non_compliant_reason}</span> : null}
    </div>
  )
  : <CmChip s="PENDING" />);
// Approved By: the approver's name with the time under it (like Status (CM)). Approving itself happens in the details dialog: click the row (or this cell) and press Approve there.
// Until a request is approved, people who can approve see a quiet "Awaiting approval" so they can spot what needs them.
const ApprovedBy = ({ r, canApprove }) => {
  if (r.approved_by) {
    return (
      <div className="stack">
        <span>{r.approved_by}</span>
        {r.approved_at ? <span className="sub nowrap">{fmtDateTime(r.approved_at)}</span> : null}
      </div>
    );
  }
  return canApprove ? <span className="dim">Awaiting approval</span> : null;
};
const dayText = (x) => (isoDate(x) ? fmtDate(isoDate(x)) : (x || ''));   // a real date reads like the Workload Tracker's; old free text is shown as written

// Columns that can be edited right in the table, like the Workload Tracker: click a cell, change it, Enter or click away saves, Esc cancels.
// Requested By is not one of them — it is filled in from whoever created the request. Destination Folder and Approved By are for PCS / OCS only.
const CELLS = {
  program: { kind: 'text', max: 200 },
  platform: { kind: 'select' },
  billable_party: { kind: 'text', max: 200 },
  episode_break_date_text: { kind: 'date' },   // the browser's own date picker
  source: { kind: 'text', max: 500 },
  materials_count: { kind: 'number' },
  destination_folder: { kind: 'area', max: 1000, approve: true },
  cm_status: { kind: 'select', cm: true, blank: 'PENDING' },   // Status (CM): a dropdown for CM users; NON-COMPLIANT then asks for its reason
};
const cellInitial = (r, k) => (k === 'cm_status' ? (r.cm_status || '') : k === 'episode_break_date_text' ? (isoDate(r.episode_break_date_text) || isoDate(r.episode_date))
  : r[k] == null ? '' : String(r[k]));

// One table cell turned into its own editor. Dropdowns save as soon as you pick; a failed save keeps the editor open with the message shown.
function InlineCell({ def, initial, options, onSave, onCancel }) {
  const [val, setVal] = useState(initial);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const finished = useRef(false);
  const field = () => box.current && box.current.querySelector('input, select, textarea');
  useEffect(() => {
    const el = field();
    if (!el) return;
    el.focus();
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) el.setSelectionRange(el.value.length, el.value.length);
    try { if (el.tagName === 'SELECT') el.showPicker(); } catch (e) { /* needs a user gesture; the field is focused anyway */ }
  }, []);
  const save = async (value) => {
    if (finished.current) return;
    finished.current = true;
    setBusy(true);
    try { await onSave(value); } catch (e) {
      finished.current = false;
      setBusy(false);
      setTimeout(() => { const el = field(); if (el) el.focus(); }, 0);
    }
  };
  const change = (e) => { const nv = e.target.value; setVal(nv); if (def.kind === 'select') save(nv); };
  const blur = (e) => { if (box.current && !box.current.contains(e.relatedTarget)) save(val); };
  const key = (e) => {
    if (e.key === 'Escape') { finished.current = true; onCancel(); return; }
    const tag = e.target.tagName;
    if (e.key === 'Enter' && tag !== 'SELECT' && (tag !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) { e.preventDefault(); save(val); }
  };
  let input;
  if (def.kind === 'select') input = <select value={val} disabled={busy} onChange={change}><Options list={options} blank={def.blank || 'Select…'} /></select>;
  else if (def.kind === 'date') input = <input type="date" value={val} disabled={busy} onChange={change} />;
  else if (def.kind === 'number') input = <input type="number" min="0" step="1" value={val} disabled={busy} onChange={change} />;
  else if (def.kind === 'area') input = <textarea className="mono" maxLength={def.max} value={val} disabled={busy} onChange={change} />;
  else input = <input maxLength={def.max} value={val} disabled={busy} onChange={change} />;
  return <div className={`cell-editor${def.kind === 'number' ? ' num' : ''}${busy ? ' busy' : ''}`} ref={box} onBlur={blur} onKeyDown={key}>{input}</div>;
}

// NON-COMPLIANT needs a reason: asked here right after it is picked in the Status (CM) cell.
function ReasonModal({ r, onClose, onSave }) {
  const [reason, setReason] = useState(r.cm_non_compliant_reason || '');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const save = async () => {
    if (!reason.trim()) { toast('Enter the reason it is NON-COMPLIANT', 'err'); return; }
    setBusy(true);
    try { await onSave(reason); } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal title={`Ingest #${r.no ?? r.id}: NON-COMPLIANT`} onClose={() => { if (!busy) onClose(); }}
      footer={(<>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={save}>Save</button>
      </>)}>
      <label className="f full"><span>Reason <span className="req">*</span></span>
        <textarea maxLength={2000} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></label>
    </Modal>
  );
}

export default function Ingest() {
  const s = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const canWrite = s.can('ingest.write');
  const canDelete = s.can('ingest.delete');

  const [lookups, setLookups] = useState(null);
  const [filt, setFilt] = useState({ q: '', status: /^pending$/i.test(params.get('status') || '') ? 'PENDING' : (params.get('status') || ''), program: '', platform: '', from: '', to: '', approval: /^pending$/i.test(params.get('approval') || '') ? 'pending' : '' });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);     // null | {} (new) | record (edit)
  const [detail, setDetail] = useState(null);
  const [reasonFor, setReasonFor] = useState(null);   // the record whose NON-COMPLIANT reason is being asked for
  const [editing, setEditing] = useState(null);   // { id, k }: the one cell being edited in the table
  const q = useDebounced(filt.q, 300);

  useEffect(() => {
    get('/api/dropdowns?categories=platform').then(setLookups);
  }, []);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ limit: PAGE, offset });
    Object.entries({ ...filt, q }).forEach(([k, v]) => { if (v) p.set(k, v); });
    try { setData(await get(`/api/ingest?${p}`)); } catch (e) { setData({ error: e.message, rows: [], total: 0 }); }
  }, [filt.status, filt.program, filt.platform, filt.from, filt.to, filt.approval, q, offset]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const openDetail = useCallback(async (id) => {
    try { setDetail(await get(`/api/ingest/${id}`)); } catch (e) { toast(e.message, 'err'); }
  }, [toast]);

  useEffect(() => {
    if (params.get('new') && canWrite) setForm({});
    if (params.get('id')) openDetail(+params.get('id'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const canApprove = s.can('ingest.approve');
  const canCm = s.can('ingest.cm_complete');
  const closeCell = (r, k) => setEditing((cur) => (cur && cur.id === r.id && cur.k === k ? null : cur));
  // Save ONE cell (PATCH writes only that column, so other people's edits to the row are kept)
  const decide = async (r, decision, reason) => {
    await post(`/api/ingest/${r.id}/cm-decision`, { decision, reason: decision === 'NON-COMPLIANT' ? reason : '' });
    const fresh = await get(`/api/ingest/${r.id}`);
    setData((d) => (d && d.rows ? { ...d, rows: d.rows.map((x) => (x.id === r.id ? { ...x, ...fresh } : x)) } : d));
  };
  const approve = async (r) => {   // called from the details dialog; you are recorded as the approver, and "Undo approval" is there if it was a mistake
    try {
      await post(`/api/ingest/${r.id}/approve`, {});
      const fresh = await get(`/api/ingest/${r.id}`);
      setData((d) => (d && d.rows ? { ...d, rows: d.rows.map((x) => (x.id === r.id ? { ...x, ...fresh } : x)) } : d));
      setDetail((cur) => (cur && cur.id === r.id ? fresh : cur));
      toast('Approved');
    } catch (e) { toast(e.message, 'err'); }
  };
  const unapprove = async (r) => {
    try {
      await post(`/api/ingest/${r.id}/unapprove`, {});
      const fresh = await get(`/api/ingest/${r.id}`);
      setData((d) => (d && d.rows ? { ...d, rows: d.rows.map((x) => (x.id === r.id ? { ...x, ...fresh } : x)) } : d));
      setDetail((cur) => (cur && cur.id === r.id ? fresh : cur));
      toast('Approval removed');
    } catch (e) { toast(e.message, 'err'); }
  };
  const saveCell = async (r, k, value, initial) => {
    if (String(value ?? '') === String(initial ?? '')) { closeCell(r, k); return; }
    if (k === 'cm_status') {
      if (!value) { try { await decide(r, 'Pending', ''); closeCell(r, k); toast('Saved'); } catch (e) { toast(e.message, 'err'); throw e; } return; }   // back to Pending
      if (value === 'NON-COMPLIANT') { closeCell(r, k); setReasonFor(r); return; }
      try { await decide(r, value, ''); closeCell(r, k); toast('Saved'); } catch (e) { toast(e.message, 'err'); throw e; }
      return;
    }
    try {
      const out = await patch(`/api/ingest/${r.id}`, { field: k, value: k === 'materials_count' ? (value === '' ? null : Number(value)) : value });
      setData((d) => (d && d.rows ? { ...d, rows: d.rows.map((x) => (x.id === r.id ? { ...x, ...out.row } : x)) } : d));
      closeCell(r, k);
    } catch (e) { toast(e.message, 'err'); throw e; }
  };
  // A cell in the table: editable in place when you may change it, otherwise plain (clicking it opens the details as before).
  const cell = (r, k, children, props = {}) => {
    const def = CELLS[k];
    const may = def && def.cm ? canCm : canWrite && (!r.cm_status || canCm) && (!def || !def.approve || canApprove);
    if (!def || !may) return <td {...props}>{children}</td>;
    if (editing && editing.id === r.id && editing.k === k) {
      const initial = cellInitial(r, k);
      return (
        <td className="editing" onClick={(e) => e.stopPropagation()}>
          <InlineCell def={def} initial={initial} options={k === 'cm_status' ? CM_OPTIONS : withCurrent(lookups ? lookups.platform : [], r.platform)}
            onSave={(value) => saveCell(r, k, value, initial)} onCancel={() => setEditing(null)} />
        </td>
      );
    }
    const open = () => setEditing({ id: r.id, k });
    return (
      <td {...props} className={`${props.className || ''} editable`.trim()} title="Click to edit" tabIndex={0}
        onClick={(e) => { e.stopPropagation(); open(); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } }}>{children}</td>
    );
  };

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

      <div className="card wl-card">
        <div className="wl-filters">
          <label className="wl-search" style={{ minWidth: 'min(100%, 410px)' }}>
            <SearchIcon />
            <input type="search" placeholder="Search program, party, source, folder, remarks…" style={{ textOverflow: 'ellipsis' }} value={filt.q} onChange={setF('q')} />
          </label>
          <FilterSelect label="Status" value={filt.status} onChange={setF('status')}><Options list={STATUS_FILTER} blank="All" /></FilterSelect>
          <FilterSelect label="Platform" value={filt.platform} onChange={setF('platform')}><Options list={lookups ? lookups.platform : []} blank="All" /></FilterSelect>
          <label className="wl-search" style={{ flex: '0 1 320px', minWidth: 'min(100%, 300px)' }}>   {/* wide enough for the whole hint, with room to spare for wider fonts (a Mac's system font is wider) */}
            <input type="text" placeholder="Program / Project (exact match)" value={filt.program} onChange={setF('program')} style={{ textOverflow: 'ellipsis' }} />
          </label>
          <DateRange title="Episode / Break date range" from={filt.from} to={filt.to} onChange={({ from, to }) => { setFilt((f) => ({ ...f, from, to })); setOffset(0); }} />
          {filt.approval ? (   // opened from the Dashboard's Pending Approval card: only requests nobody has approved yet; the chip clears it
            <button type="button" className="btn sm" title="Show every request again" onClick={() => { setFilt((f) => ({ ...f, approval: '' })); setOffset(0); }}>Awaiting approval ✕</button>
          ) : null}
        </div>
        <div className="table-wrap" id="tbl">
          {!data ? <Empty>Loading…</Empty>
            : data.error ? <Empty>{data.error}</Empty>
              : !data.rows.length ? <Empty>No ingest records match these filters.</Empty>
                : (
                  <table className="t wl">
                    <thead><tr>
                      <th>NO.</th><th>Program / Project</th><th>Platform</th><th>Billable Party</th><th>Episode / Break Date</th><th>Source</th>
                      <th className="narrow" title="No. of Materials">Materials</th><th>Requested By</th><th>Destination Folder</th><th>Approved By</th><th>Status (CM)</th><th>Updated</th>
                    </tr></thead>
                    <tbody>
                      {data.rows.map((r) => (
                        <tr key={r.id} className="clickable" onClick={() => openDetail(r.id)}>
                          <td className="dim mono">{r.no ?? r.id}</td>
                          {cell(r, 'program', <strong>{r.program}</strong>)}
                          {cell(r, 'platform', <PlatformCell value={r.platform} />)}
                          {cell(r, 'billable_party', r.billable_party)}
                          {cell(r, 'episode_break_date_text', <DateChip>{dayText(r.episode_break_date_text || r.episode_date)}</DateChip>, { className: 'nowrap' })}
                          {cell(r, 'source', r.source, { className: 'cell-clip', title: r.source || '' })}
                          {cell(r, 'materials_count', r.materials_count != null ? r.materials_count : '', { className: 'num' })}
                          <td title="Filled in automatically from the person who created the request">{r.requested_by_psd || r.requested_by_name || ''}</td>
                          {cell(r, 'destination_folder', r.destination_folder, { className: 'cell-clip mono', title: r.destination_folder || '' })}
                          <td><ApprovedBy r={r} canApprove={canApprove} /></td>
                          {cell(r, 'cm_status', <CmStatus r={r} />)}
                          <td className="dim nowrap">{ago(r.updated_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
        </div>
        <Pager total={total} offset={offset} size={PAGE} onOffset={setOffset} />
      </div>

      {form && lookups ? (
        <IngestForm rec={form.id ? form : null} lookups={lookups} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />
      ) : null}

      {reasonFor ? (
        <ReasonModal r={reasonFor} onClose={() => setReasonFor(null)}
          onSave={async (reason) => { await decide(reasonFor, 'NON-COMPLIANT', reason); setReasonFor(null); toast('Saved'); }} />
      ) : null}

      {detail ? (
        <IngestDetail
          r={detail}
          canWrite={canWrite && (!detail.cm_status || s.can('ingest.cm_complete'))}
          canDelete={canDelete && (!detail.cm_status || (detail.cm_status === 'DONE' && s.user.role === 'Admin'))}   // a CM-decided request is kept as history, except that an Admin can delete one that is DONE
          canApprove={canApprove && !detail.approved_by}
          approveReady={!!(detail.destination_folder && String(detail.destination_folder).trim())}
          canUnapprove={canApprove && !!detail.approved_by}
          onApprove={() => approve(detail)}
          onUnapprove={() => unapprove(detail)}
          onClose={() => setDetail(null)}
          onEdit={() => { setForm(detail); setDetail(null); }}
          onDelete={async () => {
            const done = detail.cm_status === 'DONE';
            if (!(await confirm('Delete ingest record', done ? `Ingest #${detail.no ?? detail.id} is already DONE in CM. Deleting it permanently removes this historical record.` : `Permanently delete ingest #${detail.no ?? detail.id}?`, { okText: 'Delete', danger: true }))) return;
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
    const cmChanged = canCm && (f.cm_status !== initialForm.cm_status || (f.cm_status === 'NON-COMPLIANT' && f.cm_reason !== initialForm.cm_reason));
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
      if (cmChanged) await post(`/api/ingest/${id}/cm-decision`, { decision: f.cm_status || 'Pending', reason: f.cm_status === 'NON-COMPLIANT' ? f.cm_reason : '' });
      toast('Saved');
      onSaved();
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };

  return (
    <Modal
      title={rec ? `Edit Ingest #${rec.no ?? rec.id}` : 'New Ingest'}
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
        <label className="f full"><span>Destination Folder <span className="dim">— PCS</span></span>
          <textarea name="destination_folder" className="mono" maxLength={1000} value={f.destination_folder} onChange={set('destination_folder')} disabled={!canApprove} /></label>
        <label className="f"><span>Status (CM)</span>
          <select name="cm_status" value={f.cm_status} onChange={set('cm_status')} disabled={!canCm}>
            <Options list={CM_OPTIONS} blank="PENDING" />
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

function IngestDetail({ r, canWrite, canDelete, canApprove, approveReady, canUnapprove, onClose, onEdit, onDelete, onApprove, onUnapprove }) {
  return (
    <Modal
      title={`Ingest #${r.no ?? r.id}`}
      onClose={onClose}
      footer={(
        <>
          {canDelete ? <button type="button" className="btn danger" id="del" onClick={onDelete}>Delete</button> : null}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {canUnapprove ? <button type="button" className="btn" id="unapprove" onClick={onUnapprove}>Undo approval</button> : null}
          {canApprove ? (
            <button type="button" className="btn primary" id="approve" disabled={!approveReady} onClick={onApprove}
              title={approveReady ? 'Approve this ingest — you will be recorded as the approver' : 'Fill in the Destination Folder first'}>Approve</button>
          ) : null}
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
        <KV k="Approved By">{r.approved_by ? `${r.approved_by}${r.approved_at ? ` · ${fmtDateTime(r.approved_at)}` : ''}` : (canApprove && !approveReady ? <span className="dim">Fill in the Destination Folder before approving.</span> : null)}</KV>
        <KV k="Status (CM)">{r.cm_status || 'PENDING'}</KV>
        {r.cm_status ? <>
          {r.cm_non_compliant_reason ? <KV k="Non-compliant reason">{r.cm_non_compliant_reason}</KV> : null}
        </> : null}
        <KV k="Remarks">{r.remarks}</KV>
        <KV k="Last updated">{fmtDateTime(r.updated_at)}{r.updated_by_name ? ` by ${r.updated_by_name}` : ''}</KV>
      </dl>
    </Modal>
  );
}
