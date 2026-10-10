import { useCallback, useEffect, useState } from 'react';
import { get, post, put } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/util.js';
import { Empty, useConfirm, useToast } from '../../components/ui.jsx';

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
      <Rules policy={p} limits={d.limits} onSaved={load} />
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

const NUM = [
  ['minPasswordLength', 'Minimum password length', 'characters', 'Applies to passwords set from now on.'],
  ['lockAfterFailures', 'Lock after wrong passwords', 'in a row', 'Then the account is locked.'],
  ['lockMinutes', 'Lock lasts', 'minutes', 'An Admin can unlock sooner.'],
  ['idleSignOutHours', 'Sign out after being idle', 'hours', 'Counted from the last activity.'],
  ['maxSessionHours', 'Longest session', 'hours', 'Then sign in again, however active.'],
];

// The rules an Admin can change here. Range-checked on the server; every change is written to the Audit Log.
function Rules({ policy, limits, onSaved }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [f, setF] = useState(policy);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(policy), [policy]);
  const dirty = Object.keys(limits).some((k) => Number(f[k]) !== policy[k]) || f.requireAdmin2fa !== policy.requireAdmin2fa;
  const bad = Object.entries(limits).find(([k, l]) => !(Number(f[k]) >= l.min && Number(f[k]) <= l.max));
  const save = async () => {
    const weaker = f.minPasswordLength < policy.minPasswordLength || f.lockAfterFailures > policy.lockAfterFailures
      || f.maxSessionHours > policy.maxSessionHours || (policy.requireAdmin2fa && !f.requireAdmin2fa);
    if (weaker && !(await confirm('Weaken a security rule?', 'One of the changes makes the rules less strict. Save it anyway?', { okText: 'Save', danger: true }))) return;
    setBusy(true);
    try {
      await put('/api/admin/security/settings', {
        ...Object.fromEntries(Object.keys(limits).map((k) => [k, Number(f[k])])), requireAdmin2fa: Boolean(f.requireAdmin2fa),
      });
      toast('Security rules saved'); onSaved();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const force = async () => {
    if (!(await confirm('Everyone changes their password', 'Every other active user must choose a new password at their next sign-in. Use this after tightening the password rules, or after a suspected leak.', { okText: 'Require change', danger: true }))) return;
    try { const r = await post('/api/admin/security/force-password-change', {}); toast(`${r.users} ${r.users === 1 ? 'user' : 'users'} must change their password`); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <div className="card mb-12">
      <div className="card-head"><h2>Rules</h2><button type="button" className="btn primary sm" disabled={!dirty || busy || Boolean(bad)} onClick={save}>Save rules</button></div>
      <div className="card-pad">
        <div className="sched-grid">
          {NUM.map(([k, label, unit, hint]) => (
            <label className="f" key={k}><span>{label} <span className="dim">({unit})</span></span>
              <input type="number" min={limits[k].min} max={limits[k].max} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-invalid={Number(f[k]) < limits[k].min || Number(f[k]) > limits[k].max} />
              <span className="dim mt-6">{hint} Allowed {limits[k].min}–{limits[k].max}.</span></label>
          ))}
        </div>
        <label className="check mt-12"><input type="checkbox" checked={Boolean(f.requireAdmin2fa)} onChange={(e) => setF({ ...f, requireAdmin2fa: e.target.checked })} />
          {' '}Require 2FA for every Admin <span className="dim">— Admins without it must set it up at their next use</span></label>
        <div className="kv-row mt-12"><span className="kv-label">Also always</span><span className="kv-value">{policy.passwordRules}. {policy.loginRateLimit} sign-in attempts per 15 minutes from one address (set in the server&apos;s .env).</span></div>
        <div className="row mt-12"><button type="button" className="btn sm danger" onClick={force}>Make everyone change their password</button><span className="dim">at their next sign-in</span></div>
      </div>
    </div>
  );
}
