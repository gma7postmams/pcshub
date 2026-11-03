import { useEffect, useRef, useState } from 'react';
import { get, post } from '../lib/api.js';
import { useBranding } from '../context.jsx';
import { BrandMark } from '../components/TopNav.jsx';

export default function Login() {
  const { branding } = useBranding();
  const [step, setStep] = useState('password'); // 'password' | 'otp'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [mail, setMail] = useState(null);   // set when the code was emailed: the masked address
  const otpForm = useRef(null);
  const [maint, setMaint] = useState(null);   // set while planned maintenance is on: the message
  const [who, setWho] = useState('');   // Forgot password: username or email
  const [code, setCode] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [note, setNote] = useState('');   // a green message (password changed)
  const [adminForm, setAdminForm] = useState(false);   // during maintenance the form stays hidden until "Administrator Sign In" is clicked
  useEffect(() => { get('/api/maintenance/status', { quiet: true }).then((r) => setMaint(r && r.planned ? r.planned.message : null)).catch(() => {}); }, []);

  useEffect(() => { document.title = `Sign in · ${branding.app_name}`; }, [branding.app_name]);

  // Full page load after sign-in so the server re-checks access for the landing page
  const go = (r) => { window.location.href = r.mustChangePassword ? '/profile?force=1' : '/'; };

  const submitPassword = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await post('/api/auth/login', { username, password });
      if (r.twofa) { setStep('otp'); setToken(''); setMail(r.method === 'email' ? r.sentTo : null); } else go(r);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };

  const submitForgot = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try { await post('/api/auth/forgot', { username: who }); setStep('reset'); setCode(''); setNewPw(''); setNewPw2(''); } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
  };
  const submitReset = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);   // the boxes' current content (autofill / keyboard suggestions can skip the change event)
    const c = String(fd.get('code') ?? code).replace(/\D/g, ''), p1 = String(fd.get('newpw') ?? newPw), p2 = String(fd.get('newpw2') ?? newPw2);
    if (p1 !== p2) { setErr('The two passwords are not the same.'); return; }
    setErr(''); setBusy(true);
    try {
      await post('/api/auth/forgot/verify', { code: c, password: p1 });
      setStep('password'); setPassword(''); setNote('Your password was changed. Sign in with the new password.');
    } catch (ex) { setErr(ex.message); if (/expired|start again/i.test(ex.message)) setStep('forgot'); } finally { setBusy(false); }
  };

  const submitOtp = async (e) => {
    if (e) e.preventDefault();
    setErr(''); setBusy(true);
    try {
      go(await post('/api/auth/2fa', { token }));
    } catch (ex) {
      setErr(ex.message);
      if (ex.status === 401 && /expired|again/i.test(ex.message)) setStep('password');
    } finally { setBusy(false); }
  };

  const resend = async () => {
    setErr(''); setBusy(true);
    try { const r = await post('/api/auth/2fa/resend', {}); setMail(r.sentTo); setToken(''); setErr(''); } catch (ex) {
      setErr(ex.message);
      if (ex.status === 401) setStep('password');
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (step === 'otp' && token.length === 6 && otpForm.current) otpForm.current.requestSubmit();
  }, [token, step]);

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="brand" id="brand">
          <BrandMark branding={branding} />
          {branding.tagline ? <span className="tagline">{branding.tagline}</span> : null}
        </div>
        {maint ? <div className="maint-tag mb-12" id="maint-note"><span className="maint-badge">Under maintenance</span><p className="m-0">{/[.!?]$/.test(maint) ? maint : `${maint}.`}</p></div> : null}
        {err ? <div className="alert err mb-12" id="err">{err}</div> : null}
        {note && step === 'password' ? <div className="alert info mb-12" id="login-note">{note}</div> : null}

        {step === 'password' && maint && !adminForm ? (
          <button className="btn primary" type="button" id="admin-signin" onClick={() => setAdminForm(true)}>Administrator Sign In</button>
        ) : step === 'password' ? (
          <form id="login-form" className="stack" onSubmit={submitPassword} autoComplete="on">
            <label className="f"><span>Username</span>
              <input name="username" autoComplete="username" required autoFocus maxLength={60} value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="f"><span>Password</span>
              <input name="password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button className="btn primary" type="submit" disabled={busy}>Sign in</button>
            <button className="btn ghost" type="button" id="forgot" onClick={() => { setStep('forgot'); setErr(''); setNote(''); setWho(username); }}>Forgot password?</button>
          </form>
        ) : step === 'forgot' ? (
          <form id="forgot-form" className="stack" onSubmit={submitForgot} autoComplete="off">
            <p className="muted m-0">Enter your username or the email address on your account. We will email you a 6-digit code to choose a new password.</p>
            <label className="f"><span>Username or email</span>
              <input name="who" required autoFocus maxLength={120} value={who} onChange={(e) => setWho(e.target.value)} />
            </label>
            <button className="btn primary" type="submit" disabled={busy}>Send code</button>
            <button className="btn ghost" type="button" onClick={() => { setStep('password'); setErr(''); }}>Back to sign in</button>
          </form>
        ) : step === 'reset' ? (
          <form id="reset-form" className="stack" onSubmit={submitReset} autoComplete="off">
            <p className="muted m-0">If that account exists and has an email address, we sent it a 6-digit code. It works for 10 minutes.</p>
            <label className="f"><span>Code</span>
              <input name="code" className="otp-input" inputMode="numeric" maxLength={6} autoComplete="one-time-code" required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
            </label>
            <label className="f"><span>New password</span>
              <input name="newpw" type="password" autoComplete="new-password" required maxLength={72} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
            </label>
            <label className="f"><span>Confirm new password</span>
              <input name="newpw2" type="password" autoComplete="new-password" required maxLength={72} value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
            </label>
            <button className="btn primary" type="submit" disabled={busy}>Change password</button>
            <button className="btn ghost" type="button" onClick={() => { setStep('password'); setErr(''); }}>Back to sign in</button>
          </form>
        ) : (
          <form id="otp-form" ref={otpForm} className="stack" onSubmit={submitOtp} autoComplete="off">
            <p className="muted m-0">{mail ? `We emailed a 6-digit code to ${mail}. It works for 10 minutes.` : 'Enter the 6-digit code from your authenticator app.'}</p>
            <input
              name="token" className="otp-input" inputMode="numeric" maxLength={6} autoComplete="one-time-code" required autoFocus
              value={token} onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <button className="btn primary" type="submit" disabled={busy}>Verify</button>
            {mail ? <button className="btn ghost" type="button" id="resend" disabled={busy} onClick={resend}>Send the code again</button> : null}
            <button className="btn ghost" type="button" onClick={() => { setStep('password'); setErr(''); }}>Back</button>
          </form>
        )}
      </div>
    </div>
  );
}
