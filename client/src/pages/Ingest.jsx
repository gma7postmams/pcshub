import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { del, get, patch, post, put } from '../lib/api.js';
import { ago, downloadFile, fmtDate, fmtDateTime } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { PlusIcon, SearchIcon, DownloadIcon, TrashIcon, FullscreenIcon, ExitFullscreenIcon } from '../components/Icons.jsx';
import { normDate, parseTsv, tsvCell } from '../components/PlugGrid.jsx';
import { Chip, DateChip, DateRange, FilterSelect, FiltersMenu, Pager, PlatformCell, SortTh, ToolMenu, useFitBox, useNarrow } from '../components/wl.jsx';
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
const RANGE = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/;
const splitRange = (x) => { const m = RANGE.exec(String(x || '')); return m ? { from: m[1], to: m[2] } : { from: isoDate(x) || '', to: '' }; };
const dayText = (x) => { const m = RANGE.exec(String(x || '')); return m ? `${fmtDate(m[1])} – ${fmtDate(m[2])}` : (isoDate(x) ? fmtDate(isoDate(x)) : (x || '')); };   // a single date, a range, or old free text as written; a real date reads like the Workload Tracker's; old free text is shown as written

// Columns that can be edited right in the table, like the Workload Tracker: click a cell, change it, Enter or click away saves, Esc cancels.
// Requested By is not one of them — it is filled in from whoever created the request. Destination Folder and Approved By are for PCS / OCS only.
const CELLS = {
  program: { kind: 'text', max: 200 },
  platform: { kind: 'select' },
  billable_party: { kind: 'text', max: 200 },
  episode_break_date_text: { kind: 'daterange' },   // one date or a from–to range, with the browser's own date pickers
  source: { kind: 'text', max: 500 },
  materials_count: { kind: 'number' },
  destination_folder: { kind: 'area', max: 1000, approve: true },
  cm_status: { kind: 'select', cm: true, blank: 'PENDING' },   // Status (CM): a dropdown for CM users; NON-COMPLIANT then asks for its reason
};
const cellInitial = (r, k) => (k === 'cm_status' ? (r.cm_status || '') : k === 'episode_break_date_text' ? (RANGE.test(r.episode_break_date_text || '') ? r.episode_break_date_text : (isoDate(r.episode_break_date_text) || isoDate(r.episode_date)))
  : r[k] == null ? '' : String(r[k]));

// The table's columns in order (for cell blocks, copy and paste). Only some can be written from the table: Requested By is the person who created the request,
// Approved By is set by the Approve button, Status (CM) has its own flow (and a reason for NON-COMPLIANT).
const COLS = ['program', 'platform', 'billable_party', 'episode_break_date_text', 'source', 'materials_count', 'requested_by', 'destination_folder', 'approved_by', 'cm_status'];
const WRITE = new Set(['program', 'platform', 'billable_party', 'episode_break_date_text', 'source', 'materials_count', 'destination_folder']);
const REQUIRED = new Set(['program', 'platform']);   // can't be cleared
const textOf = (r, k) => (k === 'requested_by' ? (r.requested_by_psd || r.requested_by_name || '') : k === 'approved_by' ? (r.approved_by || '') : k === 'cm_status' ? (r.cm_status || 'PENDING') : cellInitial(r, k));
const cleanVal = (k, raw) => { const t = String(raw ?? '').replace(/\s*\n\s*/g, ' ').trim(); return k === 'episode_break_date_text' ? (RANGE.test(t) ? t : normDate(t)) : t; };
async function writeClipboard(text) {   // the async API where the page may use it (https / localhost), else a hidden textarea + the copy command
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  const prev = document.activeElement;
  ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  if (prev && prev.focus) prev.focus({ preventScroll: true });
  return ok;
}
function CellMenu({ x, y, children, ...rest }) {   // a right-click menu that always fits in the window
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.maxHeight = `${window.innerHeight - 16}px`;
    el.style.overflowY = 'auto';
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  }, [x, y]);
  return <div ref={ref} className="xl-menu" style={{ left: x, top: y }} {...rest}>{children}</div>;
}

