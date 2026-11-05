import { useCallback, useEffect, useState } from 'react';
import { get, put, post } from '../../lib/api.js';
import { fmtBytes, fmtDateTime } from '../../lib/util.js';
import { useToast } from '../../components/ui.jsx';

const RANGES = [['yesterday', 'Yesterday'], ['last_week', 'Last week'], ['last_month', 'Last month'], ['custom', 'Custom']];
const HOW = {
  yesterday: 'Runs every day and exports the day before.',
  last_week: 'Runs every Monday and exports the week before (Monday to Sunday).',
  last_month: 'Runs on the 1st and exports the whole month before.',
  custom: 'Runs every day and exports the same dates each time (a fresh copy).',
};
const nice = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// the same dates the server works out (src/export-schedule.js resolveRange), so the line under the form follows the choice before it is saved
function rangeOf(f) {
  if (f.range === 'custom') return { from: f.from, to: f.to };
  const n = new Date(); const day = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  if (f.range === 'yesterday') { const y = new Date(day); y.setDate(y.getDate() - 1); return { from: ymd(y), to: ymd(y) }; }
  if (f.range === 'last_week') { const m = new Date(day); m.setDate(m.getDate() - ((m.getDay() + 6) % 7) - 7); const u = new Date(m); u.setDate(u.getDate() + 6); return { from: ymd(m), to: ymd(u) }; }
  return { from: ymd(new Date(day.getFullYear(), day.getMonth() - 1, 1)), to: ymd(new Date(day.getFullYear(), day.getMonth(), 0)) };
}
const span = (r) => (r.from === r.to ? nice(r.from) : `${nice(r.from)} – ${nice(r.to)}`);

export default function ExportTab({ active }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const d = await get('/api/admin/exports');
    setData(d); setForm(d.settings);
  }, []);
  useEffect(() => { if (active && !data) load().catch((e) => toast(e.message, 'err')); }, [active, data, load, toast]);
  if (!data || !form) return <p className="muted">Loading…</p>;

  const dirty = JSON.stringify(form) !== JSON.stringify(data.settings);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setMod = (k, v) => setForm((f) => ({ ...f, modules: { ...f.modules, [k]: v } }));
  const save = async () => {
    setBusy(true);
    try { const d = await put('/api/admin/exports', form); setData(d); setForm(d.settings); toast('Export schedule saved'); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true);
    try {
      const d = await post('/api/admin/exports/run', {});
      setData(d); setForm(d.settings);
      toast(d.result.errors.length ? `Exported with problems: ${d.result.errors.map((e) => `${e.label}: ${e.error}`).join('; ')}` : `Exported ${d.result.files.length} file${d.result.files.length === 1 ? '' : 's'}`, d.result.errors.length ? 'err' : undefined);
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const last = data.last;
  const pv = rangeOf(form);

  return (
    <div className="card mb-12"><div className="card-pad"><div className="stack">
      <div className="admin-note">
        Saves Excel files of the PSD Daily Plug List, Ingest Tracker and Workload Tracker on a schedule, in the same layout as each page&apos;s Export button.
        They are kept on the server in <code>{data.folder}</code>; copy that folder to OneDrive or another drive if you want them off the server.
      </div>

      <div className="sched-grid">
        <label className="f"><span>Schedule</span>
          <select value={form.enabled ? 'on' : 'off'} onChange={(e) => set('enabled', e.target.value === 'on')}><option value="off">Off</option><option value="on">On</option></select></label>
        <label className="f"><span>Time (server)</span><input type="time" value={form.time} onChange={(e) => set('time', e.target.value)} /></label>
        <label className="f"><span>Dates</span>
          <select value={form.range} onChange={(e) => set('range', e.target.value)}>{RANGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {form.range === 'custom' ? (
          <>
            <label className="f"><span>From</span><input type="date" value={form.from} onChange={(e) => set('from', e.target.value)} /></label>
            <label className="f"><span>To</span><input type="date" value={form.to} onChange={(e) => set('to', e.target.value)} /></label>
          </>
        ) : null}
        <label className="f"><span>Keep the latest</span><input type="number" min={1} max={120} value={form.keep} onChange={(e) => set('keep', e.target.value)} /></label>
      </div>
      <div className="dim">{HOW[form.range]} {pv.from && pv.to ? <>Today that means <strong>{span(pv)}</strong>.</> : null}</div>

      <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
        {data.modules.map((m) => (
          <label key={m.key} className="check"><input type="checkbox" checked={Boolean(form.modules[m.key])} onChange={(e) => setMod(m.key, e.target.checked)} /> {m.label}</label>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={form.byDate} onChange={(e) => set('byDate', e.target.checked)} /> Separate data by date into tabs (one tab per day)</label>

      <div className="row gap-8">
        <button type="button" className="btn primary" disabled={!dirty || busy} onClick={save}>Save schedule</button>
        <button type="button" className="btn" disabled={dirty || busy} title={dirty ? 'Save the schedule first' : 'Make the files now with the saved settings'} onClick={runNow}>Export now</button>
        <span className="dim">{dirty ? 'Unsaved changes.' : data.settings.enabled && data.next ? `Next export: ${fmtDateTime(data.next)}` : 'Scheduled export is off.'}</span>
      </div>

      {last ? (
        <div className={`alert ${last.ok ? 'info' : 'warn'}`} role="status">
          <strong>{last.ok ? 'Last export succeeded' : 'Last export had problems'}</strong>{' '}
          <span className="dim">{fmtDateTime(last.at)} · {span(last.range)}{last.source && last.source !== 'scheduled' ? ` · by ${last.source}` : ''}</span>
          {last.errors.map((e, i) => <div key={i}>{e.label ? `${e.label}: ` : ''}{e.error}</div>)}
        </div>
      ) : null}

      <h3 className="mt-16">Saved exports</h3>
      {data.runs.length ? (
        <div className="table-wrap">
          <table className="tbl ret-tbl">
            <thead><tr><th>Made</th><th>File</th><th className="num">Size</th><th /></tr></thead>
            <tbody>
              {data.runs.flatMap((r) => r.files.map((f, i) => (
                <tr key={`${r.id}/${f.name}`}>
                  <td>{i === 0 ? fmtDateTime(r.at) : ''}</td><td>{f.name}</td><td className="num">{fmtBytes(f.size)}</td>
                  <td><a className="btn sm" href={`/api/admin/exports/files/${encodeURIComponent(r.id)}/${encodeURIComponent(f.name)}`}>Download</a></td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      ) : <p className="dim">Nothing exported yet.</p>}
    </div></div></div>
  );
}
