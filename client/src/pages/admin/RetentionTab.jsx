import { useCallback, useEffect, useState } from 'react';
import { get, post, put } from '../../lib/api.js';
import { fmtBytes, fmtDateTime } from '../../lib/util.js';
import { useToast } from '../../components/ui.jsx';
import ReauthDialog from './ReauthDialog.jsx';

const ORDER = ['audit', 'ingest', 'workload', 'plugs'];

export default function RetentionTab({ active }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);       // { audit: '90', …, auto }
  const [pv, setPv] = useState(null);
  const [busy, setBusy] = useState(false);
  const [runOpen, setRunOpen] = useState(false);

  const load = useCallback(async () => {
    const d = await get('/api/admin/retention');
    setData(d); setPv(d.preview);
    setForm({ ...Object.fromEntries(ORDER.map((k) => [k, String(d.settings[k] || '')])), auto: d.settings.auto });
  }, []);
  useEffect(() => { if (active && !data) load().catch((e) => toast(e.message, 'err')); }, [active, data, load, toast]);

  // Preview what the values on screen would remove, before saving.
  useEffect(() => {
    if (!form) return undefined;
    const t = setTimeout(() => {
      const q = ORDER.map((k) => `${k}=${encodeURIComponent(form[k] || 0)}`).join('&');
      get(`/api/admin/retention?${q}`, { quiet: true }).then((d) => setPv(d.preview)).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [form && ORDER.map((k) => form[k]).join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data || !form) return <p className="muted">Loading…</p>;
  const dirty = ORDER.some((k) => String(data.settings[k] || '') !== form[k]) || data.settings.auto !== form.auto;
  const savedDue = ORDER.reduce((n, k) => n + (data.settings[k] ? data.preview[k].due : 0), 0);

  const save = async () => {
    setBusy(true);
    try {
      await put('/api/admin/retention', { ...Object.fromEntries(ORDER.map((k) => [k, form[k] === '' ? 0 : Number(form[k])])), auto: form.auto });
      toast('Retention settings saved');
      await load();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const run = async ({ password, code, confirm }) => {
    const { results } = await post('/api/admin/retention/run', { confirm, password, code });
    const n = Object.values(results).reduce((s, r) => s + r.deleted, 0);
    setRunOpen(false);
    toast(n ? `Removed ${n} old record${n === 1 ? '' : 's'}; copies are in the archive list` : 'Nothing was old enough to remove');
    await load();
  };

  return (
    <div className="stack">
      <div className="admin-note">
        Choose how long each area keeps its records. Records older than that are copied to a compressed archive file and then removed.
        Leave a box empty to keep everything. The shortest period is {data.minDays} days.
      </div>
      <div className="table-wrap">
        <table className="tbl ret-tbl">
          <thead><tr><th>Area</th><th>Keep for (days)</th><th>Counted from</th><th className="num">Records</th><th className="num">Older than the limit</th><th>Oldest</th></tr></thead>
          <tbody>
            {ORDER.map((k) => {
              const p = pv && pv[k];
              return (
                <tr key={k}>
                  <td><strong>{data.modules[k].label}</strong></td>
                  <td><input type="number" min="0" max={data.maxDays} placeholder="Keep forever" aria-label={`${data.modules[k].label} days to keep`} className="ret-days" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></td>
                  <td className="dim">{data.modules[k].basis}</td>
                  <td className="num">{p ? p.total : '…'}</td>
                  <td className="num">{p ? (p.days ? <strong className={p.due ? 'warn-text' : ''}>{p.due}</strong> : '—') : '…'}</td>
                  <td className="dim">{p && p.oldest ? p.oldest.slice(0, 10) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <label className="check"><input type="checkbox" checked={form.auto} onChange={(e) => setForm({ ...form, auto: e.target.checked })} /> Apply these limits automatically every day (after 3:00 server time)</label>
      <div className="row gap-8">
        <button type="button" className="btn primary" disabled={!dirty || busy} onClick={save}>Save settings</button>
        <button type="button" className="btn danger" disabled={dirty || !savedDue} title={dirty ? 'Save the settings first' : ''} onClick={() => setRunOpen(true)}>Remove old records now…</button>
        <span className="dim">{dirty ? 'Unsaved changes. The numbers above show what these values would remove.' : data.lastRun ? `Last run: ${fmtDateTime(data.lastRun.created_at)} by ${data.lastRun.username || 'scheduler'}` : 'Never run'}</span>
      </div>

      <h3 className="mt-16">Archives</h3>
      <p className="muted m-0">Every removal writes a file here first. Download and store these elsewhere if you need to keep them long term. They are not deleted automatically.</p>
      {data.archives.length ? (
        <div className="table-wrap">
          <table className="tbl ret-tbl">
            <thead><tr><th>File</th><th>Area</th><th>Created</th><th className="num">Size</th><th /></tr></thead>
            <tbody>
              {data.archives.map((a) => (
                <tr key={a.name}>
                  <td>{a.name}</td><td>{(data.modules[a.module] || {}).label || a.module}</td><td>{fmtDateTime(a.at)}</td><td className="num">{fmtBytes(a.bytes)}</td>
                  <td><a className="btn sm" href={`/api/admin/retention/archives/${encodeURIComponent(a.name)}`}>Download</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="dim">No archives yet.</p>}

      {runOpen ? (
        <ReauthDialog
          title="Remove old records" okText="Remove" danger typed="DELETE" onClose={() => setRunOpen(false)}
          intro={`This removes ${savedDue} record${savedDue === 1 ? '' : 's'} older than the saved limits. A copy is written to the archive first.`}
          onSubmit={run}
        />
      ) : null}
    </div>
  );
}
