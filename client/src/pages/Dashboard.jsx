import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get } from '../lib/api.js';
import { ago, fmtBreakdate, fmtDate } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { Bars, Empty, Kpi, Pill } from '../components/ui.jsx';

// Dashboard — one screen for everything in flight. Blocks appear only if the signed-in user may see them:
//   Workload Tracker  (needs the Workload page)       — totals, the next two weeks, teams, upcoming breakdates, priority items
//   PSD Daily Plug List (needs the plug list page)    — how much of the current list has made it into the tracker
//   Ingest & Approval (the Dashboard sections kpis / recent) — status counts and the latest ingest records
const TEAMS = [
  { key: 'VGFX', label: 'VGFX', color: 'var(--purple)' },
  { key: 'VEDIT', label: 'VEDIT', color: '#f0883e' },
  { key: 'AUDIO', label: 'Audio', color: '#26b5ad' },
];
const STATUS_ORDER = [['New', '--blue'], ['Pending Approval', '--amber'], ['Approved', '--green'], ['Rejected', '--red']];
const TEAM_COLOR = { VGFX: 'c-purple', VEDIT: 'c-orange', AUDIO: 'c-teal' };
const firstLine = (s) => String(s || '').split('\n')[0];
const dayParts = (iso) => {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return { dow: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }), num: d.getUTCDate(), weekend: [0, 6].includes(d.getUTCDay()) };
};
const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);

function Section({ title, hint, to, toLabel, children }) {
  return (
    <section className="dash-section">
      <div className="dash-sec-head">
        <h2>{title}</h2>
        {hint ? <span className="dim">{hint}</span> : null}
        <span className="grow" />
        {to ? <Link className="btn sm" to={to}>{toLabel || 'Open'}</Link> : null}
      </div>
      {children}
    </section>
  );
}

function Panel({ title, sub, children, className }) {
  return (
    <div className={`card dash-panel ${className || ''}`}>
      <div className="dash-panel-head"><h3>{title}</h3>{sub ? <span className="dim">{sub}</span> : null}</div>
      {children}
    </div>
  );
}

