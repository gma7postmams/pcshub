import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post } from '../lib/api.js';
import { ago, fmtDate, initials } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { Empty, RoleBadge } from '../components/ui.jsx';
import {
  CalendarCheckIcon, CalendarGridIcon, CheckCircleIcon, ChevronDownSmall, ChevronRightIcon, ClockIcon, DocIcon, FlagIcon,
  HeroArt, HourglassIcon, MoonArt, PulseIcon, SunArt, UsersIcon, XCircleIcon,
} from '../components/DashIcons.jsx';
import '../dashboard.css';

// Dashboard. Everything on it is shown only if the signed-in user may see it:
//   greeting banner · Active users + Recent Activity · Workload Tracker (KPI cards) · Workload by day + By team · Ingest Tracker (KPI cards)
// It lays itself out for the screen: two columns on a wide screen, stacked on a narrow one. The chart row keeps a fixed height on a big screen.
const TEAMS = [
  { key: 'VGFX', label: 'VGFX', color: 'var(--purple)' },
  { key: 'VEDIT', label: 'VEDIT', color: '#f0883e' },
  { key: 'AUDIO', label: 'Audio', color: '#26b5ad' },
];
const HUES = ['#4f8cff', '#a78bfa', '#34c38f', '#f0883e', '#e5568f', '#26b5ad', '#f1b44c'];
const hueFor = (name) => HUES[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
const pct = (n, of) => (of ? Math.round((n / of) * 100) : 0);
const monthOf = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
const dayParts = (iso) => {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return { dow: d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }), num: d.getUTCDate(), weekend: [0, 6].includes(d.getUTCDay()) };
};
const dayLabel = (iso) => { const p = dayParts(iso); return `${p.dow}, ${monthOf(iso)} ${p.num}`; };
const RANGE_KEY = 'dash:range';
// The menu choice is remembered only for the sign-in it was made in: it is stored with that sign-in's key (see /api/auth/me → session_key), so
// reloads and page changes keep it, but after signing out (and in again) it starts at "This week" again — and so does anyone else who signs in.
const readRange = (sessionKey) => {
  if (!sessionKey) return 'week';
  try { const v = JSON.parse(localStorage.getItem(RANGE_KEY)); return v && v.k === sessionKey && typeof v.r === 'string' ? v.r : 'week'; } catch (e) { return 'week'; }
};
const saveRange = (sessionKey, r) => { if (!sessionKey) return; try { localStorage.setItem(RANGE_KEY, JSON.stringify({ k: sessionKey, r })); } catch (e) { /* storage unavailable */ } };

/** A card's heading: a tinted icon chip, the title, a little grey hint and an optional control at the right. */
function CardHead({ icon: Icon, hue, dot, plain, title, hint, sub, right }) {
  return (
    <div className="dsh-head">
      {dot ? <i className="dsh-live" /> : <span className={`dsh-chip h-${hue}${plain ? ' plain' : ''}`}><Icon /></span>}
      <div className="dsh-head-text">
        <h2>{title}{hint ? <span className="dsh-hint">{hint}</span> : null}</h2>
        {sub ? <div className="dsh-sub">{sub}</div> : null}
      </div>
      {right ? <div className="dsh-head-right">{right}</div> : null}
    </div>
  );
}

/** A KPI card: a round icon, the label, a big number and a line of detail; the whole card opens the related page. */
function StatCard({ icon: Icon, hue, soft, label, value, foot, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`dsh-stat h-${hue}${soft ? ' soft' : ''}${onClick ? ' link' : ''}`} onClick={onClick || undefined}>
      <span className="dsh-stat-ico"><Icon /></span>
      <span className="dsh-stat-body">
        <span className="dsh-stat-label">{label}</span>
        <b className="dsh-stat-val">{value}</b>
        <span className="dsh-stat-foot">{foot}</span>
      </span>
      {onClick ? <span className="dsh-stat-go"><ChevronRightIcon /></span> : null}
    </Tag>
  );
}

