import { useCallback, useEffect, useRef, useState } from 'react';
import { api, get, post } from '../../lib/api.js';
import { useSession } from '../../context.jsx';
import { fmtBytes, fmtDateTime } from '../../lib/util.js';
import { Empty, Modal, useToast } from '../../components/ui.jsx';

const PAGE = 25;
const COUNT_TILES = [
  ['users', 'Users'], ['groups', 'Groups'], ['programs', 'Programs'], ['platforms', 'Platforms'],
  ['knowledge_docs', 'Knowledge Documents'], ['ingest_records', 'Ingest Records'], ['workload_items', 'Workload Records'], ['audit_logs', 'Audit Logs'],
  ['branding_files', 'Branding Files', (c, f) => f.branding.count],
];

function Environment({ env }) {
  const warns = [];
  if (!env.pgDump.ok) warns.push(`pg_dump is unavailable: ${env.pgDump.error}. Backups cannot be created.`);
  if (!env.pgRestore.ok) warns.push('pg_restore is unavailable: backups cannot be fully verified.');
  if (!env.storageWritable) warns.push('The backup directory is not writable.');
  if (!env.signing) warns.push('BACKUP_SIGNING_KEY is not set: new backups are unsigned, so tampering with the manifest cannot be detected.');
  if (!warns.length) return null;
  return <div className="alert warn mb-12">{warns.map((w) => <div key={w}>{w}</div>)}</div>;
}

