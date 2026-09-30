import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, patch, post, put } from '../lib/api.js';
import { fmtBreakdate, fmtDate, isoDate } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { CloseIcon, ColumnIcon, DownloadIcon, LockIcon, PlusIcon, SearchIcon, UploadIcon } from '../components/Icons.jsx';
import { DateChip, DateRange, FilterSelect, PlatformCell, Pager, RowMenu, TypePill, UnitsPills, WorkDate } from '../components/wl.jsx';
import { Empty, Modal, Options, useConfirm, useDebounced, useForm, useToast } from '../components/ui.jsx';

// Workload Tracker — ONE table. "Units Concerned" says which team(s) a plug is for; the tabs
// (All / VGFX / VEDIT / Audio) are filters over it. Fields, per-tab columns and the Platform rules come
// from /api/workload/meta (field types follow the red notes in the Sept 2026 template:
// dropdown / Date / Open). Table mode = read + add/edit form; Excel mode = editable grid with batch save.
const PAGE = 50;
const GRID_LIMIT = 200;
const CARDS_BELOW = 900;   // window width under which table rows become cards
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isLocked = (workDate, locks) => !!workDate && (locks || []).some((l) => workDate >= l.from_date && workDate <= l.to_date);
const lockNote = (workDate, locks) => { const hit = (locks || []).find((l) => workDate >= l.from_date && workDate <= l.to_date); return hit ? (hit.note || `${hit.from_date} – ${hit.to_date}`) : ''; };
const withCurrent = (list, v) => (v && !list.includes(v) ? [...list, v] : list);
const firstLine = (s) => String(s || '').split('\n')[0];
const newKey = () => `n${Math.random().toString(36).slice(2)}`;

/** Platform suggested by the Plug ID prefix (same rules as the template's Platform formula). null = none. */
function derivePlatform(rules, plug) {
  const text = String(plug || '');
  for (const r of rules) if (new RegExp(r.pattern, 'i').test(text)) return r.platform;
  return null;
}
/** Changing the Plug ID re-fills Platform only if it was empty or still holds the previous automatic value. */
function withAutoPlatform(rules, row, k, val) {
  const next = { ...row, [k]: val };
  if (k !== 'plug_id') return next;
  const before = derivePlatform(rules, row.plug_id);
  if (!row.platform || row.platform === before) next.platform = derivePlatform(rules, val) || '';
  return next;
}

// Audio Guide: dropdown "N/A" or "Date" (then pick the date). Stored as 'N/A' or YYYY-MM-DD.
function AudioGuideInput({ value, onChange, disabled }) {
  const v = value || '';
  const isDate = ISO.test(v);
  const legacy = v && !isDate && v !== 'N/A';
  const mode = isDate ? 'DATE' : v;
  const emit = (x) => onChange({ target: { value: x } });
  return (
    <div className="ag">
      <select value={mode} disabled={disabled} onChange={(e) => emit(e.target.value === 'DATE' ? isoDate() : e.target.value)}>
        <option value="">—</option>
        <option value="N/A">N/A</option>
        <option value="DATE">Date</option>
        {legacy ? <option value={v}>{firstLine(v)} (old)</option> : null}
      </select>
      {isDate ? <input type="date" value={v} disabled={disabled} onChange={(e) => emit(e.target.value)} /> : null}
    </div>
  );
}

