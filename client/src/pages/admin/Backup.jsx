import { useCallback, useState } from 'react';
import { post } from '../../lib/api.js';
import BackupTab from './BackupTab.jsx';
import RestoreTab from './RestoreTab.jsx';
import HistoryTab from './HistoryTab.jsx';
import ReauthDialog from './ReauthDialog.jsx';
import { RestoreOverlay, RestoreResult } from './RestoreRunner.jsx';

const TABS = [['backup', 'Backup'], ['restore', 'Restore'], ['history', 'History']];

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