function PreviewCard({ preview, onCreate, busy }) {
  const { counts, files, environment: env } = preview;
  return (
    <div className="card mb-12">
      <div className="card-head">
        <h2>Backup preview</h2>
        <button type="button" className="btn primary sm" disabled={busy || !env.pgDump.ok || !env.storageWritable} onClick={onCreate}>Create backup</button>
      </div>
      <div className="card-pad">
        <Environment env={env} />
        <div className="stat-grid">
          {COUNT_TILES.map(([k, label, value]) => (
            <div className="stat" key={k}>
              <span className="stat-label">{label}</span>
              <span className="stat-value">{(value ? value(counts, files) : counts[k]).toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StorageCard({ preview }) {
  const { files, totals, environment: env } = preview;
  const rows = [
    ['Branding Assets', `${files.branding.count} ${files.branding.count === 1 ? 'file' : 'files'}`, fmtBytes(files.branding.bytes)],
    ['Knowledge Assets', `${files.knowledge.count} ${files.knowledge.count === 1 ? 'file' : 'files'}`, fmtBytes(files.knowledge.bytes)],
    ['Database Size', null, fmtBytes(totals.databaseBytes)],
    ['Estimated Backup Size', null, `~${fmtBytes(totals.estimatedArchiveBytes)}`],
    ['Free Storage Capacity', null, env.freeBytes == null ? 'Unknown' : fmtBytes(env.freeBytes)],
  ];
  return (
    <div className="card mb-12">
      <div className="card-head"><h2>Storage &amp; Capacity</h2></div>
      <div className="card-pad">
        {rows.map(([label, count, size]) => (
          <div className="kv-row" key={label}>
            <span className="kv-label">{label}</span>
            <span className="kv-value">{count ? <span className="dim">{count}</span> : null}<strong>{size}</strong></span>
          </div>
        ))}
        <div className="dim mt-12">Sizes are estimates. The actual archive is measured when the backup finishes.</div>
      </div>
    </div>
  );
}

function CreateDialog({ preview, onClose, onStarted }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const { counts, totals } = preview;
  const start = async () => {
    setBusy(true);
    try { await post('/api/admin/backups', { note }); toast('Backup started'); onStarted(); } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal
      title="Create backup"
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={start}>{busy ? 'Starting…' : 'Start backup'}</button></>}
    >
      <p className="muted">Creates a full archive of the database, branding files and knowledge documents ({counts.users} users, {counts.knowledge_docs} documents, {counts.audit_logs.toLocaleString()} audit entries; about {fmtBytes(totals.estimatedArchiveBytes)}). Users can keep working while it runs.</p>
      <div className="alert info mb-12">The archive contains password hashes and 2FA secrets. Store downloaded copies securely.</div>
      <label className="f"><span>Note (optional)</span><input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Before month-end close" /></label>
    </Modal>
  );
}

/** Asks for the password (and 2FA code when enabled); resolves through onSubmit({ password, code }). */
function ReauthDialog({ title, intro, okText, danger, typed, onClose, onSubmit }) {
  const { user } = useSession();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const ready = password && (!user.totp_enabled || code) && (!typed || confirm === typed);
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
        {typed ? <label className="f"><span>Type <strong>{typed}</strong> to confirm</span><input autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label> : null}
        <label className="f"><span>Your password</span><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {user.totp_enabled ? <label className="f"><span>Authentication code</span><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></label> : null}
      </form>
    </Modal>
  );
}

const CHECK_PILL = { pass: 's-done', warn: 's-pending', fail: 's-rejected' };

function VerifyDialog({ job, report, onClose }) {
  const checks = report ? report.checks : (job.verify_report && job.verify_report.checks) || [];
  return (
    <Modal title={`Verification — ${job.filename || ''}`} onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <div className={`alert ${job.verify_status === 'ok' ? 'info' : 'err'} mb-12`}>
        {job.verify_status === 'ok' ? 'The backup passed all required checks.' : 'The backup failed verification. Do not rely on it.'}
        {job.verified_at ? <span className="dim"> Checked {fmtDateTime(job.verified_at)}.</span> : null}
      </div>
      <table className="t">
        <tbody>
          {checks.map((c) => (
            <tr key={c.check}>
              <td className="nowrap"><span className={`pill ${CHECK_PILL[c.status]}`}>{c.status}</span></td>
              <td><strong>{c.check}</strong><div className="dim">{c.detail}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

function StatusCell({ j }) {
  if (j.deleted_at) return <span className="pill s-hold">Deleted</span>;
  if (j.status === 'running' || j.status === 'queued') return <><span className="pill s-progress">Running</span><div className="dim">{j.progress}</div></>;
  if (j.status === 'failed') return <><span className="pill s-rejected">Failed</span><div className="dim" title={j.error}>{(j.error || '').slice(0, 60)}</div></>;
  return <span className="pill s-done">Completed</span>;
}

function VerifyCell({ j }) {
  if (j.deleted_at || j.status !== 'succeeded') return <span className="dim">—</span>;
  if (!j.verify_status) return <span className="dim">Not verified</span>;
  return (
    <>
      <span className={`pill ${j.verify_status === 'ok' ? 's-done' : 's-rejected'}`}>{j.verify_status === 'ok' ? 'Verified' : 'Failed'}</span>
      <div className="dim">{j.signed ? 'Signed' : 'Unsigned'} · {fmtDateTime(j.verified_at)}</div>
    </>
  );
}

export default function Backup() {
  const toast = useToast();
  const [preview, setPreview] = useState(null);
  const [hist, setHist] = useState(null);
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState('active');
  const [dialog, setDialog] = useState(null);
  const [working, setWorking] = useState(null);
  const timer = useRef(null);

  const loadHist = useCallback(async () => setHist(await get(`/api/admin/backups?limit=${PAGE}&offset=${offset}&view=${view}`)), [offset, view]);
  const loadPreview = useCallback(() => get('/api/admin/backups/preview').then(setPreview).catch((e) => toast(e.message, 'err')), [toast]);
  useEffect(() => { loadPreview(); }, [loadPreview]);
  useEffect(() => { loadHist().catch((e) => toast(e.message, 'err')); }, [loadHist, toast]);

  const running = Boolean(hist && hist.rows.some((j) => j.status === 'running' || j.status === 'queued'));
  useEffect(() => {
    if (!running) return undefined;
    timer.current = setInterval(() => loadHist().catch(() => {}), 1500);
    return () => clearInterval(timer.current);
  }, [running, loadHist]);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) loadPreview();
    wasRunning.current = running;
  }, [running, loadPreview]);

  const verify = async (j) => {
    setWorking(j.id);
    try {
      const { job, report } = await post(`/api/admin/backups/${j.id}/verify`);
      await loadHist();
      setDialog({ type: 'verify', job, report });
    } catch (e) { toast(e.message, 'err'); } finally { setWorking(null); }
  };

  const download = async (j, { password, code }) => {
    const { token } = await post(`/api/admin/backups/${j.id}/download-token`, { password, code });
    setDialog(null);
    window.location.assign(`/api/admin/backups/${j.id}/download?t=${encodeURIComponent(token)}`);
  };

  const remove = async (j, { password, code, confirm }) => {
    await api('DELETE', `/api/admin/backups/${j.id}`, { password, code, confirm });
    setDialog(null); toast('Backup deleted'); loadHist(); loadPreview();
  };

  if (!preview || !hist) return <Empty>Loading…</Empty>;
  return (
    <>
      <PreviewCard preview={preview} busy={running} onCreate={() => setDialog({ type: 'create' })} />
      <StorageCard preview={preview} />
      <div className="card">
        <div className="card-head">
          <h2>Backup history</h2>
          <div className="hist-stats">
            <div><span>Active Backups</span><strong>{hist.stored}</strong></div>
            <div><span>Deleted Backups</span><strong>{hist.counts.deleted}</strong></div>
            <div><span>Storage Used</span><strong>{fmtBytes(hist.storedBytes)}</strong></div>
          </div>
          <div className="row">
            <div className="segmented">
              {[['active', 'Active'], ['deleted', 'Deleted'], ['all', 'All']].map(([k, l]) => (
                <button key={k} type="button" className={view === k ? 'on' : ''} onClick={() => { setView(k); setOffset(0); }}>{l} <span className="dim">{hist.counts[k]}</span></button>
              ))}
            </div>
            <button type="button" className="btn sm" onClick={() => { loadHist(); loadPreview(); }}>Refresh</button>
          </div>
        </div>
        <div className="table-wrap">
          {!hist.rows.length ? <Empty>{view === 'deleted' ? 'No deleted backups.' : view === 'all' ? 'No backups yet.' : 'No active backups. Create the first one above.'}</Empty> : (
            <table className="t">
              <thead>
                <tr><th>Created</th><th>File</th><th className="num">Size</th><th>Status</th><th>Integrity</th><th /></tr>
              </thead>
              <tbody>
                {hist.rows.map((j) => {
                  const ok = !j.deleted_at && j.status === 'succeeded';
                  return (
                    <tr key={j.id}>
                      <td className="nowrap">{fmtDateTime(j.created_at)}<div className="dim">{j.created_by_name || ''}</div></td>
                      <td>{j.filename ? <span className="mono">{j.filename}</span> : <span className="dim">—</span>}{j.note ? <div className="dim">{j.note}</div> : null}</td>
                      <td className="num">{j.size_bytes != null ? fmtBytes(j.size_bytes) : ''}</td>
                      <td><StatusCell j={j} /></td>
                      <td><VerifyCell j={j} /></td>
                      <td className="right nowrap">
                        {ok ? (
                          <>
                            <button type="button" className="btn sm" disabled={working === j.id} onClick={() => verify(j)}>{working === j.id ? 'Verifying…' : 'Verify'}</button>{' '}
                            <button type="button" className="btn sm" onClick={() => setDialog({ type: 'download', job: j })}>Download</button>{' '}
                          </>
                        ) : null}
                        {!j.deleted_at && j.status !== 'running' && j.status !== 'queued' ? <button type="button" className="btn sm ghost" onClick={() => setDialog({ type: 'delete', job: j })}>Delete</button> : null}
                        {ok && j.verify_report ? <>{' '}<button type="button" className="btn sm ghost" onClick={() => setDialog({ type: 'verify', job: j })}>Report</button></> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {hist.total > PAGE ? (
          <div className="row" style={{ padding: 12, justifyContent: 'flex-end' }}>
            <span className="dim">{offset + 1}–{Math.min(offset + PAGE, hist.total)} of {hist.total}</span>
            <button type="button" className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Prev</button>
            <button type="button" className="btn sm" disabled={offset + PAGE >= hist.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
          </div>
        ) : null}
      </div>

      {dialog && dialog.type === 'create' ? <CreateDialog preview={preview} onClose={() => setDialog(null)} onStarted={() => { setDialog(null); loadHist(); }} /> : null}
      {dialog && dialog.type === 'verify' ? <VerifyDialog job={dialog.job} report={dialog.report} onClose={() => setDialog(null)} /> : null}
      {dialog && dialog.type === 'download' ? (
        <ReauthDialog title="Download backup" intro={`Confirm your identity to download ${dialog.job.filename}. The file contains password hashes and 2FA secrets.`} okText="Download" onClose={() => setDialog(null)} onSubmit={(f) => download(dialog.job, f)} />
      ) : null}
      {dialog && dialog.type === 'delete' ? (
        <ReauthDialog title="Delete backup" intro={dialog.job.filename ? `${dialog.job.filename} will be permanently removed from storage.` : 'This entry will be removed from the history.'} okText="Delete" danger typed="DELETE" onClose={() => setDialog(null)} onSubmit={(f) => remove(dialog.job, f)} />
      ) : null}
    </>
  );
}
