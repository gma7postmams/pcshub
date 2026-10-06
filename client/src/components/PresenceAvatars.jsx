import { useEffect, useState } from 'react';
import { get } from '../lib/api.js';
import { initials } from '../lib/util.js';

// Who is on this page right now — round avatars in a row, like the collaborators at the top of a Google Sheet. Hover one to see the name.
// There are no profile pictures in the app, so each avatar is the person's initials on a colour of their own. Refreshes every 10 seconds (like Active users on the Dashboard), and straight away when the tab or window comes back into focus.
const HUES = ['#4f8cff', '#a78bfa', '#34c38f', '#f0883e', '#e5568f', '#26b5ad', '#f1b44c'];
const hueFor = (name) => HUES[[...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
const MAX_SHOWN = 6;

export default function PresenceAvatars({ path }) {
  const [users, setUsers] = useState([]);
  useEffect(() => {
    let live = true;
    let busy = false;   // never stack requests if one is slow
    const same = (a, b) => a.length === b.length && a.every((u, i) => u.id === b[i].id && u.you === b[i].you);
    const load = () => {
      if (busy) return;
      busy = true;
      get(`/api/presence?path=${encodeURIComponent(path)}`, { quiet: true })
        .then((d) => { if (live) setUsers((cur) => (same(cur, d.users || []) ? cur : (d.users || []))); })
        .catch(() => { /* best effort — the next tick tries again */ })
        .then(() => { busy = false; });
    };
    const first = setTimeout(load, 1500);   // let this page's own "I'm here" signal reach the server first
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 10000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { live = false; clearTimeout(first); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
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
