import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post, put } from '../lib/api.js';
import { useSession } from '../context.jsx';
import { AppearanceSeg } from '../components/TopNav.jsx';
import { Modal, RoleBadge, useForm, useToast } from '../components/ui.jsx';

export default function Profile() {
  const s = useSession();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const u = s.user;
  const forced = u.must_change_password;
  const needs2fa = u.totp_required && !u.totp_enabled;
  const [acct, setAcct] = useForm({ full_name: u.full_name, email: u.email || '' });
  const [pw, setPw, setPwAll] = useForm({ current: '', password: '', confirm: '' });
  const [setup, setSetup] = useState(null);   // { secret, qr }

  const startSetup = async () => {
    try { setSetup(await post('/api/profile/2fa/setup')); } catch (e) { toast(e.message, 'err'); }
  };

  useEffect(() => {
    if (params.get('force') && !forced) setParams({}, { replace: true });
    if (!forced && needs2fa) startSetup();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveAccount = async (e) => {
    e.preventDefault();
    try { await put('/api/profile', acct); s.patchUser(acct); toast('Profile saved'); } catch (ex) { toast(ex.message, 'err'); }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    if (pw.password !== pw.confirm) { toast('New passwords do not match', 'err'); return; }
    try {
      await post('/api/profile/password', { current: pw.current, password: pw.password });
      toast('Password updated');
      setPwAll({ current: '', password: '', confirm: '' });
      if (forced) setTimeout(() => { window.location.href = '/'; }, 600);
    } catch (ex) { toast(ex.message, 'err'); }
  };

  const pages = s.pages.map((p) => p.label).join(', ');

  return (
    <main className="container">
      <div className="page-head"><div><h1>Profile</h1><div className="sub">Your account, password and two-factor authentication.</div></div></div>
      {forced ? <div className="alert warn mb-12"><strong>Password change required.</strong> Set a new password to continue using the app.</div> : null}
      {!forced && needs2fa ? <div className="alert warn mb-12"><strong>Two-factor authentication is required for your account.</strong> Set it up below to continue using the app.</div> : null}

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>Account</h2><RoleBadge role={u.role} /></div>
          <form className="card-pad stack" id="pf" onSubmit={saveAccount}>
            <label className="f"><span>Username</span><input value={u.username} disabled /></label>
            <label className="f"><span>Full name</span><input name="full_name" maxLength={120} value={acct.full_name} onChange={setAcct('full_name')} /></label>
            <label className="f"><span>Email</span><input name="email" type="email" maxLength={200} value={acct.email} onChange={setAcct('email')} /></label>
            <div><button className="btn primary" disabled={forced}>Save</button></div>
            <dl className="kv">
              <dt>Role</dt><dd>{u.role} <span className="dim">— what you can do</span></dd>
              <dt>Group</dt><dd>
                {u.group || (u.role === 'Admin'
                  ? <span className="dim">Not needed (Admin role opens every page)</span>
                  : <span className="dim">Not enrolled — ask an Admin</span>)}{' '}
                <span className="dim">— what you can open</span>
              </dd>
              <dt>Pages</dt><dd>{pages}</dd>
            </dl>
          </form>
        </div>

        <div className="card">
          <div className="card-head"><h2>Change password</h2></div>
          <form className="card-pad stack" id="pwf" autoComplete="off" onSubmit={changePassword}>
            <label className="f"><span>Current password</span><input name="current" type="password" autoComplete="current-password" value={pw.current} onChange={setPw('current')} /></label>
            <label className="f"><span>New password</span><input name="password" type="password" autoComplete="new-password" placeholder="8+ chars, letters and numbers" value={pw.password} onChange={setPw('password')} /></label>
            <label className="f"><span>Confirm new password</span><input name="confirm" type="password" autoComplete="new-password" value={pw.confirm} onChange={setPw('confirm')} /></label>
            <div><button className="btn primary">Update password</button></div>
            <div className="dim">Other sessions are signed out when you change your password.</div>
          </form>
        </div>

        <div className="card">
          <div className="card-head"><h2>Appearance</h2></div>
          <div className="card-pad stack">
            <div><AppearanceSeg /></div>
            <p className="muted m-0 mt-12">Dark, Light, or System to follow your device setting. Saved to your account. The colour theme is set by your Admin.</p>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Two-factor authentication</h2>
            {u.totp_enabled ? <span className="pill s-approved">Enabled</span> : <span className="pill s-hold">Off</span>}
          </div>
          <div className="card-pad stack">
            <p className="muted m-0">{u.totp_enabled
              ? 'Your account requires a 6-digit code from your authenticator app at sign-in.'
              : u.totp_required ? 'An Admin has turned on 2FA for your account. Set it up with an authenticator app to continue.'
                : '2FA is off for your account. Only an Admin can turn it on or off.'}</p>
            {!u.totp_enabled && u.totp_required ? <div><button type="button" className="btn primary" id="tfa" disabled={forced} onClick={startSetup}>Set up 2FA</button></div> : null}
          </div>
        </div>
      </div>

      {setup ? (
        <SetupModal
          setup={setup}
          onClose={() => setSetup(null)}
          onEnabled={() => {
            setSetup(null);
            toast('2FA enabled');
            if (needs2fa) setTimeout(() => { window.location.href = '/'; }, 600);
            else s.patchUser({ totp_enabled: true });
          }}
        />
      ) : null}
    </main>
  );
}

function SetupModal({ setup, onClose, onEnabled }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const enable = async () => {
    try { await post('/api/profile/2fa/enable', { token, password }); onEnabled(); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal
      title="Set up two-factor authentication"
      size="sm"
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" id="en" onClick={enable}>Enable 2FA</button></>}
    >
      <div className="stack">
        <p className="muted m-0">1. Scan this QR code with your authenticator app.</p>
        <div className="right-center"><span className="qr"><img src={setup.qr} alt="2FA QR code" /></span></div>
        <p className="muted m-0">Can&apos;t scan? Enter this key manually:</p>
        <div className="secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</div>
        <label className="f"><span>2. Enter the 6-digit code</span>
          <input id="tok" className="otp-input" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={token}
            onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>
        <label className="f"><span>3. Confirm with your password</span>
          <input id="tokpw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

