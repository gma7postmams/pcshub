import { useEffect, useState } from 'react';
import { get } from '../lib/api.js';
import { initials } from '../lib/util.js';

// Who is on this page right now — round avatars in a row, like the collaborators at the top of a Google Sheet. Hover one to see the name.
// There are no profile pictures in the app, so each avatar is the person's initials on a colour of their own.
// The list is pushed live by the server (an event stream), so someone arriving or leaving shows up at once. If the stream can't be opened or drops,
// it quietly falls back to asking every 10 seconds, and straight away when the tab or window comes back into focus.
const HUES = ['#4f8cff', '#a78bfa', '#34c38f', '#f0883e', '#e5568f', '#26b5ad', '#f1b44c'];
const hueFor = (name) => HUES[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
const MAX_SHOWN = 6;

export default function PresenceAvatars({ path }) {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    let live = true;
    let busy = false;   // never stack requests if one is slow
    let es = null;
    const same = (a, b) => a.length === b.length && a.every((u, i) => u.id === b[i].id && u.you === b[i].you);
    const apply = (list) => { if (live) setUsers((cur) => (same(cur, list) ? cur : list)); };
    const load = () => {
      if (busy) return;
      busy = true;
      get(`/api/presence?path=${encodeURIComponent(path)}`, { quiet: true })
        .then((d) => apply(d.users || []))
        .catch(() => { /* best effort — the next tick tries again */ })
        .then(() => { busy = false; });
    };
    const close = () => { if (es) { es.close(); es = null; } };
    const open = () => {
      if (es || typeof EventSource === 'undefined') return;
      es = new EventSource(`/api/presence/stream?path=${encodeURIComponent(path)}`);
      es.onmessage = (e) => { try { apply(JSON.parse(e.data).users || []); } catch (err) { /* ignore a bad message */ } };
      // A refused stream (signed out, no access) is final; a dropped one reconnects by itself, and the poll below covers the gap.
      es.onerror = () => { if (es && es.readyState === 2) close(); };
    };
    const first = setTimeout(() => { load(); open(); }, 1500);   // let this page's own "I'm here" signal reach the server first
    // With the stream open the poll is only a safety net (30 s); without it, it is the main way and runs every 10 s.
    let n = 0;
    const timer = setInterval(() => { n += 1; if (document.visibilityState === 'visible' && (!es || es.readyState !== 1 || n % 3 === 0)) load(); }, 10000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') { load(); open(); }
      else close();   // a hidden tab doesn't need a live feed (and doesn't hold a connection open)
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { live = false; clearTimeout(first); clearInterval(timer); close(); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [path]);
  if (!users.length) return null;
  const shown = users.slice(0, MAX_SHOWN);
  const rest = users.slice(MAX_SHOWN);
  const nameOf = (u) => `${u.name}${u.you ? ' (you)' : ''}`;
  return (
    <div className="presence" role="list" aria-label="People on this page right now">
      {shown.map((u) => (
        <span key={u.id} role="listitem" className={`pa${u.you ? ' you' : ''}`} style={{ background: hueFor(u.name) }} data-tip={nameOf(u)} aria-label={nameOf(u)}>
          {initials(u.name).slice(0, 2)}
        </span>
      ))}
      {rest.length ? <span role="listitem" className="pa more" data-tip={rest.map(nameOf).join(', ')} aria-label={rest.map(nameOf).join(', ')}>+{rest.length}</span> : null}
    </div>
  );
}
