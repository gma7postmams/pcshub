import { useEffect, useState } from 'react';
import { get } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/util.js';
import { Empty, useDebounced } from '../../components/ui.jsx';

const PAGE = 50;

export default function Audit() {
  const [f, setF] = useState({ action: '', user: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const [d, setD] = useState(null);
  const action = useDebounced(f.action);
  const user = useDebounced(f.user);

  useEffect(() => {
    const p = new URLSearchParams({ limit: PAGE, offset });
    Object.entries({ action, user, from: f.from, to: f.to }).forEach(([k, v]) => { if (v) p.set(k, v); });
    get(`/api/admin/audit?${p}`).then(setD).catch(() => setD({ rows: [], total: 0 }));
  }, [action, user, f.from, f.to, offset]);

  const set = (k) => (e) => { setF((x) => ({ ...x, [k]: e.target.value })); setOffset(0); };
  const total = d ? d.total : 0;

  return (
    <div className="card">
      <div className="filters">
        <input type="search" placeholder="Action (e.g. ingest, approval, auth, import, export)" value={f.action} onChange={set('action')} />
        <input type="search" placeholder="Username" value={f.user} onChange={set('user')} />
        <input type="date" value={f.from} onChange={set('from')} />
        <input type="date" value={f.to} onChange={set('to')} />
      </div>
      <div className="table-wrap">
        {!d ? <Empty>Loading…</Empty> : !d.rows.length ? <Empty>No audit entries.</Empty> : (
          <table className="t">
            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr></thead>
            <tbody>
              {d.rows.map((r) => {
                const details = r.details ? JSON.stringify(r.details) : '';
                return (
                  <tr key={r.id}>
                    <td className="nowrap dim">{fmtDateTime(r.created_at)}</td>
                    <td className="mono">{r.username || '—'}</td>
                    <td className="mono">{r.action}</td>
                    <td className="nowrap">{r.entity || ''}{r.entity_id ? ` #${r.entity_id}` : ''}</td>
                    <td className="cell-clip mono" title={details}>{details}</td>
                    <td className="mono dim">{r.ip || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="pager">
        <span>{total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : ''}</span>
        <span className="grow" />
        <button type="button" className="btn sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
        <button type="button" className="btn sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Next</button>
      </div>
    </div>
  );
}
