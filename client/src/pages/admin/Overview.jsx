import { useEffect, useState } from 'react';
import { get } from '../../lib/api.js';
import { fmtBytes, fmtDateTime } from '../../lib/util.js';
import { Empty } from '../../components/ui.jsx';

const ago = (d) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

export default function Overview({ go }) {
  const [o, setO] = useState(null);
  const [b, setB] = useState(null);
  useEffect(() => {
    get('/api/admin/overview').then(setO).catch(() => setO(false));
    get('/api/admin/backups/status').then(setB).catch(() => {});
  }, []);
  if (o === null) return <Empty>Loading…</Empty>;
  if (o === false) return <Empty>Could not load the overview.</Empty>;
  const stale = b ? b.stale : !o.lastBackup;
  const tiles = [
    ['Users online now', o.online, `${o.users.active} active of ${o.users.total}`, 'users', ''],
    ['Failed sign-ins (7 days)', o.failedLogins7d, o.users.locked ? `${o.users.locked} locked now` : 'None locked now', 'security', o.failedLogins7d >= 10 ? 'warn' : ''],
    ['Waiting for approval', o.pendingApproval, 'Ingest records', null, ''],
    ['2FA on', `${o.users.twofa_on}/${o.users.active}`, 'active users', 'security', ''],
  ];
  return (
    <div className="card">
      <div className="card-head"><h2 className="sr-only">Overview</h2></div>
      <div className="card-pad">
        {stale ? (
          <div className="alert warn mb-12">
            {o.lastBackup ? `The last successful backup was ${ago(o.lastBackup.at)}.` : 'There is no successful backup yet.'}{' '}
            <button type="button" className="linklike" onClick={() => go('backup')}>Open Backup and Restore</button>
          </div>
        ) : null}
        <div className="stat-grid">
          {tiles.map(([label, value, sub, tab, tone]) => (
            <div className={`stat ${tone}`} key={label}>
              <span className="stat-label">{label}</span>
              <span className="stat-value">{value}</span>
              <span className="dim">{tab ? <button type="button" className="linklike" onClick={() => go(tab)}>{sub}</button> : sub}</span>
            </div>
          ))}
          <div className={`stat ${stale ? 'warn' : ''}`}>
            <span className="stat-label">Last backup</span>
            <span className="stat-value">{o.lastBackup ? ago(o.lastBackup.at) : 'Never'}</span>
            <span className="dim">{o.lastBackup ? `${fmtDateTime(o.lastBackup.at)}${o.lastBackup.size ? ` · ${fmtBytes(o.lastBackup.size)}` : ''}` : 'Create one in Backup and Restore'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