// Textarea that grows to fit its content (used in the Excel grid so pasted text is never cut off)
function AutoTextarea({ value, ...props }) {
  const ref = useRef(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight + 2, 32)}px`;
  }, []);
  useLayoutEffect(fit, [fit, value]);
  useEffect(() => { window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit); }, [fit]);
  return <textarea ref={ref} value={value} {...props} />;
}

function FieldInput({ def, value, onChange, disabled, lookups, auto }) {
  const v = value ?? '';
  // date and time picked together (the browser's own calendar + time picker); 15-minute steps
  if (def.kind === 'datetime') return <input type="datetime-local" step={900} value={v} disabled={disabled} onChange={onChange} />;
  if (def.kind === 'audio_guide') return <AudioGuideInput value={v} onChange={onChange} disabled={disabled} />;
  if (def.kind === 'date') return <input type="date" value={v} disabled={disabled} onChange={onChange} />;
  if (def.kind === 'select') {
    const list = def.lookup ? withCurrent(lookups[def.lookup] || [], v) : def.options;
    return <select value={v} disabled={disabled} onChange={onChange}><Options list={list} blank={def.required ? 'Select…' : '—'} /></select>;
  }
  if (def.multiline && auto) return <AutoTextarea maxLength={def.max} placeholder={def.hint} value={v} disabled={disabled} onChange={onChange} />;
  if (def.multiline) return <textarea maxLength={def.max} placeholder={def.hint} value={v} disabled={disabled} onChange={onChange} />;
  return <input maxLength={def.max} placeholder={def.hint} value={v} disabled={disabled} onChange={onChange} />;
}

// Excel mode only: every cell is plain text you can type OR paste into — no date picker, no dropdown — closer
// to how an actual spreadsheet cell behaves. Validation (a real date, a valid Platform, etc.) still happens
// when you hit Save, same as any other grid error. `onKeyDown`/`onFocus` are wired in by the grid for range
// selection and copy/paste; they pass straight through.
function GridCellInput({ def, value, onChange, disabled, ...rest }) {
  const v = value ?? '';
  if (def.multiline) return <AutoTextarea maxLength={def.max} placeholder={def.hint} value={v} disabled={disabled} onChange={onChange} {...rest} />;
  return <input maxLength={def.max} placeholder={def.hint} value={v} disabled={disabled} onChange={onChange} {...rest} />;
}

// One table cell turned into its own editor. Enter or clicking away saves, Esc cancels; dropdowns save as soon as you pick.
// A failed save (e.g. an invalid value) keeps the editor open with the message shown.
function CellEditor({ def, initial, lookups, onSave, onCancel }) {
  const [val, setVal] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const finished = useRef(false);
  const field = () => box.current && box.current.querySelector('input, select, textarea');
  useEffect(() => {
    const el = field();
    if (!el) return;
    el.focus();
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) el.setSelectionRange(el.value.length, el.value.length);
    // dropdowns open straight away; date fields open focused (the browser's own picker would swallow Enter while it is open)
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
  const change = (e) => {
    const nv = e.target.value;
    setVal(nv);
    if (def.kind === 'select') save(nv);
  };
  const blur = (e) => { if (box.current && !box.current.contains(e.relatedTarget)) save(val); };
  const key = (e) => {
    if (e.key === 'Escape') { finished.current = true; onCancel(); return; }
    const tag = e.target.tagName;
    if (e.key === 'Enter' && tag !== 'SELECT' && (tag !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) { e.preventDefault(); save(val); }
  };
  return (
    <div className={`cell-editor${busy ? ' busy' : ''}`} ref={box} onBlur={blur} onKeyDown={key}>
      <FieldInput auto def={def} value={val} lookups={lookups} disabled={busy} onChange={change} />
    </div>
  );
}

export default function Workload() {
  const s = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const canWrite = s.can('workload.write');

  const [meta, setMeta] = useState(null);
  const [lookups, setLookups] = useState({ workload_platform: [], plug_type: [] });
  const [tab, setTab] = useState('ALL');
  const [mode, setMode] = useState('table');
  const [filt, setFilt] = useState({ q: '', units: '', platform: '', plug_type: '', from: '', to: '' });
  const [stats, setStats] = useState(null);   // summary cards + tab badges
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);   // table mode: { total, rows } | { error }
  const [grid, setGrid] = useState(null);   // excel mode: { total, rows } | { error }
  const [gridSel, setGridSel] = useState(null);   // { r0, c0, r1, c1 } — row/col INDICES into (grid.rows, cols); null = nothing selected
  const [form, setForm] = useState(null);   // null | { rec } (rec null = new)
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);   // { id, k } while one table cell is open for editing
  const [addingColumn, setAddingColumn] = useState(false);
  const [managingLocks, setManagingLocks] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => { setEditing(null); setGridSel(null); }, [tab, mode, offset]);
  const q = useDebounced(filt.q, 300);
  const isGrid = mode === 'excel' && tab !== 'ALL';

  // Rows are one line each (Remarks wraps), so a wide table scrolls sideways inside the card, like Excel.
  // Phones and small tablets show each row as a card instead.
  const [winW, setWinW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWinW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const cards = mode === 'table' && winW < CARDS_BELOW;

  const loadMeta = useCallback(() => {
    Promise.all([get('/api/workload/meta'), get('/api/dropdowns?categories=workload_platform,plug_type')])
      .then(([m, dd]) => { setMeta(m); setLookups(dd); })
      .catch((e) => toast(e.message, 'err'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(loadMeta, []); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useCallback((extra = {}) => {
    const p = new URLSearchParams(extra);
    if (tab !== 'ALL') p.set('team', tab);
    ['units', 'platform', 'plug_type', 'from', 'to'].forEach((k) => { if (filt[k]) p.set(k, filt[k]); });
    if (!isGrid && q) p.set('q', q);
    return p;
  }, [tab, filt.units, filt.platform, filt.plug_type, filt.from, filt.to, q, isGrid]);

  // Tab badges (the counts next to All / VGFX / VEDIT / Audio) follow every filter except the team tab
  const loadStats = useCallback(async () => {
    if (!meta) return;
    const p = query();
    p.delete('team');
    p.set('today', isoDate());
    try { setStats(await get(`/api/workload/stats?${p}`)); } catch (e) { /* cards just stay as they were */ }
  }, [meta, query]);

  const load = useCallback(async () => {
    if (!meta) return;
    loadStats();
    try {
      if (isGrid) {
        const d = await get(`/api/workload?${query({ limit: GRID_LIMIT })}`);
        setGrid({ total: d.total, rows: d.rows.map((r) => ({ ...r, _key: `r${r.id}`, _dirty: false })) });
      } else {
        setData(await get(`/api/workload?${query({ limit: PAGE, offset })}`));
      }
    } catch (e) {
      (isGrid ? setGrid : setData)({ error: e.message, rows: [], total: 0 });
    }
  }, [meta, isGrid, query, offset, loadStats]);

  useEffect(() => { load(); }, [load]);

  // ---- unsaved-change protection (Excel mode) ----
  const dirtyCount = isGrid && grid && grid.rows ? grid.rows.filter((r) => r._dirty).length : 0;
  useEffect(() => {
    if (!dirtyCount) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyCount]);
  const okToLeave = async () => dirtyCount === 0
    || !!(await confirm('Discard unsaved changes?', `${dirtyCount} row(s) in the grid have unsaved changes. Leave without saving?`, { okText: 'Discard', danger: true }));

  const changeTab = async (t) => { if (t === tab || !(await okToLeave())) return; setTab(t); setOffset(0); };
  const changeMode = async (m) => { if (m === mode || !(await okToLeave())) return; setMode(m); setOffset(0); };
  const setF = (k) => async (e) => {
    const val = e.target.value;
    if (k !== 'q' && !(await okToLeave())) return;
    setFilt((f) => ({ ...f, [k]: val }));
    setOffset(0);
  };

  const setRange = async ({ from, to }) => {
    if (!(await okToLeave())) return;
    setFilt((f) => ({ ...f, from, to }));
    setOffset(0);
  };

  // ---- click-to-edit: save ONE cell (PATCH writes only that column, so other people's edits to the row are kept) ----
  const saveCell = async (r, k, value) => {
    if (String(value ?? '') === String(r[k] ?? '')) { setEditing((cur) => (cur && cur.id === r.id && cur.k === k ? null : cur)); return; }
    try {
      const out = await patch(`/api/workload/${r.id}`, { field: k, value });
      setData((d) => (d && d.rows ? { ...d, rows: d.rows.map((x) => (x.id === r.id ? { ...x, ...out.values } : x)) } : d));
      // close only THIS cell's editor: the person may already have opened another cell while this one was saving
      setEditing((cur) => (cur && cur.id === r.id && cur.k === k ? null : cur));
      if (['work_date', 'units_concerned', 'platform', 'plug_type'].includes(k)) load();   // may change the row's place, filters or the counts
    } catch (e) { toast(e.message, 'err'); throw e; }
  };

  // ---- Excel export (sheets mirror the template: MAIN + AUDIO, or just the open team tab) ----
  const exportXlsx = async () => {
    try {
      const res = await fetch(`/api/workload/export?${query()}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'PromoHub' } });
      if (!res.ok) {
        let msg = `Export failed (${res.status})`;
        try { msg = (await res.json()).error || msg; } catch (e) { /* not JSON */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const now = new Date();
      a.download = `Workload_${tab}_${MONTH_ABBR[now.getMonth()]}_${now.getFullYear()}.xlsx`;   // tab is already 'ALL' or a team key like 'VGFX', both already upper case
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    } catch (e) { toast(e.message, 'err'); }
  };

  // ---- Import: reads a .xlsx shaped like this page's own Export (MAIN/AUDIO sheets, matching headers) ----
  const importFile = async (file) => {
    if (!file) return;
    const form2 = new FormData();
    form2.append('file', file);
    setImporting(true);
    try {
      const out = await post('/api/workload/import', form2);
      const bits = [`${out.created} row${out.created === 1 ? '' : 's'} imported`];
      if (out.skipped) bits.push(`${out.skipped} skipped`);
      if (out.newColumns && out.newColumns.length) bits.push(`new column${out.newColumns.length === 1 ? '' : 's'}: ${out.newColumns.join(', ')}`);
      toast(bits.join(' — '), out.skipped ? 'err' : undefined);
      if (out.errors && out.errors.length) console.warn('Import errors:', out.errors);
      if (out.newColumns && out.newColumns.length) loadMeta();
      load();
    } catch (e) { toast(e.message, 'err'); } finally { setImporting(false); if (fileRef.current) fileRef.current.value = ''; }
  };


  const setCell = (key, k, val) => setGrid((g) => ({
    ...g, rows: g.rows.map((r) => (r._key === key ? { ...withAutoPlatform(meta.platformRules, r, k, val), _dirty: true } : r)),
  }));

  // ---- Excel mode: click-and-shift-click cell range selection, plus Excel-style copy/paste across it ----
  // (Excel mode only — Table mode's click-to-edit and the New/Edit form keep their pickers/dropdowns.)
  const gridClickCell = (r, c, e) => { setGridSel((s) => (e.shiftKey && s ? { ...s, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c })); };
  // Real spreadsheets quote a cell's text (wrapping in "…", doubling any internal ") when it contains a tab or a
  // newline, so a multi-line cell (Remarks, VO, ...) survives being copied as part of a larger range. Match that.
  const tsvCell = (v) => { const s = String(v ?? ''); return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const parseTsvBlock = (text) => {
    const rows = []; let row = []; let field = ''; let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === '\t') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* normalize CRLF: skip, \n below ends the row */ }
      else field += c;
    }
    row.push(field); rows.push(row);
    if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();   // trailing blank line
    return rows;
  };
  const inGridSel = (r, c) => {
    if (!gridSel) return false;
    const { r0, c0, r1, c1 } = gridSel;
    return r >= Math.min(r0, r1) && r <= Math.max(r0, r1) && c >= Math.min(c0, c1) && c <= Math.max(c0, c1);
  };
  const gridCopy = (cols) => (e) => {
    if (!gridSel || (gridSel.r0 === gridSel.r1 && gridSel.c0 === gridSel.c1)) return;   // one cell: let the browser copy the selected text normally
    const { r0, c0, r1, c1 } = gridSel;
    const [rLo, rHi] = [Math.min(r0, r1), Math.max(r0, r1)];
    const [cLo, cHi] = [Math.min(c0, c1), Math.max(c0, c1)];
    const tsv = [];
    for (let r = rLo; r <= rHi; r++) {
      const row = grid.rows[r];
      tsv.push(cols.slice(cLo, cHi + 1).map((k) => tsvCell(row && row[k])).join('\t'));
    }
    e.clipboardData.setData('text/plain', tsv.join('\n'));
    e.preventDefault();
  };
  const gridPaste = (cols) => (e) => {
    const block = parseTsvBlock(e.clipboardData.getData('text/plain'));
    if (block.length === 1 && block[0].length === 1) return;   // a single value: let it paste into the focused cell normally
    e.preventDefault();
    const r0 = gridSel ? Math.min(gridSel.r0, gridSel.r1) : 0;
    const c0 = gridSel ? Math.min(gridSel.c0, gridSel.c1) : 0;
    setGrid((g) => {
      const rows = g.rows.map((row, ri) => {
        const bi = ri - r0;
        if (bi < 0 || bi >= block.length) return row;
        let changed = row;
        block[bi].forEach((val, ci) => {
          const col = cols[c0 + ci];
          if (col) changed = withAutoPlatform(meta.platformRules, changed, col, val);
        });
        return { ...changed, _dirty: true };
      });
      return { ...g, rows };
    });
    setGridSel({ r0, c0, r1: Math.min(r0 + block.length - 1, grid.rows.length - 1), c1: Math.min(c0 + (block[0] || []).length - 1, cols.length - 1) });
  };
  const isEmptyRow = (r) => meta.views[tab].filter((k) => k !== 'work_date' && k !== 'units_concerned').every((k) => !String(r[k] ?? '').trim());
  const addRow = () => setGrid((g) => {
    const last = g.rows.length ? g.rows[g.rows.length - 1].work_date : '';
    return { ...g, rows: [...g.rows, { _key: newKey(), _new: true, _dirty: false, work_date: last || filt.from || isoDate(), units_concerned: filt.units || meta.tabDefaultUnits[tab] }] };
  });
  const removeRow = async (r) => {
    if (!r._new) {
      if (!(await confirm('Delete row', `Permanently delete "${firstLine(r.plug_id)}"?`, { okText: 'Delete', danger: true }))) return;
      try { await del(`/api/workload/${r.id}`); toast('Deleted'); } catch (e) { toast(e.message, 'err'); return; }
    }
    setGrid((g) => ({ ...g, rows: g.rows.filter((x) => x._key !== r._key), total: r._new ? g.total : g.total - 1 }));
    setGridSel(null);   // row indices shift after a removal; avoid a stale selection pointing at the wrong row
    if (!r._new) loadStats();
  };
  // ---- table-mode delete (per row) ----
  const deleteItem = async (r) => {
    const what = `${firstLine(r.plug_id)}${r.work_date ? ` (${fmtDate(r.work_date)})` : ''}`;
    if (!(await confirm('Delete workload item', `Permanently delete "${what}"? This cannot be undone.`, { okText: 'Delete', danger: true }))) return;
    try {
      await del(`/api/workload/${r.id}`);
      toast('Deleted');
      if (data && data.rows.length === 1 && offset > 0) setOffset(Math.max(0, offset - PAGE)); // last row on this page
      else load();
    } catch (e) { toast(e.message, 'err'); }
  };
  const saveGrid = async () => {
    const idx = [];
    const rows = [];
    grid.rows.forEach((r, i) => {
      if (!r._dirty || (r._new && isEmptyRow(r))) return;
      const { _key, _dirty, _new, ...rest } = r; // eslint-disable-line no-unused-vars
      idx.push(i);
      rows.push(rest);
    });
    if (!rows.length) { toast('Nothing to save'); return; }
    setSaving(true);
    try {
      const out = await post('/api/workload/batch', { rows });
      toast(`Saved — ${out.created} added, ${out.updated} updated`);
      await load();
    } catch (e) {
      // Server numbers rows within the changed set; show the grid row number instead
      toast(String(e.message).replace(/^Row (\d+):/, (_, n) => `Grid row ${idx[+n - 1] + 1}:`), 'err');
    } finally { setSaving(false); }
  };

  if (!meta) return <main className="container wide"><Empty>Loading…</Empty></main>;

  const isAll = tab === 'ALL';
  const cols = meta.views[tab];   // raw column list: used as-is for Excel mode (one value per cell, so VGFX/VEDIT stay separate there)
  // Table mode only: Breakdate/Time (VGFX) and (VEDIT) merge into ONE column/cell, holding one or two pills —
  // 'breakdate_vgfx' is kept as that column's position; breakdateCell() below decides what actually shows in it.
  const tableCols = cols.filter((k) => k !== 'breakdate_vedit');
  const total = data && data.total ? data.total : 0;
  const head = (k) => (k === 'breakdate_vgfx' ? 'Breakdate / Time' : meta.fields[k].label);   // table header only; Excel mode reads meta.fields directly and keeps the (VGFX)/(VEDIT) labels
  const firstLineOf = (t) => String(t || '').split('\n');
  // every cell except Remarks stays on one line: line breaks in pasted text are shown as " · "
  const oneLine = (t) => String(t ?? '').replace(/\s*\n+\s*/g, ' · ');

  // Cells wrap (pasted line breaks kept) instead of being cut off; data-label feeds the card layout.
  const cellView = (r, k) => {
    const val = r[k];
    const common = { key: k, 'data-k': k, 'data-label': head(k) };
    switch (k) {
      case 'work_date': return <td {...common}><WorkDate value={val} /></td>;
      case 'platform': return <td {...common}><PlatformCell value={val} /></td>;
      case 'units_concerned': return <td {...common}><UnitsPills value={val} unitTeams={meta.unitTeams} /></td>;
      case 'plug_type': return <td {...common}><TypePill value={val} /></td>;
      case 'plug_id': {
        const [first, ...rest] = firstLineOf(val);
        return (
          <td {...common}>
            <span className="strong">{first}</span>
            {rest.length ? <span className="dim-inline"> · {rest.join(' · ')}</span> : null}
          </td>
        );
      }
      case 'prog_name':
        return (
          <td {...common}>
            {val ? <span className="strong">{oneLine(val)}</span> : null}
          </td>
        );
      case 'audio_guide': return <td {...common}><DateChip hue="fuchsia">{val ? (ISO.test(val) ? fmtDate(val) : oneLine(val)) : null}</DateChip></td>;
      case 'breakdate_vgfx': return <td {...common}><DateChip hue="purple">{fmtBreakdate(val)}</DateChip></td>;   // same colour as VGFX in Units Concerned
      case 'breakdate_vedit': return <td {...common}><DateChip hue="orange">{fmtBreakdate(val)}</DateChip></td>;   // same colour as VEDIT in Units Concerned
      case 'remarks': return <td {...common}>{val ? <div className="rem">{val}</div> : null}</td>;
      default:
        return <td {...common}>{meta.fields[k].kind === 'date' ? <DateChip>{fmtDate(val)}</DateChip> : oneLine(val)}</td>;
    }
  };

  // Managers click a cell to edit just that cell (nothing else opens); viewers just read.
  const rowLocked = (r) => !meta.canOverrideLocks && isLocked(r.work_date, meta.locks);
  const cell = (r, k) => {
    const td = cellView(r, k);
    if (!canWrite) return td;
    if (rowLocked(r)) return cloneElement(td, { title: `Locked: ${lockNote(r.work_date, meta.locks)}` });
    if (editing && editing.id === r.id && editing.k === k) {
      return (
        <td key={k} data-k={k} data-label={head(k)} className="editing" onClick={(e) => e.stopPropagation()}>
          <CellEditor def={meta.fields[k]} initial={r[k]} lookups={lookups} onSave={(value) => saveCell(r, k, value)} onCancel={() => setEditing(null)} />
        </td>
      );
    }
    const open = () => setEditing({ id: r.id, k });
    return cloneElement(td, {
      className: 'editable', title: 'Click to edit', tabIndex: 0,
      onClick: (e) => { e.stopPropagation(); open(); },
      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } },
    });
  };

  // The merged Breakdate/Time column/cell: one or two pills (VGFX purple, VEDIT orange) depending on which
  // team(s) the row involves. Each pill is its own click target, editing only that underlying field — the
  // outer cell isn't one clickable unit the way every other column is, since it can hold two values at once.
  const breakdateCell = (r) => {
    const teams = meta.unitTeams[r.units_concerned] || [];
    const parts = [];
    if (teams.includes('VGFX')) parts.push({ k: 'breakdate_vgfx', hue: 'purple' });
    if (teams.includes('VEDIT')) parts.push({ k: 'breakdate_vedit', hue: 'orange' });
    const locked = canWrite && rowLocked(r);
    return (
      <td key="breakdate_vgfx" data-k="breakdate_vgfx" title={locked ? `Locked: ${lockNote(r.work_date, meta.locks)}` : undefined}>
        <span className="chips">
          {parts.map(({ k, hue }) => {
            if (editing && editing.id === r.id && editing.k === k) {
              return (
                <span key={k} className="cell-editor-inline" onClick={(e) => e.stopPropagation()}>
                  <CellEditor def={meta.fields[k]} initial={r[k]} lookups={lookups} onSave={(value) => saveCell(r, k, value)} onCancel={() => setEditing(null)} />
                </span>
              );
            }
            const clickable = canWrite && !locked;
            return (
              <span
                key={k} className={clickable ? 'wl-pill-edit' : ''} tabIndex={clickable ? 0 : undefined} title={clickable ? 'Click to edit' : undefined}
                onClick={clickable ? (e) => { e.stopPropagation(); setEditing({ id: r.id, k }); } : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === 'Enter') { e.preventDefault(); setEditing({ id: r.id, k }); } } : undefined}
              >
                <DateChip hue={hue}>{fmtBreakdate(r[k])}</DateChip>
              </span>
            );
          })}
        </span>
      </td>
    );
  };

  const tabCount = { ALL: stats && stats.total, VGFX: stats && stats.vgfx, VEDIT: stats && stats.vedit, AUDIO: stats && stats.audio };

  return (
    <main className="container wide wl-page">
      <div className="page-head">
        <div><h1>Workload Tracker</h1><div className="sub">Track and monitor promotional plug workloads across VGFX, VEDIT and Audio.</div></div>
      </div>

      {!lookups.workload_platform.length || !lookups.plug_type.length ? (
        <div className="alert warn mb-12">
          {!lookups.workload_platform.length ? 'No Workload Platform options exist yet. ' : ''}
          {!lookups.plug_type.length ? 'No Plug Type options exist yet. ' : ''}
          {s.canPage('/admin') ? <>Add them in <Link to="/admin#dropdowns">Admin → Dropdowns</Link>.</> : 'Ask an Admin to add them.'}
        </div>
      ) : null}

      <div className="card wl-card">
        <div className="wl-tabbar">
          <div className="tabs" id="section-tabs">
            {meta.tabs.map((t) => (
              <button key={t.key} type="button" className={tab === t.key ? 'on' : ''} onClick={() => changeTab(t.key)}>
                {t.label}<span className="count">{tabCount[t.key] ?? '–'}</span>
              </button>
            ))}
          </div>
          <div className="wl-tabactions">
            <div className="segmented" id="mode-seg">
              <button type="button" className={mode === 'table' ? 'on' : ''} onClick={() => changeMode('table')}>Table</button>
              <button type="button" className={mode === 'excel' ? 'on' : ''} onClick={() => changeMode('excel')}>Excel</button>
            </div>
            <button type="button" className="btn" id="export-btn" onClick={exportXlsx}><DownloadIcon /> Export</button>
            {canWrite ? (
              <>
                <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => importFile(e.target.files[0])} />
                <button type="button" className="btn" id="import-btn" disabled={importing} onClick={() => fileRef.current.click()}>
                  <UploadIcon /> {importing ? 'Importing…' : 'Import'}
                </button>
              </>
            ) : null}
            {s.canPage('/admin') ? (
              <>
                <button type="button" className="btn" id="add-column-btn" onClick={() => setAddingColumn(true)}><ColumnIcon /> Add Column</button>
                <button type="button" className="btn" id="lock-dates-btn" onClick={() => setManagingLocks(true)}><LockIcon /> Lock Dates</button>
              </>
            ) : null}
            {canWrite && !isGrid ? (
              <button type="button" className="btn primary" id="new-btn" onClick={() => setForm({ rec: null })}><PlusIcon /> New Workload</button>
            ) : null}
            {canWrite && isGrid ? (
              <>
                <button type="button" className="btn" id="add-row" onClick={addRow}><PlusIcon /> Add row</button>
                <button type="button" className="btn primary" id="save-grid" disabled={saving || !dirtyCount} onClick={saveGrid}>
                  {saving ? 'Saving…' : `Save changes${dirtyCount ? ` (${dirtyCount})` : ''}`}
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="wl-filters">
          {!isGrid ? (
            <label className="wl-search">
              <SearchIcon />
              <input type="search" placeholder="Search plug ID, PSD, program, billable party, remarks…" value={filt.q} onChange={setF('q')} />
            </label>
          ) : null}
          <FilterSelect label="Units" value={filt.units} onChange={setF('units')}><Options list={meta.units} blank="All" /></FilterSelect>
          <FilterSelect label="Platform" value={filt.platform} onChange={setF('platform')}><Options list={lookups.workload_platform} blank="All" /></FilterSelect>
          <FilterSelect label="Plug Type" value={filt.plug_type} onChange={setF('plug_type')}><Options list={lookups.plug_type} blank="All" /></FilterSelect>
          <DateRange from={filt.from} to={filt.to} onChange={setRange} />
        </div>

        {mode === 'excel' && tab === 'ALL' ? (
          <Empty>Pick VGFX, VEDIT or Audio above to edit in the Excel grid — each shows its own columns.</Empty>
        ) : isGrid ? (
          <>
            <div className="table-wrap" id="grid">
              {!grid ? <Empty>Loading…</Empty>
                : grid.error ? <Empty>{grid.error}</Empty>
                  : (
                    <table className="t xl" onCopy={gridCopy(cols)} onPaste={gridPaste(cols)}>
                      <thead><tr>{cols.map((k) => <th key={k}>{meta.fields[k].label}</th>)}{canWrite ? <th /> : null}</tr></thead>
                      <tbody>
                        {grid.rows.length ? grid.rows.map((r, ri) => (
                          <tr key={r._key} className={r._dirty ? 'dirty' : ''}>
                            {cols.map((k, ci) => (
                              <td key={k} data-k={k} className={inGridSel(ri, ci) ? 'xl-sel' : ''}>
                                <GridCellInput
                                  def={meta.fields[k]} value={r[k]} disabled={!canWrite}
                                  onChange={(e) => setCell(r._key, k, e.target.value)}
                                  onMouseDown={(e) => gridClickCell(ri, ci, e)}
                                />
                              </td>
                            ))}
                            {canWrite ? <td className="right nowrap"><button type="button" className="btn sm ghost" onClick={() => removeRow(r)}>{r._new ? 'Remove' : 'Delete'}</button></td> : null}
                          </tr>
                        )) : <tr><td colSpan={cols.length + 1} className="empty">No {meta.tabs.find((t) => t.key === tab).label} rows match these filters.{canWrite ? ' Use “Add row” to start.' : ''}</td></tr>}
                      </tbody>
                    </table>
                  )}
            </div>
            {grid && grid.total > GRID_LIMIT ? (
              <div className="pager"><span>Showing the first {GRID_LIMIT} of {grid.total} rows — narrow the date range to edit the rest.</span></div>
            ) : null}
          </>
        ) : (
          <>
            <div className="table-wrap" id="tbl">
              {!data ? <Empty>Loading…</Empty>
                : data.error ? <Empty>{data.error}</Empty>
                  : !data.rows.length ? <Empty>No workload items match these filters.</Empty>
                    : (
                      <table className={`t wl${cards ? ' cards' : ''}`}>
                        <thead><tr>{tableCols.map((k) => <th key={k}>{head(k)}</th>)}{canWrite ? <th className="right">Actions</th> : null}</tr></thead>
                        <tbody>
                          {data.rows.map((r) => (
                            <tr key={r.id} className={canWrite ? '' : 'clickable'} onClick={canWrite ? undefined : () => setForm({ rec: r })}>
                              {tableCols.map((k) => (k === 'breakdate_vgfx' ? breakdateCell(r) : cell(r, k)))}
                              {canWrite ? (
                                <td className="right nowrap actions-cell" onClick={(e) => e.stopPropagation()}>
                                  <RowMenu
                                  onEdit={() => (rowLocked(r) ? toast(`Locked: ${lockNote(r.work_date, meta.locks)}. Ask an Admin.`, 'err') : setForm({ rec: r }))}
                                  onDuplicate={() => setForm({ rec: null, duplicateFrom: r })}
                                  onDelete={() => (rowLocked(r) ? toast(`Locked: ${lockNote(r.work_date, meta.locks)}. Ask an Admin.`, 'err') : deleteItem(r))}
                                />
                                </td>
                              ) : null}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
            </div>
            <Pager total={total} offset={offset} size={PAGE} onOffset={setOffset} />
          </>
        )}
      </div>

      {form ? (
        <WorkloadForm
          rec={form.rec}
          duplicateFrom={form.duplicateFrom}
          defaultUnits={tab === 'ALL' ? '' : meta.tabDefaultUnits[tab]}
          meta={meta}
          lookups={lookups}
          canWrite={canWrite}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); load(); }}
        />
      ) : null}
      {addingColumn ? (
        <AddColumnModal
          onClose={() => setAddingColumn(false)}
          onAdded={() => { setAddingColumn(false); loadMeta(); }}
        />
      ) : null}
      {managingLocks ? (
        <LockManagerModal
          locks={meta.locks}
          onClose={() => setManagingLocks(false)}
          onChanged={loadMeta}
        />
      ) : null}
    </main>
  );
}

// Admin-only: name a new column. It shows up everywhere (Table, Excel grid, the add/edit form, Excel export)
// as a plain open-text field, appended after the template's own columns.
function AddColumnModal({ onClose, onAdded }) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const name = label.trim();
    if (!name) { toast('Enter a name for the column', 'err'); return; }
    setBusy(true);
    try {
      const out = await post('/api/admin/workload-columns', { label: name });
      toast('Column added');
      onAdded(out.column);
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal
      title="Add Column"
      onClose={onClose}
      footer={(
        <>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={submit}>Add</button>
        </>
      )}
    >
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="f full">
          <span>Column name</span>
          <input autoFocus maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Client Approval" />
        </label>
        <div className="full dim">Shows up as a plain text column everywhere — Table, Excel, the form, and the export — for every row.</div>
      </form>
    </Modal>
  );
}

// Admin-only: freeze a date range so its rows can't be edited/deleted, and no new row can be created dated
// inside it. Admins can still override; this is a period lock, not a hard permission wall.
function LockManagerModal({ locks, onClose, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!from || !to) { toast('Pick both a From and a To date', 'err'); return; }
    setBusy(true);
    try {
      await post('/api/admin/workload-locks', { from_date: from, to_date: to, note });
      toast('Date range locked');
      setFrom(''); setTo(''); setNote('');
      onChanged();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const remove = async (lock) => {
    if (!(await confirm('Remove this lock?', `${lock.from_date} to ${lock.to_date} will be editable again.`, { danger: true }))) return;
    try { await del(`/api/admin/workload-locks/${lock.id}`); toast('Lock removed'); onChanged(); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal title="Lock Dates" onClose={onClose} footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Close</button></>}>
      <div className="dim" style={{ marginBottom: 12 }}>Rows dated inside a locked range can't be edited or deleted by Managers (Admins can still override).</div>
      {locks.length ? (
        <ul className="lock-list">
          {locks.map((l) => (
            <li key={l.id}>
              <span><strong>{fmtDate(l.from_date)}</strong> – <strong>{fmtDate(l.to_date)}</strong>{l.note ? <span className="dim"> · {l.note}</span> : null}</span>
              <button type="button" className="iconbtn" aria-label="Remove lock" onClick={() => remove(l)}><CloseIcon /></button>
            </li>
          ))}
        </ul>
      ) : <div className="dim" style={{ marginBottom: 12 }}>No locked date ranges yet.</div>}
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <label className="f"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="f"><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="f full"><span>Note (optional)</span><input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. September closed" /></label>
        <div className="full"><button type="button" className="btn primary" disabled={busy} onClick={add}>Add lock</button></div>
      </form>
    </Modal>
  );
}

function WorkloadForm({ rec, duplicateFrom, defaultUnits, meta, lookups, canWrite, onClose, onSaved }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const initial = Object.keys(meta.fields).reduce((o, k) => ({ ...o, [k]: (rec && rec[k]) ?? (duplicateFrom && duplicateFrom[k]) ?? '' }), {});
  if (!rec && !duplicateFrom) { initial.work_date = isoDate(); initial.units_concerned = defaultUnits; }
  const [f, , setAll] = useForm(initial);
  const set = (k) => (e) => {
    const val = e && e.target ? e.target.value : e;
    setAll((prev) => withAutoPlatform(meta.platformRules, prev, k, val));
  };

  // Audio-only units use the template's Audio sheet columns; everything else uses the main sheet columns
  const teams = meta.unitTeams[f.units_concerned] || [];
  const audioOnly = teams.length === 1 && teams[0] === 'AUDIO';
  const base = meta.views[audioOnly ? 'AUDIO' : 'VGFX'].filter((k) => k !== 'work_date' && k !== 'units_concerned'
    // Breakdate/Time (VGFX or VEDIT): only shown for a team that's actually involved; the note follows whichever time field(s) show
    && !(k === 'breakdate_vgfx' && !teams.includes('VGFX'))
    && !(k === 'breakdate_vedit' && !teams.includes('VEDIT'))
    && !(k === 'breakdate_note' && !teams.includes('VGFX') && !teams.includes('VEDIT')));
  // Any row that involves Audio also gets the Audio-only columns (Length, Others)
  const shown = f.units_concerned
    ? [...base, ...(teams.includes('AUDIO') ? meta.audioExtra.filter((k) => !base.includes(k)) : [])]
    : [];
  const bothVgfxVedit = teams.includes('VGFX') && teams.includes('VEDIT');
  // Only one of the two teams involved: drop the "(VGFX)"/"(VEDIT)" suffix since there's no ambiguity to resolve
  const fieldLabel = (k, def) => (!bothVgfxVedit && (k === 'breakdate_vgfx' || k === 'breakdate_vedit') ? 'Breakdate / Time' : def.label);
  const plugText = String(f.plug_id || '').trim();

  const submit = async () => {
    if (!f.work_date) { toast('Work Date is required', 'err'); return; }
    if (!f.units_concerned) { toast('Units Concerned is required', 'err'); return; }
    if (!plugText) { toast('Plug ID is required', 'err'); return; }
    setBusy(true);
    try {
      if (rec) await put(`/api/workload/${rec.id}`, f);
      else await post('/api/workload', f);
      toast('Saved');
      onSaved();
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };

  const remove = async () => {
    if (!(await confirm('Delete workload item', `Permanently delete "${firstLine(rec.plug_id)}"?`, { okText: 'Delete', danger: true }))) return;
    try { await del(`/api/workload/${rec.id}`); toast('Deleted'); onSaved(); } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <Modal
      title={rec ? `${canWrite ? 'Edit' : 'View'} Workload #${rec.id}` : duplicateFrom ? 'Duplicate Workload' : 'New Workload'}
      onClose={onClose}
      footer={(
        <>
          {rec && canWrite ? <button type="button" className="btn danger" id="del" onClick={remove}>Delete</button> : null}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{canWrite ? 'Cancel' : 'Close'}</button>
          {canWrite ? <button type="button" className="btn primary" id="save" disabled={busy} onClick={submit}>Save</button> : null}
        </>
      )}
    >
      <form id="wl-form" className="form-grid" noValidate onSubmit={(e) => e.preventDefault()}>
        <label className="f"><span>Work Date <span className="req">*</span></span>
          <FieldInput def={meta.fields.work_date} value={f.work_date} onChange={set('work_date')} disabled={!canWrite} lookups={lookups} /></label>
        <label className="f"><span>Units Concerned <span className="req">*</span></span>
          <FieldInput def={meta.fields.units_concerned} value={f.units_concerned} onChange={set('units_concerned')} disabled={!canWrite} lookups={lookups} /></label>
        {!f.units_concerned ? <div className="full dim">Choose Units Concerned to see the fields.</div> : shown.map((k) => {
          const def = meta.fields[k];
          return (
            <label key={k} className={`f${def.multiline ? ' full' : ''}`}>
              <span>{fieldLabel(k, def)}{def.required ? <span className="req"> *</span> : null}</span>
              <FieldInput def={def} value={f[k]} onChange={set(k)} disabled={!canWrite} lookups={lookups} />
              {k === 'platform' && plugText && !f.platform ? (
                <small className="dim">{/PD_/i.test(plugText) ? 'PD_ plugs are digital — choose DIGITAL or INTL DIGITAL.' : 'Could not tell the platform from the Plug ID — choose one.'}</small>
              ) : null}
            </label>
          );
        })}
      </form>
    </Modal>
  );
}
