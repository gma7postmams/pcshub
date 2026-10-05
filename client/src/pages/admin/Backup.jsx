import { useState } from 'react';
import BackupTab from './BackupTab.jsx';
import RestoreTab from './RestoreTab.jsx';
import HistoryTab from './HistoryTab.jsx';

const TABS = [['backup', 'Backup'], ['restore', 'Restore'], ['history', 'History']];

export default function Backup() {
  const [tab, setTab] = useState('backup');
  const [running, setRunning] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);
  // All panes stay mounted so an in-progress analysis survives switching tabs.
  return (
    <>
      <div className="tabs sub-tabs">
        {TABS.map(([k, l]) => <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div hidden={tab !== 'backup'}><BackupTab running={running} refreshKey={refreshKey} onStarted={() => { bump(); setTab('history'); }} /></div>
      <div hidden={tab !== 'restore'}><RestoreTab /></div>
      <div hidden={tab !== 'history'}><HistoryTab active={tab === 'history'} refreshKey={refreshKey} onRunning={setRunning} onChanged={bump} /></div>
    </>
  );
}
