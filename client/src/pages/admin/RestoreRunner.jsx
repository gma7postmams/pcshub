import { useEffect, useRef, useState } from 'react';
import { get } from '../../lib/api.js';
import { fmtBytes } from '../../lib/util.js';
import { Modal } from '../../components/ui.jsx';

const CHECK_PILL = { pass: 's-done', warn: 's-pending', fail: 's-rejected' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Full-screen progress while the server is in maintenance mode. Polls the one endpoint that stays reachable. */
export function RestoreOverlay({ jobId, onFinished }) {
  const [stage, setStage] = useState('Starting');
  const done = useRef(false);

  useEffect(() => {
    window.__pcsRestoring = true;
    const finish = async () => {
      for (let i = 0; i < 20; i += 1) {
        try {
          const { job } = await get(`/api/admin/backups/jobs/${jobId}`);
          if (job.status !== 'running') { onFinished(job); return; }
        } catch (_) { /* server may still be settling */ }
        await sleep(1500);
      }
      onFinished(null);
    };
    const t = setInterval(async () => {
      if (done.current) return;
      try {
        const s = await (await fetch('/api/maintenance/status', { cache: 'no-store' })).json();
        if (s.active) setStage(s.stage || 'Working');
        else { done.current = true; finish(); }
      } catch (_) { /* restarting or briefly unreachable */ }
    }, 1500);
    return () => { clearInterval(t); window.__pcsRestoring = false; };
  }, [jobId, onFinished]);

  return (
    <div className="modal-backdrop restore-overlay">
      <div className="modal sm" role="alertdialog" aria-modal="true">
        <div className="modal-head"><h2>Restore in progress</h2></div>
        <div className="modal-body">
          <p className="m-0"><strong>{stage}…</strong></p>
          <progress className="mt-12" style={{ width: '100%' }} />
          <p className="dim mt-12 m-0">The system is in maintenance mode and unavailable to everyone. Keep this window open.</p>
        </div>
      </div>
    </div>
  );
}

export function RestoreResult({ job, onClose, onRollback }) {
  if (!job) {
    return (
      <Modal title="Restore status unknown" size="sm" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
        <p className="m-0">The restore finished, but its result could not be read. Sign in again if needed and check the History tab.</p>
      </Modal>
    );
  }
  const s = job.summary || {};
  const ok = job.status === 'succeeded';
  const canRollback = !ok && s.preRestoreBackupId;
  return (
    <Modal
      title={ok ? 'Restore completed' : 'Restore failed'}
      onClose={onClose}
      footer={<>{canRollback ? <button type="button" className="btn danger" onClick={() => onRollback(job)}>Roll back to pre-restore backup</button> : null}<button type="button" className="btn" onClick={onClose}>Close</button></>}
    >
      {ok ? (
        <div className="alert info mb-12">The backup was restored. If you were signed out, sign in again to continue.</div>
      ) : (
        <div className="alert err mb-12">
          <div>{job.error || 'The restore did not complete.'}</div>
          <div className="dim mt-12">{s.dbModified ? 'The database was already replaced when the failure occurred.' : 'The database was not modified.'}</div>
        </div>
      )}
      {s.preRestoreFilename ? <p className="muted">Pre-restore backup kept: <span className="mono">{s.preRestoreFilename}</span></p> : null}
      {s.validation ? (
        <table className="t wl">
          <tbody>
            {s.validation.map((c) => (
              <tr key={c.check}>
                <td className="nowrap"><span className={`pill ${CHECK_PILL[c.status]}`}>{c.status}</span></td>
                <td><strong>{c.check}</strong><div className="dim">{c.detail}</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {job.duration_ms != null ? <p className="dim mt-12 m-0">Took {Math.round(job.duration_ms / 1000)}s{job.size_bytes ? ` · ${fmtBytes(job.size_bytes)} archive` : ''}</p> : null}
    </Modal>
  );
}
