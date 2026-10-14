import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useToast } from './ui.jsx';

const b64 = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); };
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

// "Phone notifications" card on the Profile page: switches Web Push on/off for THIS device.
export default function PushSetup() {
  const toast = useToast();
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState(supported ? Notification.permission : 'unsupported');

  useEffect(() => {
    if (!supported) return undefined;
    let alive = true;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) { if (alive) setOn(false); return; }
        const { endpoints } = await api('GET', '/api/profile/push', undefined, { quiet: true });
        if (alive) setOn(endpoints.includes(sub.endpoint));
      } catch (_) { /* leave it off */ }
    })();
    return () => { alive = false; };
  }, [supported]);

  const enable = async () => {
    setBusy(true);
    try {
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== 'granted') { toast('Notifications are blocked. Allow them in your phone settings for this app.', 'err'); return; }
      const { key } = await api('GET', '/api/profile/push');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
      await api('POST', '/api/profile/push', sub.toJSON());
      setOn(true);
      toast('Phone notifications are on');
    } catch (e) { toast(e.message || 'Could not turn notifications on', 'err'); } finally { setBusy(false); }
  };
  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await api('DELETE', '/api/profile/push', { endpoint: sub.endpoint }); await sub.unsubscribe(); }
      setOn(false);
      toast('Phone notifications are off for this device');
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const test = async () => { try { await api('POST', '/api/profile/push/test'); toast('Test sent. It should arrive in a few seconds.'); } catch (e) { toast(e.message, 'err'); } };

  let note = null;
  if (!supported) {
    note = isIos && !standalone
      ? 'On iPhone, first add this app to your Home Screen (Share, then Add to Home Screen), open it from there, and come back to this page.'
      : 'This browser does not support push notifications.';
  } else if (perm === 'denied') {
    note = 'Notifications are blocked for this app. Allow them in your phone settings (iPhone: Settings, Notifications, this app; Android: long-press the app icon, App info, Notifications), then reload.';
  }

  return (
    <div className="card" id="push-card">
      <div className="card-head"><h2>Phone notifications</h2>{supported ? (on ? <span className="pill s-approved">On</span> : <span className="pill s-hold">Off</span>) : null}</div>
      <div className="card-pad stack">
        <p className="muted m-0">Get the same alerts as the bell as a notification on this phone or computer, even when the app is closed. This is per device: turn it on on each phone you use.</p>
        {note ? <p className="m-0 push-note">{note}</p> : null}
        {supported && perm !== 'denied' ? (
          <div className="row gap-8">
            {on
              ? <><button type="button" className="btn" id="push-off" disabled={busy} onClick={disable}>Turn off</button><button type="button" className="btn" id="push-test" onClick={test}>Send a test</button></>
              : <button type="button" className="btn primary" id="push-on" disabled={busy} onClick={enable}>Turn on notifications</button>}
          </div>
        ) : null}
      </div>
    </div>
  );
}
