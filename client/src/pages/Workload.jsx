import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, post, put } from '../lib/api.js';
import { fmtDate, isoDate } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { DownloadIcon, PlusIcon } from '../components/Icons.jsx';
import { Empty, Modal, Options, useConfirm, useDebounced, useForm, useToast } from '../components/ui.jsx';

// Workload Tracker — ONE table. "Units Concerned" says which team(s) a plug is for; the tabs
// (All / VGFX / VEDIT / Audio) are filters over it. Fields, per-tab columns and the Platform rules come
// from /api/workload/meta (field types follow the red notes in the Sept 2026 template:
// dropdown / Date / Open). Table mode = read + add/edit form; Excel mode = editable grid with batch save.
const PAGE = 50;
const GRID_LIMIT = 200;
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

function FieldInput({ def, value, onChange, disabled, lookups }) {
  const v = value ?? '';
  if (def.kind === 'audio_guide') return <AudioGuideInput value={v} onChange={onChange} disabled={disabled} />;
  if (def.kind === 'date') return <input type="date" value={v} disabled={disabled} onChange={onChange} />;
  if (def.kind === 'select') {
    const list = def.lookup ? withCurrent(lookups[def.lookup] || [], v) : def.options;
    return <select value={v} disabled={disabled} onChange={onChange}><Options list={list} blank={def.required ? 'Select…' : '—'} /></select>;
  }
  if (def.multiline) return <textarea maxLength={def.max} placeholder={def.hint} value={v} disabled={disabled} onChange={onChange} />;
  return <input maxLength={def.max} placeholder={def.hint} value={v} disabled={disabled} onChange={onChange} />;
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
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);   // table mode: { total, rows } | { error }
  const [grid, setGrid] = useState(null);   // excel mode: { total, rows } | { error }
  const [form, setForm] = useState(null);   // null | { rec } (rec null = new)
  const [saving, setSaving] = useState(false);
  const q = useDebounced(filt.q, 300);
  const isGrid = mode === 'excel' && tab !== 'ALL';

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

  const load = useCallback(async () => {
    if (!meta) return;
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
  }, [meta, isGrid, query, offset]);

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
      a.download = `Workload_${tab === 'ALL' ? 'all' : tab}_${isoDate()}.xlsx`;
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

  if (!meta) return <main className="container"><Empty>Loading…</Empty></main>;

  const cols = meta.views[tab];
  const total = data && data.total ? data.total : 0;
  const cell = (r, k) => {
    const val = r[k];
    if (meta.fields[k].kind === 'date') return <td key={k} className="nowrap">{fmtDate(val)}</td>;
    if (k === 'audio_guide') return <td key={k} className="nowrap">{ISO.test(val || '') ? fmtDate(val) : val}</td>;
    if (k === 'units_concerned') return <td key={k} className="nowrap"><strong>{val}</strong></td>;
    if (k === 'plug_id') return <td key={k} className="cell-clip mono" title={val || ''}><strong>{val}</strong></td>;
    return <td key={k} className="cell-clip" title={val || ''}>{val}</td>;
  };

  return (
    <main className="container">
      <div className="page-head">
        <div><h1>Workload Tracker</h1><div className="sub">One table for VGFX, VEDIT and Audio — Units Concerned says which team(s) a plug is for.</div></div>
        <div className="actions">
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

      {!lookups.workload_platform.length || !lookups.plug_type.length ? (
        <div className="alert warn mb-12">
          {!lookups.workload_platform.length ? 'No Workload Platform options exist yet. ' : ''}
          {!lookups.plug_type.length ? 'No Plug Type options exist yet. ' : ''}
          {s.canPage('/admin') ? <>Add them in <Link to="/admin#dropdowns">Admin → Dropdowns</Link>.</> : 'Ask an Admin to add them.'}
        </div>
      ) : null}

      <div className="tabs" id="section-tabs">
        {meta.tabs.map((t) => <button key={t.key} type="button" className={tab === t.key ? 'on' : ''} onClick={() => changeTab(t.key)}>{t.label}</button>)}
      </div>

      <div className="card">
        <div className="filters">
          {!isGrid ? <input type="search" placeholder="Search plug ID, PSD, program, billable party, remarks…" value={filt.q} onChange={setF('q')} /> : null}
          <select value={filt.units} onChange={setF('units')} title="Units Concerned"><Options list={meta.units} blank="All units" /></select>
          <select value={filt.platform} onChange={setF('platform')}><Options list={lookups.workload_platform} blank="All platforms" /></select>
          <select value={filt.plug_type} onChange={setF('plug_type')}><Options list={lookups.plug_type} blank="All plug types" /></select>
          <input type="date" title="Work date from" value={filt.from} onChange={setF('from')} />
          <input type="date" title="Work date to" value={filt.to} onChange={setF('to')} />
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
                              <td key={k}>
                                <FieldInput def={meta.fields[k]} value={r[k]} lookups={lookups} disabled={!canWrite} onChange={(e) => setCell(r._key, k, e.target.value)} />
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
                      <table className="t">
                        <thead><tr>{cols.map((k) => <th key={k}>{meta.fields[k].label}</th>)}</tr></thead>
                        <tbody>
                          {data.rows.map((r) => (
                            <tr key={r.id} className="clickable" onClick={() => setForm({ rec: r })}>
                              {cols.map((k) => cell(r, k))}
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
          </>
        )}
      </div>

      {form ? (
        <WorkloadForm
          rec={form.rec}
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

function WorkloadForm({ rec, defaultUnits, meta, lookups, canWrite, onClose, onSaved }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const initial = Object.keys(meta.fields).reduce((o, k) => ({ ...o, [k]: (rec && rec[k]) ?? '' }), {});
  if (!rec) { initial.work_date = isoDate(); initial.units_concerned = defaultUnits; }
  const [f, , setAll] = useForm(initial);
  const set = (k) => (e) => {
    const val = e && e.target ? e.target.value : e;
    setAll((prev) => withAutoPlatform(meta.platformRules, prev, k, val));
  };

  // Audio-only units use the template's Audio sheet columns; everything else uses the main sheet columns
  const teams = meta.unitTeams[f.units_concerned] || [];
  const audioOnly = teams.length === 1 && teams[0] === 'AUDIO';
  const shown = f.units_concerned
    ? meta.views[audioOnly ? 'AUDIO' : 'VGFX'].filter((k) => k !== 'work_date' && k !== 'units_concerned')
    : [];
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
      title={rec ? `${canWrite ? 'Edit' : 'View'} Workload #${rec.id}` : 'New Workload'}
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
              <span>{def.label}{def.required ? <span className="req"> *</span> : null}</span>
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
