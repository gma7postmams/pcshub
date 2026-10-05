import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../lib/api.js';
import { ago, fmtDate, initials } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { Empty, Kpi, RoleBadge } from '../components/ui.jsx';

// Dashboard — one screen for everything in flight. Blocks appear only if the signed-in user may see them:
//   Active users      (the Dashboard section "Active users")  — who is working in the app right now
//   Workload Tracker  (needs the Workload page)               — totals, the next two weeks, teams
//   Ingest & Approval (the Dashboard section "Ingest KPIs")   — status counts
const TEAMS = [
  { key: 'VGFX', label: 'VGFX', color: 'var(--purple)' },
  { key: 'VEDIT', label: 'VEDIT', color: '#f0883e' },
  { key: 'AUDIO', label: 'Audio', color: '#26b5ad' },
];
const dayParts = (iso) => {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return { dow: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }), num: d.getUTCDate(), weekend: [0, 6].includes(d.getUTCDay()) };
};
const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);
const HUES = ['#4f8cff', '#a78bfa', '#34c38f', '#f0883e', '#e5568f', '#26b5ad', '#f1b44c'];
const hueFor = (name) => HUES[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];

/** Workload by day: a column chart with a y axis and gridlines, past days muted, upcoming days in the accent colour, today picked out. */
function DayChart({ byDay, todayIso }) {
  const days = byDay.map((x) => ({ iso: String(x.day).slice(0, 10), n: x.n }));
  const total = days.reduce((a, x) => a + x.n, 0);
  const top = Math.max(...days.map((x) => x.n), 0);
  const busiest = days.find((x) => x.n === top && top > 0);
  const niceMax = Math.max(4, Math.ceil(top / 4) * 4);   // axis tops out on a multiple of 4 so the four gridlines are whole numbers
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => Math.round(niceMax * f));
  const label = (iso) => {
    const p = dayParts(iso);
    return `${p.dow}, ${new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })} ${p.num}`;
  };
  return (
    <div className="wbd">
      <div className="wbd-stats">
        <div><span>In view</span><b>{total}</b></div>
        <div><span>Daily average</span><b>{(total / (days.length || 1)).toFixed(1)}</b></div>
        <div><span>Busiest day</span><b>{busiest ? `${label(busiest.iso)} · ${busiest.n}` : '—'}</b></div>
        <div className="wbd-legend"><span><i className="past" />Past</span><span><i className="next" />Upcoming</span><span><i className="today" />Today</span></div>
      </div>
      <div className="wbd-chart">
        <div className="wbd-y">{ticks.map((t) => <span key={t}>{t}</span>)}</div>
        <div className="wbd-plot">
          {[0, 25, 50, 75].map((pct0) => <div key={pct0} className="wbd-line" style={{ top: `${pct0}%` }} />)}
          <div className="wbd-line base" />
          <div className="wbd-cols">
            {days.map((x) => {
              const p = dayParts(x.iso);
              const h = x.n ? Math.max((x.n / niceMax) * 100, 3) : 0;
              const kind = x.iso === todayIso ? 'today' : x.iso < todayIso ? 'past' : 'next';
              return (
                <div key={x.iso} className={`wbd-col ${kind}${p.weekend ? ' weekend' : ''}`}>
                  {x.n ? <span className="wbd-val" style={{ bottom: `calc(${h}% + 5px)` }}>{x.n}</span> : <span className="wbd-zero" />}
                  <div className="wbd-bar" style={{ height: `${h}%` }} />
                  <span className="wbd-tip" style={{ bottom: `calc(${h}% + 28px)` }}>{label(x.iso)}<b>{x.n} item{x.n === 1 ? '' : 's'}</b></span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="wbd-x">
        {days.map((x, i) => {
          const p = dayParts(x.iso);
          const month = new Date(`${x.iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
          return (
            <div key={x.iso} className={`wbd-xl${x.iso === todayIso ? ' today' : ''}${p.weekend ? ' weekend' : ''}`}>
              <span className="wbd-mon">{i === 0 || p.num === 1 ? month : ''}</span>
              <span className="wbd-dow">{p.dow}</span>
              <span className="wbd-num">{p.num}</span>
            </div>
          );
        })}
      </div>
    </div>
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
  const us = d.users;
  const st = d.kpis ? d.kpis.byStatus : {};
  const todayIso = String(d.today || '').slice(0, 10);
  const nothing = !w && !us && !d.kpis;

  const workloadKpis = w ? (
    <div className="dash-kgroup">
      <div className="dash-kgroup-h"><h2>Workload Tracker</h2><span className="dim">{w.total} item{w.total === 1 ? '' : 's'} in total</span></div>
      <div className="dash-kgrid">
        <Kpi label="Today" value={w.today} foot={w.today === 1 ? 'item to work on' : 'items to work on'} color="c-blue" onClick={go('/workload')} />
        <Kpi label="This week" value={w.thisWeek} foot="Monday to Sunday" color="c-purple" onClick={go('/workload')} />
        <Kpi label="Breakdates, next 7 days" value={w.breakdatesNext7Days} foot="VGFX and VEDIT times" color="c-green" onClick={go('/workload')} />
        <Kpi label="Priority" value={w.priority} foot={w.priority === 1 ? 'item flagged' : 'items flagged'} color="c-red" onClick={go('/workload')} />
      </div>
    </div>
  ) : null;
  const ingestKpis = d.kpis ? (
    <div className="dash-kgroup">
      <div className="dash-kgroup-h"><h2>Ingest &amp; Approval</h2><span className="dim">{d.kpis.total} record{d.kpis.total === 1 ? '' : 's'}</span></div>
      <div className="dash-kgrid">
        <Kpi label="Total Ingest Records" value={d.kpis.total} foot={`${d.kpis.thisMonth.created} created this month`} color="c-blue" onClick={go(d.canOpen.ingest ? '/ingest' : null)} />
        <Kpi label="Pending Approval" value={st['Pending Approval'] || 0} foot="Awaiting a decision" color="c-amber" onClick={go(d.canOpen.approval ? '/approval?status=Pending' : null)} />
        <Kpi label="Approved" value={st.Approved || 0} foot={`${d.kpis.thisMonth.approved} this month`} color="c-green" onClick={go(d.canOpen.ingest ? '/ingest?status=Approved' : null)} />
        <Kpi label="Rejected" value={st.Rejected || 0} foot="Needs rework" color="c-red" onClick={go(d.canOpen.ingest ? '/ingest?status=Rejected' : null)} />
      </div>
    </div>
  ) : null;

  // On a laptop-sized window (1100 px wide and 620 px tall or more) the whole dashboard fits the screen with no page scrolling:
  // the hero, the KPI row and then the chart beside Active users / By team share the remaining height. Smaller windows just stack and scroll.
  return (
    <main className="container wide dash fit">
      <div className="dash-hero">
        <h1>{greet}, {s.user.full_name.split(' ')[0]}</h1>
        <div className="sub">{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · here’s where everything stands.</div>
      </div>

      {w || d.kpis ? <div className={`dash-kpirow${w && d.kpis ? '' : ' one'}`}>{workloadKpis}{ingestKpis}</div> : null}

      {w || us ? (
        <div className={`dash-main${w ? '' : ' single'}`}>
          {w ? (
            <Panel title="Workload by day" sub="past week and the week ahead" className="dash-chart-panel">
              <DayChart byDay={w.byDay} todayIso={todayIso} />
            </Panel>
          ) : null}
          <div className="dash-side">
            {us ? (
              <Panel title="Active users" sub={us.active.length ? `${us.active.length} working right now` : `no one in the last ${us.windowMinutes} minutes`} className="dash-users-panel">
                <div className="du-scroll">
                  {us.active.length ? (
                    <div className="du-list">
                      {us.active.map((p) => (
                        <div className="du" key={p.id}>
                          <span className="du-avatar" style={{ background: hueFor(p.name) }}>{initials(p.name).slice(0, 2)}<i className="du-dot" title="Active now" /></span>
                          <div className="du-info">
                            <div className="du-name">{p.name}{p.you ? <span className="chip du-you">You</span> : null}</div>
                            <div className="du-meta"><RoleBadge role={p.role} />{p.page ? <span className="dim">on {p.page}</span> : null}</div>
                          </div>
                          <span className="du-ago dim">{ago(p.lastActiveAt)}</span>
                        </div>
                      ))}
                    </div>
                  ) : <Empty>No one has been active in the last {us.windowMinutes} minutes.</Empty>}
                  {us.earlier.length ? (
                    <div className="du-earlier">
                      <span className="dim">Earlier today</span>
                      {us.earlier.map((p) => <span className="du-chip" key={p.id} title={`${p.role}${p.page ? ` · last on ${p.page}` : ''}`}><i style={{ background: hueFor(p.name) }} />{p.name}<em>{ago(p.lastActiveAt)}</em></span>)}
                    </div>
                  ) : null}
                </div>
              </Panel>
            ) : null}
            {w ? (
              <Panel title="By team" sub="a VGFX/VEDIT item counts for both" className="dash-team-panel">
                <div className="dash-teams">
                  {TEAMS.map((t) => (
                    <div className="dt" key={t.key}>
                      <div className="dt-top"><span className="dt-name"><i style={{ background: t.color }} />{t.label}</span><b>{w.byTeam[t.key] || 0}</b></div>
                      <div className="dt-track"><div style={{ width: `${pct(w.byTeam[t.key] || 0, w.total)}%`, background: t.color }} /></div>
                    </div>
                  ))}
                </div>
              </Panel>
            ) : null}
          </div>
        </div>
      ) : null}

      {nothing ? <div className="card"><Empty>Nothing to show yet — your group has no Dashboard sections or tracker pages enabled.</Empty></div> : null}
    </main>
  );
}