/** The little "This week ▾" menu on the Workload Tracker card: which days the chart covers. */
function RangeMenu({ ranges, value, onChange }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  const current = ranges.find((r) => r.key === value) || ranges[0];
  return (
    <div className="dsh-range" ref={box}>
      <button type="button" className="dsh-range-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="dsh-range-ico"><CalendarGridIcon /></span>{current.label}<span className="dsh-range-chev"><ChevronDownSmall /></span>
      </button>
      {open ? (
        <ul className="dsh-range-list" role="listbox">
          {ranges.map((r) => (
            <li key={r.key} role="option" aria-selected={r.key === value} className={r.key === value ? 'sel' : ''}
              onMouseDown={(e) => { e.preventDefault(); setOpen(false); onChange(r.key); }}>{r.label}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** "Earlier today · 2": people active in the last 24 hours who aren't now; hover or focus it for their names. (A pill, not a row, so Active users never grows taller.) */
function EarlierPill({ people }) {
  if (!people.length) return null;
  return (
    <span className="dsh-earlier" tabIndex={0} aria-label={`Earlier today: ${people.map((p) => p.name).join(', ')}`}>
      Earlier today<b>{people.length}</b>
      <span className="dsh-earlier-pop" role="tooltip">
        {people.map((p) => <span key={p.id}><i style={{ background: hueFor(p.name) }} />{p.name}<em>{ago(p.lastActiveAt)}</em></span>)}
      </span>
    </span>
  );
}

/** The scrolling list of online people. When some are scrolled out of sight a small "+N more" pill sits on a faint fade at the bottom edge
    (same look as the "Earlier today" pill); click it to scroll down. At the end of the list the pill and the fade go away. */
function UserScroller({ count, children }) {
  const ref = useRef(null);
  const [more, setMore] = useState(0);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const edge = el.scrollTop + el.clientHeight + 2;
    let n = 0;
    for (const c of el.children) if (c.offsetTop + c.offsetHeight > edge) n += 1;   // not fully in view yet
    setMore((cur) => (cur === n ? cur : n));
  }, []);
  useEffect(() => { measure(); });   // after every render: people come and go every few seconds
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [measure]);
  const down = () => {
    const el = ref.current;
    if (!el) return;
    const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ top: Math.max(60, Math.round(el.clientHeight * 0.8)), behavior: calm ? 'auto' : 'smooth' });
  };
  return (
    <div className="dsh-ulwrap">
      <div className="dsh-userlist" ref={ref} onScroll={measure} data-count={count}>{children}</div>
      {more > 0 ? (
        <>
          <div className="dsh-ulfade" aria-hidden="true" />
          <button type="button" className="dsh-more" onClick={down} aria-label={`${more} more ${more === 1 ? 'person' : 'people'} online, scroll down`}>+{more} more</button>
        </>
      ) : null}
    </div>
  );
}

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const partsOf = (iso) => ({ y: iso.slice(0, 4), m: monthOf(iso), d: Number(iso.slice(8, 10)) });
/** What one bar covers, for the tooltip: a day, a week ("Sep 28 – Oct 4"), a month ("October 2026") or a year. */
function barLabel(x, bucket) {
  if (bucket === 'week') { const a = partsOf(x.iso); const z = partsOf(x.last); return `${a.m} ${a.d}${a.y !== z.y ? `, ${a.y}` : ''} – ${z.m} ${z.d}, ${z.y}`; }
  if (bucket === 'month') return new Date(`${x.iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (bucket === 'year') return x.iso.slice(0, 4);
  return dayLabel(x.iso);
}
/** The short label under a bar (and whether to show it: with many bars only every few are labelled). */
function axisLabel(x, i, days, bucket) {
  const a = partsOf(x.iso);
  if (bucket === 'week') return `${a.m} ${a.d}`;
  if (bucket === 'month') return i === 0 || a.m === 'Jan' ? `${a.m} '${a.y.slice(2)}` : a.m;
  return a.y;
}

function dayInfo(byDay, bucket = 'day') {
  const days = byDay.map((x) => ({ iso: String(x.day).slice(0, 10), last: String(x.last || x.day).slice(0, 10), n: x.n }));
  const total = days.reduce((a, x) => a + x.n, 0);
  const top = Math.max(...days.map((x) => x.n), 0);
  return { days, bucket, total, top, busiest: days.find((x) => x.n === top && top > 0), avg: total / (days.length || 1) };
}

function DayChart({ info, todayIso }) {
  const { days, top, bucket } = info;
  const niceMax = Math.max(4, Math.ceil(top / 4) * 4);   // the axis tops out on a multiple of 4, so the gridlines are whole numbers
  const ticks = [1, 0.75, 0.5, 0.25, 0].map((f) => Math.round(niceMax * f));
  const byDays = bucket === 'day';
  const dense = !byDays || days.length > 16;   // a month or 30 days, or week / month / year bars: no weekday names
  const step = byDays ? 1 : Math.max(1, Math.ceil(days.length / 12));   // with many bars only every few are labelled
  const cols = { gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` };
  if (!days.length) return <div className="dsh-chart-empty"><Empty>No workload yet.</Empty></div>;
  return (
    <div className={`dsh-chart${dense ? ' dense' : ''}${byDays ? '' : ' buckets'}`}>
      <div className="dsh-plotwrap">
        <div className="dsh-y">{ticks.map((t) => <span key={t}>{t}</span>)}</div>
        <div className="dsh-plot">
          {[0, 25, 50, 75].map((p) => <div key={p} className="dsh-line" style={{ top: `${p}%` }} />)}
          <div className="dsh-line base" />
          <div className="dsh-cols" style={cols}>
            {days.map((x) => {
              const p = dayParts(x.iso);
              const h = x.n ? Math.max((x.n / niceMax) * 100, 3) : 0;
              const kind = x.last < todayIso ? 'past' : x.iso <= todayIso ? 'today' : 'next';   // a bar that contains today is "today"
              return (
                <div key={x.iso} className={`dsh-col ${kind}${byDays && p.weekend ? ' weekend' : ''}`}>
                  {x.n ? <span className="dsh-val" style={{ bottom: `calc(${h}% + 4px)` }}>{x.n}</span> : <span className="dsh-zero" />}
                  <div className="dsh-bar" style={{ height: `${h}%` }} />
                  <span className="dsh-tip" style={{ bottom: h > 62 ? `calc(${h}% - 58px)` : `calc(${h}% + 26px)` }}>{barLabel(x, bucket)}<b>{x.n} item{x.n === 1 ? '' : 's'}</b></span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="dsh-xaxis" style={cols}>
        {days.map((x, i) => {
          const p = dayParts(x.iso);
          const isToday = x.last >= todayIso && x.iso <= todayIso;
          const showMonth = i === 0 || p.num === 1;
          const label = byDays
            ? (dense ? (showMonth ? `${monthOf(x.iso)} ${p.num}` : p.num) : `${monthOf(x.iso)} ${p.num}`)
            : axisLabel(x, i, days, bucket);
          const skipped = !byDays && !isToday && i % step !== 0 && !(bucket === 'month' && partsOf(x.iso).m === 'Jan');   // the start of a year is always labelled
          return (
            <div key={x.iso} className={`dsh-xl${isToday ? ' today' : ''}${byDays && p.weekend ? ' weekend' : ''}`}>
              {dense ? null : <span className="dsh-xl-dow">{p.dow}</span>}
              {isToday && byDays ? <span className="dsh-xl-pill">{p.num}</span> : <span className={`dsh-xl-date${skipped ? ' skip' : ''}${isToday ? ' now' : ''}`}>{label}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const s = useSession();
  const navigate = useNavigate();
  const [d, setD] = useState(null);
  const [range, setRangeState] = useState(() => readRange(s.session_key));
  const rangeRef = useRef(range);
  rangeRef.current = range;
  // Active users grows with the number of people online, up to the height of the Recent Activity card beside it, then scrolls inside.
  const [actH, setActH] = useState(null);
  const actObs = useRef(null);
  const actRef = useCallback((node) => {
    if (actObs.current) { actObs.current.disconnect(); actObs.current = null; }
    if (!node) { setActH(null); return; }
    const measure = () => setActH(Math.round(node.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver !== 'undefined') { actObs.current = new ResizeObserver(measure); actObs.current.observe(node); }
  }, []);

  const load = useCallback(() => get(`/api/dashboard?range=${rangeRef.current}`).then(setD).catch(() => setD((cur) => cur || { error: true })), []);
  useEffect(() => {
    // Say "I'm on the Dashboard" BEFORE asking for the numbers, so Active users never shows where you were a moment ago
    post('/api/presence', { path: '/dashboard' }, { quiet: true }).catch(() => { /* best effort */ }).then(load);
    const t = setInterval(load, 60000);   // the whole dashboard refreshes every minute
    return () => clearInterval(t);
  }, [load]);
  // Active users is live: a Server-Sent-Events stream pushes the list the moment someone arrives, switches page or leaves. A light poll stays as a
  // safety net (every 30 s while the stream is open, every 10 s if it can't be), and everything re-syncs when the tab comes back into view.
  const showUsers = !!(d && d.users);
  useEffect(() => {
    if (!showUsers) return undefined;
    let es = null;
    let live = true;
    let busy = false;
    const apply = (users) => setD((cur) => (cur ? { ...cur, users } : cur));
    const poll = () => {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      get('/api/dashboard/users', { quiet: true }).then((r) => { if (live) apply(r.users); }).catch(() => { /* next time */ }).then(() => { busy = false; });
    };
    const close = () => { if (es) { es.close(); es = null; } };
    const open = () => {
      if (es || typeof EventSource === 'undefined') return;
      es = new EventSource('/api/dashboard/users/stream');
      es.onmessage = (e) => { try { const m = JSON.parse(e.data); if (live && m.users) apply(m.users); } catch (err) { /* ignore a bad message */ } };
      es.onerror = () => { if (es && es.readyState === 2) close(); };   // refused (signed out / no access) is final; a dropped stream reconnects by itself
    };
    open();
    let n = 0;
    const t = setInterval(() => { n += 1; if (!es || es.readyState !== 1 || n % 3 === 0) poll(); }, 10000);
    const onVisible = () => { if (document.visibilityState === 'visible') { poll(); open(); } else close(); };   // a hidden tab doesn't hold a connection open
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { live = false; close(); clearInterval(t); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [showUsers]);

  const changeRange = (key) => {
    setRangeState(key);
    saveRange(s.session_key, key);
    get(`/api/dashboard/days?range=${key}`).then((r) => setD((cur) => (cur && cur.workload ? { ...cur, workload: { ...cur.workload, byDay: r.days, bucket: r.bucket, range: r.range, rangeLabel: r.label, rangeSub: r.sub } } : cur))).catch(() => { /* keep the old chart */ });
  };

  if (!d) return <main className="container wide dsh"><Empty>Loading…</Empty></main>;
  if (d.error) return <main className="container wide dsh"><Empty>Could not load the dashboard.</Empty></main>;

  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const night = hour >= 18 || hour < 5;   // the moon from 6 pm until 5 am, the sun in between (the wording of the greeting is separate)
  const go = (href) => (href ? () => navigate(href) : null);
  const w = d.workload;
  const us = d.users;
  const st = d.kpis ? d.kpis.byStatus : {};
  const todayIso = String(d.today || '').slice(0, 10);
  const act = d.activity;
  const nothing = !w && !us && !d.kpis && !act;
  const info = w ? dayInfo(w.byDay, w.bucket) : null;

  return (
    <main className="container wide dsh">
      <section className="dsh-hero">
        {night ? <MoonArt /> : <SunArt />}
        <div className="dsh-hero-text">
          <h1>{greet}, {s.user.full_name.split(' ')[0]}!</h1>
          <div className="dsh-date">{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
        </div>
        <HeroArt />
      </section>

      {us || act ? (
        <div className={`dsh-row2${us && act ? '' : ' one'}`}>
          {us ? (
            <section className="dsh-card dsh-users" style={actH ? { '--act-h': `${actH}px` } : undefined}>
              <CardHead dot title="Active users" hint={us.active.length ? `${us.active.length} working right now` : `no one in the last ${us.windowMinutes} minutes`} right={<EarlierPill people={us.earlier} />} />
              {us.active.length ? (
                <UserScroller count={us.active.length}>
                  {us.active.map((p) => {
                    const where = p.you ? 'Dashboard' : p.page;
                    const target = p.you ? null : (p.path && s.canPage(p.path) ? p.path : null);   // a card opens the page that person is on, if you can open it too
                    const Tag = target ? 'button' : 'div';
                    return (
                      <Tag key={p.id} type={target ? 'button' : undefined} className={`dsh-user${target ? ' link' : ''}`} onClick={target ? () => navigate(target) : undefined}
                        title={`${p.name} · ${p.role}${where ? ` · on ${where}` : ''} · ${p.you ? 'just now' : ago(p.lastActiveAt)}`}>
                        <span className="dsh-avatar" style={{ background: hueFor(p.name) }}>{initials(p.name).slice(0, 2)}<i className="dsh-status" /></span>
                        <span className="dsh-user-info">
                          <span className="dsh-user-name"><span className="dsh-user-nm">{p.name}</span>{p.you ? <span className="dsh-you">You</span> : null}</span>
                          <span className="dsh-user-meta"><RoleBadge role={p.role} />{where ? <span className="dim">on {where}</span> : null}</span>
                        </span>
                        {target ? <span className="dsh-go"><ChevronRightIcon /></span> : null}
                      </Tag>
                    );
                  })}
                </UserScroller>
              ) : <Empty>No one has been active in the last {us.windowMinutes} minutes.</Empty>}
            </section>
          ) : null}

          {act ? (
            <section className="dsh-card dsh-activity-card" ref={actRef}>
              <CardHead icon={ClockIcon} hue="blue" title="Recent Activity" sub="Latest updates across the hub"
                right={<Link to="/activity-history" className="dsh-viewall">View all<ChevronRightIcon /></Link>} />
              {act.length ? (
                <ul className="dsh-activity">
                  {act.map((a) => (
                    <li key={a.id}>
                      <Link to={a.path} className="dsh-act">
                        <span className="dsh-act-av" style={{ background: hueFor(a.name) }}>{initials(a.name).slice(0, 2)}</span>
                        <span className="dsh-act-name">{a.you ? 'You' : a.name}</span>
                        <span className="dsh-act-text">{a.verb}{a.label ? <> <b>{a.label}</b></> : null}</span>
                        <span className="dsh-act-time">{ago(a.at)}</span>
                        <i className={`dsh-act-dot h-${a.hue}`} />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <Empty>No activity yet.</Empty>}
            </section>
          ) : null}
        </div>
      ) : null}

      {w ? (
        <section className="dsh-card">
          <CardHead icon={PulseIcon} hue="blue" title="Workload Tracker" hint={`${w.total} item${w.total === 1 ? '' : 's'} in total`} right={<RangeMenu ranges={w.ranges} value={w.range} onChange={changeRange} />} />
          <div className="dsh-stats">
            <StatCard icon={CalendarGridIcon} hue="blue" label="Today" value={w.today} foot={w.today === 1 ? 'item to work on' : 'items to work on'} onClick={go('/workload')} />
            <StatCard icon={CalendarGridIcon} hue="purple" label="This week" value={w.thisWeek} foot="Monday to Sunday" onClick={go('/workload')} />
            <StatCard icon={ClockIcon} hue="teal" label="Breakdates, next 7 days" value={w.breakdatesNext7Days} foot="VGFX and VEDIT times coming up" onClick={go('/workload')} />
            <StatCard icon={FlagIcon} hue="rose" label="Priority" value={w.priority} foot={w.priority === 1 ? 'item flagged priority' : 'items flagged priority'} onClick={go('/workload')} />
          </div>
        </section>
      ) : null}

      {w ? (
        <div className="dsh-row3">
          <section className="dsh-card dsh-chart-card">
            <CardHead icon={UsersIcon} hue="blue" title={`Workload by ${info.bucket}`} sub={w.rangeSub}
              right={(
                <div className="dsh-cstats">
                  <span>In view <b>{info.total}</b></span>
                  <span>{{ day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }[info.bucket]} average <b>{info.avg.toFixed(1)}</b></span>
                  <span>Busiest {info.bucket} <b>{info.busiest ? `${barLabel(info.busiest, info.bucket)} · ${info.busiest.n}` : '—'}</b></span>
                  <span className="dsh-legend"><i className="past" />Past<i className="next" />Upcoming<i className="today" />Today</span>
                </div>
              )} />
            <DayChart info={info} todayIso={todayIso} />
          </section>

          <section className="dsh-card dsh-team-card">
            <CardHead icon={UsersIcon} hue="blue" title="By team" hint="items each team is on" />
            <div className="dsh-teams">
              {TEAMS.map((t) => (
                <div className="dsh-team" key={t.key}>
                  <div className="dsh-team-top"><span className="dsh-team-name"><i style={{ background: t.color }} />{t.label}</span><b>{w.byTeam[t.key] || 0}</b></div>
                  <div className="dsh-track"><div style={{ width: `${pct(w.byTeam[t.key] || 0, w.total)}%`, background: t.color }} /></div>
                </div>
              ))}
              <div className="dsh-note"><span>VGFX/VEDIT</span> item counts for both teams.</div>
            </div>
          </section>
        </div>
      ) : null}

      {d.kpis ? (
        <section className="dsh-card">
          <CardHead icon={DocIcon} hue="blue" plain title="Ingest Tracker" hint={`${d.kpis.total} record${d.kpis.total === 1 ? '' : 's'}`} />
          <div className="dsh-stats compact">
            <StatCard icon={CalendarCheckIcon} hue="blue" soft label="Total Ingest Records" value={d.kpis.total} foot={`${d.kpis.thisMonth.created} created this month`} onClick={go(d.canOpen.ingest ? '/ingest' : null)} />
            <StatCard icon={HourglassIcon} hue="amber" soft label="Pending (CM)" value={st.Pending || 0} foot="Awaiting a CM decision" onClick={go(d.canOpen.ingest ? '/ingest?status=Pending' : null)} />
            <StatCard icon={CheckCircleIcon} hue="green" label="Done" value={st.DONE || 0} foot={`${d.kpis.thisMonth.done} this month`} onClick={go(d.canOpen.ingest ? '/ingest?status=DONE' : null)} />
            <StatCard icon={XCircleIcon} hue="red" label="Non-compliant" value={st['NON-COMPLIANT'] || 0} foot="Needs rework" onClick={go(d.canOpen.ingest ? '/ingest?status=NON-COMPLIANT' : null)} />
          </div>
        </section>
      ) : null}

      {nothing ? <div className="dsh-card"><Empty>Nothing to show yet — your group has no Dashboard sections or tracker pages enabled.</Empty></div> : null}
    </main>
  );
}
