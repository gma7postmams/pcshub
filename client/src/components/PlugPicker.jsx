import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon } from './Icons.jsx';

// The Plug ID field of the New / Edit Workload form: there is no free-text box — a plug is picked from the PSD Daily Plug List of the
// chosen Work Date (search by plug ID, program or PSD). `plugs` is null while loading. A row saved earlier with a Plug ID that isn't on
// the list is shown as it is (tagged) so it can still be saved unchanged, until another plug is chosen.
const firstLine = (s) => String(s || '').split('\n')[0].trim();

export default function PlugPicker({ date, value, plugs, disabled, onPick, manageLink }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef(null);
  const search = useRef(null);
  const list = useRef(null);
  const cur = firstLine(value);
  const selected = plugs && cur ? plugs.find((p) => p.plug_id.toUpperCase() === cur.toUpperCase()) : null;
  const legacy = !!cur && !!plugs && !selected;
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (plugs || []).filter((p) => !needle || `${p.plug_id} ${p.prog_name} ${p.psd}`.toLowerCase().includes(needle)).slice(0, 300);
  }, [plugs, q]);

  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);
  useEffect(() => { if (open && search.current) search.current.focus(); }, [open]);
  useEffect(() => { setHi(0); }, [q, open]);
  useEffect(() => {
    const el = open && list.current ? list.current.children[hi] : null;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  const pick = (p) => { setOpen(false); setQ(''); onPick(p); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.min(items.length - 1, Math.max(0, h + (e.key === 'ArrowDown' ? 1 : -1)))); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[hi]) pick(items[hi]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };

  let blocked = null;
  if (!date) blocked = 'Choose the Work Date first';
  else if (plugs === null) blocked = 'Loading the plug list…';
  else if (!plugs.length) blocked = `No PSD Daily Plug List for this date yet`;

  return (
    <div className="plugpick" ref={box}>
      <button type="button" className={`plugpick-btn${cur ? ' has' : ''}`} disabled={disabled || !!blocked} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>
        {cur ? (
          <span className="pp-cur">
            <span className="pp-id">{cur}</span>
            {selected ? <span className="pp-sub">{selected.prog_name || '(no title)'} · {selected.psd || '(no PSD)'}</span> : null}
            {legacy ? <span className="chip c-orange pp-tag">not on this day’s list</span> : null}
          </span>
        ) : <span className="dim">{blocked || 'Choose a plug from the PSD Daily Plug List…'}</span>}
        <ChevronDownIcon />
      </button>
      {blocked && date && plugs && !plugs.length ? <div className="pp-hint">{manageLink || 'Import the day’s list on the PSD Daily Plug List page first.'}</div> : null}
      {open ? (
        <div className="plugpick-pop">
          <input ref={search} className="plugpick-search" type="search" placeholder={`Search ${plugs.length} plug${plugs.length === 1 ? '' : 's'} — plug ID, program, PSD…`}
            value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} autoComplete="off" />
          <ul role="listbox" ref={list}>
            {items.length ? items.map((p, i) => (
              <li key={p.id} role="option" aria-selected={selected && selected.id === p.id} className={`${i === hi ? 'hi' : ''}${selected && selected.id === p.id ? ' sel' : ''}`.trim()}
                onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(p); }}>
                <span className="pp-id">{p.plug_id}</span>
                <span className="pp-sub">{p.prog_name || '(no title)'} · {p.psd || '(no PSD)'}</span>
                {p.in_workload ? <span className="chip c-green pp-tag">in workload</span> : null}
              </li>
            )) : <li className="none">No plug matches “{q}”</li>}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