export default function Dashboard() {
  const s = useSession();
  const navigate = useNavigate();
  const [d, setD] = useState(null);

  const load = useCallback(() => get('/api/dashboard').then(setD).catch(() => setD((cur) => cur || { error: true })), []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);   // refreshes itself every minute
  if (!d) return <main className="container wide"><Empty>Loading…</Empty></main>;
  if (d.error) return <main className="container wide"><Empty>Could not load the dashboard.</Empty></main>;

  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const go = (href) => (href ? () => navigate(href) : null);
  const w = d.workload;
  const pl = d.plugs;
  const st = d.kpis ? d.kpis.byStatus : {};
  const todayIso = String(d.today || '').slice(0, 10);
  const nothing = !w && !pl && !d.kpis && !d.recent;

  return (
    <main className="container wide dash">
      <div className="dash-hero">
        <div>
          <h1>{greet}, {s.user.full_name.split(' ')[0]}</h1>
          <div className="sub">{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · here’s where everything stands.</div>
        </div>
        <div className="actions">
          {d.canOpen.workload ? <Link className="btn primary" to="/workload">Workload Tracker</Link> : null}
          {d.canOpen.plugs ? <Link className="btn" to="/plug-list">PSD Daily Plug List</Link> : null}
          {s.can('ingest.write') ? <Link className="btn" to="/ingest?new=1">+ New Ingest</Link> : null}
          {d.canOpen.reports ? <Link className="btn" to="/reports">Reports</Link> : null}
        </div>
      </div>

      {/* ---------------- Workload Tracker ---------------- */}
      {w ? (
        <Section title="Workload Tracker" hint={`${w.total} item${w.total === 1 ? '' : 's'} in total`} to="/workload">
          <div className="grid dash-kpis">
            <Kpi label="Today" value={w.today} foot={w.today === 1 ? 'item to work on' : 'items to work on'} color="c-blue" onClick={go('/workload')} />
            <Kpi label="This week" value={w.thisWeek} foot="Monday to Sunday" color="c-purple" onClick={go('/workload')} />
            <Kpi label="Breakdates, next 7 days" value={w.breakdatesNext7Days} foot="VGFX and VEDIT times coming up" color="c-green" onClick={go('/workload')} />
            <Kpi label="Priority" value={w.priority} foot={w.priority === 1 ? 'item flagged priority' : 'items flagged priority'} color="c-red" onClick={go('/workload')} />
            <Kpi label="Needs units" value={w.unassigned} foot={w.unassigned ? 'Copied from the plug list — choose a team' : 'Every item has a team'} color={w.unassigned ? 'c-amber' : 'c-gray'} onClick={go('/workload')} />
          </div>

          <div className="dash-grid mt-16">
            <Panel title="Workload by day" sub="past week and the week ahead" className="span-2">
              <div className="dash-days">
                {(() => {
                  const max = Math.max(...w.byDay.map((x) => x.n), 1);
                  return w.byDay.map((x) => {
                    const iso = String(x.day).slice(0, 10);
                    const p = dayParts(iso);
                    return (
                      <div key={iso} className={`dd${iso === todayIso ? ' today' : ''}${p.weekend ? ' weekend' : ''}${iso < todayIso ? ' past' : ''}`} title={`${fmtDate(iso)} — ${x.n} item${x.n === 1 ? '' : 's'}`}>
                        <span className="dd-val">{x.n || ''}</span>
                        <div className="dd-bar"><i style={{ height: `${x.n ? Math.max((x.n / max) * 100, 6) : 0}%` }} /></div>
                        <span className="dd-dow">{iso === todayIso ? 'Today' : p.dow}</span>
                        <span className="dd-num">{p.num}</span>
                      </div>
                    );
                  });
                })()}
              </div>
            </Panel>

            <Panel title="By team" sub="items each team is on">
              <div className="dash-teams">
                {TEAMS.map((t) => (
                  <div className="dt" key={t.key}>
                    <div className="dt-top"><span className="dt-name"><i style={{ background: t.color }} />{t.label}</span><b>{w.byTeam[t.key] || 0}</b></div>
                    <div className="dt-track"><div style={{ width: `${pct(w.byTeam[t.key] || 0, w.total)}%`, background: t.color }} /></div>
                  </div>
                ))}
                {w.unassigned ? (
                  <div className="dt unset">
                    <div className="dt-top"><span className="dt-name"><i />No team yet</span><b>{w.unassigned}</b></div>
                    <div className="dt-track"><div style={{ width: `${pct(w.unassigned, w.total)}%` }} /></div>
                  </div>
                ) : null}
                <div className="dim dt-note">A VGFX/VEDIT item counts for both teams.</div>
              </div>
            </Panel>
          </div>

          <div className="dash-grid mt-16">
            <Panel title="Upcoming breakdates" sub="next VGFX / VEDIT times" className="span-2">
              {w.upcoming.length ? (
                <ul className="dash-list">
                  {w.upcoming.map((e, i) => (
                    <li key={`${e.id}-${e.team}-${i}`} className="clickable" onClick={() => navigate('/workload')}>
                      <span className={`chip ${TEAM_COLOR[e.team]}`}>{e.team}</span>
                      <span className="dl-when">{fmtBreakdate(e.at)}</span>
                      <span className="dl-main">
                        <b className="mono">{firstLine(e.plug_id)}</b>
                        <span className="dim">{[e.prog_name, e.psd].filter(Boolean).join(' · ')}</span>
                      </span>
                      {e.is_priority ? <span className="chip c-red">Priority</span> : null}
                    </li>
                  ))}
                </ul>
              ) : <Empty>No breakdates coming up.</Empty>}
            </Panel>

            <Panel title="Priority items" sub="flagged, last week onwards">
              {w.priorityItems.length ? (
                <ul className="dash-list tight">
                  {w.priorityItems.map((r) => (
                    <li key={r.id} className="clickable" onClick={() => navigate('/workload')}>
                      <span className="dl-main">
                        <b className="mono">{firstLine(r.plug_id)}</b>
                        <span className="dim">{[r.prog_name, fmtDate(r.work_date)].filter(Boolean).join(' · ')}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : <Empty>Nothing is flagged priority.</Empty>}
            </Panel>
          </div>

          <div className="dash-grid mt-16">
            <Panel title="Platforms" sub="most used">
              <Bars list={w.byPlatform.map((x) => ({ k: x.k, n: x.n }))} />
            </Panel>
            <Panel title="Recently updated" sub="latest changes in the tracker" className="span-2">
              {w.recent.length ? (
                <div className="table-wrap">
                  <table className="t dash-t">
                    <thead><tr><th>Plug ID</th><th>Program</th><th>Work date</th><th>Updated</th></tr></thead>
                    <tbody>
                      {w.recent.map((r) => (
                        <tr key={r.id} className="clickable" onClick={() => navigate('/workload')}>
                          <td className="mono">{firstLine(r.plug_id)}</td>
                          <td>{r.prog_name || <span className="dim">—</span>}</td>
                          <td className="nowrap">{fmtDate(r.work_date)}</td>
                          <td className="dim nowrap">{ago(r.updated_at)}{r.by ? ` · ${r.by}` : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <Empty>No workload yet.</Empty>}
            </Panel>
          </div>
        </Section>
      ) : null}

      {/* ---------------- PSD Daily Plug List ---------------- */}
      {pl ? (
        <Section title="PSD Daily Plug List" hint={pl.plugs ? `${pl.plugs} plugs over ${pl.days} day${pl.days === 1 ? '' : 's'}` : 'nothing imported yet'} to="/plug-list">
          {pl.plugs ? (
            <div className="dash-grid">
              <Panel title="Plug list coverage" sub={pl.focus ? `${fmtDate(pl.focus.date)}${String(pl.focus.date).slice(0, 10) === todayIso ? ' · today' : ''}` : ''} className="span-2">
                {pl.focus && pl.focus.total ? (
                  <div className="dash-cover">
                    <div className="dc-nums">
                      <div><b>{pl.focus.inWorkload}</b><span>in the Workload Tracker</span></div>
                      <div><b>{pl.focus.total - pl.focus.inWorkload}</b><span>still to copy</span></div>
                      <div><b>{pct(pl.focus.inWorkload, pl.focus.total)}%</b><span>covered</span></div>
                    </div>
                    <div className="dc-track"><div style={{ width: `${pct(pl.focus.inWorkload, pl.focus.total)}%` }} /></div>
                    <div className="dim">{pl.focus.total} plug{pl.focus.total === 1 ? '' : 's'} on this day’s list{pl.focus.total - pl.focus.inWorkload ? ' — use Copy to Workload on the plug list page.' : ' — all of them are in the tracker.'}</div>
                  </div>
                ) : <Empty>No plugs on the current list day.</Empty>}
              </Panel>
              <Panel title="Lists on file">
                <div className="dash-facts">
                  <div><span>First day</span><b>{fmtDate(pl.first)}</b></div>
                  <div><span>Latest day</span><b>{fmtDate(pl.last)}</b></div>
                  <div><span>Days</span><b>{pl.days}</b></div>
                  <div><span>Plugs</span><b>{pl.plugs}</b></div>
                </div>
              </Panel>
            </div>
          ) : <div className="card"><Empty>No PSD Daily Plug List yet — import the PSD’s workbook on the plug list page.</Empty></div>}
        </Section>
      ) : null}

      {/* ---------------- Ingest & Approval ---------------- */}
      {d.kpis || d.recent ? (
        <Section title="Ingest & Approval" hint={d.kpis ? `${d.kpis.total} record${d.kpis.total === 1 ? '' : 's'}` : ''} to={d.canOpen.ingest ? '/ingest' : null} toLabel="Open tracker">
          {d.kpis ? (
            <>
              <div className="grid grid-4">
                <Kpi label="Total Ingest Records" value={d.kpis.total} foot={`${d.kpis.thisMonth.created} created this month`} color="c-blue" onClick={go(d.canOpen.ingest ? '/ingest' : null)} />
                <Kpi label="Pending Approval" value={st['Pending Approval'] || 0} foot="Awaiting a decision" color="c-amber" onClick={go(d.canOpen.approval ? '/approval?status=Pending' : null)} />
                <Kpi label="Approved" value={st.Approved || 0} foot={`${d.kpis.thisMonth.approved} this month`} color="c-green" onClick={go(d.canOpen.ingest ? '/ingest?status=Approved' : null)} />
                <Kpi label="Rejected" value={st.Rejected || 0} foot="Needs rework & resubmission" color="c-red" onClick={go(d.canOpen.ingest ? '/ingest?status=Rejected' : null)} />
              </div>
              {d.kpis.total ? (
                <div className="card dash-status mt-16">
                  <div className="dash-panel-head"><h3>Status mix</h3><span className="dim">share of all records</span></div>
                  <div className="ds-bar">
                    {STATUS_ORDER.map(([k, v]) => (st[k] ? <div key={k} style={{ width: `${pct(st[k], d.kpis.total)}%`, background: `var(${v})` }} title={`${k}: ${st[k]}`} /> : null))}
                  </div>
                  <div className="ds-legend">
                    {STATUS_ORDER.map(([k, v]) => <span key={k}><i style={{ background: `var(${v})` }} />{k} <b>{st[k] || 0}</b></span>)}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          {d.recent ? (
            <div className={`card ${d.kpis ? 'mt-16' : ''}`}>
              <div className="card-head"><h2>Recent Ingest Activity</h2></div>
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
        </Section>
      ) : null}

      {nothing ? <div className="card"><Empty>Nothing to show yet — your group has no Dashboard sections or tracker pages enabled.</Empty></div> : null}
    </main>
  );
}
