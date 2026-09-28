import { keyLabels } from './labels.js';

const ACT = {
  'ingest.write': 'Create / edit / send ingest',
  'ingest.delete': 'Delete ingest records',
  'approval.decide': 'Approve / reject',
  'workload.write': 'Edit Work Load',
  'admin': 'Users, groups, dropdowns, branding, audit',
};

export default function Roles({ model }) {
  const LABEL = keyLabels(model);
  const cell = (ok) => (ok ? <span className="yes">✓</span> : <span className="no">—</span>);
  return (
    <>
      <div className="alert info mb-12">
        Roles decide what a user can <strong>do</strong>. An action also needs the user&apos;s group to open the page it happens on
        (e.g. approving needs Manager role <em>and</em> a group with the Approval page). Roles are fixed in <span className="mono">src/permissions.js</span>.
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="t perm-matrix">
            <thead><tr><th>Action</th><th>Needs page</th>{model.roles.map((r) => <th key={r}><span className={`role-badge r-${r}`}>{r}</span></th>)}</tr></thead>
            <tbody>
              {Object.keys(model.actionPage).map((a) => (
                <tr key={a}>
                  <td>{ACT[a] || a} <span className="dim mono">{a}</span></td>
                  <td className="dim">{model.actionPage[a] ? LABEL[model.actionPage[a]] : 'Admin page'}</td>
                  {model.roles.map((r) => <td key={r}>{cell(model.roleActions[r].includes(a))}</td>)}
                </tr>
              ))}
              <tr>
                <td>Open pages / sections</td><td className="dim">—</td>
                {model.roles.map((r) => <td key={r} className="dim">{r === 'Admin' ? 'All' : 'Per group'}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
