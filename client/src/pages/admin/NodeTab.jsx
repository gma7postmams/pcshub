import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from '../../lib/api.js';
import { Empty, useToast } from '../../components/ui.jsx';
import { useSession } from '../../context.jsx';
import ReauthDialog from './ReauthDialog.jsx';

const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const mins = (ms) => (ms < 90000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`);

// Administration → Backup Server (System Admin). One app, two roles: the MAIN server everyone uses, and a BACKUP server that copies it
// every few hours and stays read-only until it is promoted. The setup (NODE_ROLE, NODE_MAIN_URL, NODE_SYNC_TOKEN in .env) is in the README.
export default function NodeTab() {
  const toast = useToast();
  const session = useSession();
  const [d, setD] = useState(null);
  const [dlg, setDlg] = useState(null);   // 'promote' | 'demote'
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const load = useCallback(() => get('/api/admin/node').then(setD).catch(() => setD(false)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {   // while a sync runs (or the other server is checked) keep the page fresh
    clearInterval(timer.current);
    timer.current = setInterval(load, d && d.running ? 4000 : 30000);
    return () => clearInterval(timer.current);
  }, [load, d && d.running]);

  if (d === null) return <Empty>Loading…</Empty>;
  if (d === false) return <Empty>Could not load the Backup Server tab.</Empty>;
  const backup = d.role === 'backup';
  const syncNow = async () => {
    setBusy(true);
    try { setD(await post('/api/admin/node/sync', {})); toast('Sync started'); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const act = (kind) => async ({ password, code, confirm }) => {
    try {
      const r = await post(`/api/admin/node/${kind}`, { password, code, confirm, force });
      setDlg(null); setForce(false); setD(r);
      toast(kind === 'promote' ? 'This server is now the main server' : 'This server is now a backup server');
      if (session && session.reload) session.reload();
    } catch (e) {
      if (e.data && e.data.mainReachable) setForce(true);   // ask again with the extra tick-box
      throw e;
    }
  };
  const la = d.lastAttempt;
  const failed = la && !la.ok;

  return (
    <div className="card">
      <div className="card-head"><h2 className="sr-only">Backup server</h2></div>
      <div className="card-pad">
        <div className="kv-row"><span className="kv-label">This server is the</span>
          <span className="kv-value"><span className={`chip ${backup ? 'c-amber' : 'c-green'}`} id="node-role">{backup ? 'BACKUP server (read-only)' : 'MAIN server'}</span></span></div>

        {backup ? (
          <>
            <div className="kv-row"><span className="kv-label">Copies from</span><span className="kv-value wrap-any">{d.mainUrl || <span className="dim">not set (NODE_MAIN_URL)</span>}</span></div>
            <div className="kv-row"><span className="kv-label">Main server</span>
              <span className="kv-value">{d.mainReachable && d.mainReachable.ok ? <span className="chip c-green">Answering</span> : <span className="chip c-red" title={d.mainReachable && d.mainReachable.error}>Not answering</span>}</span></div>
            <div className="kv-row"><span className="kv-label">Data here is as of</span><span className="kv-value" id="node-last">{d.lastSync ? `${when(d.lastSync.at)} (took ${mins(d.lastSync.durationMs)})` : 'Never copied yet'}</span></div>
            <div className="kv-row"><span className="kv-label">Next copy</span><span className="kv-value">{d.running ? `Running now: ${d.running.step}…` : d.nextSyncAt ? (new Date(d.nextSyncAt) <= new Date() ? `Within a minute (then every ${d.syncHours} h)` : `${when(d.nextSyncAt)} (every ${d.syncHours} h)`) : <span className="dim">off until NODE_MAIN_URL and NODE_SYNC_TOKEN are set</span>}</span></div>
            {failed ? <div className="alert err mt-12 wrap-any" id="node-error">The last copy failed ({when(la.at)}): {la.error}. It tries again in 15 minutes.</div> : null}
            <p className="muted">Everything here is replaced by the main server's data at every copy, and nothing can be changed on this server meanwhile. People can sign in with their usual accounts to read.</p>
            <div className="row mt-12">
              <button type="button" className="btn" id="node-sync" disabled={busy || Boolean(d.running) || !d.mainUrl || !d.tokenSet} onClick={syncNow}>Sync now</button>
              <button type="button" className="btn danger" id="node-promote" disabled={Boolean(d.running)} onClick={() => setDlg('promote')}>Promote to main…</button>
            </div>
            <div className="alert warn mt-12">
              <strong>When the main server is down:</strong> click <em>Promote to main</em>, then point users here (DNS, or the address in the reverse proxy). Changes made on the main server after
              the data time above are not here. Later, set the old server back up as a backup server (below) so it copies this one; never start it as a second main server.
            </div>
          </>
        ) : (
          <>
            <div className="kv-row"><span className="kv-label">Backup server link</span><span className="kv-value">{d.tokenSet ? <span className="chip c-green">NODE_SYNC_TOKEN set</span> : <span className="chip c-amber">NODE_SYNC_TOKEN not set: a backup server cannot copy this one</span>}</span></div>
            <div className="kv-row"><span className="kv-label">Backup server last asked</span><span className="kv-value">{d.lastPull ? `${when(d.lastPull.at)}${d.lastPull.ip ? ` from ${d.lastPull.ip}` : ''}` : <span className="dim">never</span>}</span></div>
            {d.promotedAt ? <div className="kv-row"><span className="kv-label">Promoted from backup</span><span className="kv-value">{when(d.promotedAt)}</span></div> : null}
            <p className="muted">The backup server asks this one for a fresh backup (database and uploaded files) every few hours. Those backups are marked “Backup server sync” in Backup and Restore and are not counted with your own.</p>
            <div className="row mt-12">
              <button type="button" className="btn danger" id="node-demote" onClick={() => setDlg('demote')}>Make this a backup server…</button>
            </div>
            <p className="dim">For the old main server after a failover: it then copies the new main server and its own data here is replaced. Needs NODE_MAIN_URL and NODE_SYNC_TOKEN in .env first.</p>
          </>
        )}
      </div>

      {dlg === 'promote' ? (
        <ReauthDialog
          title="Promote this server to main" okText="Promote to main" danger typed="PROMOTE" onClose={() => { setDlg(null); setForce(false); }}
          intro={`This server stops copying and becomes the main one, with the data as of ${d.lastSync ? when(d.lastSync.at) : 'its last copy (none yet: it may be empty)'}. Users must then be pointed here.`}
          extraReady onSubmit={act('promote')}
        >
          {force ? (
            <label className="alert warn row"><input type="checkbox" checked readOnly /> <span>The main server still answers. Promote anyway (two main servers can exist until the other one is stopped).</span></label>
          ) : null}
        </ReauthDialog>
      ) : null}
      {dlg === 'demote' ? (
        <ReauthDialog
          title="Make this a backup server" okText="Make backup server" danger typed="DEMOTE" onClose={() => setDlg(null)}
          intro={`This server becomes read-only and, within minutes, ALL of its data is replaced by a copy of ${d.mainUrl || 'the other server'}. Do this only on the server that is NOT the one people use now.`}
          onSubmit={act('demote')}
        />
      ) : null}
    </div>
  );
}
