import { useCallback, useEffect, useState } from 'react';
import { get, put } from '../../lib/api.js';
import { Empty, useConfirm, useToast } from '../../components/ui.jsx';
import { useSession } from '../../context.jsx';

// Maintenance mode (System Admin only). While it is on, only a System Admin can sign in or use the site; everyone else sees an
// "Under maintenance" page. The server also honours MAINTENANCE_MODE in .env and a MAINTENANCE flag file; this switch is the third way.
export default function Maintenance() {
  const toast = useToast();
  const confirm = useConfirm();
  const session = useSession();
  const [d, setD] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => get('/api/admin/maintenance').then((x) => { setD(x); setMsg(x.uiMessage || ''); }).catch(() => setD(false)), []);
  useEffect(() => { load(); }, [load]);
  if (d === null) return <Empty>Loading…</Empty>;
  if (d === false) return <Empty>Could not load maintenance mode.</Empty>;

  const { sources: src } = d;
  const outside = src.env || src.file;   // kept on by the server's .env or the flag file, whatever this switch says
  const set = async (on) => {
    if (on && !(await confirm('Turn on maintenance mode?', 'Everyone except System Admins is locked out right away: they see an "Under maintenance" page and cannot sign in. People already signed in are not signed out, they just see the page until you turn it off.', { okText: 'Turn on', danger: true }))) return;
    setBusy(true);
    try {
      const r = await put('/api/admin/maintenance', { on, message: msg.trim() });
      setD(r);
      toast(on ? 'Maintenance mode is ON' : (r.on ? 'Switched off here, but it is still on (see below)' : 'Maintenance mode is OFF'));
      if (session && session.reload) session.reload();   // the top-bar badge follows
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const saveMsg = async () => {
    setBusy(true);
    try { const r = await put('/api/admin/maintenance', { on: true, message: msg.trim() }); setD(r); toast('Message updated'); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const changed = src.ui && msg.trim() !== (d.uiMessage || '');

  return (
    <div className="card">
      <div className="card-head"><h2 className="sr-only">Maintenance mode</h2></div>
      <div className="card-pad">
        <div className="kv-row mb-12"><span className="kv-label">Status</span><span className="kv-value"><span className={`chip ${d.on ? 'c-amber' : 'c-green'}`} id="maint-state">{d.on ? 'ON' : 'OFF'}</span></span></div>
        <p className="m-0">Closes the site to everyone except System Admins, for upgrades and similar work. Visitors and regular users see an &quot;Under maintenance&quot; page and their sign-in is refused. You and other System Admins carry on as usual.</p>

        <label className="f mt-12"><span>Message shown to everyone else <span className="dim">(optional, up to {d.maxMessage} characters)</span></span>
          <input id="maint-msg" value={msg} maxLength={d.maxMessage} placeholder="We are upgrading the system. Back at 3 PM." onChange={(e) => setMsg(e.target.value)} />
        </label>

        <div className="row mt-12">
          {src.ui
            ? <>
              <button type="button" className="btn primary" id="maint-off" disabled={busy} onClick={() => set(false)}>Turn off</button>
              <button type="button" className="btn" id="maint-save" disabled={busy || !changed} onClick={saveMsg}>Update message</button>
            </>
            : <button type="button" className="btn danger" id="maint-on" disabled={busy} onClick={() => set(true)}>Turn on maintenance mode</button>}
        </div>

        {outside ? (
          <div className="alert warn mt-12 wrap-any" id="maint-outside">
            Maintenance mode is also held on by the server
            {src.env && src.file ? ': MAINTENANCE_MODE in .env and the flag file' : src.env ? ': MAINTENANCE_MODE=true in .env' : ': the flag file'}.
            {' '}Turning this switch off will not end it.
            {src.env ? ' Set MAINTENANCE_MODE=false in .env and restart the service.' : ''}
            {src.file ? <> Delete the file <span className="mono">{d.flagFile}</span> on the server (its text, if any, is the message people see).</> : null}
          </div>
        ) : null}

        <div className="dim mt-12 wrap-any">Other ways to switch it, without opening the app: create or delete the file <span className="mono">{d.flagFile}</span> (takes effect within a second), or set <span className="mono">MAINTENANCE_MODE</span> in the server&apos;s .env and restart. Every change made here is written to the Audit Log.</div>
      </div>
    </div>
  );
}
