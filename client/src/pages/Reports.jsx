import { useEffect, useMemo, useState } from 'react';
import { get } from '../lib/api.js';
import { isoDate } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { DownloadIcon } from '../components/Icons.jsx';
import { Bars, Columns, Empty, Kpi, Options, useToast } from '../components/ui.jsx';

const STATUSES = ['New', 'Pending Approval', 'Approved', 'Rejected'];
const monthLabel = (k) => {
  const [y, m] = k.split('-').map(Number);
  return `${new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'short' })} '${String(y).slice(2)}`;
};

export default function Reports() {
  const s = useSession();
  const toast = useToast();
  const canSummary = s.hasSection('reports.ingest');
  const canExport = s.hasSection('reports.export');
  const [dd, setDd] = useState({ program: [], platform: [] });
  const [f, setF] = useState({ basis: 'created', from: '', to: '', program: '', platform: '', status: '' });
  const [preset, setPreset] = useState('all');
  const [d, setD] = useState(null);

  useEffect(() => { get('/api/dropdowns?categories=program,platform').then(setDd).catch(() => {}); }, []);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => { if (v) p.set(k, v); });
    return p.toString();
  }, [f]);

  useEffect(() => {
    if (!canSummary) return;
    setD(null);
    get(`/api/reports/ingest?${qs}`).then(setD).catch((e) => toast(e.message, 'err'));
  }, [qs, canSummary, toast]);

  const set = (k) => (e) => {
    setF((x) => ({ ...x, [k]: e.target.value }));
    if (k === 'from' || k === 'to') setPreset('');
  };
  const applyPreset = (p) => {
    setPreset(p);
    if (p === 'month') { const n = new Date(); setF((x) => ({ ...x, from: isoDate(new Date(n.getFullYear(), n.getMonth(), 1)), to: isoDate() })); }
    else if (p === '30') setF((x) => ({ ...x, from: isoDate(new Date(Date.now() - 29 * 86400000)), to: isoDate() }));
    else setF((x) => ({ ...x, from: '', to: '' }));
  };

  const st = d ? Object.fromEntries(d.byStatus.map((x) => [x.k, x.n])) : {};
  const decided = (st.Approved || 0) + (st.Rejected || 0);

  return (
    <main className="container">
      <div className="page-head">
        <div><h1>Reports</h1><div className="sub">Ingest and approval summaries.</div></div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => window.print()}>Print</button>
          {canExport ? <a className="btn primary" id="csv" href={`/api/reports/ingest.csv?${qs}`}><DownloadIcon /> Export CSV</a> : null}
        </div>
      </div>

      <div className="card mb-12">
        <div className="filters">
          <select title="Date basis" value={f.basis} onChange={set('basis')}>
            <option value="created">By created date</option><option value="episode">By episode date</option>
          </select>
          <input type="date" title="From" value={f.from} onChange={set('from')} />
          <input type="date" title="To" value={f.to} onChange={set('to')} />
          <select value={f.program} onChange={set('program')}><Options list={dd.program} blank="All programs" /></select>
          <select value={f.platform} onChange={set('platform')}><Options list={dd.platform} blank="All platforms" /></select>
          <select value={f.status} onChange={set('status')}><Options list={STATUSES} blank="All statuses" /></select>
          <div className="segmented" id="presets">
            {[['month', 'This month'], ['30', '30 days'], ['all', 'All time']].map(([k, l]) => (
              <button key={k} type="button" className={preset === k ? 'on' : ''} onClick={() => applyPreset(k)}>{l}</button>
            ))}
          </div>
        </div>
      </div>

      {!canSummary ? (
        <div className="card"><Empty>{canExport ? 'Summary is not enabled for your group. Use the filters above and Export CSV.' : 'Your group has no Reports sections enabled.'}</Empty></div>
      ) : !d ? <Empty>Loading…</Empty> : (
        <>
          <div className="grid grid-4">
            <Kpi label="Ingest Records" value={d.total} color="c-blue" />
            <Kpi label="Approval Rate" value={`${decided ? Math.round(((st.Approved || 0) / decided) * 100) : 0}%`} foot={`${st.Approved || 0} approved / ${decided} decided`} color="c-green" />
            <Kpi label="Pending Approval" value={st['Pending Approval'] || 0} color="c-amber" />
            <Kpi label="Avg. Decision Time" value={d.approval.avg_hours != null ? `${d.approval.avg_hours}h` : '—'} foot={`${d.approval.decided} decisions`} color="c-purple" />
          </div>
          <div className="grid grid-2 mt-16">
            <div className="card"><div className="card-head"><h3>By Status</h3></div><div className="card-pad"><Bars list={d.byStatus} statusColors /></div></div>
            <div className="card"><div className="card-head"><h3>By Platform</h3></div><div className="card-pad"><Bars list={d.byPlatform} /></div></div>
            <div className="card"><div className="card-head"><h3>Top Programs</h3></div><div className="card-pad"><Bars list={d.byProgram} /></div></div>
            <div className="card"><div className="card-head"><h3>Monthly Volume (created)</h3></div><div className="card-pad"><Columns list={d.byMonth} label={monthLabel} /></div></div>
          </div>
        </>
      )}
    </main>
  );
}
