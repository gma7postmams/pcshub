import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, patch, post, put } from '../lib/api.js';
import { fmtBreakdate, fmtDate, isoDate } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { DownloadIcon, PlusIcon, SearchIcon } from '../components/Icons.jsx';
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
  const [form, setForm] = useState(null);   // null | { rec } (rec null = new)
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);   // { id, k } while one table cell is open for editing
  useEffect(() => { setEditing(null); }, [tab, mode, offset]);
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

  useEffect(() => {
    Promise.all([get('/api/workload/meta'), get('/api/dropdowns?categories=workload_platform,plug_type')])
      .then(([m, dd]) => { setMeta(m); setLookups(dd); })
      .catch((e) => toast(e.message, 'err'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // ---- grid operations ----
  const setCell = (key, k, val) => setGrid((g) => ({
    ...g, rows: g.rows.map((r) => (r._key === key ? { ...withAutoPlatform(meta.platformRules, r, k, val), _dirty: true } : r)),
  }));
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
  const cols = meta.views[tab];
  const total = data && data.total ? data.total : 0;
  const head = (k) => meta.fields[k].label;
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
  const cell = (r, k) => {
    const td = cellView(r, k);
    if (!canWrite) return td;
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
                    <table className="t xl">
                      <thead><tr>{cols.map((k) => <th key={k}>{meta.fields[k].label}</th>)}{canWrite ? <th /> : null}</tr></thead>
                      <tbody>
                        {grid.rows.length ? grid.rows.map((r) => (
                          <tr key={r._key} className={r._dirty ? 'dirty' : ''}>
                            {cols.map((k) => (
                              <td key={k} data-k={k}>
                                <FieldInput auto def={meta.fields[k]} value={r[k]} lookups={lookups} disabled={!canWrite} onChange={(e) => setCell(r._key, k, e.target.value)} />
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
                        <thead><tr>{cols.map((k) => <th key={k}>{head(k)}</th>)}{canWrite ? <th className="right">Actions</th> : null}</tr></thead>
                        <tbody>
                          {data.rows.map((r) => (
                            <tr key={r.id} className={canWrite ? '' : 'clickable'} onClick={canWrite ? undefined : () => setForm({ rec: r })}>
                              {cols.map((k) => cell(r, k))}
                              {canWrite ? (
                                <td className="right nowrap actions-cell" onClick={(e) => e.stopPropagation()}>
                                  <RowMenu onEdit={() => setForm({ rec: r })} onDuplicate={() => setForm({ rec: null, duplicateFrom: r })} onDelete={() => deleteItem(r)} />
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
    </main>
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
