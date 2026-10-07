import { useState } from 'react';
import { useSession } from '../../context.jsx';
import { Modal, useToast } from '../../components/ui.jsx';
import { ApiError } from '../../lib/api.js';

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


/**
 * "Confirm it's you" for sensitive actions. `run(call)` invokes call() and, when the server answers that a password
 * (+ authenticator code) is needed, shows the prompt and repeats call({ password, code }). A confirmation stays valid
 * for a few minutes, so a second action straight after does not prompt again.
 *   const [stepUp, stepUpDialog] = useStepUp();
 *   await stepUp((reauth) => post(url, { ...body, reauth }), { intro: '…' });   // render {stepUpDialog} somewhere
 * Rejects with an ApiError whose data.cancelled is true when the prompt is dismissed.
 */
export function useStepUp() {
  const [ask, setAsk] = useState(null);
  const run = (call, { title = 'Confirm it\u2019s you', intro = 'Enter your password to continue.', okText = 'Confirm' } = {}) => call().catch((e) => {
    if (!(e && e.data && e.data.reauth)) throw e;
    return new Promise((resolve, reject) => setAsk({ call, resolve, reject, title, intro, okText }));
  });
  const dialog = ask ? (
    <ReauthDialog
      title={ask.title}
      intro={ask.intro}
      okText={ask.okText}
      onClose={() => { setAsk(null); ask.reject(new ApiError('Cancelled', 0, { cancelled: true })); }}
      onSubmit={async ({ password, code }) => {
        let result;
        try { result = await ask.call({ password, code }); } catch (e) {
          if (e && e.data && e.data.reauth) throw e;   // wrong password / code: the prompt shows it and stays open
          setAsk(null); ask.reject(e); return;
        }
        setAsk(null); ask.resolve(result);
      }}
    />
  ) : null;
  return [run, dialog];
}
