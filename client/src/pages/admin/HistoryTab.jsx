import { useCallback, useEffect, useState } from 'react';
import { api, get, post } from '../../lib/api.js';
import ReauthDialog from './ReauthDialog.jsx';
import { fmtBytes, fmtDateTime } from '../../lib/util.js';
import { Empty, Modal, useToast } from '../../components/ui.jsx';

const PAGE = 25;
const RISK_PILL = { LOW: 's-done', MEDIUM: 's-pending', HIGH: 's-rejected' };
const RESTORE_RESULT = {
  succeeded: ['s-done', 'Succeeded'], failed: ['s-rejected', 'Failed'], rolled_back: ['s-pending', 'Rolled back'],
  running: ['s-progress', 'Running'], queued: ['s-progress', 'Queued'], cancelled: ['s-hold', 'Cancelled'],
};

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
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

const isRunning = (j) => j.status === 'running' || j.status === 'queued';

function ResultCell({ j }) {
  if (j.kind === 'restore') {
    const [cls, label] = RESTORE_RESULT[j.status] || ['s-normal', j.status];
    return <><span className={`pill ${cls}`}>{label}</span>{j.error ? <div className="dim" title={j.error}>{j.error.slice(0, 60)}</div> : null}</>;
  }
  return (
    <>
      <StatusCell j={j} />
      {!j.deleted_at && j.status === 'succeeded' ? <div className="dim">{j.verify_status ? `${j.verify_status === 'ok' ? 'Verified' : 'Verification failed'} · ${j.signed ? 'Signed' : 'Unsigned'}` : 'Not verified'}</div> : null}
    </>
  );
}

export default function HistoryTab({ active, refreshKey, onRunning, onChanged, onRollback }) {
  const toast = useToast();
  const [hist, setHist] = useState(null);
  const [type, setType] = useState('all');
  const [showDeleted, setShowDeleted] = useState(false);
  const [offset, setOffset] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [working, setWorking] = useState(null);

  const load = useCallback(async () => {
    setHist(await get(`/api/admin/backups?type=${type}&deleted=${showDeleted ? 1 : 0}&limit=${PAGE}&offset=${offset}`));
  }, [type, showDeleted, offset]);
  useEffect(() => { load().catch((e) => toast(e.message, 'err')); }, [load, toast, refreshKey, active]);

  const running = Boolean(hist && hist.running);
  useEffect(() => { onRunning(running); }, [running, onRunning]);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => load().catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [running, load]);

  const verify = async (j) => {
    setWorking(j.id);
    try {
      const { job, report } = await post(`/api/admin/backups/${j.id}/verify`);
      await load();
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
    setDialog(null); toast('Backup deleted'); load(); onChanged();
  };

  if (!hist) return <Empty>Loading…</Empty>;
  const counts = { all: hist.counts.backups + hist.counts.restores, backup: hist.counts.backups, restore: hist.counts.restores };
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>History</h2>
          <div className="hist-stats">
            <div><span>Active Backups</span><strong>{hist.stored}</strong></div>
            <div><span>Deleted Backups</span><strong>{hist.counts.deleted}</strong></div>
            <div><span>Storage Used</span><strong>{fmtBytes(hist.storedBytes)}</strong></div>
          </div>
          <div className="row">
            <div className="segmented">
              {[['all', 'All'], ['backup', 'Backup'], ['restore', 'Restore']].map(([k, l]) => (
                <button key={k} type="button" className={type === k ? 'on' : ''} onClick={() => { setType(k); setOffset(0); }}>{l} <span className="dim">{counts[k]}</span></button>
              ))}
            </div>
            <label className="check"><input type="checkbox" checked={showDeleted} onChange={(e) => { setShowDeleted(e.target.checked); setOffset(0); }} /> Show deleted</label>
            <button type="button" className="btn sm" onClick={() => load()}>Refresh</button>
          </div>
        </div>
        <div className="table-wrap">
          {!hist.rows.length ? <Empty>{type === 'restore' ? 'No restores have been performed.' : type === 'backup' ? 'No backups yet. Create the first one from the Backup tab.' : 'No backup or restore activity yet.'}</Empty> : (
            <table className="t">
              <thead>
                <tr><th>Date</th><th>Type</th><th>User</th><th>File</th><th>Risk Level</th><th>Result</th><th>Duration</th><th /></tr>
              </thead>
              <tbody>
                {hist.rows.map((j) => {
                  const backup = j.kind === 'create';
                  const ok = backup && !j.deleted_at && j.status === 'succeeded';
                  return (
                    <tr key={j.id}>
                      <td className="nowrap">{fmtDateTime(j.created_at)}</td>
                      <td><span className={`pill ${backup ? 's-new' : 's-progress'}`}>{backup ? 'Backup' : 'Restore'}</span></td>
                      <td>{j.created_by_name || <span className="dim">—</span>}</td>
                      <td>
                        {j.filename ? <span className="mono">{j.filename}</span> : <span className="dim">—</span>}
                        {j.size_bytes != null ? <div className="dim">{fmtBytes(j.size_bytes)}</div> : null}
                        {j.note ? <div className="dim">{j.note}</div> : null}
                      </td>
                      <td>{j.risk_level ? <span className={`pill ${RISK_PILL[j.risk_level]}`}>{j.risk_level}</span> : <span className="dim">—</span>}</td>
                      <td><ResultCell j={j} /></td>
                      <td className="nowrap">{fmtDuration(j.duration_ms)}</td>
                      <td className="right nowrap">
                        {ok ? (
                          <>
                            <button type="button" className="btn sm" disabled={working === j.id} onClick={() => verify(j)}>{working === j.id ? 'Verifying…' : 'Verify'}</button>{' '}
                            <button type="button" className="btn sm" onClick={() => setDialog({ type: 'download', job: j })}>Download</button>{' '}
                          </>
                        ) : null}
                        {backup && !j.deleted_at && !isRunning(j) ? <button type="button" className="btn sm ghost" onClick={() => setDialog({ type: 'delete', job: j })}>Delete</button> : null}
                        {ok && j.verify_report ? <>{' '}<button type="button" className="btn sm ghost" onClick={() => setDialog({ type: 'verify', job: j })}>Report</button></> : null}
                        {!backup && j.status === 'failed' && j.summary && j.summary.preRestoreBackupId ? <button type="button" className="btn sm danger" onClick={() => onRollback(j)}>Roll back</button> : null}
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
