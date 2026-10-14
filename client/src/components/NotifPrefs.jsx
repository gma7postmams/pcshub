import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useToast } from './ui.jsx';

// Profile → "Notification settings": for each kind of activity this person can receive, switch the bell and the phone alert on or off.
export default function NotifPrefs() {
  const toast = useToast();
  const [kinds, setKinds] = useState(null);

  useEffect(() => {
    let alive = true;
    api('GET', '/api/profile/notif-prefs').then((d) => { if (alive) setKinds(d.kinds); }).catch((e) => toast(e.message, 'err'));
    return () => { alive = false; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const set = async (kind, channel, on) => {
    setKinds((ks) => ks.map((k) => (k.key === kind ? { ...k, [channel]: on } : k)));   // shown at once; put back if the save fails
    try { await api('PUT', '/api/profile/notif-prefs', { kind, channel, on }); }
    catch (e) { setKinds((ks) => ks.map((k) => (k.key === kind ? { ...k, [channel]: !on } : k))); toast(e.message, 'err'); }
  };
  const all = async (on) => { for (const k of kinds) for (const ch of ['bell', 'push']) if (k[ch] !== on) await set(k.key, ch, on); };

  if (!kinds) return null;
  if (!kinds.length) return null;
  return (
    <div className="card mt-14" id="notif-prefs">
      <div className="card-head">
        <h2>Notification settings</h2>
        <span className="np-all"><button type="button" className="btn" onClick={() => all(true)}>All on</button><button type="button" className="btn" onClick={() => all(false)}>All off</button></span>
      </div>
      <div className="card-pad">
        <p className="muted m-0">Choose which activities notify you. <strong>Bell</strong> is the list inside the app; <strong>Phone</strong> is the alert on your phone or computer (it also needs Phone notifications turned on for that device). Only the activities your role and group can receive are listed.</p>
        <div className="np-list">
          <div className="np-row np-head"><span>Activity</span><span>Bell</span><span>Phone</span></div>
          {kinds.map((k) => (
            <div className="np-row" key={k.key}>
              <span className="np-what"><strong>{k.label}</strong><span className="dim">{k.desc}</span></span>
              <label className="np-sw" title="Show in the bell"><input type="checkbox" data-kind={k.key} data-ch="bell" checked={k.bell} onChange={(e) => set(k.key, 'bell', e.target.checked)} /><span className="sr-only">Bell</span></label>
              <label className="np-sw" title="Alert on my phone"><input type="checkbox" data-kind={k.key} data-ch="push" checked={k.push} onChange={(e) => set(k.key, 'push', e.target.checked)} /><span className="sr-only">Phone</span></label>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
