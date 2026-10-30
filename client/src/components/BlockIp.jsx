import { useEffect, useState } from 'react';
import { get, post } from '../lib/api.js';
import { useSession } from '../context.jsx';
import { Modal, useToast } from './ui.jsx';

// "Block" button next to an IP address in the Audit Log and the Security page (System Admin only). Adds the address to Administration > IP Access > Block list.
// The block list is read once per page and shared by every button on it; a refused address (your own, localhost) is explained by the server.

const DURATIONS = [['1h', '1 hour', 3600e3], ['24h', '24 hours', 86400e3], ['7d', '7 days', 7 * 86400e3], ['30d', '30 days', 30 * 86400e3], ['never', 'Until I remove it', 0]];

let shared = null;                 // { promise, rules: [cidr], at }
const listeners = new Set();
const load = (force) => {
  if (!shared || force || Date.now() - shared.at > 60000) {
    shared = { at: Date.now(), rules: null, promise: get('/api/admin/ip-rules').then((r) => { shared.rules = (r.rules || []).filter((x) => x.kind === 'block' && !x.expired).map((x) => x.cidr); listeners.forEach((f) => f()); return shared.rules; }).catch(() => { shared.rules = []; return []; }) };
  }
  return shared.promise;
};

const v4 = (s) => { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s); return m ? (((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4]) >>> 0 : null; };
const unmap = (ip) => String(ip || '').replace(/^::ffff:/i, '');
function covers(cidr, ip) {
  const [base, bits] = String(cidr).split('/');
  const a = v4(unmap(base)); const b = v4(unmap(ip));
  if (a == null || b == null) return unmap(base).toLowerCase() === unmap(ip).toLowerCase();
  const n = bits == null ? 32 : Number(bits);
  const mask = n === 0 ? 0 : (0xffffffff << (32 - n)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export default function BlockIp({ ip, source = 'Audit Log' }) {
  const { user } = useSession();
  const toast = useToast();
  const isSys = Boolean(user && user.role === 'System Admin');
  const [, bump] = useState(0);
  const [open, setOpen] = useState(false);
  const [dur, setDur] = useState('24h');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isSys) return undefined;
    const f = () => bump((n) => n + 1);
    listeners.add(f); load();
    return () => { listeners.delete(f); };
  }, [isSys]);
  if (!isSys || !ip || ip === '::1' || unmap(ip) === '127.0.0.1') return null;
  const blocked = shared && shared.rules && shared.rules.some((c) => covers(c, ip));
  if (blocked) return <span className="dim" title="Administration > IP Access"> · blocked</span>;
  if (!shared || !shared.rules) return null;
  const submit = async () => {
    setBusy(true);
    try {
      const d = DURATIONS.find((x) => x[0] === dur);
      await post('/api/admin/ip-rules', { list: 'block', ip, note: note.trim() || `Blocked from the ${source}`, expires: d[2] ? new Date(Date.now() + d[2]).toISOString() : '' });
      toast(`${ip} is blocked`);
      setOpen(false);
      await load(true);
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <>
      {' '}<button type="button" className="linklike" title={`Block ${ip}`} onClick={() => setOpen(true)}>Block</button>
      {open ? (
        <Modal title="Block this address" size="sm" onClose={() => setOpen(false)}
          footer={<><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="btn danger" disabled={busy} onClick={submit}>Block {ip}</button></>}>
          <div className="stack">
            <p className="muted m-0"><strong className="mono">{ip}</strong> will get &ldquo;Access denied&rdquo; for everything, signed in or not, within a second. People sharing this address (an office or VPN gateway) are blocked too.</p>
            <label className="f"><span>For how long</span>
              <select value={dur} onChange={(e) => setDur(e.target.value)}>{DURATIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></label>
            <label className="f"><span>Note <span className="dim">(optional)</span></span><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={`Blocked from the ${source}`} /></label>
            <span className="dim">Undo it any time in Administration &rarr; IP Access.</span>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
