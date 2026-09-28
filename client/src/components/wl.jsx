import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtDate, isoDate } from '../lib/util.js';
import { CalendarIcon, ChevronDownIcon, KebabIcon, PencilIcon, TrashIcon } from './Icons.jsx';

// Presentational pieces for the Workload Tracker (pills, summary cards, filters, row menu, pager).
// Colours come from the app's theme variables (see .c-* in app.css), so they follow every theme and light/dark mode.

const PALETTE = ['blue', 'purple', 'teal', 'orange', 'green', 'pink', 'gray'];
/** Stable colour for any text (platforms, plug types added later by an Admin, ...) */
const hueOf = (s) => PALETTE[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

export const Chip = ({ hue, dot, small, children }) => (
  <span className={`chip c-${hue}${small ? ' sm' : ''}`}>{dot ? <i className="dot" /> : null}{children}</span>
);

const STATUS_HUE = { Draft: 'gray', 'In Progress': 'blue', 'For Review': 'amber', Approved: 'green', Completed: 'teal' };
export const StatusPill = ({ value }) => (value ? <Chip hue={STATUS_HUE[value] || 'gray'} dot>{value}</Chip> : null);

const TYPE_HUE = { EPISODIC: 'blue', SEASONAL: 'purple', BUMPER: 'orange', 'POP-UP/POP LOGO': 'blue', RADIO: 'green' };
export const TypePill = ({ value }) => (value ? <Chip hue={TYPE_HUE[value] || hueOf(value)}>{value}</Chip> : null);

const TEAM_HUE = { VGFX: 'purple', VEDIT: 'orange', AUDIO: 'teal' };
const TEAM_LABEL = { VGFX: 'VGFX', VEDIT: 'VEDIT', AUDIO: 'Audio' };
/** One team -> one pill with the option's own wording ("VGFX Only", "Audio - RADIO"); several teams -> one pill each */
export function UnitsPills({ value, unitTeams }) {
  const teams = (value && unitTeams[value]) || [];
  if (!teams.length) return null;
  if (teams.length === 1) return <Chip hue={TEAM_HUE[teams[0]]}>{value}</Chip>;
  return <span className="chips">{teams.map((t) => <Chip key={t} hue={TEAM_HUE[t]}>{TEAM_LABEL[t]}</Chip>)}</span>;
}

/** "REG/TDMD (GMA MUSIC)" -> pill "REG/TDMD" with "GMA MUSIC" underneath; plain platforms -> just the pill */
export function PlatformCell({ value }) {
  if (!value) return null;
  const m = /^(.+?)\s*\((.+)\)$/.exec(value);
  const main = m ? m[1] : value;
  return <div className="stack"><Chip hue={hueOf(main)}>{main}</Chip>{m ? <span className="sub">{m[2]}</span> : null}</div>;
}

const dayNum = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
/** Friendly label for a date relative to today (null when it is far away) */
export function relDay(iso, today = isoDate()) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const n = dayNum(today) - dayNum(iso);
  if (n === 0) return { label: 'Today', hue: 'blue' };
  if (n === 1) return { label: 'Yesterday', hue: 'gray' };
  if (n > 1 && n <= 30) return { label: `${n} days ago`, hue: 'gray' };
  if (n === -1) return { label: 'Tomorrow', hue: 'green' };
  if (n < -1 && n >= -30) return { label: `In ${-n} days`, hue: 'green' };
  return null;
}
export function WorkDate({ value, today }) {
  const rel = relDay(value, today);
  return <div className="stack"><strong>{fmtDate(value)}</strong>{rel ? <Chip hue={rel.hue} small>{rel.label}</Chip> : null}</div>;
}

/** Summary card: coloured icon tile + label + big number. Clickable when onClick is given. */
export function KpiCard({ hue, icon, label, value, active, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`wl-kpi c-${hue}${active ? ' active' : ''}`} onClick={onClick}>
      <span className="ico">{icon}</span>
      <span className="txt"><span className="lbl">{label}</span><span className="num">{value ?? '–'}</span></span>
    </Tag>
  );
}

/** Select with its label inside the box (like the design) */
export function FilterSelect({ label, value, onChange, children }) {
  return (
    <label className="fsel">
      <span>{label}</span>
      <select value={value} onChange={onChange}>{children}</select>
      <ChevronDownIcon />
    </label>
  );
}

