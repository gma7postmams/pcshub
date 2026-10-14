import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../../lib/api.js';
import { useToast } from '../../components/ui.jsx';
import ReauthDialog from './ReauthDialog.jsx';

const SAFE_TIPS = { users: 'System Admins and you are never removed.', groups: 'A group that still has users is kept.' };

export default function ClearData() {
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [pick, setPick] = useState({});          // area -> true
  const [allDates, setAllDates] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState(false);

  const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const load = useCallback(() => get(`/api/admin/clear-data?${q}`, { quiet: true }).then(setInfo).catch((e) => toast(e.message, 'err')), [q, toast]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  if (!info) return <p className="muted">Loading…</p>;
  const areas = info.order.filter((k) => pick[k]);
  const rangeOk = allDates || from || to;
  const bad = from && to && from > to;
  const hits = areas.reduce((n, k) => n + info.preview[k].hit, 0);
  const scope = allDates ? 'all dates' : `${from || 'the start'} to ${to || 'today'}`;
  const run = async ({ password, code, confirm }) => {
    const { results } = await post('/api/admin/clear-data', { areas, from: allDates ? '' : from, to: allDates ? '' : to, allDates, confirm, password, code });
    const n = Object.values(results).reduce((s, r) => s + r.deleted, 0);
    setOpen(false); setPick({}); toast(n ? `Cleared ${n} record${n === 1 ? '' : 's'}. Copies are in the archive list (Backup and Restore → Data retention)` : 'Nothing matched, so nothing was cleared');
    load();
  };

  return (
    <div className="stack">
      <div className="admin-note">
        Permanently remove records from the areas you tick, within a date range. A compressed copy of everything removed is written to the archive first
        (password hashes and 2FA secrets are left out of user copies). The Audit Log keeps a line saying what was cleared.
      </div>

      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="m-0"><strong>1. Date range</strong></legend>
        <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'end' }}>
          <label className="f"><span>From</span><input type="date" id="cd-from" value={from} disabled={allDates} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="f"><span>To</span><input type="date" id="cd-to" value={to} disabled={allDates} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="check"><input type="checkbox" id="cd-all" checked={allDates} onChange={(e) => { setAllDates(e.target.checked); if (e.target.checked) { setFrom(''); setTo(''); } }} /> All dates</label>
        </div>
        <span className="dim">Both ends are included. Leave one empty for “everything before” or “everything after”.</span>
        {bad ? <span className="warn-text">The From date is after the To date.</span> : null}
      </fieldset>

      <div className="table-wrap">
        <table className="tbl ret-tbl">
          <thead><tr><th><span className="sr-only">Clear</span></th><th>Area</th><th>Counted from</th><th className="num">Records</th><th className="num">In this range</th></tr></thead>
          <tbody>
            {info.order.map((k) => {
              const p = info.preview[k];
              return (
                <tr key={k}>
                  <td><input type="checkbox" id={`cd-${k}`} aria-label={`Clear ${info.areas[k].label}`} checked={!!pick[k]} onChange={(e) => setPick({ ...pick, [k]: e.target.checked })} /></td>
                  <td><strong>{info.areas[k].label}</strong></td>
                  <td className="dim">{info.areas[k].basis}</td>
                  <td className="num">{p.total}</td>
                  <td className="num">{rangeOk ? <strong className={p.hit ? 'warn-text' : ''}>{p.hit}</strong> : '—'}{rangeOk && k === 'groups' && p.kept ? <span className="dim"> ({p.kept} kept: still has users)</span> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pick.groups && !pick.users ? <p className="dim m-0">Tick User access too if you want the users in those groups removed first. {SAFE_TIPS.groups}</p> : null}

      <div className="row gap-8">
        <button type="button" className="btn danger" id="cd-go" disabled={!areas.length || !rangeOk || bad || !hits} onClick={() => setOpen(true)}>Clear selected data…</button>
        <span className="dim">{!areas.length ? 'Tick the areas to clear.' : !rangeOk ? 'Choose a date range, or tick All dates.' : hits ? `${hits} record${hits === 1 ? '' : 's'} in ${areas.length} area${areas.length === 1 ? '' : 's'}, ${scope}` : 'Nothing in that range.'}</span>
      </div>

      {open ? (
        <ReauthDialog
          title="Clear data" okText="Clear data" danger typed="DELETE" onClose={() => setOpen(false)}
          intro={`This permanently removes about ${hits} record${hits === 1 ? '' : 's'} (${areas.map((k) => info.areas[k].label).join(', ')}) for ${scope}. A copy is written to the archive first.${areas.includes('knowledge') ? ' Knowledge Base document files are deleted from the server and are not copied.' : ''}`}
          onSubmit={run}
        />
      ) : null}
    </div>
  );
}
