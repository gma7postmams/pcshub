import { useCallback, useEffect, useRef, useState } from 'react';
import { del, get, post, put } from '../lib/api.js';
import { fmtDate, isoDate } from '../lib/util.js';
import { PlusIcon, SearchIcon, UploadIcon } from '../components/Icons.jsx';
import { Empty, Modal, useConfirm, useDebounced, useToast } from '../components/ui.jsx';

// PSD Daily Plug List — the "PSD Daily Plug List" tab of the Workload Tracker. One list per day (imported from the PSD's daily plug
// list workbook: NO / PLUG ID / PROG NAME/PROJ TITLE / PSD / Account By). The Workload Tracker copies Plug ID, PSD and
// PROG. NAME / PROJ. TITLE from here: typing or picking a Plug ID fills the other two, and "Copy to Workload" makes a workload row
// for every plug of the day that isn't in the tracker yet.
const weekday = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
const dateLabel = (iso) => `${weekday(iso)}, ${fmtDate(iso)}`;

export default function PlugList({ canWrite, isAdmin, onCopied }) {
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef(null);
  const [dates, setDates] = useState(null);       // [{ date, n }] newest first; null = loading
  const [totals, setTotals] = useState({ plugs: 0, days: 0 });   // across every day (the dropdown is capped at the latest 366)
  const [deleting, setDeleting] = useState(false);
  const [date, setDate] = useState('');
  const [q, setQ] = useState('');
  const query = useDebounced(q, 250);
  const [rows, setRows] = useState(null);         // null = loading
  const [picked, setPicked] = useState(() => new Set());
  const [importing, setImporting] = useState(false);
  const [needYear, setNeedYear] = useState(null);  // File waiting for a year (its name has none)
  const [year, setYear] = useState(new Date().getFullYear());
  const [summary, setSummary] = useState(null);    // result of the last import
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);   // the plug being edited
  const [copying, setCopying] = useState(false);
  const [filling, setFilling] = useState(false);

  const loadDates = useCallback(async (keep) => {
    try {
      const out = await get('/api/workload/plugs/dates');
      const d = out.dates;
      setDates(d);
      setTotals({ plugs: out.total ?? d.reduce((n, x) => n + x.n, 0), days: out.days ?? d.length });
      setDate((cur) => {
        if (keep && cur && d.some((x) => x.date === cur)) return cur;
        const today = isoDate();
        return (d.find((x) => x.date === today) || d[0] || {}).date || '';
      });
    } catch (e) { setDates([]); toast(e.message, 'err'); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadDates(false); }, [loadDates]);

  const loadRows = useCallback(async () => {
    if (!date) { setRows([]); return; }
    try {
      const p = new URLSearchParams({ date, used: '1' });
      if (query) p.set('q', query);
      setRows((await get(`/api/workload/plugs?${p}`)).rows);
    } catch (e) { setRows([]); toast(e.message, 'err'); }
  }, [date, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(null); setPicked(new Set()); loadRows(); }, [loadRows]);

  const idx = dates ? dates.findIndex((x) => x.date === date) : -1;
  const step = (d) => { if (dates && dates[idx + d]) setDate(dates[idx + d].date); };   // dates are newest first: +1 = earlier day

  const upload = async (file, yr) => {
    const form = new FormData();
    form.append('file', file);
    if (yr) form.append('year', String(yr));
    setImporting(true);
    try {
      const out = await post('/api/workload/plugs/import', form);
      setSummary(out);
      toast(`${out.added} plug${out.added === 1 ? '' : 's'} added${out.existing ? `, ${out.existing} already there` : ''}${out.workloadRowsFilled ? ` — ${out.workloadRowsFilled} existing Workload row${out.workloadRowsFilled === 1 ? '' : 's'} filled in` : ''}`);
      await loadDates(true);
      if (out.sheets.length && !date) setDate(out.sheets[out.sheets.length - 1].date);
      loadRows();
    } catch (e) { toast(e.message, 'err'); } finally { setImporting(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const pickFile = (file) => {
    if (!file) return;
    if (/(?<!\d)20\d{2}(?!\d)/.test(file.name)) upload(file, null);   // "September_2026_Plug_List…" — the server reads the year from the name
    else setNeedYear(file);                                   // the list has no year in it: ask
  };

  // Existing Workload rows with a Plug ID but no PSD / PROG. NAME / PROJ. TITLE: fill them from the lists (also happens by itself on import / restart)
  const fillExisting = async () => {
    setFilling(true);
    try {
      const out = await post('/api/workload/plugs/fill', {});
      toast(out.filled ? `${out.filled} Workload row${out.filled === 1 ? '' : 's'} filled in from the plug list` : 'Nothing to fill — every Workload row with a matching Plug ID already has its PSD and PROG. NAME / PROJ. TITLE');
      if (out.filled && onCopied) onCopied(out);
    } catch (e) { toast(e.message, 'err'); } finally { setFilling(false); }
  };
  const removePlug = async (r) => {
    if (!(await confirm('Delete plug', `Remove "${r.plug_id}" from the ${fmtDate(r.plug_date)} list? Workload rows already made from it are not touched.`, { okText: 'Delete', danger: true }))) return;
    try { await del(`/api/workload/plugs/${r.id}`); toast('Deleted'); await loadDates(true); loadRows(); } catch (e) { toast(e.message, 'err'); }
  };

  const todo = rows ? rows.filter((r) => !r.in_workload) : [];
  const chosen = rows ? rows.filter((r) => picked.has(r.id)) : [];
  const toggle = (id) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allOn = !!todo.length && todo.every((r) => picked.has(r.id));

  return (
    <div className="plug-list">
      <div className="plug-bar">
        <div className="plug-date">
          <button type="button" className="btn sm" disabled={!dates || idx < 0 || !dates[idx + 1]} onClick={() => step(1)} title="Earlier day">‹</button>
          <select value={date} onChange={(e) => setDate(e.target.value)} disabled={!dates || !dates.length} aria-label="Plug list day">
            {dates && dates.length ? dates.map((d) => <option key={d.date} value={d.date}>{dateLabel(d.date)} · {d.n} plug{d.n === 1 ? '' : 's'}</option>) : <option value="">No plug list yet</option>}
          </select>
          <button type="button" className="btn sm" disabled={!dates || idx <= 0} onClick={() => step(-1)} title="Later day">›</button>
        </div>
        <label className="wl-search">
          <SearchIcon />
          <input type="search" placeholder="Search plug ID, program, PSD…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <span className="grow" />
        {canWrite ? (
          <>
            <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => pickFile(e.target.files[0])} />
            <button type="button" className="btn" disabled={importing} onClick={() => fileRef.current.click()}><UploadIcon /> {importing ? 'Importing…' : 'Import plug list'}</button>
            <button type="button" className="btn" onClick={() => setAdding(true)}><PlusIcon /> Add plug</button>
            <button type="button" className="btn" disabled={filling} onClick={fillExisting}
              title="Rows already in the Workload Tracker that have a Plug ID but a blank PSD or PROG. NAME / PROJ. TITLE get them from this list (anything typed is kept)">{filling ? 'Filling…' : 'Fill blank rows'}</button>
            {isAdmin ? <button type="button" className="btn danger" disabled={!totals.plugs} onClick={() => setDeleting(true)} title="Delete this day's plug list, or every day's">Delete all…</button> : null}
            <button type="button" className="btn primary" disabled={!date || !todo.length} onClick={() => setCopying(true)}>
              {chosen.length ? `Copy ${chosen.length} to Workload` : `Copy ${todo.length || ''} to Workload`.replace('  ', ' ')}
            </button>
          </>
        ) : null}
      </div>

      {rows === null || dates === null ? <Empty>Loading…</Empty>
        : !dates.length ? (
          <Empty>
            No PSD Daily Plug List yet.{canWrite ? ' Use “Import plug list” and pick the PSD’s daily plug list workbook (one sheet per day).' : ' Ask someone who can edit the Workload Tracker to import it.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="t plug-t">
              <thead>
                <tr>
                  {canWrite ? <th className="chk"><input type="checkbox" checked={allOn} disabled={!todo.length} onChange={() => setPicked(allOn ? new Set() : new Set(todo.map((r) => r.id)))} title="Select every plug not yet in the Workload Tracker" /></th> : null}
                  <th>NO</th><th>PLUG ID</th><th>PROG. NAME / PROJ. TITLE</th><th>PSD</th><th>ACCOUNT BY</th><th>IN WORKLOAD</th>{canWrite ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {rows.length ? rows.map((r, i) => (
                  <tr key={r.id} className={r.in_workload ? 'done' : ''}>
                    {canWrite ? <td className="chk"><input type="checkbox" checked={picked.has(r.id)} disabled={r.in_workload} onChange={() => toggle(r.id)} /></td> : null}
                    <td>{r.list_no || i + 1}</td>
                    <td className="mono">{r.plug_id}{r.is_additional ? <span className="chip c-orange plug-add" title="Listed under “Additional for …”">Added</span> : null}</td>
                    <td>{r.prog_name}</td>
                    <td>{r.psd}</td>
                    <td>{r.account_by}</td>
                    <td>{r.in_workload ? <span className="chip c-green">In workload</span> : <span className="dim">—</span>}</td>
                    {canWrite ? (
                      <td className="right nowrap">
                        <button type="button" className="btn sm ghost" onClick={() => setEditing(r)}>Edit</button>
                        <button type="button" className="btn sm ghost" onClick={() => removePlug(r)}>Delete</button>
                      </td>
                    ) : null}
                  </tr>
                )) : <tr><td colSpan={canWrite ? 8 : 6} className="empty">{query ? 'No plugs match that search.' : 'This day has no plugs.'}</td></tr>}
              </tbody>
            </table>
          </div>
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
          {summary.workloadRowsFilled ? <p><strong>{summary.workloadRowsFilled}</strong> row{summary.workloadRowsFilled === 1 ? '' : 's'} already in the Workload Tracker had a Plug ID but no PSD / PROG. NAME / PROJ. TITLE — now filled in from this list.</p> : null}
          {summary.warnings && summary.warnings.length ? <ul className="plug-warn">{summary.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
          <div className="plug-sum">
            {summary.sheets.map((s) => <div key={s.sheet + s.date}><span>{dateLabel(s.date)}</span><span className="dim">{s.plugs} plugs{s.added ? ` · ${s.added} new` : ''}{s.additional ? ` · ${s.additional} added late` : ''}</span></div>)}
          </div>
        </Modal>
      ) : null}

      {deleting ? (
        <DeleteAllPlugsModal date={date} dayCount={(dates.find((x) => x.date === date) || {}).n || 0} totals={totals} onClose={() => setDeleting(false)}
          onDone={async (out) => { setDeleting(false); setPicked(new Set()); toast(`${out.deleted} plug${out.deleted === 1 ? '' : 's'} deleted`); await loadDates(true); loadRows(); }} />
      ) : null}

      {adding || editing ? (
        <PlugModal date={date} plug={editing} onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={async (d, out) => {
            const wasEdit = !!editing;
            setAdding(false); setEditing(null);
            if (out && out.workloadRowsFilled) toast(`${out.workloadRowsFilled} Workload row${out.workloadRowsFilled === 1 ? '' : 's'} filled in from this plug`);
            await loadDates(true);
            if (d && (!wasEdit || d !== date)) setDate(d);   // an edit that moves the plug to another day follows it there
            loadRows();
          }} />
      ) : null}

      {copying ? (
        <CopyModal date={date} plugs={chosen.length ? chosen : todo} onClose={() => setCopying(false)}
          onDone={(out) => { setCopying(false); setPicked(new Set()); loadRows(); if (onCopied) onCopied(out); }} />
      ) : null}
    </div>
  );
}

function DeleteAllPlugsModal({ date, dayCount, totals, onClose, onDone }) {
  const toast = useToast();
  const [scope, setScope] = useState(dayCount ? 'day' : 'all');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const count = scope === 'day' ? dayCount : totals.plugs;
  const go = async () => {
    setBusy(true);
    try { onDone(await post('/api/workload/plugs/delete-all', { scope, date })); } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal title="Delete plug list" onClose={onClose}
      footer={(<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn danger" disabled={busy || typed.trim() !== 'DELETE' || !count} onClick={go}>Delete {count} plug{count === 1 ? '' : 's'}</button></>)}>
      <div className="stack">
        <label className="radio-row"><input type="radio" name="plug-scope" checked={scope === 'day'} disabled={!dayCount} onChange={() => setScope('day')} /> Only <strong>{date ? dateLabel(date) : 'this day'}</strong> — {dayCount} plug{dayCount === 1 ? '' : 's'}</label>
        <label className="radio-row"><input type="radio" name="plug-scope" checked={scope === 'all'} onChange={() => setScope('all')} /> <strong>Every day</strong> — {totals.plugs} plug{totals.plugs === 1 ? '' : 's'} on {totals.days} day{totals.days === 1 ? '' : 's'}</label>
        <p className="dim m-0">This only removes the PSD Daily Plug List. Workload rows that were already made from it are not touched (they just stop being auto-filled until the list is imported again).</p>
        <label className="f"><span>Type <strong>DELETE</strong> to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim() === 'DELETE' && !busy && count) go(); }} /></label>
      </div>
    </Modal>
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
      const out = plug ? await put(`/api/workload/plugs/${plug.id}`, f) : await post('/api/workload/plugs', f);
      toast(plug ? 'Plug updated' : 'Plug added');
      onSaved(f.plug_date, out);
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal title={plug ? 'Edit plug' : 'Add plug'} onClose={onClose} footer={(<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={save}>{plug ? 'Save' : 'Add'}</button></>)}>
      <form className="form-grid" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="f"><span>Date <span className="req">*</span></span><input type="date" value={f.plug_date} onChange={set('plug_date')} /></label>
        <label className="f"><span>Plug ID <span className="req">*</span></span><input value={f.plug_id} onChange={set('plug_id')} maxLength={200} autoFocus /></label>
        <label className="f full"><span>PROG. NAME / PROJ. TITLE</span><input value={f.prog_name} onChange={set('prog_name')} maxLength={300} /></label>
        <label className="f"><span>PSD</span><input value={f.psd} onChange={set('psd')} maxLength={200} /></label>
        <label className="f"><span>Account By</span><input value={f.account_by} onChange={set('account_by')} maxLength={100} /></label>
      </form>
      {plug ? <p className="dim m-0 mt-12">Workload rows already filled from this plug keep what they have; only blank PSD / PROG. NAME fields get filled.</p> : null}
    </Modal>
  );
}

function CopyModal({ date, plugs, onClose, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const out = await post('/api/workload/plugs/copy', { date, ids: plugs.map((p) => p.id) });
      const bits = [`${out.created} row${out.created === 1 ? '' : 's'} added to the Workload Tracker`];
      if (out.already) bits.push(`${out.already} already there`);
      if (out.errors && out.errors.length) bits.push(`${out.errors.length} failed`);
      toast(bits.join(' — '), out.errors && out.errors.length ? 'err' : undefined);
      if (out.errors && out.errors.length) console.warn('Copy errors:', out.errors);
      onDone(out);
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal title="Copy to Workload Tracker" onClose={onClose} footer={(<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={go}>Copy {plugs.length}</button></>)}>
      <p>
        Adds a Workload row for <strong>{plugs.length}</strong> plug{plugs.length === 1 ? '' : 's'} from <strong>{dateLabel(date)}</strong>, with Plug ID, PSD and
        PROG. NAME / PROJ. TITLE filled in. Plugs that already have a row for that day are left alone.
      </p>
      <p>
        <strong>Units Concerned is left blank.</strong> The new rows show only under <strong>All</strong> (marked “Set units”) until you choose the
        team(s) for each one — click its Units cell, or edit the row. Once set, the row moves to the VGFX / VEDIT / Audio tabs it belongs to.
        Use the Units filter “(Not set)” to find the ones still waiting.
      </p>
    </Modal>
  );
}
