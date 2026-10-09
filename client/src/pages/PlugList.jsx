import { useCallback, useEffect, useRef, useState } from 'react';
import { del, get, post, put } from '../lib/api.js';
import { downloadFile, fmtDate, isoDate } from '../lib/util.js';
import { DownloadIcon, PlusIcon, SearchIcon, UploadIcon } from '../components/Icons.jsx';
import { FilterSelect, Pager, SortTh, useNarrow } from '../components/wl.jsx';
import { useSession } from '../context.jsx';
import PlugGrid from '../components/PlugGrid.jsx';
import { Empty, Modal, Options, useConfirm, useDebounced, useToast } from '../components/ui.jsx';

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

const PERIODS = [
  { value: 'all', label: 'All' }, { value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' }, { value: 'custom', label: 'Custom range' },
];
const SIZES = [{ value: '25', label: '25' }, { value: '50', label: '50' }, { value: '100', label: '100' }, { value: '250', label: '250' }, { value: '500', label: '500' }, { value: 'all', label: 'All' }];
const ALL_CAP = 5000;   // "All rows" shows at most this many at once (the server's limit)

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
  if (period === 'custom') return r.from || r.to ? `${r.from ? fmtDate(r.from) : '…'} – ${r.to ? fmtDate(r.to) : '…'}` : 'All days';
  return 'All days';
};
const stored = (k, fallback, allowed) => { try { const v = localStorage.getItem(`plugs:${k}`); return allowed.includes(v) ? v : fallback; } catch (e) { return fallback; } };
// Table / Excel is kept across a refresh only while you stay signed in (the same rule as the Workload Tracker): it is stored with the sign-in's key,
// removed at logout, and a different sign-in finds nothing and opens in Table mode.
const MODE_KEY = 'plugs:mode';
const readMode = (key) => { try { const v = JSON.parse(localStorage.getItem(MODE_KEY)); return key && v && v.k === key && v.m === 'excel' ? 'excel' : 'table'; } catch (e) { return 'table'; } };
const saveMode = (key, m) => { if (!key) return; try { localStorage.setItem(MODE_KEY, JSON.stringify({ k: key, m })); } catch (e) { /* storage unavailable */ } };
const remember = (k, v) => { try { localStorage.setItem(`plugs:${k}`, v); } catch (e) { /* storage unavailable */ } };

