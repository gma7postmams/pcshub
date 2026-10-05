import { useState } from 'react';
import { useSession } from '../../context.jsx';
import { Modal, useToast } from '../../components/ui.jsx';

/** Asks for the password (and 2FA code when enabled); resolves through onSubmit({ password, code }). */
export default function ReauthDialog({ title, intro, okText, danger, typed, onClose, onSubmit, extraReady = true, children }) {
  const { user } = useSession();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const ready = extraReady && password && (!user.totp_enabled || code) && (!typed || confirm === typed);
  const submit = async () => {
    setBusy(true);
    try { await onSubmit({ password, code, confirm }); } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal
      title={title}
      size="sm"
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className={`btn ${danger ? 'danger' : 'primary'}`} disabled={!ready || busy} onClick={submit}>{okText}</button></>}
    >
      <form className="stack" noValidate onSubmit={(e) => { e.preventDefault(); if (ready && !busy) submit(); }}>
        <p className="muted m-0">{intro}</p>
        {children}
        {typed ? <label className="f"><span>Type <strong>{typed}</strong> to confirm</span><input autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label> : null}
        <label className="f"><span>Your password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {user.totp_enabled ? <label className="f"><span>Authentication code</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></label> : null}
      </form>
    </Modal>
  );
}

