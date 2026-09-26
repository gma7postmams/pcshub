import { useEffect, useState } from 'react';
import { get } from '../lib/api.js';

// Work Load Tracker — fields not defined yet (to be built).
// When fields exist, /api/workload/meta returns them and this page renders Table + Excel modes.
export default function Workload() {
  const [meta, setMeta] = useState(null);
  const [mode, setMode] = useState('table');
  useEffect(() => { get('/api/workload/meta').then(setMeta).catch(() => setMeta({ ready: false, fields: [] })); }, []);

  return (
    <main className="container">
      <div className="page-head">
        <div><h1>Work Load Tracker</h1><div className="sub">Fields to be defined.</div></div>
        <div className="actions">
          <div className="segmented" id="mode-seg">
            <button type="button" className={mode === 'table' ? 'on' : ''} onClick={() => setMode('table')}>Table</button>
            <button type="button" className={mode === 'excel' ? 'on' : ''} onClick={() => setMode('excel')}>Excel</button>
          </div>
        </div>
      </div>
      <div className="card">
        {meta && !meta.ready ? (
          <div className="empty">
            <h2 className="mb-12">Fields not defined yet</h2>
            <div>The Work Load Tracker is being built. Its {mode === 'excel' ? 'Excel grid' : 'table'} will appear here once the fields are set.</div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
