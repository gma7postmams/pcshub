import { useEffect, useState } from 'react';
import { get } from '../lib/api.js';

// Knowledge Base — content not defined yet (to be built).
// When articles exist, /api/knowledge/meta returns ready: true and this page renders the list.
export default function Knowledge() {
  const [meta, setMeta] = useState(null);
  useEffect(() => { get('/api/knowledge/meta').then(setMeta).catch(() => setMeta({ ready: false })); }, []);

  return (
    <main className="container">
      <div className="page-head">
        <div><h1>Knowledge Base</h1><div className="sub">Content to be defined.</div></div>
      </div>
      <div className="card">
        {meta && !meta.ready ? (
          <div className="empty">
            <h2 className="mb-12">Nothing here yet</h2>
            <div>The Knowledge Base is being built. Articles and guides will appear here once the content is set up.</div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
