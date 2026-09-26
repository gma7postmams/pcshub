import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get } from '../lib/api.js';
import { ago, fmtDate } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { Empty, Kpi, Pill } from '../components/ui.jsx';

export default function Dashboard() {
  const s = useSession();
  const navigate = useNavigate();
  const [d, setD] = useState(null);

  useEffect(() => { get('/api/dashboard').then(setD).catch(() => setD({ error: true })); }, []);
  if (!d) return <main className="container"><Empty>Loading…</Empty></main>;
  if (d.error) return <main className="container"><Empty>Could not load the dashboard.</Empty></main>;

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const go = (href) => (href ? () => navigate(href) : null);
  const ingestHref = (st) => (d.canOpen.ingest ? `/ingest?status=${encodeURIComponent(st)}` : null);
  const st = d.kpis ? d.kpis.byStatus : {};

  return (
    <main className="container">
      <div className="page-head">
        <div>
          <h1>{greet}, {s.user.full_name.split(' ')[0]}</h1>
          <div className="sub">Here&apos;s where promotional content stands today.</div>
        </div>
        <div className="actions">
          {s.can('ingest.write') ? <Link className="btn primary" to="/ingest?new=1">+ New Ingest</Link> : null}
          {d.canOpen.reports ? <Link className="btn" to="/reports">View Reports</Link> : null}
        </div>
      </div>

      {d.kpis ? (
        <div className="grid grid-4">
          <Kpi label="Total Ingest Records" value={d.kpis.total} foot={`${d.kpis.thisMonth.created} created this month`} color="c-blue" onClick={go(d.canOpen.ingest ? '/ingest' : null)} />
          <Kpi label="Pending Approval" value={st['Pending Approval'] || 0} foot="Awaiting a decision" color="c-amber" onClick={go(d.canOpen.approval ? '/approval?status=Pending' : null)} />
          <Kpi label="Approved" value={st.Approved || 0} foot={`${d.kpis.thisMonth.approved} this month`} color="c-green" onClick={go(ingestHref('Approved'))} />
          <Kpi label="Rejected" value={st.Rejected || 0} foot="Needs rework & resubmission" color="c-red" onClick={go(ingestHref('Rejected'))} />
        </div>
      ) : null}

      {d.recent ? (
        <div className={`card ${d.kpis ? 'mt-16' : ''}`}>
          <div className="card-head">
            <h2>Recent Ingest Activity</h2>
            {d.canOpen.ingest ? <Link className="btn sm" to="/ingest">Open tracker</Link> : null}
          </div>
          <div className="table-wrap">
            {d.recent.length ? (
              <table className="t">
                <thead><tr><th>#</th><th>Program</th><th>Platform</th><th>Episode</th><th>Status</th><th>Updated</th></tr></thead>
                <tbody>
                  {d.recent.map((r) => (
                    <tr key={r.id} className={d.canOpen.ingest ? 'clickable' : ''} onClick={d.canOpen.ingest ? () => navigate(`/ingest?id=${r.id}`) : undefined}>
                      <td className="dim mono">{r.id}</td><td>{r.program}</td><td>{r.platform}</td>
                      <td className="nowrap">{fmtDate(r.episode_date)}</td><td><Pill s={r.status} /></td>
                      <td className="dim nowrap">{ago(r.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>No ingest records yet.</Empty>}
          </div>
        </div>
      ) : null}

      {!d.kpis && !d.recent ? <div className="card"><Empty>Your group has no Dashboard sections enabled.</Empty></div> : null}
    </main>
  );
}
