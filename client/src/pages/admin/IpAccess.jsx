import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, post, del } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/util.js';
import { Empty, useConfirm, useToast } from '../../components/ui.jsx';

// Administration > IP Access (System Admin). Block list: these addresses cannot reach the app at all. Allow list: these addresses are never
// shut out by wrong passwords or rate limits (and win over a block). Entries are one address or a range (203.0.113.0/24); add them by hand,
// or import / export a CSV or JSON file. Below: addresses currently shut out of an account after wrong passwords.
const SHOW = 200;
const isPrivate = (ip) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip || '');
const localInput = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

export default function IpAccess() {
  const toast = useToast();
  const confirm = useConfirm();
  const [d, setD] = useState(null);
  const [view, setView] = useState('block');
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => get('/api/admin/ip-rules').then((x) => { setD(x); setPick(new Set()); }).catch(() => setD(false)), []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    if (!d) return [];
    const t = q.trim().toLowerCase();
    return d.rules.filter((r) => r.kind === view && (!t || [r.cidr, r.note, r.created_by].some((x) => (x || '').toLowerCase().includes(t))));
  }, [d, view, q]);
  useEffect(() => { setPick(new Set()); setShowAll(false); }, [view, q]);

  if (d === null) return <Empty>Loading…</Empty>;
  if (d === false) return <Empty>Could not load the IP lists.</Empty>;
  const count = (k) => d.rules.filter((r) => r.kind === k).length;
  const shown = showAll ? rows : rows.slice(0, SHOW);

  const remove = async (r) => {
    if (!(await confirm('Remove this entry?', `${r.cidr} will no longer be on the ${r.kind} list.`, { okText: 'Remove', danger: r.kind === 'allow' }))) return;
    try { await del(`/api/admin/ip-rules/${r.id}`); toast('Removed.'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  const removePicked = async () => {
    if (!(await confirm(`Remove ${pick.size} ${pick.size === 1 ? 'entry' : 'entries'}?`, 'They are taken off the list right away.', { okText: 'Remove', danger: true }))) return;
    try { const r = await post('/api/admin/ip-rules/remove', { ids: [...pick] }); toast(`Removed ${r.removed}.`); load(); } catch (e) { toast(e.message, 'err'); }
  };
  const unblock = async (a) => {
    try { await post('/api/admin/ip-rules/auto/unblock', { user: a.user, ip: a.ip }); toast('Let back in.'); load(); } catch (e) { toast(e.message, 'err'); load(); }
  };
  const blockAuto = async (a) => {
    if (!(await confirm('Block this address completely?', `${a.ip} will not be able to open the app at all, until you remove it from the block list.`, { okText: 'Block', danger: true }))) return;
    try { await post('/api/admin/ip-rules', { list: 'block', ip: a.ip, note: `Wrong passwords for ${a.user}` }); await post('/api/admin/ip-rules/auto/unblock', { user: a.user, ip: a.ip }).catch(() => {}); toast('Blocked.'); setView('block'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  const allPicked = shown.length > 0 && shown.every((r) => pick.has(r.id));

  return (
    <>
      {d.disabled ? <div className="alert warn mb-12">IP_RULES_DISABLE is on in the server&apos;s .env: the block list is switched off until it is removed and the service restarted.</div> : null}
      <div className="card mb-12">
        <div className="card-head"><h2>Add an address</h2></div>
        <div className="card-pad">
          <div className="dim mb-12">
            <strong>Block</strong>: the address cannot open the app at all. <strong>Allow</strong>: the address is never shut out by wrong passwords or rate limits and is not counted towards security alerts, so use it only for addresses you trust (your office, a monitoring service). An allow entry wins over a block entry.
          </div>
          <div className="kv-row mb-12"><span className="kv-label">Your address</span><span className="kv-value">
            <span className="mono">{d.me.ip || 'unknown'}</span>
            {d.me.direct && d.me.direct !== d.me.ip ? <span className="dim"> (the connection reaches the app from <span className="mono">{d.me.direct}</span>)</span> : null}
            {isPrivate(d.me.ip) ? <div className="alert warn mt-6">The app sees your address as <span className="mono">{d.me.ip}</span>, which looks like a gateway or proxy, not your real address. Until that is fixed (TRUST_PROXY, and <span className="mono">set_real_ip_from</span> in nginx), a block would hit everybody behind it.</div> : null}
          </span></div>
          <AddForm onDone={load} />
        </div>
      </div>

      <ImportExport onDone={load} />

      <div className="card mb-12">
        <div className="card-head">
          <div className="tabs sub-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={view === 'block'} className={view === 'block' ? 'on' : ''} onClick={() => setView('block')}>Blocked ({count('block')})</button>
            <button type="button" role="tab" aria-selected={view === 'allow'} className={view === 'allow' ? 'on' : ''} onClick={() => setView('allow')}>Allowed ({count('allow')})</button>
          </div>
          <button type="button" className="btn" onClick={load}>Refresh</button>
        </div>
        <div className="card-pad row">
          <input type="search" placeholder="Search address, note or who added it…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the list" style={{ flex: 1, minWidth: 180 }} />
          {pick.size ? <button type="button" className="btn danger" onClick={removePicked}>Remove {pick.size} selected</button> : null}
        </div>
        <div className="table-wrap">
          <table className="t wl">
            <thead><tr>
              <th style={{ width: 28 }}><input type="checkbox" aria-label="Select all shown" checked={allPicked} onChange={(e) => setPick(e.target.checked ? new Set(shown.map((r) => r.id)) : new Set())} /></th>
              <th>Address</th><th>Note</th><th>Added by</th><th>Added</th><th>Expires</th><th />
            </tr></thead>
            <tbody>{shown.length ? shown.map((r) => (
              <tr key={r.id} className={r.expired ? 'dim' : ''}>
                <td><input type="checkbox" aria-label={`Select ${r.cidr}`} checked={pick.has(r.id)} onChange={(e) => { const n = new Set(pick); if (e.target.checked) n.add(r.id); else n.delete(r.id); setPick(n); }} /></td>
                <td className="mono">{r.cidr}</td>
                <td>{r.note || <span className="dim">—</span>}</td>
                <td>{r.created_by || <span className="dim">—</span>}</td>
                <td className="nowrap dim">{fmtDateTime(r.created_at)}</td>
                <td className="nowrap">{r.expires_at ? <>{fmtDateTime(r.expires_at)}{r.expired ? <span className="dim"> (expired)</span> : null}</> : <span className="dim">Never</span>}</td>
                <td className="nowrap"><button type="button" className="btn" onClick={() => remove(r)}>Remove</button></td>
              </tr>
            )) : <tr><td colSpan={7} className="empty">{q ? 'Nothing matches.' : view === 'block' ? 'No address is blocked.' : 'No address is on the allow list.'}</td></tr>}</tbody>
          </table>
        </div>
        {rows.length > shown.length ? <div className="card-pad dim">Showing {shown.length} of {rows.length}. <button type="button" className="linklike" onClick={() => setShowAll(true)}>Show all</button> or search to narrow the list.</div> : null}
      </div>

      <div className="card">
        <div className="card-head"><h2>Shut out after wrong passwords ({d.auto.length})</h2><button type="button" className="btn" onClick={load}>Refresh</button></div>
        <div className="card-pad dim">An address that types too many wrong passwords for one account is shut out of <em>that account only</em> for the lock time (Security tab); the account stays open to everyone else. These are cleared when the service restarts.</div>
        <div className="table-wrap">
          <table className="t wl">
            <thead><tr><th>Address</th><th>Account</th><th>Shut out until</th><th /></tr></thead>
            <tbody>{d.auto.length ? d.auto.map((a) => (
              <tr key={`${a.user}|${a.ip}`}>
                <td className="mono">{a.ip}</td><td className="mono">{a.user}</td><td className="nowrap">{fmtDateTime(a.until)}</td>
                <td className="nowrap"><button type="button" className="btn" onClick={() => unblock(a)}>Let back in</button>{' '}<button type="button" className="btn danger" onClick={() => blockAuto(a)}>Block completely</button></td>
              </tr>
            )) : <tr><td colSpan={4} className="empty">No address is shut out right now.</td></tr>}</tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function AddForm({ onDone }) {
  const toast = useToast();
  const [f, setF] = useState({ list: 'block', ip: '', note: '', expires: '' });
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const r = await post('/api/admin/ip-rules', { list: f.list, ip: f.ip, note: f.note, expires: f.expires ? new Date(f.expires).toISOString() : '' });
      toast(r.updated ? 'Entry updated.' : `Added to the ${f.list} list.`);
      setF({ ...f, ip: '', note: '', expires: '' });
      onDone();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div>
      <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <label className="f"><span>List</span>
          <select value={f.list} onChange={(e) => setF({ ...f, list: e.target.value })}><option value="block">Block</option><option value="allow">Allow</option></select></label>
        <label className="f" style={{ flex: 1, minWidth: 200 }}><span>Address or range</span>
          <input type="text" className="mono" value={f.ip} placeholder="203.0.113.7 or 203.0.113.0/24" onChange={(e) => setF({ ...f, ip: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && f.ip.trim() && !busy) add(); }} /></label>
        <label className="f" style={{ flex: 1, minWidth: 160 }}><span>Note <span className="dim">(optional)</span></span>
          <input type="text" maxLength={200} value={f.note} placeholder="Why" onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        <label className="f"><span>Expires <span className="dim">(optional)</span></span>
          <input type="datetime-local" value={f.expires} min={localInput(new Date())} onChange={(e) => setF({ ...f, expires: e.target.value })} /></label>
        <button type="button" className="btn primary" disabled={busy || !f.ip.trim()} onClick={add}>Add</button>
      </div>
    </div>
  );
}

function ImportExport({ onDone }) {
  const toast = useToast();
  const confirm = useConfirm();
  const file = useRef(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [list, setList] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const body = (dryRun) => ({ text, list: list || undefined, dryRun });
  const reset = () => { setText(''); setName(''); setRes(null); if (file.current) file.current.value = ''; };
  const read = async (e) => {
    const fl = e.target.files && e.target.files[0];
    if (!fl) return;
    if (fl.size > 900 * 1024) { toast('That file is too large (limit about 900 KB).', 'err'); e.target.value = ''; return; }
    setText(await fl.text()); setName(fl.name); setRes(null);
  };
  const check = async () => {
    setBusy(true);
    try { setRes(await post('/api/admin/ip-rules/import', body(true))); } catch (e) { setRes(null); toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const run = async () => {
    if (!(await confirm('Import these entries?', `${res.valid} ${res.valid === 1 ? 'entry' : 'entries'} (${res.block} block, ${res.allow} allow) are saved. ${res.updated ? `${res.updated} already on a list are updated. ` : ''}${res.invalid ? `${res.invalid} invalid ${res.invalid === 1 ? 'row is' : 'rows are'} skipped.` : ''}`, { okText: 'Import' }))) return;
    setBusy(true);
    try { const r = await post('/api/admin/ip-rules/import', body(false)); toast(`Imported ${r.valid} (${r.added} new, ${r.updated} updated).`); reset(); setOpen(false); onDone(); } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="card mb-12">
      <div className="card-head"><h2>Import and export</h2>
        <div className="row">
          <a className="btn" href="/api/admin/ip-rules/export?format=csv" download>Export CSV</a>
          <a className="btn" href="/api/admin/ip-rules/export?format=json" download>Export JSON</a>
          <button type="button" className="btn" onClick={() => { setOpen(!open); if (open) reset(); }}>{open ? 'Close import' : 'Import…'}</button>
        </div>
      </div>
      {open ? (
        <div className="card-pad">
          <div className="dim mb-12">
            <strong>CSV</strong>: columns <span className="mono">ip,list,note,expires</span> (a header row is optional; <span className="mono">list</span> is block or allow; <span className="mono">expires</span> is a date such as 2026-12-31 or empty). One address per line also works when you choose the list below.
            {' '}<strong>JSON</strong>: <span className="mono">[{'{'}"ip":"203.0.113.0/24","list":"block","note":"scanner"{'}'}]</span>, or <span className="mono">{'{'}"block":["…"],"allow":["…"]{'}'}</span>. An export can be imported back as is.
          </div>
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
            <label className="f"><span>File (.csv, .json, .txt)</span><input ref={file} type="file" accept=".csv,.json,.txt,text/csv,application/json,text/plain" onChange={read} /></label>
            <label className="f"><span>List for rows that name none</span>
              <select value={list} onChange={(e) => { setList(e.target.value); setRes(null); }}><option value="">— none: every row must say —</option><option value="block">Block</option><option value="allow">Allow</option></select></label>
          </div>
          <label className="f mt-12"><span>…or paste it here{name ? <span className="dim"> (from {name})</span> : null}</span>
            <textarea rows={6} className="mono" value={text} placeholder={'203.0.113.7\n198.51.100.0/24'} onChange={(e) => { setText(e.target.value); setName(''); setRes(null); }} /></label>
          <div className="row mt-12"><button type="button" className="btn" disabled={busy || !text.trim()} onClick={check}>Check</button>
            {res ? <button type="button" className="btn primary" disabled={busy || !res.valid} onClick={run}>Import {res.valid}</button> : null}</div>
          {res ? (
            <div className="mt-12">
              <div className={`alert ${res.invalid ? 'warn' : ''}`}>
                {res.valid} valid ({res.block} block, {res.allow} allow): {res.added} new, {res.updated} already listed{res.duplicates ? `, ${res.duplicates} repeated in the file` : ''}.
                {res.invalid ? ` ${res.invalid} ${res.invalid === 1 ? 'row' : 'rows'} will be skipped.` : ' Nothing to fix.'}
              </div>
              {res.errors.length ? (
                <div className="table-wrap mt-12"><table className="t wl"><thead><tr><th>Line</th><th>Value</th><th>Problem</th></tr></thead>
                  <tbody>{res.errors.map((e, i) => <tr key={i}><td className="nowrap">{e.line}</td><td className="mono">{e.value || '—'}</td><td>{e.error}</td></tr>)}</tbody></table>
                  {res.invalid > res.errors.length ? <div className="dim mt-6">…and {res.invalid - res.errors.length} more.</div> : null}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