// Episode / Breakdate: a date, or a from – to range (the second date is optional). The value is "YYYY-MM-DD" or "YYYY-MM-DD/YYYY-MM-DD".
function DateRangeInput({ value, onChange, disabled }) {
  const { from, to } = splitRange(value);
  const join = (a, b) => (a && b ? `${a}/${b}` : a || '');
  return (
    <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
      <input type="date" value={from} disabled={disabled} max={to || undefined} aria-label="From" onChange={(e) => onChange(join(e.target.value, to))} />
      <span className="dim">–</span>
      <input type="date" value={to} disabled={disabled || !from} min={from || undefined} aria-label="To (optional)" onChange={(e) => onChange(join(from, e.target.value))} />
    </span>
  );
}

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
  const save = async (value, move) => {
    if (finished.current) return;
    finished.current = true;
    setBusy(true);
    try { await onSave(value, move); } catch (e) {
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
    if (e.key === 'Enter' && tag !== 'SELECT' && (tag !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) { e.preventDefault(); save(val, def.kind === 'daterange' ? undefined : { dr: e.shiftKey ? -1 : 1, dc: 0 }); }   // Enter saves and moves down (Shift+Enter up)
    else if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && def.kind !== 'daterange') { e.preventDefault(); save(val, { dr: 0, dc: e.shiftKey ? -1 : 1 }); }   // Tab / Shift+Tab move sideways
  };
  let input;
  if (def.kind === 'select') input = <select value={val} disabled={busy} onChange={change}><Options list={options} blank={def.blank || 'Select…'} /></select>;
  else if (def.kind === 'date') input = <input type="date" value={val} disabled={busy} onChange={change} />;
  else if (def.kind === 'daterange') input = <DateRangeInput value={val} disabled={busy} onChange={(nv) => setVal(nv)} />;
  else if (def.kind === 'number') input = <input type="number" min="0" step="1" value={val} disabled={busy} onChange={change} />;
  else if (def.kind === 'area') input = <textarea className="mono" maxLength={def.max} value={val} disabled={busy} onChange={change} />;
  else input = <input maxLength={def.max} value={val} disabled={busy} onChange={change} />;
  return <div className={`cell-editor${def.kind === 'number' ? ' num' : def.kind === 'date' || def.kind === 'daterange' ? ' date' : ''}${busy ? ' busy' : ''}`} ref={box} onBlur={blur} onKeyDown={key}>{input}</div>;
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

  const narrow = useNarrow();
  const [lookups, setLookups] = useState(null);
  const [filt, setFilt] = useState({ q: '', status: /^pending$/i.test(params.get('status') || '') ? 'PENDING' : (params.get('status') || ''), program: '', platform: '', from: '', to: '', approval: /^pending$/i.test(params.get('approval') || '') ? 'pending' : '' });
  const [offset, setOffset] = useState(0);
  const [sort, setSortState] = useState({ k: '', dir: 'asc' });   // clicked column header
  const setSort = (s2) => { setSortState(s2); setOffset(0); };
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);     // null | {} (new) | record (edit)
  const [detail, setDetail] = useState(null);
  const [reasonFor, setReasonFor] = useState(null);   // the record whose NON-COMPLIANT reason is being asked for
  const [editing, setEditing] = useState(null);   // { id, k }: the one cell being edited in the table
  const [picked, setPicked] = useState(() => new Set());   // rows ticked for batch delete
  const q = useDebounced(filt.q, 300);

  useEffect(() => {
    get('/api/dropdowns?categories=platform').then(setLookups);
  }, []);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ limit: PAGE, offset });
    Object.entries({ ...filt, q }).forEach(([k, v]) => { if (v) p.set(k, v); });
    if (sort.k) { p.set('sort', sort.k); p.set('dir', sort.dir); }
    setPicked(new Set());
    try { setData(await get(`/api/ingest?${p}`)); } catch (e) { setData({ error: e.message, rows: [], total: 0 }); }
  }, [filt.status, filt.program, filt.platform, filt.from, filt.to, filt.approval, q, offset, sort.k, sort.dir]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const exportXlsx = async () => {   // what the table shows: same filters, search and sort
    const p = new URLSearchParams();
    Object.entries({ ...filt, q }).forEach(([k, v]) => { if (v) p.set(k, v); });
    if (sort.k) { p.set('sort', sort.k); p.set('dir', sort.dir); }
    try { await downloadFile(`/api/ingest/export?${p}`, 'Ingest.xlsx'); } catch (e) { toast(e.message, 'err'); }
  };

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
  // ---- table state: full screen, the Add Row draft, the right-click menu, a block of picked cells, undo / redo ----
  const rows = data && data.rows ? data.rows : [];
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const [full, setFull] = useState(false);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) setFull(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);
  const [draft, setDraft] = useState(null);          // the empty row Add Row put at the top, not saved yet
  const [ctx, setCtx] = useState(null);              // right-click menu position
  const [cellSel, setCellSel] = useState(null);      // a block of cells picked by dragging { r0, c0, r1, c1 }
  const hist = useRef({ past: [], future: [] });
  const internalClip = useRef(null);
  const lastPick = useRef(null);
  const drag = useRef(null);
  const cellDrag = useRef(null);
  const suppress = useRef(false);
  const keysRef = useRef(null);
  const pasteRef = useRef(null);
  const clearPicksRef = useRef(() => {});
  const clearPicks = () => { setPicked(new Set()); lastPick.current = null; };
  clearPicksRef.current = clearPicks;
  const chosen = rows.filter((r) => picked.has(r.id));

  // May this person change this cell? (a CM-decided record is locked unless you are CM; Destination Folder is PCS / OCS only)
  const may = (r, k) => { const def = CELLS[k]; if (!def) return false; return def.cm ? canCm : canWrite && (!r.cm_status || canCm) && (!def.approve || canApprove); };

  const patchCell = async (id, k, value) => {
    const out = await patch(`/api/ingest/${id}`, { field: k, value: k === 'materials_count' ? (value === '' ? null : Number(value)) : value });
    setData((d) => (d && d.rows ? { ...d, rows: d.rows.map((x) => (x.id === id ? { ...x, ...out.row } : x)) } : d));
    return out.row;
  };
  const pushH = (entry) => { const h = hist.current; h.past.push(entry); if (h.past.length > 50) h.past.shift(); h.future = []; };
  const step = async (from, to, verb) => {
    const e = hist.current[from].pop();
    if (!e) { toast(`Nothing to ${verb}`); return; }
    try { await e[verb](); hist.current[to].push(e); toast(`${verb === 'undo' ? 'Undone' : 'Redone'}: ${e.label}`); } catch (err) { hist.current[from].push(e); toast(err.message, 'err'); }
    clearPicks(); setCellSel(null);
    load();
  };
  const undo = () => step('past', 'future', 'undo');
  const redo = () => step('future', 'past', 'redo');

  // go to the next cell you may edit (Enter / Tab in a cell editor)
  const moveEdit = (r, k, { dr, dc }) => {
    const list = [...(draft ? [{ ...draft, id: 'draft' }] : []), ...rows];
    let ri = list.findIndex((x) => x.id === r.id);
    let ci = COLS.indexOf(k);
    if (ri < 0 || ci < 0) return;
    for (let n = 0; n < COLS.length * (list.length + 1) + 2; n++) {
      if (dc) { ci += dc; if (ci >= COLS.length) { ci = 0; ri += 1; } else if (ci < 0) { ci = COLS.length - 1; ri -= 1; } } else ri += dr;
      if (ri < 0 || ri >= list.length) return;
      const kk = COLS[ci]; const rr = list[ri];
      if (WRITE.has(kk) && (rr.id === 'draft' ? canWrite && (kk !== 'destination_folder' || canApprove) : may(rr, kk))) { setEditing({ id: rr.id, k: kk }); return; }
    }
  };
  // Save ONE cell (PATCH writes only that column, so other people's edits to the row are kept)
  const saveCell = async (r, k, value, initial, move) => {
    if (r.id === 'draft') { setDraft((d) => (d ? { ...d, [k]: value } : d)); closeCell(r, k); if (move) moveEdit(r, k, move); return; }
    if (String(value ?? '') === String(initial ?? '')) {
      closeCell(r, k);
      if (k === 'cm_status' && value === 'NON-COMPLIANT') setReasonFor(r);   // picking NON-COMPLIANT again = update its reason
      else if (move) moveEdit(r, k, move);
      return;
    }
    if (k === 'cm_status') {
      if (!value) { try { await decide(r, 'Pending', ''); closeCell(r, k); toast('Saved'); } catch (e) { toast(e.message, 'err'); throw e; } return; }   // back to Pending
      if (value === 'NON-COMPLIANT') { closeCell(r, k); setReasonFor(r); return; }
      try { await decide(r, value, ''); closeCell(r, k); toast('Saved'); } catch (e) { toast(e.message, 'err'); throw e; }
      return;
    }
    try {
      await patchCell(r.id, k, value);
      pushH({ label: 'cell edit', undo: async () => { await patchCell(r.id, k, initial); }, redo: async () => { await patchCell(r.id, k, value); } });
      closeCell(r, k);
      if (move) moveEdit(r, k, move);
    } catch (e) { toast(e.message, 'err'); throw e; }
  };

  // A cell in the table: editable in place when you may change it, otherwise plain (clicking it opens the details as before).
  const LBL = { program: 'PROG. NAME / PROJ. TITLE', platform: 'Platform', billable_party: 'Billable Party', episode_break_date_text: 'Episode / Breakdate', source: 'Source', materials_count: 'No. of Materials', requested_by: 'Requested By', destination_folder: 'Destination Folder', approved_by: 'Approved By', cm_status: 'Status (CM)', updated: 'Updated' };
  const normCells = () => (cellSel ? { r0: Math.min(cellSel.r0, cellSel.r1), r1: Math.max(cellSel.r0, cellSel.r1), c0: Math.min(cellSel.c0, cellSel.c1), c1: Math.max(cellSel.c0, cellSel.c1) } : null);
  const cell = (r, k, children, props0 = {}) => {
    const props = { 'data-k': k, 'data-label': LBL[k], ...props0 };
    const ci = COLS.indexOf(k);
    if (r.__i !== undefined && ci >= 0) {
      props['data-r'] = r.__i; props['data-c'] = ci;
      const n = normCells();
      if (n && r.__i >= n.r0 && r.__i <= n.r1 && ci >= n.c0 && ci <= n.c1) props['data-sel'] = '1';
    }
    const def = CELLS[k];
    const isDraft = r.id === 'draft';
    const mayEdit = isDraft ? canWrite && !!def && !def.cm && (!def.approve || canApprove) : !!def && may(r, k);
    if (!def || !mayEdit) return <td {...props}>{children}</td>;
    if (editing && editing.id === r.id && editing.k === k) {
      const initial = cellInitial(r, k);
      return (
        <td data-k={k} data-r={props['data-r']} data-c={props['data-c']} className="editing" onClick={(e) => e.stopPropagation()}>
          <InlineCell def={def} initial={initial} options={k === 'cm_status' ? CM_OPTIONS : withCurrent(lookups ? lookups.platform : [], r.platform)}
            onSave={(value, move) => saveCell(r, k, value, initial, move)} onCancel={() => setEditing(null)} />
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

  // ---- Add Row: an empty row at the top; fill the cells and Save (Program and Platform are required) or Discard ----
  const addDraft = () => {
    if (!canWrite) return;
    if (draft) { setEditing({ id: 'draft', k: 'program' }); return; }
    setDraft({ id: 'draft', program: '', platform: '', billable_party: '', episode_break_date_text: '', source: '', materials_count: '', destination_folder: '' });
    setEditing({ id: 'draft', k: 'program' });
    requestAnimationFrame(() => { const box = document.querySelector('.wl-card .wl-fit'); if (box) box.scrollTop = 0; });
  };
  const bodyOf = (o) => ({
    program: o.program || '', platform: o.platform || '', billable_party: o.billable_party || '', episode_break_date_text: o.episode_break_date_text || '',
    source: o.source || '', materials_count: o.materials_count === '' || o.materials_count == null ? null : Number(o.materials_count),
    destination_folder: canApprove ? (o.destination_folder || '') : '', remarks: '',
  });
  const createRecs = async (list, label) => {   // new records from { program, platform, … } objects; one undo step removes them again
    let ids = [];
    let failed = 0; let firstErr = '';
    for (const o of list) {
      try { const out = await post('/api/ingest', bodyOf(o)); ids.push(out.id); } catch (e) { failed++; if (!firstErr) firstErr = e.message; }
    }
    if (ids.length) {
      pushH({
        label,
        undo: async () => { if (ids.length) await post('/api/ingest/delete', { ids }); },
        redo: async () => { const again = []; for (const o of list) { try { again.push((await post('/api/ingest', bodyOf(o))).id); } catch (e) { /* skipped */ } } ids = again; },
      });
    }
    return { added: ids.length, failed, firstErr };
  };
  const saveDraft = async () => {
    if (!draft) return;
    if (!String(draft.program).trim() || !String(draft.platform).trim()) { toast('Program and Platform are required', 'err'); return; }
    const out = await createRecs([draft], 'add row');
    if (!out.added) { toast(out.firstErr || 'Could not add the row', 'err'); return; }
    setDraft(null); setEditing(null);
    toast('Ingest request added');
    load();
  };

  // ---- cells: apply a list of changes one cell at a time; one undo step covers them all ----
  const applyOps = async (ops, label, skipped = 0) => {
    const done = []; let failed = 0; let firstErr = '';
    for (const o of ops) {
      try { await patchCell(o.r.id, o.k, o.after); done.push(o); } catch (e) { failed++; if (!firstErr) firstErr = e.message; }
    }
    if (done.length) {
      pushH({
        label,
        undo: async () => { for (const o of done) await patchCell(o.r.id, o.k, o.before); },
        redo: async () => { for (const o of done) await patchCell(o.r.id, o.k, o.after); },
      });
    }
    const bits = [];
    if (done.length) bits.push(`${label.charAt(0).toUpperCase()}${label.slice(1)}: ${done.length} cell${done.length === 1 ? '' : 's'}`);
    else bits.push('Nothing changed');
    if (skipped) bits.push(`${skipped} cell${skipped === 1 ? '' : 's'} left as they are (read-only, locked or required)`);
    if (failed) bits.push(`${failed} failed — ${firstErr}`);
    toast(bits.join(' — '), failed || !done.length ? 'err' : undefined);
    return done.length;
  };
  const blockOps = (n, valueAt) => {   // valueAt(rowOffset, colOffset, key) → new text, or undefined to leave the cell
    const ops = []; let skipped = 0;
    for (let ri = n.r0; ri <= n.r1; ri++) {
      const r = rows[ri];
      if (!r) continue;
      for (let ci = n.c0; ci <= n.c1; ci++) {
        const k = COLS[ci];
        const raw = valueAt(ri - n.r0, ci - n.c0, k);
        if (raw === undefined) continue;
        if (!WRITE.has(k) || !may(r, k)) { skipped++; continue; }
        const after = cleanVal(k, raw);
        if (after === '' && REQUIRED.has(k)) { skipped++; continue; }
        const before = cellInitial(r, k);
        if (after !== before) ops.push({ r, k, before, after });
      }
    }
    return { ops, skipped };
  };
  const cellAt = (el) => { const td = el && el.closest ? el.closest('.wl-card td[data-c]') : null; return td ? { r: Number(td.dataset.r), c: Number(td.dataset.c) } : null; };
  const cellDown = (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (t.closest && t.closest('.rn, .chk, .editing, input, select, textarea, button, a')) return;
    const at = cellAt(t);
    if (!at) return;
    if (e.shiftKey && cellSel) { e.preventDefault(); setCellSel((cur) => (cur ? { ...cur, r1: at.r, c1: at.c } : cur)); suppress.current = true; setTimeout(() => { suppress.current = false; }, 150); return; }
    if (picked.size) clearPicks();
    setCellSel(null);
    cellDrag.current = { r: at.r, c: at.c, moved: false };
  };
  const copyCells = async () => {
    const n = normCells();
    if (!n) return false;
    const text = rows.slice(n.r0, n.r1 + 1).map((r) => COLS.slice(n.c0, n.c1 + 1).map((k) => tsvCell(textOf(r, k))).join('\t')).join('\n');
    internalClip.current = text;
    const ok = await writeClipboard(text);
    const cnt = (n.r1 - n.r0 + 1) * (n.c1 - n.c0 + 1);
    toast(ok ? `Copied ${cnt} cell${cnt === 1 ? '' : 's'}` : 'Could not reach the clipboard', ok ? undefined : 'err');
    return ok;
  };
  const clearCells = async () => { const n = normCells(); if (!n) return; const { ops, skipped } = blockOps(n, () => ''); await applyOps(ops, 'cells cleared', skipped); };
  const pasteCells = async (text) => {
    const n = normCells();
    if (!n) return;
    const block = parseTsv(text);
    if (!block.length) return;
    const single = block.length === 1 && block[0].length === 1;
    const big = { ...n };
    if (!single) { big.r1 = Math.min(rows.length - 1, n.r0 + block.length - 1); big.c1 = Math.min(COLS.length - 1, n.c0 + Math.max(...block.map((x) => x.length)) - 1); }
    const { ops, skipped } = blockOps(big, (ri, ci) => (single ? block[0][0] : (block[ri] && block[ri][ci] !== undefined ? block[ri][ci] : undefined)));
    await applyOps(ops, 'cells pasted', skipped);
  };

  // ---- rows: picked with the row numbers (click, Shift+click a range, Ctrl+click to add, drag down) ----
  const selectRange = (a, b) => setPicked(new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id)));
  const numDown = (e, r, idx) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (editing) setEditing(null);
    setCellSel(null);
    if (document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) document.activeElement.blur();
    if (e.ctrlKey || e.metaKey) {
      setPicked((cur) => { const n = new Set(cur); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; });
      lastPick.current = r.id;
      return;
    }
    if (e.shiftKey && lastPick.current != null) {
      const from = rows.findIndex((x) => x.id === lastPick.current);
      if (from >= 0) { selectRange(from, idx); return; }
    }
    setPicked(new Set([r.id]));
    lastPick.current = r.id;
    drag.current = { from: idx };
  };
  const rowMenu = (e, r) => {
    if (e.target.closest && e.target.closest('.cell-editor, input, select, textarea')) return;
    e.preventDefault();
    if (editing) setEditing(null);
    if (!picked.has(r.id)) { setPicked(new Set([r.id])); lastPick.current = r.id; setCellSel(null); }
    setCtx({ x: e.clientX, y: e.clientY });
  };
  const copyChosen = async () => {
    if (!chosen.length) return false;
    const text = chosen.map((r) => COLS.map((k) => tsvCell(textOf(r, k))).join('\t')).join('\n');
    internalClip.current = text;
    const ok = await writeClipboard(text);
    toast(ok ? `Copied ${chosen.length} row${chosen.length === 1 ? '' : 's'}` : 'Could not reach the clipboard', ok ? undefined : 'err');
    return ok;
  };
  // 'replace' (rows picked): the pasted rows overwrite the picked rows' cells (one row picked: it and the rows below it); 'new': each pasted row becomes a new request
  const pasteRows = async (text, how) => {
    if (!canWrite) return;
    const block = parseTsv(text).filter((cells) => cells.some((c) => String(c).trim() !== ''));
    if (!block.length) return;
    const mode = how || (chosen.length ? 'replace' : 'new');
    if (mode === 'replace') {
      let targets = chosen;
      if (chosen.length === 1) { const i = rows.findIndex((x) => x.id === chosen[0].id); targets = rows.slice(i, i + block.length); }
      const ops = []; let skipped = 0;
      targets.forEach((r, i) => {
        const cells = block[Math.min(i, block.length - 1)];
        cells.forEach((raw, ci) => {
          const k = COLS[ci];
          if (!k) return;
          if (!WRITE.has(k) || !may(r, k)) { skipped++; return; }
          const after = cleanVal(k, raw);
          if (after === '' && REQUIRED.has(k)) { skipped++; return; }
          const before = cellInitial(r, k);
          if (after !== before) ops.push({ r, k, before, after });
        });
      });
      await applyOps(ops, `paste (${targets.length} row${targets.length === 1 ? '' : 's'} replaced)`, skipped);
      clearPicks();
      return;
    }
    const recs = block.slice(0, 200).map((cells) => { const o = {}; cells.forEach((raw, ci) => { const k = COLS[ci]; if (k && WRITE.has(k)) o[k] = cleanVal(k, raw); }); return o; });
    const out = await createRecs(recs, `paste (${recs.length} new row${recs.length === 1 ? '' : 's'})`);
    toast(out.added ? `Pasted: ${out.added} new request${out.added === 1 ? '' : 's'}${out.failed ? ` — ${out.failed} not added (${out.firstErr})` : ''}` : (out.firstErr || 'Nothing was added'), out.failed || !out.added ? 'err' : undefined);
    clearPicks();
    load();
  };
  const menuPaste = async (how) => {
    setCtx(null);
    let text = null;
    try { if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) text = await navigator.clipboard.readText(); } catch (err) { text = null; }
    if (text == null || text === '') text = internalClip.current;   // plain-http addresses can't read the clipboard: use what was last copied here
    if (text == null || text === '') { toast('Nothing to paste yet — copy some rows first, or press Ctrl+V', 'err'); return; }
    pasteRows(text, how);
  };

  const setF = (k) => (e) => { setFilt((f) => ({ ...f, [k]: e.target.value })); setOffset(0); };
  const total = data ? data.total : 0;

  useFitBox(`${rows.length}|${!!data}|${picked.size ? 1 : 0}|${full}|${!!draft}`);
  const allOn = rows.length > 0 && rows.every((r) => picked.has(r.id));
  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const removePicked = async () => {
    const ids = [...picked];
    if (!(await confirm('Delete ingest records', `Permanently delete ${ids.length} selected record${ids.length === 1 ? '' : 's'}? Records with a CM decision are kept (only an Admin can delete DONE ones).`, { okText: 'Delete', danger: true }))) return;
    try {
      const r = await post('/api/ingest/delete', { ids });
      toast(`${r.deleted} deleted${r.kept ? `, ${r.kept} kept (CM decided)` : ''}`, r.deleted ? undefined : 'err');
      load();
    } catch (e) { toast(e.message, 'err'); }
  };

  const cutChosen = async () => { if (!canDelete) { toast('You do not have permission to delete ingest records', 'err'); return; } if (await copyChosen()) await removePicked(); };
  const deletePicked = () => { if (!canDelete) { toast('You do not have permission to delete ingest records', 'err'); return; } removePicked(); };

  // keyboard shortcuts, the same as the Workload Tracker's table (not while typing in a box, with a dialog open, or while a cell is being edited)
  const keysOk = (e) => {
    const el = e.target;
    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return false;
    return !(document.querySelector('.modal-backdrop') || form || detail || reasonFor || editing);
  };
  keysRef.current = (e) => {
    if (e.defaultPrevented || e.altKey || !keysOk(e)) return;
    const key = e.key.toLowerCase();
    if (cellSel && !picked.size) {   // a block of cells is picked
      if ((e.ctrlKey || e.metaKey) && key === 'c') { if (!(window.getSelection && String(window.getSelection()))) { e.preventDefault(); copyCells(); } return; }
      if ((e.ctrlKey || e.metaKey) && key === 'x') { if (canWrite) { e.preventDefault(); copyCells().then((ok) => { if (ok) clearCells(); }); } return; }
      if (!e.ctrlKey && !e.metaKey && (key === 'delete' || key === 'backspace')) { if (canWrite) { e.preventDefault(); clearCells(); } return; }
      if (!e.ctrlKey && !e.metaKey && key === 'escape') { setCellSel(null); return; }
    }
    if (e.ctrlKey || e.metaKey) {
      if (key === 'a') { e.preventDefault(); setPicked(new Set(rows.map((r) => r.id))); setCellSel(null); }
      else if (key === 'c') { if (picked.size && !(window.getSelection && String(window.getSelection()))) { e.preventDefault(); copyChosen(); } }
      else if (key === 'x') { if (picked.size) { e.preventDefault(); cutChosen(); } }
      else if (key === 'z') { if (canWrite) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); } }
      else if (key === 'y') { if (canWrite) { e.preventDefault(); redo(); } }
      return;   // Ctrl+V arrives as a paste event
    }
    if (key === 'escape') clearPicks();
    else if ((key === 'delete' || key === 'backspace') && picked.size) { e.preventDefault(); deletePicked(); }
    else if (['arrowdown', 'arrowup', 'home', 'end'].includes(key) && picked.size && rows.length) {
      e.preventDefault();
      const anchorIdx = Math.max(0, rows.findIndex((r) => r.id === lastPick.current));
      const sel = rows.map((r, i) => (picked.has(r.id) ? i : -1)).filter((i) => i >= 0);
      const cur = sel.length ? (sel[sel.length - 1] === anchorIdx ? sel[0] : sel[sel.length - 1]) : anchorIdx;
      const to = key === 'home' ? 0 : key === 'end' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, cur + (key === 'arrowdown' ? 1 : -1)));
      if (e.shiftKey) selectRange(anchorIdx, to); else { setPicked(new Set([rows[to].id])); lastPick.current = rows[to].id; }
      requestAnimationFrame(() => { const tr = document.querySelector(`.wl-card tr[data-id="${rows[to].id}"]`); if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest' }); });
    } else if ((key === 'enter' || key === 'f2') && picked.size === 1) {
      e.preventDefault();
      openDetail([...picked][0]);   // the details dialog
    }
  };
  pasteRef.current = (e) => {
    if (!canWrite || !keysOk(e)) return;
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!text || !text.trim()) return;
    e.preventDefault();
    if (cellSel && !picked.size) pasteCells(text); else pasteRows(text);
  };
  useEffect(() => {
    const key = (e) => { if (keysRef.current) keysRef.current(e); };
    const paste = (e) => { if (pasteRef.current) pasteRef.current(e); };
    const move = (e) => {
      const cd = cellDrag.current;
      if (cd) {
        if (!(e.buttons & 1)) { cellDrag.current = null; return; }
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const td = el && el.closest ? el.closest('.wl-card td[data-c]') : null;
        if (!td) return;
        const at = { r: Number(td.dataset.r), c: Number(td.dataset.c) };
        if (!cd.moved && (at.r !== cd.r || at.c !== cd.c)) { cd.moved = true; suppress.current = true; if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); setEditing(null); }
        if (cd.moved) { if (window.getSelection) window.getSelection().removeAllRanges(); setCellSel({ r0: cd.r, c0: cd.c, r1: at.r, c1: at.c }); }
        return;
      }
      const d = drag.current;
      if (!d) return;
      if (!(e.buttons & 1)) { drag.current = null; return; }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const tr = el && el.closest ? el.closest('.wl-card tr[data-id]') : null;
      if (!tr) return;
      const idx = tr.parentElement ? [...tr.parentElement.querySelectorAll('tr[data-id]')].indexOf(tr) : -1;
      if (idx >= 0 && rowsRef.current[idx]) setPicked(new Set(rowsRef.current.slice(Math.min(d.from, idx), Math.max(d.from, idx) + 1).map((x) => x.id)));
    };
    const up = () => { drag.current = null; if (cellDrag.current && cellDrag.current.moved) setTimeout(() => { suppress.current = false; }, 150); cellDrag.current = null; };
    const down = (e) => {   // a click outside the table (and its bar, menus and dialogs) drops the selection
      const t = e.target;
      if (t && t.closest && !t.closest('.wl-card .table-wrap, .xl-menu, .modal-backdrop, .tpop, #del-sel')) { clearPicksRef.current(); setCellSel(null); }
    };
    window.addEventListener('keydown', key); window.addEventListener('paste', paste); window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up); window.addEventListener('mousedown', down);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('paste', paste); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.removeEventListener('mousedown', down); };
  }, []);

  return (
    <main className="container wide wl-page">
      <h1 className="sr-only">Ingest Tracker</h1>

      <div className={`card wl-card${full ? ' full' : ''}`}>
        <div className="wl-tabbar one-row">
          <div className="wl-filters">
          <label className="wl-search short">
            <SearchIcon />
            <input type="search" placeholder="Search program, party, source, folder, remarks…" style={{ textOverflow: 'ellipsis' }} value={filt.q} onChange={setF('q')} />
          </label>
          <FiltersMenu count={[filt.status, filt.platform].filter(Boolean).length} onClear={() => { setFilt((f) => ({ ...f, status: '', platform: '' })); setOffset(0); }}>
            <FilterSelect label="Status" value={filt.status} onChange={setF('status')}><Options list={STATUS_FILTER} blank="All" /></FilterSelect>
            <FilterSelect label="Platform" value={filt.platform} onChange={setF('platform')}><Options list={lookups ? lookups.platform : []} blank="All" /></FilterSelect>
          </FiltersMenu>
          <DateRange title="Episode / Breakdate range" from={filt.from} to={filt.to} onChange={({ from, to }) => { setFilt((f) => ({ ...f, from, to })); setOffset(0); }} />
          {filt.approval ? (   // opened from the Dashboard's Pending Approval card: only requests nobody has approved yet; the chip clears it
            <button type="button" className="btn sm" title="Show every request again" onClick={() => { setFilt((f) => ({ ...f, approval: '' })); setOffset(0); }}>Awaiting approval ✕</button>
          ) : null}
          </div>
          <div className="wl-tabactions">
            {canWrite ? <button type="button" className="btn ibtn primary" id="new-btn" aria-label="New Ingest" title="New Ingest" onClick={() => setForm({})}><PlusIcon /></button> : null}
            <button type="button" className="btn ibtn" id="export-btn" aria-label="Export to Excel" title="Export to Excel" onClick={exportXlsx}><DownloadIcon /></button>
            {canDelete && picked.size ? <button type="button" className="btn ibtn danger" id="del-sel" onClick={removePicked} aria-label="Delete selected records" title={`Delete Selected (${picked.size})`}><TrashIcon /></button> : null}
            <button type="button" className="btn ibtn" id="full-btn" aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'} onClick={() => setFull((f) => !f)}>
              {full ? <ExitFullscreenIcon /> : <FullscreenIcon />}
            </button>
            {canWrite ? <ToolMenu items={[{ id: 'add-row-menu', label: 'Add Row', icon: <PlusIcon />, onClick: addDraft }]} /> : null}
          </div>
        </div>
        <div className={`table-wrap${narrow ? "" : " wl-fit"}`} id="tbl">
          {!data ? <Empty>Loading…</Empty>
            : data.error ? <Empty>{data.error}</Empty>
              : !data.rows.length && !draft ? <Empty>No ingest records match these filters.</Empty>
                : (
                  <table className={`t wl ing${narrow ? ' cards' : ''}`}>
                    <thead><tr>
                      {!narrow ? <th className="rn" title={allOn ? 'Click to unselect all' : 'Select every row on this page (Ctrl+A)'} onClick={() => (allOn ? clearPicks() : setPicked(new Set(rows.map((r) => r.id))))} /> : null}
                      {narrow && canDelete ? <th className="chk"><input type="checkbox" checked={allOn} onChange={() => setPicked(allOn ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all records on this page" /></th> : null}
                      <SortTh k="program" sort={sort} onSort={setSort}>PROG. NAME / PROJ. TITLE</SortTh>
                      <SortTh k="platform" sort={sort} onSort={setSort}>Platform</SortTh>
                      <SortTh k="billable_party" sort={sort} onSort={setSort}>Billable Party</SortTh>
                      <SortTh k="episode_break_date_text" sort={sort} onSort={setSort} className="tight">Episode / Breakdate</SortTh>
                      <SortTh k="source" sort={sort} onSort={setSort}>Source</SortTh>
                      <SortTh k="materials_count" sort={sort} onSort={setSort} className="narrow">No. of Materials</SortTh>
                      <SortTh k="requested_by" sort={sort} onSort={setSort}>Requested By</SortTh>
                      <SortTh k="destination_folder" sort={sort} onSort={setSort}>Destination Folder</SortTh>
                      <SortTh k="approved_by" sort={sort} onSort={setSort}>Approved By</SortTh>
                      <SortTh k="cm_status" sort={sort} onSort={setSort}>Status (CM)</SortTh>
                      <SortTh k="updated" sort={sort} onSort={setSort}>Updated</SortTh>
                    </tr></thead>
                    <tbody>
                      {draft ? (() => { const d = { ...draft, id: 'draft' }; return (
                        <tr key="draft" className="draft-row" data-draft="1">
                          {!narrow ? <td className="rn" title="New row — not saved yet">＋</td> : null}
                          {cell(d, 'program', <strong>{d.program}</strong>)}
                          {cell(d, 'platform', <PlatformCell value={d.platform} />)}
                          {cell(d, 'billable_party', d.billable_party)}
                          {cell(d, 'episode_break_date_text', d.episode_break_date_text ? <DateChip>{dayText(d.episode_break_date_text)}</DateChip> : '', { className: 'nowrap' })}
                          {cell(d, 'source', d.source, { className: 'cell-clip' })}
                          {cell(d, 'materials_count', d.materials_count, { className: 'num' })}
                          <td />
                          {cell(d, 'destination_folder', d.destination_folder, { className: 'cell-clip mono' })}
                          <td />
                          <td />
                          <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                            <button type="button" className="btn primary" style={{ padding: '4px 10px' }} id="draft-save" onClick={saveDraft}>Save</button>{' '}
                            <button type="button" className="btn" style={{ padding: '4px 10px' }} id="draft-discard" onClick={() => { setDraft(null); setEditing(null); }}>Discard</button>
                          </td>
                        </tr>
                      ); })() : null}
                      {data.rows.map((r0, i) => { const r = { ...r0, __i: i }; return (
                        <tr key={r.id} data-id={r.id} className={`clickable${picked.has(r.id) ? ' picked' : ''}`} onMouseDown={cellDown} onContextMenu={(e) => rowMenu(e, r)}
                          onClick={() => { if (suppress.current) { suppress.current = false; return; } openDetail(r.id); }}>
                          {!narrow ? <td className={`rn${picked.has(r.id) ? ' hl' : ''}`} onMouseDown={(e) => numDown(e, r, i)} onClick={(e) => e.stopPropagation()} title="Click to select the row (Shift-click a range, Ctrl-click to add, drag down)">{i + 1}</td> : null}
                          {narrow && canDelete ? <td className="chk" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.program}`} /></td> : null}
                          {cell(r, 'program', <strong>{r.program}</strong>)}
                          {cell(r, 'platform', <PlatformCell value={r.platform} />)}
                          {cell(r, 'billable_party', r.billable_party)}
                          {cell(r, 'episode_break_date_text', <DateChip>{dayText(r.episode_break_date_text || r.episode_date)}</DateChip>, { className: 'nowrap' })}
                          {cell(r, 'source', r.source, { className: 'cell-clip', title: r.source || '' })}
                          {cell(r, 'materials_count', r.materials_count != null ? r.materials_count : '', { className: 'num' })}
                          {cell(r, 'requested_by', r.requested_by_psd || r.requested_by_name || '', { title: 'Filled in automatically from the person who created the request' })}
                          {cell(r, 'destination_folder', r.destination_folder, { className: 'cell-clip mono', title: r.destination_folder || '' })}
                          {cell(r, 'approved_by', <ApprovedBy r={r} canApprove={canApprove} />)}
                          {cell(r, 'cm_status', <CmStatus r={r} />)}
                          <td data-k="updated" data-label="Updated" className="dim nowrap">{ago(r.updated_at)}</td>
                        </tr>
                      ); })}
                    </tbody>
                  </table>
                )}
        </div>
        {ctx ? (
          <CellMenu x={ctx.x} y={ctx.y} onContextMenu={(e) => e.preventDefault()}>
            {canWrite ? <><button type="button" disabled={!hist.current.past.length} onClick={() => { setCtx(null); undo(); }}>Undo<span>Ctrl+Z</span></button>
              <button type="button" disabled={!hist.current.future.length} onClick={() => { setCtx(null); redo(); }}>Redo<span>Ctrl+Y</span></button>
              <hr /></> : null}
            {canDelete ? <button type="button" disabled={!picked.size} onClick={() => { setCtx(null); cutChosen(); }}>Cut<span>Ctrl+X</span></button> : null}
            <button type="button" disabled={!picked.size} onClick={() => { setCtx(null); copyChosen(); }}>Copy<span>Ctrl+C</span></button>
            {canWrite ? <><button type="button" onClick={() => menuPaste()}>{picked.size ? 'Paste (replace row)' : 'Paste'}<span>Ctrl+V</span></button>
              <button type="button" onClick={() => menuPaste('new')}>Paste as new row</button></> : null}
            <hr />
            <button type="button" disabled={picked.size !== 1} onClick={() => { setCtx(null); openDetail([...picked][0]); }}>Open details<span>Enter</span></button>
            {canDelete ? <button type="button" disabled={!picked.size} onClick={() => { setCtx(null); deletePicked(); }}>Delete {picked.size > 1 ? `${picked.size} rows` : 'row'}<span>Del</span></button> : null}
          </CellMenu>
        ) : null}
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
  const initialEpisodeText = rec ? (RANGE.test(r.episode_break_date_text || '') ? r.episode_break_date_text : (isoDate(r.episode_break_date_text) || isoDate(r.episode_date))) : '';
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
    if (!f.program || !f.platform) { toast('PROG. NAME / PROJ. TITLE and Platform are required', 'err'); return; }
    const materialsCount = f.materials_count === '' ? null : Number(f.materials_count);
    if (materialsCount !== null && (!Number.isInteger(materialsCount) || materialsCount < 0)) {
      toast('Number of Materials must be a nonnegative integer', 'err');
      return;
    }
    const cmChanged = canCm && (f.cm_status !== initialForm.cm_status || (f.cm_status === 'NON-COMPLIANT' && f.cm_reason !== initialForm.cm_reason));
    if (cmChanged && f.cm_status === 'NON-COMPLIANT' && !f.cm_reason.trim()) { toast('Enter the reason it is NON-COMPLIANT', 'err'); return; }
    const { cm_status: _s, cm_reason: _r, ...rest } = f;
    const payload = { ...rest, materials_count: materialsCount };
    if (!rec) delete payload.remarks;   // Remarks are not part of the New Ingest form
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
        <label className="f"><span>PROG. NAME / PROJ. TITLE <span className="req">*</span></span>
          <input name="program" maxLength={200} value={f.program} onChange={set('program')} /></label>
        <label className="f"><span>Platform <span className="req">*</span></span>
          <select name="platform" value={f.platform} onChange={set('platform')}><Options list={withCurrent(lookups.platform, r.platform)} blank="Select platform…" /></select></label>
        <label className="f"><span>Billable Party</span><input name="billable_party" maxLength={200} value={f.billable_party} onChange={set('billable_party')} /></label>
        <label className="f"><span>Episode / Breakdate</span><DateRangeInput value={f.episode_break_date_text} onChange={(nv) => set('episode_break_date_text')({ target: { value: nv } })} /></label>
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
        {rec ? <label className="f full"><span>Remarks</span><textarea name="remarks" maxLength={4000} value={f.remarks} onChange={set('remarks')} /></label> : null}
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
        <KV k="PROG. NAME / PROJ. TITLE">{r.program}</KV>
        <KV k="Platform">{r.platform}</KV>
        <KV k="Billable Party">{r.billable_party}</KV>
        <KV k="Episode / Breakdate">{dayText(r.episode_break_date_text || r.episode_date)}</KV>
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
