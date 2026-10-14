import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { del, get, post, put } from '../lib/api.js';
import { downloadFile, fmtDate, isoDate } from '../lib/util.js';
import { pasteFallback } from '../lib/pasteFallback.js';
import { loadView, saveView, loadDialog, syncDialog, loadEdit, syncEdit, loadCellText, saveCellText } from '../lib/viewstate.js';
import { CalendarIcon, DownloadIcon, ExitFullscreenIcon, FullscreenIcon, PlusIcon, SearchIcon, TrashIcon, UploadIcon } from '../components/Icons.jsx';
import PresenceAvatars from '../components/PresenceAvatars.jsx';
import { useLive } from '../lib/live.js';
import { ExportButton, FilterSelect, FiltersMenu, pickerHeld, Pager, RowMenu, SortTh, ToolMenu, useFitBox, useNarrow } from '../components/wl.jsx';
import { useSession } from '../context.jsx';
import { normDate, parseTsv, tsvCell } from '../components/PlugGrid.jsx';
import { Empty, Modal, Options, useConfirm, useDebounced, useForm, useToast } from '../components/ui.jsx';

// PSD Daily Plug List — the PSD's daily plug list (imported from their workbook: NO / PLUG ID / PROG NAME/PROJ TITLE / PSD / Account By),
// one row per plug with its DATE in a column of its own. The "View" dropdown chooses the period shown: All, Daily, Weekly, Monthly or a
// Custom range; "Rows" chooses how many rows are visible per page. The Workload Tracker copies Plug ID, PSD and PROG. NAME / PROJ. TITLE
// from here, and every new plug is copied to the Workload Tracker automatically (there is no manual copy button any more).
const weekday = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
const dateLabel = (iso) => `${weekday(iso)}, ${fmtDate(iso)}`;

// ---- date maths on 'YYYY-MM-DD' strings (UTC, so no time-zone drift) ----
const pad = (n) => String(n).padStart(2, '0');
const toIso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parseIso = (iso) => new Date(`${iso}T00:00:00Z`);
const addDays = (iso, n) => { const d = parseIso(iso); d.setUTCDate(d.getUTCDate() + n); return toIso(d); };
const monday = (iso) => addDays(iso, -((parseIso(iso).getUTCDay() + 6) % 7));   // weeks run Monday to Sunday
const monthStart = (iso) => `${iso.slice(0, 8)}01`;
const monthEnd = (iso) => { const d = parseIso(monthStart(iso)); d.setUTCMonth(d.getUTCMonth() + 1, 0); return toIso(d); };
const addMonths = (iso, n) => { const d = parseIso(monthStart(iso)); d.setUTCMonth(d.getUTCMonth() + n, 1); return toIso(d); };

const SIZES = [{ value: '25', label: '25' }, { value: '50', label: '50' }, { value: '100', label: '100' }, { value: '250', label: '250' }, { value: '500', label: '500' }, { value: 'all', label: 'All' }];
const ALL_CAP = 5000;   // "All rows" shows at most this many at once (the server's limit)

const PERIODS = [
  { value: 'all', label: 'All' }, { value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' }, { value: 'custom', label: 'Custom Range' },
];

const rangeOf = (period, anchor, custom) => {
  if (period === 'day') return { from: anchor, to: anchor };
  if (period === 'week') return { from: monday(anchor), to: addDays(monday(anchor), 6) };
  if (period === 'month') return { from: monthStart(anchor), to: monthEnd(anchor) };
  if (period === 'custom') return { from: custom.from || '', to: custom.to || '' };
  return { from: '', to: '' };
};
const rangeLabel = (period, r, anchor) => {
  if (period === 'day') return dateLabel(anchor);
  if (period === 'week') return `${fmtDate(r.from)} – ${fmtDate(r.to)}`;
  if (period === 'month') return parseIso(anchor).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (period === 'custom') return r.from || r.to ? `${r.from ? fmtDate(r.from) : 'Any'} – ${r.to ? fmtDate(r.to) : 'Any'}` : 'All Dates';
  return 'All Days';
};
const stored = (k, fallback, allowed) => { try { const v = localStorage.getItem(`plugs:${k}`); return allowed.includes(v) ? v : fallback; } catch (e) { return fallback; } };
const EDIT_COLS = ['plug_date', 'plug_id', 'prog_name', 'psd'];   // the cells you can edit / copy / paste; REQUESTED BY and IN WORKLOAD are set by the server
const MAXLEN = { plug_id: 200, prog_name: 300, psd: 200 };
const recOf = (r) => ({ plug_date: r.plug_date, plug_id: r.plug_id || '', prog_name: r.prog_name || '', psd: r.psd || '' });
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
function CellMenu({ x, y, children, ...rest }) {
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
// One cell being edited: Enter saves and moves down (Shift+Enter up), Tab / Shift+Tab move sideways, Esc cancels, clicking away saves.
function PlugCellEditor({ k, initial, onSave, onCancel, memo }) {
  const [val, setValRaw] = useState(() => (memo ? loadCellText('plugs', memo, initial ?? '') : initial ?? ''));
  const setVal = (v) => { setValRaw(v); if (memo) saveCellText('plugs', memo, v); };
  const ref = useRef(null);
  const done = useRef(false);
  useEffect(() => { const el = ref.current; if (el) { el.focus(); if (el.setSelectionRange && k !== 'plug_date') el.setSelectionRange(el.value.length, el.value.length); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const finish = (move) => { if (done.current) return; done.current = true; onSave(val, move); };
  const key = (e) => {
    if (k === 'plug_date') pasteFallback(e, (t) => { const d = normDate(String(t).trim()); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) setVal(d); });
    if (e.key === 'Escape') { done.current = true; onCancel(); return; }
    if (e.key === 'Enter') { e.preventDefault(); finish({ dr: e.shiftKey ? -1 : 1, dc: 0 }); }
    else if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); finish({ dr: 0, dc: e.shiftKey ? -1 : 1 }); }
  };
  return (
    <div className="cell-editor" onClick={(e) => e.stopPropagation()}>
      <input ref={ref} type={k === 'plug_date' ? 'date' : 'text'} value={val} maxLength={MAXLEN[k]} onChange={(e) => setVal(e.target.value)} onKeyDown={key} onBlur={() => finish(null)}
        onPaste={k === 'plug_date' ? (e) => { const d = normDate(String(e.clipboardData.getData('text/plain') || '').trim()); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) { e.preventDefault(); setVal(d); } } : undefined} />
    </div>
  );
}
const remember = (k, v) => { try { localStorage.setItem(`plugs:${k}`, v); } catch (e) { /* storage unavailable */ } };

/** The date button: click it to choose the View (All / Daily / Weekly / Monthly / Custom range; Custom adds From – To). The ‹ › arrows step through days, weeks or months. */
function PlugDate({ period, anchor, range, custom, onCustom, onPeriod }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target) && !pickerHeld(ref.current)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const label = period === 'all' ? 'All Dates' : period === 'custom' && !range.from && !range.to ? 'All Dates' : rangeLabel(period, range, anchor);
  const shown = period === 'all' ? { from: '', to: '' } : range;   // From / To always show what is being looked at; changing one makes it a custom range
  return (
    <div className="daterange" ref={ref}>
      <button type="button" className="daterange-btn" id="plug-date-btn" title="Choose the dates" onClick={() => setOpen((o) => !o)}><CalendarIcon /><span>{label}</span></button>
      {open ? (
        <div className="popover daterange-pop">
          <div className="presets">
            {PERIODS.filter((o) => o.value !== 'custom').map((o) => <button key={o.value} type="button" className="btn sm" onClick={() => { onPeriod(o.value); setOpen(false); }}>{o.label}</button>)}
          </div>
          <label className="f"><span>From</span><input type="date" value={shown.from} onChange={(e) => onCustom({ from: e.target.value, to: shown.to })} /></label>
          <label className="f"><span>To</span><input type="date" value={shown.to} onChange={(e) => onCustom({ from: shown.from, to: e.target.value })} /></label>
        </div>
      ) : null}
    </div>
  );
}

