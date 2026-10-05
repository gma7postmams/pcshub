import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get } from '../lib/api.js';
import { ago, fmtBreakdate, fmtDate, initials } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { Empty, Kpi, RoleBadge } from '../components/ui.jsx';

// Dashboard — one screen for everything in flight. Blocks appear only if the signed-in user may see them:
//   Active users      (the Dashboard section "Active users")  — who is working in the app right now
//   Workload Tracker  (needs the Workload page)               — totals, the next two weeks, teams, upcoming breakdates, priority items
//   Ingest & Approval (the Dashboard section "Ingest KPIs")   — status counts
const TEAMS = [
  { key: 'VGFX', label: 'VGFX', color: 'var(--purple)' },
  { key: 'VEDIT', label: 'VEDIT', color: '#f0883e' },
  { key: 'AUDIO', label: 'Audio', color: '#26b5ad' },
];
const TEAM_COLOR = { VGFX: 'c-purple', VEDIT: 'c-orange', AUDIO: 'c-teal' };
const firstLine = (s) => String(s || '').split('\n')[0];
const dayParts = (iso) => {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return { dow: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }), num: d.getUTCDate(), weekend: [0, 6].includes(d.getUTCDay()) };
};
const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);
const HUES = ['#4f8cff', '#a78bfa', '#34c38f', '#f0883e', '#e5568f', '#26b5ad', '#f1b44c'];
const hueFor = (name) => HUES[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];

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
  const us = d.users;
  const st = d.kpis ? d.kpis.byStatus : {};
  const todayIso = String(d.today || '').slice(0, 10);
  const nothing = !w && !us && !d.kpis;

  return (
    <main className="container wide dash">
      <div className="dash-hero">
        <div>
          <h1>{greet}, {s.user.full_name.split(' ')[0]}</h1>
          <div className="sub">{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} · here’s where everything stands.</div>
        </div>
        <div className="actions">
          {d.canOpen.workload ? <Link className="btn primary" to="/workload">Workload Tracker</Link> : null}
          {s.can('ingest.write') ? <Link className="btn" to="/ingest?new=1">+ New Ingest</Link> : null}
          {d.canOpen.reports ? <Link className="btn" to="/reports">Reports</Link> : null}
        </div>
      </div>

      {/* ---------------- Active users ---------------- */}
      {us ? (
        <Section title="Active users" hint={us.active.length ? `${us.active.length} working right now` : `no one in the last ${us.windowMinutes} minutes`}>
          <div className="card dash-users">
            {us.active.length ? (
              <div className="du-grid">
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
        </Section>
      ) : null}

      {/* ---------------- Workload Tracker ---------------- */}
      {w ? (
        <Section title="Workload Tracker" hint={`${w.total} item${w.total === 1 ? '' : 's'} in total`} to="/workload">
          <div className="grid grid-4">
            <Kpi label="Today" value={w.today} foot={w.today === 1 ? 'item to work on' : 'items to work on'} color="c-blue" onClick={go('/workload')} />
            <Kpi label="This week" value={w.thisWeek} foot="Monday to Sunday" color="c-purple" onClick={go('/workload')} />
            <Kpi label="Breakdates, next 7 days" value={w.breakdatesNext7Days} foot="VGFX and VEDIT times coming up" color="c-green" onClick={go('/workload')} />
            <Kpi label="Priority" value={w.priority} foot={w.priority === 1 ? 'item flagged priority' : 'items flagged priority'} color="c-red" onClick={go('/workload')} />
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
        </Section>
      ) : null}

      {/* ---------------- Ingest & Approval ---------------- */}
      {d.kpis ? (
        <Section title="Ingest & Approval" hint={`${d.kpis.total} record${d.kpis.total === 1 ? '' : 's'}`} to={d.canOpen.ingest ? '/ingest' : null} toLabel="Open tracker">
          <div className="grid grid-4">
            <Kpi label="Total Ingest Records" value={d.kpis.total} foot={`${d.kpis.thisMonth.created} created this month`} color="c-blue" onClick={go(d.canOpen.ingest ? '/ingest' : null)} />
            <Kpi label="Pending Approval" value={st['Pending Approval'] || 0} foot="Awaiting a decision" color="c-amber" onClick={go(d.canOpen.approval ? '/approval?status=Pending' : null)} />
            <Kpi label="Approved" value={st.Approved || 0} foot={`${d.kpis.thisMonth.approved} this month`} color="c-green" onClick={go(d.canOpen.ingest ? '/ingest?status=Approved' : null)} />
            <Kpi label="Rejected" value={st.Rejected || 0} foot="Needs rework & resubmission" color="c-red" onClick={go(d.canOpen.ingest ? '/ingest?status=Rejected' : null)} />
          </div>
        </Section>
      ) : null}

      {nothing ? <div className="card"><Empty>Nothing to show yet — your group has no Dashboard sections or tracker pages enabled.</Empty></div> : null}
    </main>
  );
}
