import { useEffect, useRef, useState } from 'react';
import { post } from '../lib/api.js';
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
  const otpForm = useRef(null);

  useEffect(() => { document.title = `Sign in · ${branding.app_name}`; }, [branding.app_name]);

  // Full page load after sign-in so the server re-checks access for the landing page
  const go = (r) => { window.location.href = r.mustChangePassword ? '/profile?force=1' : '/'; };

  const submitPassword = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const r = await post('/api/auth/login', { username, password });
      if (r.twofa) { setStep('otp'); setToken(''); } else go(r);
    } catch (ex) { setErr(ex.message); } finally { setBusy(false); }
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
        {err ? <div className="alert err mb-12" id="err">{err}</div> : null}

        {step === 'password' ? (
          <form id="login-form" className="stack" onSubmit={submitPassword} autoComplete="on">
            <label className="f"><span>Username</span>
              <input name="username" autoComplete="username" required autoFocus maxLength={60} value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="f"><span>Password</span>
              <input name="password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button className="btn primary" type="submit" disabled={busy}>Sign in</button>
          </form>
        ) : (
          <form id="otp-form" ref={otpForm} className="stack" onSubmit={submitOtp} autoComplete="off">
            <p className="muted m-0">Enter the 6-digit code from your authenticator app.</p>
            <input
              name="token" className="otp-input" inputMode="numeric" maxLength={6} autoComplete="one-time-code" required autoFocus
              value={token} onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <button className="btn primary" type="submit" disabled={busy}>Verify</button>
            <button className="btn ghost" type="button" onClick={() => { setStep('password'); setErr(''); }}>Back</button>
          </form>
        )}
      </div>
    </div>
  );
}