export default function PlugList({ canWrite, canWorkload, onCopied }) {
  const toast = useToast();
  const confirm = useConfirm();
  const session = useSession();
  const fileRef = useRef(null);
  const [days, setDays] = useState(null);            // [{ date, n }] newest first (the latest 366 days with a list); null = loading
  const [totals, setTotals] = useState({ plugs: 0, days: 0, first: '', last: '' });   // across every day
  const saved = useRef(loadView('plugs', {})).current;   // what this tab last had on screen (kept across a refresh)
  const [period, setPeriodState] = useState(() => (PERIODS.some((p) => p.value === saved.period) ? saved.period : stored('period', 'day', PERIODS.map((p) => p.value))));
  const [size, setSizeState] = useState(() => stored('size3', '25', SIZES.map((s) => s.value)));
  const [anchor, setAnchor] = useState(saved.anchor || '');          // the day / a day of the week / of the month being looked at
  const [custom, setCustom] = useState(saved.custom || { from: '', to: '' });
  const [filt, setFilt] = useState({ in_workload: '', psd: '', account_by: '', ...(saved.filt || {}) });   // the Filters menu
  const [opts, setOpts] = useState({ psd: [], account_by: [] });
  const filtCount = Object.values(filt).filter(Boolean).length
  const [q, setQ] = useState(saved.q || '');
  const query = useDebounced(q, 250);
  const [data, setData] = useState(null);            // { rows, total }; null = loading
  const [picked, setPicked] = useState(() => new Set());   // ticked rows (Table mode) for Delete selected
  const [allMatching, setAllMatching] = useState(false);   // Admin: "Select all N": every plug the view matches, on every page
  const [deletingAll, setDeletingAll] = useState(false);
  const isAdminUser = !!(session.user && ['Admin', 'System Admin'].includes(session.user.role));
  const [importing, setImporting] = useState(false);
  // Full screen: the list covers the app's page (the browser's own tabs and address bar stay); Esc or the button leaves it
  const [full, setFull] = useState(false);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) setFull(false); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, []);
  const [needYear, setNeedYear] = useState(null);    // file waiting for a year (its name has none)
  const [year, setYear] = useState(new Date().getFullYear());
  const [summary, setSummary] = useState(null);      // result of the last import
  const [adding, setAdding] = useState(() => { const d = loadDialog('plugs'); return !!(d && d.rec && d.rec.adding); });   // an open Add / Edit dialog comes back after a refresh
  const [editing, setEditing] = useState(() => { const d = loadDialog('plugs'); return d && d.rec && d.rec.editing ? d.rec.editing : null; });      // the plug being edited
  useEffect(() => { syncDialog('plugs', editing ? { editing } : adding ? { adding: true } : null); }, [adding, editing]);
  const okToLeave = async () => true;   // Excel mode (and its unsaved-grid prompt) is gone: the list is the Table only
  const [draft, setDraft] = useState(() => loadEdit('plugs').draft || null);          // the empty row Add Row put at the top, not saved yet (kept across a refresh)
  const [cellEd, setCellEd] = useState(() => loadEdit('plugs').cell || null);        // { id, k } while one cell is open for editing (comes back after a refresh)
  const prevEd = useRef(cellEd ? `${cellEd.id}:${cellEd.k}` : null);
  useEffect(() => { prevEd.current = syncEdit('plugs', cellEd, draft, prevEd.current); }, [cellEd, draft]);
  const [ctx, setCtx] = useState(null);              // right-click menu position
  useEffect(() => { if (cellEd && cellEd.id !== 'draft' && data && data.rows && !data.rows.some((r) => r.id === cellEd.id)) setCellEd(null); }, [data]);   // eslint-disable-line react-hooks/exhaustive-deps
  const hist = useRef({ past: [], future: [] });
  const internalClip = useRef(null);
  const lastPick = useRef(null);
  const drag = useRef(null);
  const suppress = useRef(false);
  const [cellSel, setCellSel] = useState(null);   // a block of cells picked by dragging { r0, c0, r1, c1 }
  const cellDrag = useRef(null);
  const keysRef = useRef(null);
  const pasteRef = useRef(null);

  const range = rangeOf(period, anchor, custom);
  const limit = size === 'all' ? ALL_CAP : Number(size);
  const narrow = useNarrow();
  const [sort, setSort] = useState(saved.sort || { k: '', dir: 'asc' });   // clicked column header
  const viewKey = `${period}|${range.from}|${range.to}|${query}|${filt.in_workload}|${filt.psd}|${filt.account_by}|${size}|${sort.k}|${sort.dir}`;
  const [pageState, setPageState] = useState(() => ({ key: viewKey, offset: saved.offset || 0 }));   // the page you were on is kept across a refresh   // the page resets to the first whenever the view changes
  const offset = pageState.key === viewKey ? pageState.offset : 0;
  const setOffset = async (o) => { if (!(await okToLeave())) return; setPageState({ key: viewKey, offset: o }); };
  useEffect(() => { saveView('plugs', { filt, q, sort, custom, anchor, period, offset }); }, [filt, q, sort, custom, anchor, period, offset]);
  const setPeriod = async (p) => { if (!(await okToLeave())) return; setPeriodState(p); remember('period', p); };
  const pickCustom = async (r) => {   // typing a From / To date = a custom range (both empty = every day)
    if (!(await okToLeave())) return;
    if (!r.from && !r.to) { setPeriodState('all'); remember('period', 'all'); return; }
    setCustom(r); setPeriodState('custom');
  };
  const setF = (k) => (e) => { setFilt((f) => ({ ...f, [k]: e.target.value })); };
  const setSize = async (s) => { if (!(await okToLeave())) return; setSizeState(s); remember('size3', s); };

  const loadDays = useCallback(async (quiet) => {   // quiet = a re-read because somebody else changed the list: no error pop-up
    try {
      const out = await get('/api/plugs/dates');
      setDays(out.dates);
      setTotals({ plugs: out.total ?? 0, days: out.days ?? out.dates.length, first: out.first || '', last: out.last || '' });
      setAnchor((cur) => {   // first visit: today if it has a list, else the latest day that does
        if (cur) return cur;
        const today = isoDate();
        return (out.dates.find((x) => x.date === today) || out.dates[0] || {}).date || today;
      });
    } catch (e) { if (!quiet) { setDays([]); toast(e.message, 'err'); } }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadDays(); }, [loadDays]);
  const loadOpts = useCallback(() => { get('/api/plugs/options').then(setOpts).catch(() => {}); }, []);
  useEffect(() => { loadOpts(); }, [loadOpts]);

  const loadRows = useCallback(async (quiet) => {
    if (!anchor) return;
    try {
      const p = new URLSearchParams({ used: '1', limit: String(limit), offset: String(offset), order: period === 'all' ? 'desc' : 'asc' });
      if (range.from) p.set('from', range.from);
      if (range.to) p.set('to', range.to);
      if (query) p.set('q', query);
      Object.entries(filt).forEach(([k, val]) => { if (val) p.set(k, val); });
      if (sort.k) { p.set('sort', sort.k); p.set('dir', sort.dir); }
      setData(await get(`/api/plugs?${p}`));
    } catch (e) { if (!quiet) { setData({ rows: [], total: 0 }); toast(e.message, 'err'); } }
  }, [anchor, range.from, range.to, query, filt, limit, offset, period, sort.k, sort.dir]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); setPicked(new Set()); setAllMatching(false); loadRows(); }, [loadRows]);
  // other people's changes appear by themselves (Workload changes too: the "In Workload" flag) — not while a cell, form or dialog is open here
  useLive(['plugs'], () => { loadDays(true); loadOpts(); return loadRows(true); }, () => {
    const el = document.activeElement;
    return !!(adding || editing || draft || cellEd || needYear || summary || importing || document.querySelector('.modal-backdrop') || (el && el.closest && el.closest('td') && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
  });
  const exportXlsx = async (byDate) => {   // the days and search on screen, in the sort on screen
    const p = new URLSearchParams({ order: period === 'all' ? 'desc' : 'asc' });
    if (range.from) p.set('from', range.from);
    if (range.to) p.set('to', range.to);
    if (query) p.set('q', query);
    Object.entries(filt).forEach(([k, val]) => { if (val) p.set(k, val); });
    if (sort.k) { p.set('sort', sort.k); p.set('dir', sort.dir); }
    if (byDate) p.set('by_date', '1');
    try { await downloadFile(`/api/plugs/export?${p}`, byDate ? 'PSD_Plug_List_tabs.xlsx' : 'PSD_Plug_List.xlsx'); } catch (e) { toast(e.message, 'err'); }
  };

  // ---- moving through time ----
  const dayList = days || [];
  const prevDay = dayList.find((d) => d.date < anchor);
  const nextDay = [...dayList].reverse().find((d) => d.date > anchor);
  const canPrev = period === 'day' ? !!prevDay : !!totals.first && range.from > totals.first;
  const canNext = period === 'day' ? !!nextDay : !!totals.last && range.to < totals.last;
  const go = async (dir) => {
    if (!(await okToLeave())) return;
    if (period === 'day') setAnchor((dir < 0 ? prevDay : nextDay).date);   // the previous / next day that has a list
    else if (period === 'week') setAnchor(addDays(anchor, dir * 7));
    else if (period === 'month') setAnchor(addMonths(anchor, dir));
  };

  const upload = async (file, yr) => {
    const form = new FormData();
    form.append('file', file);
    if (yr) form.append('year', String(yr));
    setImporting(true);
    try {
      const out = await post('/api/plugs/import', form);
      setSummary(out);
      toast(`${out.added} plug${out.added === 1 ? '' : 's'} added${out.existing ? `, ${out.existing} already there` : ''}${out.copied && out.copied.created ? ` — ${out.copied.created} copied to the Workload Tracker` : ''}${out.workloadRowsFilled ? ` — ${out.workloadRowsFilled} existing Workload row${out.workloadRowsFilled === 1 ? '' : 's'} filled in` : ''}`);
      await loadDays();
      loadRows();
    } catch (e) { toast(e.message, 'err'); } finally { setImporting(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const pickFile = async (file) => {
    if (!file) return;
    if (!(await okToLeave())) { if (fileRef.current) fileRef.current.value = ''; return; }
    if (/(?<!\d)20\d{2}(?!\d)/.test(file.name)) upload(file, null);   // "September_2026_Plug_List…" — the server reads the year from the name
    else setNeedYear(file);                                           // the list has no year in it: ask
  };

  const removePlug = async (r) => {
    if (!(await confirm('Delete plug', `Remove "${r.plug_id}" from the ${fmtDate(r.plug_date)} list? Workload rows already made from it are not touched.`, { okText: 'Delete', danger: true }))) return;
    try { await del(`/api/plugs/${r.id}`); toast('Deleted'); await loadDays(); loadRows(); } catch (e) { toast(e.message, 'err'); }
  };

  const rows = data ? data.rows : [];
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const clearPicksRef = useRef(() => {}); clearPicksRef.current = () => { setPicked(new Set()); setAllMatching(false); lastPick.current = null; };
  useFitBox(`table|${narrow}|${rows.length}|${days === null}|${!!data}|${size}|${full}`);
  const chosen = rows.filter((r) => picked.has(r.id));
  const pickedCount = chosen.length;
  const allOn = !!rows.length && rows.every((r) => picked.has(r.id));
  const clearPicks = () => { setPicked(new Set()); setAllMatching(false); lastPick.current = null; };
  const reload = async () => { await loadDays(); loadRows(); };
  const batch = async (list) => post('/api/plugs/batch', { rows: list });

  // undo / redo of what the table does straight on the server
  const pushH = (entry) => { const h = hist.current; h.past.push(entry); if (h.past.length > 50) h.past.shift(); h.future = []; };
  const step = async (from, to, verb) => {
    const e = hist.current[from].pop();
    if (!e) { toast(`Nothing to ${verb}`); return; }
    try { await e[verb](); hist.current[to].push(e); toast(`${verb === 'undo' ? 'Undone' : 'Redone'}: ${e.label}`); } catch (err) { hist.current[from].push(e); toast(err.message, 'err'); }
    clearPicks();
    reload();
  };
  const undo = () => step('past', 'future', 'undo');
  const redo = () => step('future', 'past', 'redo');

  // delete / cut
  // the server deletes at most 1000 ticked plugs per request, so a long selection goes in several requests
  const deleteIds = async (ids) => {
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 1000) deleted += (await post('/api/plugs/delete-selected', { ids: ids.slice(i, i + 1000) })).deleted || 0;
    return { deleted };
  };
  const deleteChosen = async (verb = 'Delete') => {
    if (allMatching) { setDeletingAll(true); return; }
    const list = chosen;
    if (!list.length) return;
    if (!(await confirm(`${verb} plugs`, `${verb === 'Cut' ? 'Cut and remove' : 'Remove'} the ${list.length} selected plug${list.length === 1 ? '' : 's'} from the list? Workload rows already made from them are not touched.`, { okText: verb, danger: true }))) return;
    const recs = list.map(recOf);
    let ids = list.map((r) => r.id);
    try {
      const out = await deleteIds(ids);
      pushH({
        label: `${verb.toLowerCase()} ${list.length} plug${list.length === 1 ? '' : 's'}`,
        undo: async () => { ids = (await batch(recs)).addedIds || []; },
        redo: async () => { await deleteIds(ids); },
      });
      toast(`${out.deleted} plug${out.deleted === 1 ? '' : 's'} deleted`);
      clearPicks();
      reload();
    } catch (e) { toast(e.message, 'err'); }
  };
  const removeChosen = () => deleteChosen('Delete');

  // copy / cut / paste (tab-separated, so it also goes to and from a real Excel sheet)
  const copyChosen = async () => {
    if (!chosen.length) return false;
    const text = chosen.map((r) => EDIT_COLS.map((k) => tsvCell(String(r[k] ?? ''))).join('\t')).join('\n');
    internalClip.current = text;
    const ok = await writeClipboard(text);
    toast(ok ? `Copied ${chosen.length} plug${chosen.length === 1 ? '' : 's'}` : 'Could not reach the clipboard', ok ? undefined : 'err');
    return ok;
  };
  const cutChosen = async () => { if (await copyChosen()) await deleteChosen('Cut'); };
  const defaultDate = () => (period === 'day' ? anchor : (rows[0] && rows[0].plug_date) || range.from || isoDate());
  // 'replace' (rows selected): the pasted rows overwrite the selected rows (one selected: it and the rows below it); extra pasted rows are added
  // 'above' / 'below': new plugs on the selected row's day; 'new' (nothing selected): new plugs
  const pasteRows = async (text, how) => {
    if (!canWrite) return;
    const block = parseTsv(text).filter((cells) => cells.some((c) => String(c).trim() !== ''));
    if (!block.length) return;
    if (block.length > 500) toast('Only the first 500 rows are pasted at a time', 'err');
    const sel = chosen;
    const mode = how || (sel.length ? 'replace' : 'new');
    const anchorRow = mode === 'above' ? sel[0] : mode === 'below' ? sel[sel.length - 1] : null;
    let targets = [];
    if (mode === 'replace') {
      if (sel.length === 1) { const i = rows.findIndex((x) => x.id === sel[0].id); targets = rows.slice(i, i + block.length); } else targets = sel;
    }
    const cellsOf = (base, cells) => {
      const o = { ...base };
      cells.forEach((raw, ci) => {
        const k = EDIT_COLS[ci];
        if (!k) return;
        o[k] = k === 'plug_date' ? normDate(raw) : String(raw).replace(/\s*\n\s*/g, ' ').trim();
      });
      return o;
    };
    const olds = [];
    const list = block.slice(0, 500).map((cells, i) => {
      if (mode === 'replace' && i < targets.length) {
        olds.push({ id: targets[i].id, ...recOf(targets[i]) });
        const o = { id: targets[i].id, ...cellsOf(recOf(targets[i]), cells) };
        if (!o.plug_date) o.plug_date = targets[i].plug_date;
        return o;
      }
      const o = cellsOf({ plug_date: '', plug_id: '', prog_name: '', psd: '' }, cells);
      if (!o.plug_date) o.plug_date = (anchorRow && anchorRow.plug_date) || defaultDate();
      return o;
    });
    const nRep = olds.length;
    const nNew = list.length - nRep;
    const what = [nRep ? `replace ${nRep} row${nRep === 1 ? '' : 's'}` : '', nNew ? `add ${nNew} new row${nNew === 1 ? '' : 's'}${mode === 'above' ? ' above' : mode === 'below' ? ' below' : ''}` : ''].filter(Boolean).join(' and ');
    try {
      let ids = (await batch(list)).addedIds || [];
      pushH({
        label: `paste (${what})`,
        undo: async () => { if (ids.length) await post('/api/plugs/delete-selected', { ids }); if (olds.length) await batch(olds); },
        redo: async () => { ids = (await batch(list)).addedIds || []; },
      });
      toast(`Pasted: ${what}`);
      clearPicks();
      reload();
    } catch (e) { toast(e.message, 'err'); }
  };
  const menuPaste = async (how) => {
    setCtx(null);
    let text = null;
    try { if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) text = await navigator.clipboard.readText(); } catch (err) { text = null; }
    if (text == null || text === '') text = internalClip.current;   // plain-http addresses can't read the clipboard: use what was last copied here
    if (text == null || text === '') { toast('Nothing to paste yet — copy some rows first, or press Ctrl+V', 'err'); return; }
    pasteRows(text, how);
  };

  // click a cell to edit just that cell (Plug ID, date, program, PSD, account by)
  const moveEdit = (r, k, dr, dc) => {
    const list = [...(draft ? [draft] : []), ...rows];
    let ri = list.findIndex((x) => x.id === r.id);
    let ci = EDIT_COLS.indexOf(k);
    if (ri < 0 || ci < 0) return;
    if (dc) { ci += dc; if (ci >= EDIT_COLS.length) { ci = 0; ri += 1; } else if (ci < 0) { ci = EDIT_COLS.length - 1; ri -= 1; } } else ri += dr;
    if (ri < 0 || ri >= list.length) return;
    setCellEd({ id: list[ri].id, k: EDIT_COLS[ci] });
  };
  const saveCell = async (r, k, raw, move) => {
    const value = k === 'plug_date' ? normDate(raw) : String(raw ?? '').replace(/\s*\n\s*/g, ' ').trim();
    const close = () => setCellEd((cur) => (cur && cur.id === r.id && cur.k === k ? null : cur));
    if (r.id === 'draft') { setDraft((d) => (d ? { ...d, [k]: value } : d)); close(); if (move) moveEdit(r, k, move.dr, move.dc); return; }
    if (value === String(r[k] ?? '')) { close(); if (move) moveEdit(r, k, move.dr, move.dc); return; }
    if (k === 'plug_id' && !value) { toast('Plug ID is required', 'err'); close(); return; }
    const before = recOf(r);
    const after = { ...before, [k]: value };
    try {
      await put(`/api/plugs/${r.id}`, after);
      pushH({ label: 'cell edit', undo: async () => { await put(`/api/plugs/${r.id}`, before); }, redo: async () => { await put(`/api/plugs/${r.id}`, after); } });
      setData((d) => (d && d.rows ? { ...d, rows: d.rows.map((x) => (x.id === r.id ? { ...x, [k]: value } : x)) } : d));
      close();
      if (k === 'plug_date') reload();
      if (move) moveEdit(r, k, move.dr, move.dc);
    } catch (e) { toast(e.message, 'err'); close(); }
  };
  const addDraft = () => {
    if (!canWrite) return;
    if (draft) { setCellEd({ id: 'draft', k: 'plug_id' }); return; }
    setDraft({ id: 'draft', plug_date: defaultDate(), plug_id: '', prog_name: '', psd: '' });
    setCellEd({ id: 'draft', k: 'plug_id' });
    requestAnimationFrame(() => { const box = document.querySelector('.plug-list .wl-fit'); if (box) box.scrollTop = 0; });
  };
  const saveDraft = async () => {
    if (!draft) return;
    if (!String(draft.plug_id).trim()) { toast('Plug ID is required', 'err'); return; }
    const rec = recOf(draft);
    try {
      let ids = (await batch([rec])).addedIds || [];
      pushH({ label: 'add row', undo: async () => { await post('/api/plugs/delete-selected', { ids }); }, redo: async () => { ids = (await batch([rec])).addedIds || []; } });
      setDraft(null); setCellEd(null);
      toast('Plug added');
      reload();
    } catch (e) { toast(e.message, 'err'); }
  };

  // ---- a block of cells: drag across cells (or Shift+click) to pick it; Ctrl+C copies, Delete clears, Ctrl+V pastes from its top-left cell ----
  const cellAt = (el) => { const td = el && el.closest ? el.closest('.plug-list td[data-c]') : null; return td ? { r: Number(td.dataset.r), c: Number(td.dataset.c) } : null; };
  const normCells = () => (cellSel ? { r0: Math.min(cellSel.r0, cellSel.r1), r1: Math.max(cellSel.r0, cellSel.r1), c0: Math.min(cellSel.c0, cellSel.c1), c1: Math.max(cellSel.c0, cellSel.c1) } : null);
  const cellDown = (e) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (t.closest && t.closest('.plug-actions, .rn, .chk, .editing, input, select, textarea, button, a')) return;
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
    const text = rows.slice(n.r0, n.r1 + 1).map((r) => EDIT_COLS.slice(n.c0, n.c1 + 1).map((k) => tsvCell(String(r[k] ?? ''))).join('\t')).join('\n');
    internalClip.current = text;
    const ok = await writeClipboard(text);
    const cnt = (n.r1 - n.r0 + 1) * (n.c1 - n.c0 + 1);
    toast(ok ? `Copied ${cnt} cell${cnt === 1 ? '' : 's'}` : 'Could not reach the clipboard', ok ? undefined : 'err');
    return ok;
  };
  const writeCells = async (n, valueAt, label) => {
    const olds = [];
    const list = [];
    for (let ri = n.r0; ri <= n.r1; ri++) {
      const r = rows[ri];
      if (!r) continue;
      const row = { id: r.id, ...recOf(r) };
      let changed = false;
      for (let ci = n.c0; ci <= n.c1; ci++) {
        const k = EDIT_COLS[ci];
        const val = valueAt(ri - n.r0, ci - n.c0, k);
        if (val === undefined) continue;
        row[k] = k === 'plug_date' ? normDate(val) : String(val).replace(/\s*\n\s*/g, ' ').trim();
        changed = true;
      }
      if (changed) { olds.push({ id: r.id, ...recOf(r) }); list.push(row); }
    }
    if (!list.length) { toast('Nothing to change (Date and Plug ID are required)', 'err'); return; }
    try {
      await batch(list);
      pushH({ label, undo: async () => { await batch(olds); }, redo: async () => { await batch(list); } });
      toast(`${label.charAt(0).toUpperCase()}${label.slice(1)}`);
      reload();
    } catch (e) { toast(e.message, 'err'); }
  };
  const clearCells = async () => { const n = normCells(); if (n) await writeCells(n, (ri, ci, k) => (k === 'plug_date' || k === 'plug_id' ? undefined : ''), 'cells cleared'); };
  const pasteCells = async (text) => {
    const n = normCells();
    if (!n) return;
    const block = parseTsv(text);
    if (!block.length) return;
    const single = block.length === 1 && block[0].length === 1;
    const big = { ...n };
    if (!single) { big.r1 = Math.min(rows.length - 1, n.r0 + block.length - 1); big.c1 = Math.min(EDIT_COLS.length - 1, n.c0 + Math.max(...block.map((x) => x.length)) - 1); }
    await writeCells(big, (ri, ci) => (single ? block[0][0] : (block[ri] && block[ri][ci] !== undefined ? block[ri][ci] : undefined)), 'cells pasted');
  };

  // selecting rows with the row numbers (click, Shift+click a range, Ctrl+click to add, drag down)
  const selectRange = (a, b) => setPicked(new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id)));
  const numDown = (e, r, idx) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (cellEd) setCellEd(null);
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
    if (cellEd) setCellEd(null);
    if (!picked.has(r.id)) { setPicked(new Set([r.id])); lastPick.current = r.id; }
    setCtx({ x: e.clientX, y: e.clientY });
  };

  // the same keyboard shortcuts the Workload Tracker's table has (not while typing in a box, with a dialog open, or while a cell is being edited)
  const keysOk = (e) => {
    if (!canWrite) return false;
    const el = e.target;
    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return false;
    return !(document.querySelector('.modal-backdrop') || adding || editing || needYear || summary || cellEd);
  };
  keysRef.current = (e) => {
    if (e.defaultPrevented || e.altKey || !keysOk(e)) return;
    const key = e.key.toLowerCase();
    if (cellSel && !picked.size) {   // a block of cells is picked
      if ((e.ctrlKey || e.metaKey) && key === 'c') { if (!(window.getSelection && String(window.getSelection()))) { e.preventDefault(); copyCells(); } return; }
      if ((e.ctrlKey || e.metaKey) && key === 'x') { e.preventDefault(); copyCells().then((ok) => { if (ok) clearCells(); }); return; }
      if (!e.ctrlKey && !e.metaKey && (key === 'delete' || key === 'backspace')) { e.preventDefault(); clearCells(); return; }
      if (!e.ctrlKey && !e.metaKey && key === 'escape') { setCellSel(null); return; }
    }
    if (e.ctrlKey || e.metaKey) {
      if (key === 'a') { e.preventDefault(); if (isAdminUser && allOn && total > rows.length) setAllMatching(true); else setPicked(new Set(rows.map((r) => r.id))); }   // Admin, again: every matching plug on every page
      else if (key === 'c') { if (picked.size && !(window.getSelection && String(window.getSelection()))) { e.preventDefault(); copyChosen(); } }
      else if (key === 'x') { if (picked.size) { e.preventDefault(); cutChosen(); } }
      else if (key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (key === 'y') { e.preventDefault(); redo(); }
      return;   // Ctrl+V arrives as a paste event
    }
    if (key === 'escape') clearPicks();
    else if ((key === 'delete' || key === 'backspace') && pickedCount) { e.preventDefault(); deleteChosen(); }
    else if (['arrowdown', 'arrowup', 'home', 'end'].includes(key) && picked.size && rows.length) {
      e.preventDefault();
      const anchorIdx = Math.max(0, rows.findIndex((r) => r.id === lastPick.current));
      const sel = rows.map((r, i) => (picked.has(r.id) ? i : -1)).filter((i) => i >= 0);
      const cur = sel.length ? (sel[sel.length - 1] === anchorIdx ? sel[0] : sel[sel.length - 1]) : anchorIdx;
      const to = key === 'home' ? 0 : key === 'end' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, cur + (key === 'arrowdown' ? 1 : -1)));
      if (e.shiftKey) selectRange(anchorIdx, to); else { setPicked(new Set([rows[to].id])); lastPick.current = rows[to].id; }
      requestAnimationFrame(() => { const tr = document.querySelector(`.plug-list tr[data-id="${rows[to].id}"]`); if (tr && tr.scrollIntoView) tr.scrollIntoView({ block: 'nearest' }); });
    } else if ((key === 'enter' || key === 'f2') && picked.size === 1) {
      e.preventDefault();
      const r = rows.find((x) => picked.has(x.id));
      if (r) setEditing(r);   // the Edit plug form
    }
  };
  pasteRef.current = (e) => {
    if (!keysOk(e)) return;
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
        const td = el && el.closest ? el.closest('.plug-list td[data-c]') : null;
        if (!td) return;
        const at = { r: Number(td.dataset.r), c: Number(td.dataset.c) };
        if (!cd.moved && (at.r !== cd.r || at.c !== cd.c)) { cd.moved = true; suppress.current = true; if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); setCellEd(null); }
        if (cd.moved) { if (window.getSelection) window.getSelection().removeAllRanges(); setCellSel({ r0: cd.r, c0: cd.c, r1: at.r, c1: at.c }); }
        return;
      }
      const d = drag.current;
      if (!d) return;
      if (!(e.buttons & 1)) { drag.current = null; return; }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const tr = el && el.closest ? el.closest('.plug-list tr[data-id]') : null;
      if (!tr) return;
      const idx = tr.parentElement ? [...tr.parentElement.querySelectorAll('tr[data-id]')].indexOf(tr) : -1;
      if (idx >= 0 && rowsRef.current[idx]) setPicked(new Set(rowsRef.current.slice(Math.min(d.from, idx), Math.max(d.from, idx) + 1).map((x) => x.id)));
    };
    const up = () => { drag.current = null; if (cellDrag.current && cellDrag.current.moved) setTimeout(() => { suppress.current = false; }, 150); cellDrag.current = null; };
    const down = (e) => {   // a click outside the table (and its bar, menus and dialogs) drops the selection
      const t = e.target;
      if (t && t.closest && !t.closest('.plug-list .table-wrap, .xl-menu, .modal-backdrop, .tpop, #delete-selected-btn, .sel-banner')) { clearPicksRef.current(); setCellSel(null); }
    };
    window.addEventListener('keydown', key); window.addEventListener('paste', paste); window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up); window.addEventListener('mousedown', down);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('paste', paste); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.removeEventListener('mousedown', down); };
  }, []);
  useEffect(() => { if (!ctx) return undefined; const close = (e) => { if (e.type === 'mousedown' && e.target.closest && e.target.closest('.xl-menu')) return; setCtx(null); }; window.addEventListener('mousedown', close); window.addEventListener('scroll', close, true); window.addEventListener('keydown', close); return () => { window.removeEventListener('mousedown', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', close); }; }, [ctx]);
  const total = data ? data.total : 0;
  const viewLabel = `${rangeLabel(period, range, anchor)}${query ? ` · “${query}”` : ''}`;

  // the cells of one row; a click edits just that cell (read-only people see plain text)
  const editCell = (r, k, content, extra = {}) => {
    const td = { 'data-k': k, ...extra };
    if (r.__i !== undefined) {
      const ci = EDIT_COLS.indexOf(k); const n = normCells();
      td['data-r'] = r.__i; td['data-c'] = ci;
      if (n && r.__i >= n.r0 && r.__i <= n.r1 && ci >= n.c0 && ci <= n.c1) td['data-sel'] = '1';
    }
    if (canWrite && cellEd && cellEd.id === r.id && cellEd.k === k) {
      return <td key={k} {...td} className={`editing ${extra.className || ''}`.trim()} onClick={(e) => e.stopPropagation()}><PlugCellEditor memo={`${r.id}:${k}`} k={k} initial={r[k]} onSave={(v, move) => saveCell(r, k, v, move)} onCancel={() => setCellEd(null)} /></td>;
    }
    if (!canWrite) return <td key={k} {...td}>{content}</td>;
    return <td key={k} {...td} className={`editable ${extra.className || ''}`.trim()} title="Click to edit" tabIndex={0}
      onClick={(e) => { e.stopPropagation(); setCellEd({ id: r.id, k }); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setCellEd({ id: r.id, k }); } }}>{content}</td>;
  };
  const dataCells = (r0, idx) => { const r = idx === undefined ? r0 : { ...r0, __i: idx }; return [
    editCell(r, 'plug_date', r.plug_date ? dateLabel(r.plug_date) : '', { 'data-label': 'Date', className: 'nowrap' }),
    editCell(r, 'plug_id', <>{r.plug_id}{r.is_additional ? <span className="chip c-orange plug-add" title="Listed under “Additional for …”">Added</span> : null}</>, { 'data-label': 'Plug ID', className: 'mono' }),
    editCell(r, 'prog_name', r.prog_name, { 'data-label': 'PROG. NAME / PROJ. TITLE' }),
    editCell(r, 'psd', r.psd, { 'data-label': 'PSD' }),
    <td key="requested_by" data-label="Requested By">{r.requested_by}</td>,
    <td key="in_workload" data-label="In Workload" className="plug-inwl">{r.id === 'draft' ? null : r.in_workload ? <span className="chip c-green">In workload</span> : <span className="dim">—</span>}</td>,
  ]; };

  return (
    <div className={`plug-list${full ? ' full' : ''}`}>
      <div className="plug-bar">
        <label className="wl-search">
          <SearchIcon />
          <input type="search" placeholder="Search plugs…" title="Search plug ID, program, PSD" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <FiltersMenu count={filtCount} onClear={() => setFilt({ in_workload: '', psd: '', account_by: '' })}>
          <FilterSelect label="In workload" value={filt.in_workload} onChange={setF('in_workload')}><Options list={[{ value: 'yes', label: 'In workload' }, { value: 'no', label: 'Not in workload' }]} blank="All" /></FilterSelect>
          <FilterSelect label="PSD" value={filt.psd} onChange={setF('psd')}><Options list={opts.psd} blank="All" /></FilterSelect>
          <FilterSelect label="Account by" value={filt.account_by} onChange={setF('account_by')}><Options list={opts.account_by} blank="All" /></FilterSelect>
        </FiltersMenu>
        <PlugDate period={period} anchor={anchor} range={range} custom={custom} onCustom={pickCustom} onPeriod={setPeriod} />
        {period === 'day' || period === 'week' || period === 'month' ? (
          <div className="plug-date">
            <button type="button" className="btn sm" disabled={!canPrev} onClick={() => go(-1)} title={`Previous ${period === 'day' ? 'day with a list' : period}`}>‹</button>
            <button type="button" className="btn sm" disabled={!canNext} onClick={() => go(1)} title={`Next ${period === 'day' ? 'day with a list' : period}`}>›</button>
          </div>
        ) : null}
        <span className="grow" />
        <div className="wl-presence"><PresenceAvatars path="/plug-list" /></div>
        <div className="wl-iconbar">
          {canWrite ? <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={(e) => pickFile(e.target.files[0])} /> : null}
          {canWrite ? <button type="button" className="btn ibtn primary" id="add-plug-btn" aria-label="Add Plug" title="Add Plug" onClick={() => setAdding(true)}><PlusIcon /></button> : null}
          {canWrite ? <button type="button" className="btn ibtn" id="import-btn" aria-label="Import Plug List" title={importing ? 'Importing…' : 'Import Plug List'} disabled={importing} onClick={() => fileRef.current.click()}><UploadIcon /></button> : null}
          <ExportButton onExport={exportXlsx} disabled={!total}><DownloadIcon /></ExportButton>
          {canWrite && (pickedCount || allMatching) ? (
            <button type="button" className="btn ibtn danger" id="delete-selected-btn" onClick={removeChosen} aria-label="Delete selected plugs" title={`Delete Selected (${allMatching ? total : pickedCount})`}><TrashIcon /></button>
          ) : null}
          <button type="button" className="btn ibtn" id="full-btn" aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'} onClick={() => setFull((f) => !f)}>
            {full ? <ExitFullscreenIcon /> : <FullscreenIcon />}
          </button>
          {canWrite ? (
            <ToolMenu items={[
              { id: 'add-row-menu', label: 'Add Row', icon: <PlusIcon />, onClick: addDraft },
              isAdminUser && { id: 'delete-all-menu', label: 'Delete All…', icon: <TrashIcon />, onClick: () => setDeletingAll(true) },
            ]} />
          ) : null}
        </div>
      </div>

      {data === null || days === null ? <Empty>Loading…</Empty>
        : !totals.plugs ? (
          <Empty>
            No PSD Daily Plug List yet.{canWrite ? ' Use “Import Plug List” and pick the PSD’s daily plug list workbook (one sheet per day).' : ' Ask someone who can edit the Workload Tracker to import it.'}
          </Empty>
        ) : (
          <>
            {canWrite && isAdminUser && ((allOn && total > rows.length) || allMatching) ? (
              <div className="sel-banner" role="status">
                {allMatching
                  ? <>All <strong>{total}</strong> plug{total === 1 ? '' : 's'} in this view are selected. <button type="button" className="linklike" onClick={clearPicks}>Clear selection</button></>
                  : <>All <strong>{rows.length}</strong> on this page are selected. <button type="button" className="linklike" id="select-all-matching" onClick={() => setAllMatching(true)}>Select all {total} in this view</button></>}
              </div>
            ) : null}
            <div className={`table-wrap${narrow ? '' : ' wl-fit'}`} onClickCapture={(e) => { if (suppress.current) { suppress.current = false; e.stopPropagation(); e.preventDefault(); return; } if (canWrite && picked.size && !(e.target.closest && e.target.closest('.rn, .chk, .plug-actions'))) clearPicks(); }}>
              <table className={`t wl plug-t${narrow ? ' cards' : ''}`}>
                <thead>
                  <tr>
                    {canWrite && !narrow ? <th className="rn" title={allOn ? 'Click to unselect all' : 'Select every plug on this page (Ctrl+A)'} onClick={() => (allOn ? clearPicks() : setPicked(new Set(rows.map((r) => r.id))))} /> : null}
                    {canWrite && narrow ? <th className="chk"><input type="checkbox" checked={allOn} disabled={!rows.length} onChange={() => setPicked(allOn ? new Set() : new Set(rows.map((r) => r.id)))} title="Select every plug on this page" /></th> : null}
                    <SortTh k="plug_date" sort={sort} onSort={setSort}>DATE</SortTh><SortTh k="plug_id" sort={sort} onSort={setSort}>PLUG ID</SortTh><SortTh k="prog_name" sort={sort} onSort={setSort}>PROG. NAME / PROJ. TITLE</SortTh><SortTh k="psd" sort={sort} onSort={setSort}>PSD</SortTh><SortTh k="requested_by" sort={sort} onSort={setSort}>REQUESTED BY</SortTh><SortTh k="in_workload" sort={sort} onSort={setSort} className="plug-inwl">IN WORKLOAD</SortTh>{canWrite ? <th className="plug-actions" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {draft ? (
                    <tr key="draft" className="draft-row" data-draft="1">
                      {!narrow ? <td className="rn" title="New row — not saved yet">＋</td> : <td className="chk" />}
                      {dataCells(draft)}
                      
                      <td className="plug-actions nowrap" onClick={(e) => e.stopPropagation()}>
                        <button type="button" className="btn primary" style={{ padding: '4px 10px' }} id="draft-save" onClick={saveDraft}>Save</button>{' '}
                        <button type="button" className="btn" style={{ padding: '4px 10px' }} id="draft-discard" onClick={() => { setDraft(null); setCellEd(null); }}>Discard</button>
                      </td>
                    </tr>
                  ) : null}
                  {rows.length ? rows.map((r, i) => (
                    <tr key={r.id} data-id={r.id} className={`${r.in_workload ? 'done' : ''}${picked.has(r.id) ? ' picked' : ''}`.trim()}
                      onMouseDown={canWrite ? cellDown : undefined} onContextMenu={canWrite ? (e) => rowMenu(e, r) : undefined}>
                      {canWrite && !narrow ? <td className={`rn${picked.has(r.id) ? ' hl' : ''}`} onMouseDown={(e) => numDown(e, r, i)} title="Click to select the row (Shift-click a range, Ctrl-click to add; Ctrl+C copies, Ctrl+V pastes)">{offset + i + 1}</td> : null}
                      {canWrite && narrow ? <td className="chk"><input type="checkbox" checked={picked.has(r.id)} onChange={() => { setPicked((cur) => { const n = new Set(cur); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; }); lastPick.current = r.id; }} aria-label={`Select ${r.plug_id}`} /></td> : null}
                      {dataCells(r, i)}
                      {canWrite ? (
                        <td className="plug-actions" onClick={(e) => e.stopPropagation()}>
                          <RowMenu onEdit={() => setEditing(r)} onDelete={() => removePlug(r)} />
                        </td>
                      ) : null}
                    </tr>
                  )) : !draft ? <tr><td colSpan={canWrite ? 8 : 6} className="empty">{query ? 'No plugs match that search.' : period === 'day' ? 'No plugs on this day.' : 'No plugs in this period.'}</td></tr> : null}
                </tbody>
              </table>
            </div>
            {ctx ? (
              <CellMenu x={ctx.x} y={ctx.y} onContextMenu={(e) => e.preventDefault()}>
                <button type="button" disabled={!hist.current.past.length} onClick={() => { setCtx(null); undo(); }}>Undo<span>Ctrl+Z</span></button>
                <button type="button" disabled={!hist.current.future.length} onClick={() => { setCtx(null); redo(); }}>Redo<span>Ctrl+Y</span></button>
                <hr />
                <button type="button" disabled={!picked.size} onClick={() => { setCtx(null); cutChosen(); }}>Cut<span>Ctrl+X</span></button>
                <button type="button" disabled={!picked.size} onClick={() => { setCtx(null); copyChosen(); }}>Copy<span>Ctrl+C</span></button>
                <button type="button" onClick={() => menuPaste()}>{picked.size ? 'Paste (replace row)' : 'Paste'}<span>Ctrl+V</span></button>
                <button type="button" disabled={!picked.size} onClick={() => menuPaste('above')}>Paste as new row above</button>
                <button type="button" disabled={!picked.size} onClick={() => menuPaste('below')}>Paste as new row below</button>
                <hr />
                <button type="button" disabled={!pickedCount} onClick={() => { setCtx(null); deleteChosen(); }}>Delete {pickedCount > 1 ? `${pickedCount} rows` : 'row'}<span>Del</span></button>
              </CellMenu>
            ) : null}
            {(() => {
              const rowsSel = (
                <label className="rows-sel"><span>Rows</span>
                  <select value={size} onChange={(e) => setSize(e.target.value)} aria-label="Rows per page"><Options list={SIZES} /></select>
                </label>
              );
              return size === 'all' || total <= limit
                ? <div className="pager"><span>{total ? `${total} plug${total === 1 ? '' : 's'}${size === 'all' && total > ALL_CAP ? ` (showing the first ${ALL_CAP})` : ''}` : ''}</span>{rowsSel}</div>
                : <Pager total={total} offset={offset} size={limit} onOffset={setOffset} lead={rowsSel} />;
            })()}
          </>
        )}

      {needYear ? (
        <Modal title="Which year is this plug list for?" onClose={() => setNeedYear(null)}
          footer={(<><span className="grow" /><button type="button" className="btn" onClick={() => setNeedYear(null)}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => { const f = needYear; setNeedYear(null); upload(f, year); }}>Import</button></>)}>
          <p>The plug list only has month and day (“September 28”), and the file name doesn’t include a year.</p>
          <label className="f"><span>Year</span><input type="number" min="2000" max="2100" value={year} onChange={(e) => setYear(e.target.value)} /></label>
        </Modal>
      ) : null}

      {summary ? (
        <Modal title="Plug list imported" onClose={() => setSummary(null)} footer={(<><span className="grow" /><button type="button" className="btn primary" onClick={() => setSummary(null)}>Done</button></>)}>
          <p>
            <strong>{summary.added}</strong> new plug{summary.added === 1 ? '' : 's'} across <strong>{summary.days}</strong> day{summary.days === 1 ? '' : 's'} ({summary.year})
            {summary.existing ? <>; {summary.existing} {summary.existing === 1 ? 'was' : 'were'} already on the list</> : null}
            {summary.skipped ? <>; {summary.skipped} line{summary.skipped === 1 ? '' : 's'} skipped (no Plug ID)</> : null}.
          </p>
          {summary.copied ? <p><strong>{summary.copied.created}</strong> plug{summary.copied.created === 1 ? '' : 's'} copied to the Workload Tracker (Units Concerned left blank — set it there){summary.copied.already ? <>; {summary.copied.already} already {summary.copied.already === 1 ? 'was' : 'were'} there</> : null}{summary.copied.locked ? <>; {summary.copied.locked} skipped because the day is locked</> : null}.</p> : null}
          {summary.workloadRowsFilled ? <p><strong>{summary.workloadRowsFilled}</strong> row{summary.workloadRowsFilled === 1 ? '' : 's'} already in the Workload Tracker had a Plug ID but no PSD / PROG. NAME / PROJ. TITLE — now filled in from this list.</p> : null}
          {summary.warnings && summary.warnings.length ? <ul className="plug-warn">{summary.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
          <div className="plug-sum">
            {summary.sheets.map((s) => <div key={s.sheet + s.date}><span>{dateLabel(s.date)}</span><span className="dim">{s.plugs} plugs{s.added ? ` · ${s.added} new` : ''}{s.additional ? ` · ${s.additional} added late` : ''}</span></div>)}
          </div>
        </Modal>
      ) : null}

      {deletingAll ? (
        <DeleteAllPlugs
          viewTotal={total}
          listTotal={totals.plugs}
          hasView={!!(range.from || range.to || query)}
          viewText={[range.from && range.to && range.from === range.to ? `Day: ${fmtDate(range.from)}` : (range.from || range.to) && `Dates: ${range.from ? fmtDate(range.from) : '…'} → ${range.to ? fmtDate(range.to) : '…'}`, query && `Search: “${query}”`].filter(Boolean)}
          view={{ from: range.from || undefined, to: range.to || undefined, q: query || undefined }}
          onClose={() => setDeletingAll(false)}
          onDone={async (n) => { setDeletingAll(false); clearPicks(); toast(`${n} plug${n === 1 ? '' : 's'} deleted`); await loadDays(); loadRows(); }} />
      ) : null}

      {adding || editing ? (
        <PlugModal date={period === 'day' ? anchor : ''} plug={editing} onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={async (d, out) => {
            setAdding(false); setEditing(null);
            if (editing) { if (out && out.workloadRowsFilled) toast(`${out.workloadRowsFilled} Workload row${out.workloadRowsFilled === 1 ? '' : 's'} filled in from this plug`); }
            else if (out && out.copied && out.copied.created) toast('Plug added and copied to the Workload Tracker (set its Units Concerned there)');
            else if (out && out.copied && out.copied.locked) toast('Plug added — not copied to the Workload Tracker because that day is locked', 'err');
            else toast(out && out.workloadRowsFilled ? `Plug added — ${out.workloadRowsFilled} Workload row${out.workloadRowsFilled === 1 ? '' : 's'} filled in from it` : 'Plug added');
            await loadDays();
            if (d && period !== 'all' && period !== 'custom' && (d < range.from || d > range.to)) setAnchor(d);   // a plug on another day: go there
            loadRows();
          }} />
      ) : null}
    </div>
  );
}

// Admin: delete every plug the current view shows (its days and search), or the whole list. Typed DELETE to confirm.
function DeleteAllPlugs({ viewTotal, listTotal, hasView, viewText, view, onClose, onDone }) {
  const toast = useToast();
  const [scope, setScope] = useState('view');   // 'view' | 'all'
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const wholeList = scope === 'all' || !hasView;   // a view with no days or search narrowing it IS the whole list
  const n = wholeList ? listTotal : viewTotal;
  const go = async () => {
    setBusy(true);
    try {
      const out = await post('/api/plugs/delete-all', wholeList ? { scope: 'all' } : { scope: 'range', ...view });
      onDone(out.deleted);
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal title="Delete all plugs" onClose={() => { if (!busy) onClose(); }}
      footer={(<><span className="grow" /><button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn danger" disabled={busy || typed.trim() !== 'DELETE' || !n} onClick={go}>Delete {n} plug{n === 1 ? '' : 's'}</button></>)}>
      {hasView ? (
        <div className="stack" style={{ marginBottom: 10 }}>
          <label className="check"><input type="radio" name="dp-scope" checked={scope === 'view'} onChange={() => setScope('view')} /> {' '}This view: <strong>{viewTotal}</strong> plug{viewTotal === 1 ? '' : 's'} ({viewText.join(', ')})</label>
          <label className="check"><input type="radio" name="dp-scope" checked={scope === 'all'} onChange={() => setScope('all')} /> {' '}The whole list, every day: <strong>{listTotal}</strong> plug{listTotal === 1 ? '' : 's'}</label>
        </div>
      ) : <p>This permanently deletes the <strong>whole list</strong>, every day: <strong>{listTotal}</strong> plug{listTotal === 1 ? '' : 's'}.</p>}
      <p>Workload rows already made from these plugs are not touched. It cannot be undone — consider an Export first.</p>
      <label className="f"><span>Type <strong>DELETE</strong> to confirm</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim() === 'DELETE' && !busy && n) go(); }} /></label>
    </Modal>
  );
}

function PlugModal({ date, plug, onClose, onSaved }) {
  const toast = useToast();
  const [f, , setF] = useForm(plug
    ? { plug_date: plug.plug_date, plug_id: plug.plug_id, prog_name: plug.prog_name || '', psd: plug.psd || '' }
    : { plug_date: date || isoDate(), plug_id: '', prog_name: '', psd: '' }, 'plugs');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    if (!f.plug_id.trim()) { toast('Plug ID is required', 'err'); return; }
    setBusy(true);
    try {
      const out = plug ? await put(`/api/plugs/${plug.id}`, f) : await post('/api/plugs', f);
      if (plug) toast('Plug updated');   // a new plug's message (added / copied to the Workload Tracker) comes from onSaved, so there is only one
      onSaved(f.plug_date, out);
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal title={plug ? 'Edit plug' : 'Add Plug'} onClose={onClose} footer={(<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={save}>{plug ? 'Save' : 'Add'}</button></>)}>
      <form className="form-grid" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="f"><span>Date <span className="req">*</span></span><input type="date" value={f.plug_date} onChange={set('plug_date')} /></label>
        <label className="f"><span>Plug ID <span className="req">*</span></span><input value={f.plug_id} onChange={set('plug_id')} maxLength={200} autoFocus /></label>
        <label className="f full"><span>PROG. NAME / PROJ. TITLE</span><input value={f.prog_name} onChange={set('prog_name')} maxLength={300} autoComplete="off" /></label>
        <label className="f"><span>PSD</span><input value={f.psd} onChange={set('psd')} maxLength={200} /></label>
      </form>
      {plug ? <p className="dim m-0 mt-12">Workload rows already filled from this plug keep what they have; only blank PSD / PROG. NAME fields get filled.</p> : null}
    </Modal>
  );
}
