import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../../lib/api.js';
import { fmtBytes, fmtDateTime } from '../../lib/util.js';
import BackupTab from './BackupTab.jsx';
import RestoreTab from './RestoreTab.jsx';
import HistoryTab from './HistoryTab.jsx';
import ReauthDialog from './ReauthDialog.jsx';
import { RestoreOverlay, RestoreResult } from './RestoreRunner.jsx';

const TABS = [['backup', 'Backup'], ['restore', 'Restore'], ['history', 'History']];

const ago = (d) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000));
  if (m < 60) return `${Math.max(m, 1)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

// Always visible: when the last good backup was, and a warning when it is too old or the last attempt failed.
function StatusBanner({ refreshKey }) {
  const [st, setSt] = useState(null);
  useEffect(() => { get('/api/admin/backups/status').then(setSt).catch(() => setSt(null)); }, [refreshKey]);
  if (!st) return null;
  const warn = st.stale || st.lastFailure;
  return (
    <div className={`alert ${warn ? 'warn' : 'info'} mb-12 backup-status`} role="status">
      <strong>{st.last ? `Last successful backup: ${ago(st.last.at)}` : 'No successful backup yet'}</strong>
      <span className="dim">{st.last ? `${fmtDateTime(st.last.at)}${st.last.size ? ` · ${fmtBytes(st.last.size)}` : ''}${st.last.by === 'scheduler' ? ' · scheduled' : ''}` : ''}</span>
      <span className="grow" />
      <span>{st.schedule.mode === 'off' ? 'Automatic backups are off' : `Next automatic backup: ${fmtDateTime(st.next)}`}</span>
      {st.stale ? <div className="full">This is older than {st.staleDays} days. {st.schedule.mode === 'off' ? 'Create a backup now or turn on a schedule below.' : 'Check the History tab for a failed run.'}</div> : null}
      {st.lastFailure ? <div className="full">The latest attempt failed: {st.lastFailure.error || 'unknown error'}</div> : null}
    </div>
  );
}

export default function Backup() {
  const [tab, setTab] = useState('backup');
  const [running, setRunning] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [runJob, setRunJob] = useState(null); // restore or rollback in progress
  const [result, setResult] = useState(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [rollbackFor, setRollbackFor] = useState(null);
  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  const onFinished = useCallback((job) => { setRunJob(null); setResult(job); setResultOpen(true); bump(); }, [bump]);
  const rollback = async (job, { password, code, confirm }) => {
    const { job: started } = await post(`/api/admin/backups/${job.id}/rollback`, { confirm, password, code });
    setRollbackFor(null); setResultOpen(false); setRunJob(started.id);
  };

  // All panes stay mounted so an in-progress analysis survives switching tabs.
  return (
    <>
      <StatusBanner refreshKey={refreshKey} />
      <div className="tabs sub-tabs">
        {TABS.map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div hidden={tab !== 'backup'}><BackupTab running={running} refreshKey={refreshKey} onStarted={() => { bump(); setTab('history'); }} /></div>
      <div hidden={tab !== 'restore'}><RestoreTab onRestoreStarted={setRunJob} /></div>
      <div hidden={tab !== 'history'}><HistoryTab active={tab === 'history'} refreshKey={refreshKey} onRunning={setRunning} onChanged={bump} onRollback={setRollbackFor} /></div>

      {runJob ? <RestoreOverlay jobId={runJob} onFinished={onFinished} /> : null}
      {resultOpen ? <RestoreResult job={result} onClose={() => setResultOpen(false)} onRollback={setRollbackFor} /> : null}
      {rollbackFor ? (
        <ReauthDialog
          title="Roll back" okText="Roll back" danger typed="ROLLBACK" onClose={() => setRollbackFor(null)}
          intro="This restores the pre-restore backup taken before the failed restore, returning the system to its earlier state. Maintenance mode applies while it runs."
          onSubmit={(f) => rollback(rollbackFor, f)}
        />
      ) : null}
    </>
  );
}