export default function PlugList({ canWrite, canWorkload, onCopied }) {
  const toast = useToast();
  const confirm = useConfirm();
  const session = useSession();
  const fileRef = useRef(null);
  const [days, setDays] = useState(null);            // [{ date, n }] newest first (the latest 366 days with a list); null = loading
  const [totals, setTotals] = useState({ plugs: 0, days: 0, first: '', last: '' });   // across every day
  const [period, setPeriodState] = useState(() => stored('period', 'day', PERIODS.map((p) => p.value)));
  const [size, setSizeState] = useState(() => stored('size', '50', SIZES.map((s) => s.value)));
  const [anchor, setAnchor] = useState('');          // the day / a day of the week / of the month being looked at
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);
  const [data, setData] = useState(null);            // { rows, total }; null = loading
  const [picked, setPicked] = useState(() => new Set());   // ticked rows (Table mode) for Delete selected
  const [importing, setImporting] = useState(false);
  const [needYear, setNeedYear] = useState(null);    // file waiting for a year (its name has none)
  const [year, setYear] = useState(new Date().getFullYear());
  const [summary, setSummary] = useState(null);      // result of the last import
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);      // the plug being edited
  const [filling, setFilling] = useState(false);
  const [mode, setModeState] = useState(() => (canWrite ? readMode(session.session_key) : 'table'));   // Table or Excel (Excel is for people who can edit)
  const isGrid = mode === 'excel' && canWrite;
  const [gridDirty, setGridDirty] = useState(0);        // unsaved rows in the Excel grid
  const tbRef = useRef(null);                            // the grid's Add Row / Save / Delete actions
  const [, setTbSig] = useState('');
  const registerToolbar = useCallback((tb) => { tbRef.current = tb; setTbSig(tb ? `${tb.dirtyCount}|${tb.saving}|${tb.selCount}|${tb.wholeRows}` : ''); }, []);
  const okToLeave = async () => gridDirty === 0
    || !!(await confirm('Discard unsaved changes?', `${gridDirty} row${gridDirty === 1 ? '' : 's'} in the grid ${gridDirty === 1 ? 'has' : 'have'} unsaved changes. Leave without saving?`, { okText: 'Discard', danger: true }));
  const changeMode = async (m) => { if (m === mode || !(await okToLeave())) return; setModeState(m); saveMode(session.session_key, m); setPicked(new Set()); };

  const range = rangeOf(period, anchor, custom);
  const limit = size === 'all' ? ALL_CAP : Number(size);
  const narrow = useNarrow();
  const [sort, setSort] = useState({ k: '', dir: 'asc' });   // clicked column header
  const viewKey = `${period}|${range.from}|${range.to}|${query}|${size}|${sort.k}|${sort.dir}`;
  const [pageState, setPageState] = useState({ key: '', offset: 0 });   // the page resets to the first whenever the view changes
  const offset = pageState.key === viewKey ? pageState.offset : 0;
  const setOffset = async (o) => { if (!(await okToLeave())) return; setPageState({ key: viewKey, offset: o }); };
  const setPeriod = async (p) => { if (!(await okToLeave())) return; setPeriodState(p); remember('period', p); };
  const setSize = async (s) => { if (!(await okToLeave())) return; setSizeState(s); remember('size', s); };

  const loadDays = useCallback(async () => {
    try {
      const out = await get('/api/plugs/dates');
      setDays(out.dates);
      setTotals({ plugs: out.total ?? 0, days: out.days ?? out.dates.length, first: out.first || '', last: out.last || '' });
      setAnchor((cur) => {   // first visit: today if it has a list, else the latest day that does
        if (cur) return cur;
        const today = isoDate();
        return (out.dates.find((x) => x.date === today) || out.dates[0] || {}).date || today;
      });
    } catch (e) { setDays([]); toast(e.message, 'err'); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadDays(); }, [loadDays]);

  const loadRows = useCallback(async () => {
    if (!anchor) return;
    try {
      const p = new URLSearchParams({ used: '1', limit: String(limit), offset: String(offset), order: period === 'all' ? 'desc' : 'asc' });
      if (range.from) p.set('from', range.from);
      if (range.to) p.set('to', range.to);
      if (query) p.set('q', query);
      if (sort.k) { p.set('sort', sort.k); p.set('dir', sort.dir); }
      setData(await get(`/api/plugs?${p}`));
    } catch (e) { setData({ rows: [], total: 0 }); toast(e.message, 'err'); }
  }, [anchor, range.from, range.to, query, limit, offset, period, sort.k, sort.dir]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); setPicked(new Set()); loadRows(); }, [loadRows]);
  const exportXlsx = async () => {   // the days and search on screen, in the sort on screen
    const p = new URLSearchParams({ order: period === 'all' ? 'desc' : 'asc' });
    if (range.from) p.set('from', range.from);
    if (range.to) p.set('to', range.to);
    if (query) p.set('q', query);
    if (sort.k) { p.set('sort', sort.k); p.set('dir', sort.dir); }
    try { await downloadFile(`/api/plugs/export?${p}`, 'PSD_Plug_List.xlsx'); } catch (e) { toast(e.message, 'err'); }
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

  // Existing Workload rows with a Plug ID but no PSD / PROG. NAME / PROJ. TITLE: fill them from the lists (also happens by itself on import / restart)
  const fillExisting = async () => {
    setFilling(true);
    try {
      const out = await post('/api/plugs/fill', {});
      toast(out.filled ? `${out.filled} Workload row${out.filled === 1 ? '' : 's'} filled in from the plug list` : 'Nothing to fill — every Workload row with a matching Plug ID already has its PSD and PROG. NAME / PROJ. TITLE');
      if (out.filled && onCopied) onCopied(out);
    } catch (e) { toast(e.message, 'err'); } finally { setFilling(false); }
  };
  const removePlug = async (r) => {
    if (!(await confirm('Delete plug', `Remove "${r.plug_id}" from the ${fmtDate(r.plug_date)} list? Workload rows already made from it are not touched.`, { okText: 'Delete', danger: true }))) return;
    try { await del(`/api/plugs/${r.id}`); toast('Deleted'); await loadDays(); loadRows(); } catch (e) { toast(e.message, 'err'); }
  };

  const rows = data ? data.rows : [];
  const chosen = rows.filter((r) => picked.has(r.id));
  const allOn = !!rows.length && rows.every((r) => picked.has(r.id));
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const removeChosen = async () => {
    if (!chosen.length) return;
    if (!(await confirm('Delete plugs', `Remove the ${chosen.length} selected plug${chosen.length === 1 ? '' : 's'} from the list? Workload rows already made from them are not touched.`, { okText: 'Delete', danger: true }))) return;
    try {
      const out = await post('/api/plugs/delete-selected', { ids: chosen.map((r) => r.id) });
      toast(`${out.deleted} plug${out.deleted === 1 ? '' : 's'} deleted`); setPicked(new Set()); await loadDays(); loadRows();
    } catch (e) { toast(e.message, 'err'); }
  };
  const total = data ? data.total : 0;
  const viewLabel = `${rangeLabel(period, range, anchor)}${query ? ` · “${query}”` : ''}`;

  return (
    <div className="plug-list">
      <div className="plug-bar">
        <FilterSelect label="View" value={period} onChange={(e) => setPeriod(e.target.value)}><Options list={PERIODS} /></FilterSelect>
        {period === 'day' || period === 'week' || period === 'month' ? (
          <div className="plug-date">
            <button type="button" className="btn sm" disabled={!canPrev} onClick={() => go(-1)} title={`Previous ${period === 'day' ? 'day with a list' : period}`}>‹</button>
            <button type="button" className="btn sm" disabled={!canNext} onClick={() => go(1)} title={`Next ${period === 'day' ? 'day with a list' : period}`}>›</button>
            <span className="plug-range">{rangeLabel(period, range, anchor)}</span>
          </div>
        ) : null}
        {period === 'custom' ? (
          <div className="plug-date">
            <label className="plug-from">From <input type="date" value={custom.from} max={custom.to || undefined} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></label>
            <label className="plug-from">To <input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></label>
          </div>
        ) : null}
        {!isGrid ? (
          <label className="wl-search">
            <SearchIcon />
            <input type="search" placeholder="Search plugs…" title="Search plug ID, program, PSD" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        ) : null}
        <span className="grow" />
        {canWrite ? (
          <div className="segmented" id="mode-seg">
            <button type="button" className={mode === 'table' ? 'on' : ''} onClick={() => changeMode('table')}>Table</button>
            <button type="button" className={mode === 'excel' ? 'on' : ''} onClick={() => changeMode('excel')}>Excel</button>
          </div>
        ) : null}
        {!canWrite ? <button type="button" className="btn" onClick={exportXlsx} disabled={!total}><DownloadIcon /> Export</button> : null}
        {canWrite ? (
          <>
            <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => pickFile(e.target.files[0])} />
            <button type="button" className="btn" disabled={importing} onClick={() => fileRef.current.click()}><UploadIcon /> {importing ? 'Importing…' : 'Import Plug List'}</button>
            {isGrid ? (
              <>
                <button type="button" className="btn" id="add-row" onClick={() => tbRef.current && tbRef.current.addRow()}><PlusIcon /> Add Row</button>
                {tbRef.current && tbRef.current.selCount && tbRef.current.wholeRows ? <button type="button" className="btn danger" data-keep-sel onClick={() => tbRef.current.deleteRows()}>Delete {tbRef.current.selCount > 1 ? `${tbRef.current.selCount} Rows` : 'Row'}</button> : null}
              </>
            ) : <button type="button" className="btn" onClick={() => setAdding(true)}><PlusIcon /> Add Plug</button>}
            <button type="button" className="btn" onClick={exportXlsx} disabled={!total}><DownloadIcon /> Export</button>
            {canWorkload ? <button type="button" className="btn" disabled={filling} onClick={fillExisting}
              title="Rows already in the Workload Tracker that have a Plug ID but a blank PSD or PROG. NAME / PROJ. TITLE get them from this list (anything typed is kept)">{filling ? 'Filling…' : 'Fill Blank Rows'}</button> : null}
            {canWrite && !isGrid ? (
              <button type="button" className="btn danger" id="delete-selected-btn" disabled={!chosen.length} onClick={removeChosen} title="Delete the plugs ticked in the table">
                {chosen.length ? `Delete Selected (${chosen.length})` : 'Delete Selected'}
              </button>
            ) : null}
            {isGrid ? (
              <button type="button" className="btn primary" id="save-grid" disabled={!tbRef.current || tbRef.current.saving || !gridDirty} onClick={() => tbRef.current && tbRef.current.save()}>
                {tbRef.current && tbRef.current.saving ? 'Saving…' : `Save changes${gridDirty ? ` (${gridDirty})` : ''}`}
              </button>
            ) : null}
          </>
        ) : null}
      </div>

      {data === null || days === null ? <Empty>Loading…</Empty>
        : !totals.plugs && !isGrid ? (
          <Empty>
            No PSD Daily Plug List yet.{canWrite ? ' Use “Import Plug List” and pick the PSD’s daily plug list workbook (one sheet per day).' : ' Ask someone who can edit the Workload Tracker to import it.'}
          </Empty>
        ) : (
          <>
            {isGrid && data ? (
              <PlugGrid source={data} canWrite={canWrite} me={(session.user && (session.user.full_name || session.user.username)) || ''} defaultDate={period === 'day' ? anchor : ''} limit={limit} onDirty={setGridDirty} registerToolbar={registerToolbar}
                onSaved={async () => { await loadDays(); loadRows(); }} />
            ) : (
            <div className="table-wrap">
              <table className={`t wl plug-t${narrow ? ' cards' : ''}`}>
                <thead>
                  <tr>
                    {canWrite ? <th className="chk"><input type="checkbox" checked={allOn} disabled={!rows.length} onChange={() => setPicked(allOn ? new Set() : new Set(rows.map((r) => r.id)))} title="Select every plug on this page" /></th> : null}
                    <SortTh k="plug_date" sort={sort} onSort={setSort}>DATE</SortTh><SortTh k="plug_id" sort={sort} onSort={setSort}>PLUG ID</SortTh><SortTh k="prog_name" sort={sort} onSort={setSort}>PROG. NAME / PROJ. TITLE</SortTh><SortTh k="psd" sort={sort} onSort={setSort}>PSD</SortTh><SortTh k="account_by" sort={sort} onSort={setSort}>ACCOUNT BY</SortTh><SortTh k="requested_by" sort={sort} onSort={setSort}>REQUESTED BY</SortTh><SortTh k="in_workload" sort={sort} onSort={setSort} className="plug-inwl">IN WORKLOAD</SortTh>{canWrite ? <th className="plug-actions">Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {rows.length ? rows.map((r, i) => (
                    <tr key={r.id} className={r.in_workload ? 'done' : ''}>
                      {canWrite ? <td className="chk"><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.plug_id}`} /></td> : null}
                      <td data-label="Date" className="nowrap">{dateLabel(r.plug_date)}</td>
                      <td data-k="plug_id" data-label="Plug ID" className="mono">{r.plug_id}{r.is_additional ? <span className="chip c-orange plug-add" title="Listed under “Additional for …”">Added</span> : null}</td>
                      <td data-label="PROG. NAME / PROJ. TITLE">{r.prog_name}</td>
                      <td data-label="PSD">{r.psd}</td>
                      <td data-label="Account By">{r.account_by}</td>
                      <td data-label="Requested By">{r.requested_by}</td>
                      <td data-label="In Workload" className="plug-inwl">{r.in_workload ? <span className="chip c-green">In workload</span> : <span className="dim">—</span>}</td>
                      {canWrite ? (
                        <td className="plug-actions">
                          <button type="button" className="btn sm ghost" onClick={() => setEditing(r)}>Edit</button>
                          <button type="button" className="btn sm ghost" onClick={() => removePlug(r)}>Delete</button>
                        </td>
                      ) : null}
                    </tr>
                  )) : <tr><td colSpan={canWrite ? 9 : 7} className="empty">{query ? 'No plugs match that search.' : period === 'day' ? 'No plugs on this day.' : 'No plugs in this period.'}</td></tr>}
                </tbody>
              </table>
            </div>
            )}
            <div className="plug-foot">
              <FilterSelect label="Rows" value={size} onChange={(e) => setSize(e.target.value)}><Options list={SIZES} /></FilterSelect>
              <div className="grow">
                {size === 'all' || total <= limit
                  ? <div className="pager"><span>{total ? `${total} plug${total === 1 ? '' : 's'}${size === 'all' && total > ALL_CAP ? ` (showing the first ${ALL_CAP})` : ''}` : ''}</span></div>
                  : <Pager total={total} offset={offset} size={limit} onOffset={setOffset} />}
              </div>
            </div>
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

function PlugModal({ date, plug, onClose, onSaved }) {
  const toast = useToast();
  const [f, setF] = useState(plug
    ? { plug_date: plug.plug_date, plug_id: plug.plug_id, prog_name: plug.prog_name || '', psd: plug.psd || '', account_by: plug.account_by || '' }
    : { plug_date: date || isoDate(), plug_id: '', prog_name: '', psd: '', account_by: '' });
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
        <label className="f"><span>Account By</span><input value={f.account_by} onChange={set('account_by')} maxLength={100} /></label>
      </form>
      {plug ? <p className="dim m-0 mt-12">Workload rows already filled from this plug keep what they have; only blank PSD / PROG. NAME fields get filled.</p> : null}
    </Modal>
  );
}
