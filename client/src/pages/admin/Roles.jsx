import { useCallback, useEffect, useState } from 'react';
import { del, get, post, put } from '../../lib/api.js';
import { Empty, Modal, RoleBadge, useConfirm, useForm, useToast } from '../../components/ui.jsx';
import { keyLabels } from './labels.js';

const ACT = {
  'ingest.write': 'Create / edit ingest',
  'ingest.delete': 'Delete ingest records',
  'ingest.approve': 'Ingest: Destination Folder / Approved by',
  'ingest.cm_complete': 'Ingest: set Status (CM) and reason',
  'workload.write': 'Edit Workload',
  'knowledge.write': 'Upload / rename / delete Knowledge Base PDFs',
  'plugs.write': 'Edit PSD Daily Plug List',
};

export default function Roles({ model, refreshModel }) {
  const toast = useToast();
  const confirm = useConfirm();
  const LABEL = keyLabels(model);
  const [roles, setRoles] = useState(null);
  const [editing, setEditing] = useState(null);   // a role, or {} for a new one
  const [members, setMembers] = useState(null);     // role whose users are being shown
  const load = useCallback(async () => { setRoles(await get('/api/admin/roles')); if (refreshModel) refreshModel(); }, [refreshModel]);
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!roles) return <Empty>Loading…</Empty>;

  const actions = Object.keys(model.actionPage).filter((a) => a !== 'admin');
  const remove = async (r) => {
    if (!(await confirm('Delete role', `Delete the "${r.name}" role?`, { okText: 'Delete', danger: true }))) return;
    try { await del(`/api/admin/roles/${encodeURIComponent(r.name)}`); toast('Deleted'); load(); } catch (e) { toast(e.message, 'err'); }
  };
  const cell = (ok) => (ok ? <span className="yes">✓</span> : <span className="no">—</span>);

  return (
    <>
      <div className="admin-bar"><span className="grow" /><button type="button" className="btn primary sm" id="role-new" onClick={() => setEditing({})}>New role</button></div>
      <div className="card">
        <div className="table-wrap">
          <table className="t wl perm-matrix">
            <thead><tr><th>Action</th><th>Needs page</th>{roles.map((r) => <th key={r.name}><RoleBadge role={r.name} /></th>)}</tr></thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a}>
                  <td>{ACT[a] || a} <span className="dim mono">{a}</span></td>
                  <td className="dim">{model.actionPage[a] ? LABEL[model.actionPage[a]] : 'Admin page'}</td>
                  {roles.map((r) => <td key={r.name}>{cell(r.actions.includes(a))}</td>)}
                </tr>
              ))}
              <tr><td>Open pages / sections</td><td className="dim">—</td>{roles.map((r) => <td key={r.name} className="dim">{r.name === 'Admin' ? 'All' : 'Per group'}</td>)}</tr>
              <tr><td>Users</td><td className="dim">—</td>{roles.map((r) => <td key={r.name}>{r.users ? <button type="button" className="linklike" onClick={() => setMembers(r)} title="Who has this role">{r.users} {r.users === 1 ? 'user' : 'users'}</button> : <span className="dim">0</span>}</td>)}</tr>
              <tr><td /><td />{roles.map((r) => (
                <td key={r.name} className="nowrap">
                  {r.name === 'Admin' ? <span className="dim">Fixed</span> : (
                    <>
                      <button type="button" className="btn sm" data-edit={r.name} onClick={() => setEditing(r)}>Edit</button>{' '}
                      {r.is_builtin ? null : <button type="button" className="btn sm ghost" disabled={r.users > 0} title={r.users ? 'Users have this role' : undefined} onClick={() => remove(r)}>Delete</button>}
                    </>
                  )}
                </td>
              ))}</tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="admin-note">
        Roles decide what a user can <strong>do</strong>. An action also needs the user&apos;s group to open the page it happens on
        (e.g. filling Destination Folder / Approved by needs a role with that action <em>and</em> a group with the Ingest Tracker page).
        Admin is fixed; the other built-in roles can have their actions changed; custom roles can be added, renamed and deleted (only when no user has them).
      </div>
      {members ? <RoleMembers role={members} onClose={() => setMembers(null)} /> : null}
      {editing ? <RoleForm role={editing.name ? editing : null} actions={actions} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} /> : null}
    </>
  );
}

function RoleMembers({ role, onClose }) {
  const [users, setUsers] = useState(null);
  useEffect(() => { get('/api/admin/users').then((l) => setUsers(l.filter((u) => u.role === role.name))); }, [role.name]);
  return (
    <Modal title={`Who has the ${role.name} role`} size="sm" onClose={onClose} footer={<button type="button" className="btn primary" onClick={onClose}>Close</button>}>
      {!users ? <Empty>Loading…</Empty> : !users.length ? <p className="muted m-0">Nobody has this role.</p> : (
        <ul className="plain-list">
          {users.map((u) => (
            <li key={u.id}><strong>{u.full_name}</strong> <span className="dim mono">{u.username}</span>
              <div className="dim">{u.group_name || 'Not enrolled'}{u.is_active ? '' : ' · disabled'}</div></li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function RoleForm({ role, actions, onClose, onSaved }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [f, set] = useForm({ name: role ? role.name : '', description: role ? role.description || '' : '' });
  const [acts, setActs] = useState(() => new Set(role ? role.actions : []));
  const [busy, setBusy] = useState(false);
  const tick = (a) => setActs((p) => { const n = new Set(p); if (n.has(a)) n.delete(a); else n.add(a); return n; });
  const save = async () => {
    const removed = role ? role.actions.filter((a) => !acts.has(a)) : [];
    if (removed.length && role.users > 0) {
      const names = removed.map((a) => ACT[a] || a).join('; ');
      if (!(await confirm('Remove actions from a role in use',
        `${role.users} ${role.users === 1 ? 'user has' : 'users have'} the ${role.name} role. They will immediately lose: ${names}.`, { okText: 'Remove and save', danger: true }))) return;
    }
    setBusy(true);
    try {
      const body = { ...f, actions: [...acts] };
      if (role) await put(`/api/admin/roles/${encodeURIComponent(role.name)}`, body); else await post('/api/admin/roles', body);
      toast('Saved'); onSaved();
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal title={role ? `Edit role: ${role.name}` : 'New role'} size="sm" onClose={() => { if (!busy) onClose(); }}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={busy} onClick={save}>Save</button></>}>
      <form className="stack" onSubmit={(e) => e.preventDefault()}>
        <label className="f"><span>Name</span><input name="name" maxLength={40} value={f.name} disabled={!!(role && role.is_builtin)} onChange={set('name')} /></label>
        <label className="f"><span>Description</span><input maxLength={300} value={f.description} onChange={set('description')} /></label>
        {role && role.users ? <div className="alert info">{role.users} {role.users === 1 ? 'user has' : 'users have'} this role. Changes apply to them straight away.</div> : null}
        <div className="f"><span>Can do <span className="dim">— {acts.size} of {actions.length}</span></span>
          {actions.map((a) => (
            <label className="check" key={a}><input type="checkbox" checked={acts.has(a)} onChange={() => tick(a)} /> {ACT[a] || a}</label>
          ))}
        </div>
      </form>
    </Modal>
  );
}
