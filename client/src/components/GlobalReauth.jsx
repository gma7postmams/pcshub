import { useEffect, useRef, useState } from 'react';
import ReauthDialog from '../pages/admin/ReauthDialog.jsx';
import { ApiError, setReauthHandler } from '../lib/api.js';

/**
 * One "Confirm it's you" prompt for the whole app. When the server refuses a sensitive action with "confirm your password" (reauth + auto), the shared
 * api client calls this, the person types their password once, and the same request is repeated with it. A confirmation then stays valid for a few
 * minutes on the server, so the next sensitive action does not ask again. Mounted once, inside the signed-in app.
 */
export default function GlobalReauth() {
  const [ask, setAsk] = useState(null);
  const open = useRef(false);
  useEffect(() => {
    setReauthHandler((retry, info) => new Promise((resolve, reject) => {
      if (open.current) { reject(new ApiError(info.error || 'Confirm your password to continue', 403, info)); return; }   // one prompt at a time
      open.current = true;
      setAsk({ retry, info, resolve, reject });
    }));
    return () => setReauthHandler(null);
  }, []);
  if (!ask) return null;
  const close = () => { open.current = false; setAsk(null); };
  const what = ask.info && ask.info.what ? ask.info.what : 'continue';
  return (
    <ReauthDialog
      title="Confirm it&rsquo;s you"
      intro={`Enter your password to ${what}. You will not be asked again for a few minutes.`}
      okText="Confirm"
      onClose={() => { close(); ask.reject(new ApiError('Cancelled', 0, { cancelled: true })); }}
      onSubmit={async ({ password, code }) => {
        let result;
        try { result = await ask.retry({ password, code }); } catch (e) {
          if (e && e.data && e.data.reauth) throw e;   // wrong password: the prompt shows why and stays open
          close(); ask.reject(e); return;
        }
        close(); ask.resolve(result);
      }}
    />
  );
}
