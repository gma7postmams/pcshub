import { useCallback, useEffect, useState } from 'react';
import { get } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/util.js';
import { Empty } from '../../components/ui.jsx';

const EVENT = {
  'auth.login_failed': 'Failed sign-in', 'auth.locked': 'Account locked', 'auth.login_blocked_locked': 'Sign-in blocked (locked)', 'auth.2fa_failed': 'Wrong 2FA code',
  'auth.reauth_failed': 'Wrong password on a sensitive action', 'admin.user_signout': 'Signed out by an Admin', 'admin.user_reset_password': 'Password reset', 'admin.user_reset_2fa': '2FA reset',
};

export default function Security({ go }) {
  const [d, setD] = useState(null);
  const load = useCallback(() => get('/api/admin/security').then(setD).catch(() => setD(false)), []);
  useEffect(() => { load(); }, [load]);
  if (d === null) return <Empty>Loading…</Empty>;
  if (d === false) return <Empty>Could not load security details.</Empty>;
  const { policy: p, users: u } = d;
  const rows = [
    ['Password', `At least ${p.minPasswordLength} characters. ${p.passwordRules}.`],
    ['Account lock', `After ${p.lockAfterFailures} wrong passwords in a row, the account is locked for ${p.lockMinutes} minutes. An Admin can unlock it sooner.`],
    ['Sign-in rate limit', `${p.loginRateLimit} sign-in attempts per 15 minutes from one address.`],
    ['Idle sign-out', `After ${p.idleSignOutHours} ${p.idleSignOutHours === 1 ? 'hour' : 'hours'} without activity.`],
    ['Longest session', `${p.maxSessionHours >= 48 ? `${Math.round(p.maxSessionHours / 24)} days` : `${p.maxSessionHours} hours`}, then sign in again.`],
  ];
  return (
    <>
      <div className="card mb-12">
        <div className="card-head"><h2>Where things stand</h2></div>
        <div className="card-pad">
          {u.admins_without_2fa ? <div className="alert warn mb-12">{u.admins_without_2fa} active {u.admins_without_2fa === 1 ? 'Admin has' : 'Admins have'} no 2FA. <button type="button" className="linklike" onClick={() => go('users')}>Review users</button></div> : null}
          <div className="stat-grid">
            <div className="stat"><span className="stat-label">Signed in now</span><span className="stat-value">{d.openSessions == null ? '—' : d.openSessions}</span><span className="dim">open sessions</span></div>
            <div className="stat"><span className="stat-label">2FA on</span><span className="stat-value">{u.twofa_on}/{u.active}</span><span className="dim">{u.twofa_pending ? `${u.twofa_pending} awaiting setup` : 'active users'}</span></div>
            <div className={`stat ${d.failedLogins7d >= 10 ? 'warn' : ''}`}><span className="stat-label">Failed sign-ins</span><span className="stat-value">{d.failedLogins7d}</span><span className="dim">last 7 days</span></div>
            <div className={`stat ${u.locked ? 'warn' : ''}`}><span className="stat-label">Locked accounts</span><span className="stat-value">{u.locked}</span><span className="dim">{u.must_change ? `${u.must_change} must change password` : 'right now'}</span></div>
          </div>
          <div className="dim mt-12">To sign someone out of every device, open the person in Users and choose <strong>Sign out everywhere</strong>; to do it for several people, tick them and use the bulk action. Disabling an account also signs it out.</div>
        </div>
      </div>
      <div className="card mb-12">
        <div className="card-head"><h2>Rules in force</h2></div>
        <div className="card-pad">{rows.map(([k, v]) => <div className="kv-row" key={k}><span className="kv-label">{k}</span><span className="kv-value">{v}</span></div>)}
          <div className="dim mt-12">These are set by the server&apos;s settings, not here.</div></div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Recent security events</h2><button type="button" className="btn sm" onClick={load}>Refresh</button></div>
        <div className="table-wrap">
          <table className="t wl">
            <thead><tr><th>Time</th><th>Who</th><th>Event</th><th>IP</th></tr></thead>
            <tbody>{d.events.length ? d.events.map((e) => (
              <tr key={e.id}><td className="nowrap dim">{fmtDateTime(e.created_at)}</td><td className="mono">{e.username || '—'}</td><td>{EVENT[e.action] || e.action}</td><td className="mono dim">{e.ip || ''}</td></tr>
            )) : <tr><td colSpan={4} className="empty">Nothing to report.</td></tr>}</tbody>
          </table>
        </div>
      </div>
    </>
  );
}