const shift = (iso, days) => { const d = new Date(dayNum(iso) * 86400000 + days * 86400000); return d.toISOString().slice(0, 10); };
/** Single control showing the date range; opens a small panel with presets and From / To */
export function DateRange({ from, to, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const today = isoDate();
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = shift(`${shift(monthStart, 32).slice(0, 7)}-01`, -1);
  const presets = [
    ['Today', { from: today, to: today }],
    ['Last 7 days', { from: shift(today, -6), to: today }],
    ['This month', { from: monthStart, to: monthEnd }],
    ['All dates', { from: '', to: '' }],
  ];
  const label = from || to ? `${from ? fmtDate(from) : 'Any'} – ${to ? fmtDate(to) : 'Any'}` : 'All dates';
  return (
    <div className="daterange" ref={ref}>
      <button type="button" className="daterange-btn" title="Work date range" onClick={() => setOpen((o) => !o)}><CalendarIcon /><span>{label}</span></button>
      {open ? (
        <div className="popover daterange-pop">
          <div className="presets">
            {presets.map(([name, range]) => <button key={name} type="button" className="btn sm" onClick={() => { onChange(range); setOpen(false); }}>{name}</button>)}
          </div>
          <label className="f"><span>From</span><input type="date" value={from} onChange={(e) => onChange({ from: e.target.value, to })} /></label>
          <label className="f"><span>To</span><input type="date" value={to} onChange={(e) => onChange({ from, to: e.target.value })} /></label>
        </div>
      ) : null}
    </div>
  );
}

/** Row "⋮" menu: fixed-position so it is never clipped by the scrolling table */
export function RowMenu({ onEdit, onDelete }) {
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const menu = useRef(null);
  const openedAt = useRef(0);
  const close = useCallback(() => setPos(null), []);
  useEffect(() => {
    if (!pos) return undefined;
    const away = (e) => { if (menu.current && !menu.current.contains(e.target) && e.target !== btn.current && !btn.current.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    // scrolling closes the menu, but not the tail of the scroll that brought the button into view (touch/momentum scrolling)
    const onScroll = () => { if (Date.now() - openedAt.current > 300) close(); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [pos, close]);
  const toggle = (e) => {
    e.stopPropagation();
    if (pos) { close(); return; }
    openedAt.current = Date.now();
    const r = btn.current.getBoundingClientRect();
    const up = r.bottom + 100 > window.innerHeight;
    setPos({ right: Math.max(8, window.innerWidth - r.right), ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) });
  };
  return (
    <>
      <button type="button" className="kebab" aria-label="Row actions" aria-haspopup="menu" aria-expanded={!!pos} ref={btn} onClick={toggle}><KebabIcon /></button>
      {pos ? (
        <div className="rowmenu" role="menu" style={pos} ref={menu}>
          <button type="button" role="menuitem" onClick={() => { close(); onEdit(); }}><PencilIcon /> Edit</button>
          <button type="button" role="menuitem" className="danger row-del" onClick={() => { close(); onDelete(); }}><TrashIcon /> Delete</button>
        </div>
      ) : null}
    </>
  );
}

function pageList(cur, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out = [1];
  const lo = Math.max(2, cur - 1);
  const hi = Math.min(pages - 1, cur + 1);
  if (lo > 2) out.push('…');
  for (let i = lo; i <= hi; i++) out.push(i);
  if (hi < pages - 1) out.push('…');
  out.push(pages);
  return out;
}
/** "1–8 of 24" + Previous / 1 2 3 / Next */
export function Pager({ total, offset, size, onOffset }) {
  const pages = Math.max(1, Math.ceil(total / size));
  const cur = Math.floor(offset / size) + 1;
  return (
    <div className="pager">
      <span>{total ? `${offset + 1}–${Math.min(offset + size, total)} of ${total}` : ''}</span>
      <span className="grow" />
      <button type="button" className="btn sm" disabled={cur <= 1} onClick={() => onOffset((cur - 2) * size)}>Previous</button>
      {pageList(cur, pages).map((n, i) => (n === '…'
        ? <span key={`gap${i}`} className="pg-gap">…</span>
        : <button key={n} type="button" className={`btn sm pg${n === cur ? ' on' : ''}`} onClick={() => onOffset((n - 1) * size)}>{n}</button>))}
      <button type="button" className="btn sm" disabled={cur >= pages} onClick={() => onOffset(cur * size)}>Next</button>
    </div>
  );
}
