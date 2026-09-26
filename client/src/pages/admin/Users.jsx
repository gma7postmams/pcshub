import { useCallback, useEffect, useState } from 'react';
import { get, post, put } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/util.js';
import { useSession } from '../../context.jsx';
import { PlusIcon } from '../../components/Icons.jsx';
import { Empty, Modal, Options, RoleBadge, useConfirm, useForm, useToast } from '../../components/ui.jsx';
import { keyLabels } from './labels.js';

export default function Users({ model }) {
  const [list, setList] = useState(null);
  const [groups, setGroups] = useState([]);
  const [editing, setEditing] = useState(null); // null | {} new | user

  const load = useCallback(async () => {
    const [u, g] = await Promise.all([get('/api/admin/users'), get('/api/admin/groups')]);
    setList(u); setGroups(g);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!list) return <Empty>Loading…</Empty>;
  const locked = (u) => u.locked_until && new Date(u.locked_until) > new Date();

  return (
    <div className="card">
      <div className="card-head">
        <h2>Users <span className="dim">{list.length}</span></h2>
        <button type="button" className="btn primary sm" id="add" onClick={() => setEditing({})}><PlusIcon /> Add user</button>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Group</th><th>Status</th><th>2FA</th><th>Last login</th><th /></tr></thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id}>
                <td><strong>{u.full_name}</strong>{u.email ? <div className="dim">{u.email}</div> : null}</td>
                <td className="mono">{u.username}</td>
                <td><RoleBadge role={u.role} /></td>
                <td>{u.group_name ? <span className="group-chip">{u.group_name}</span>
                  : u.role === 'Admin' ? <span className="dim">— (full access)</span> : <span className="pill s-pending">Not enrolled</span>}</td>
                <td>
                  {u.is_active ? <span className="pill s-approved">Active</span> : <span className="pill s-hold">Disabled</span>}
                  {locked(u) ? <> <span className="pill s-rejected">Locked</span></> : null}
                  {u.must_change_password ? <> <span className="pill s-pending">Must change pw</span></> : null}
                </td>
                <td>{u.totp_enabled ? <span className="yes">On</span> : <span className="no">OFF</span>}</td>
                <td className="dim nowrap">{u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never'}</td>
                <td className="right"><button type="button" className="btn sm" data-edit={u.id} onClick={() => setEditing(u)}>Manage</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing ? (
        <UserForm u={editing.id ? editing : null} groups={groups} model={model} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      ) : null}
    </div>
  );
}

function UserForm({ u, groups, model, onClose, onSaved }) {
  const s = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const self = u && u.id === s.user.id;
  const LABEL = keyLabels(model);
  const [f, set] = useForm({
    full_name: u ? u.full_name : '', email: u ? u.email || '' : '', username: '', password: '',
    role: u ? u.role : 'Viewer', group_id: u && u.group_id ? String(u.group_id) : '', is_active: u ? u.is_active : true,
  });
  const [temp, setTemp] = useState(null);

  const g = groups.find((x) => String(x.id) === f.group_id);
  const hint = f.role === 'Admin' ? 'Admin role opens every page regardless of group.'
    : g ? `Opens: ${g.perms.filter((k) => !k.includes('.')).map((k) => LABEL[k] || k).join(', ') || 'no pages'} + Profile`
      : 'Not enrolled: user can only open Profile until assigned to a group.';

  const save = async () => {
    const body = { ...f, is_active: self ? true : f.is_active };
    try {
      if (u) await put(`/api/admin/users/${u.id}`, body); else await post('/api/admin/users', body);
      toast('User saved'); onSaved();
    } catch (e) { toast(e.message, 'err'); }
  };
  const action = async (path, msg, confirmArgs) => {
    if (confirmArgs && !(await confirm(...confirmArgs))) return null;
    try { const r = await post(`/api/admin/users/${u.id}/${path}`); if (msg) { toast(msg); onSaved(); } return r; } catch (e) { toast(e.message, 'err'); return null; }
  };

  return (
    <>
      <Modal
        title={u ? `Manage ${u.full_name}` : 'Add user'}
        onClose={onClose}
        footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" id="save" onClick={save}>Save</button></>}
      >
        <form className="form-grid" id="uf" noValidate onSubmit={(e) => e.preventDefault()}>
          <label className="f"><span>Full name <span className="req">*</span></span><input name="full_name" maxLength={120} value={f.full_name} onChange={set('full_name')} /></label>
          <label className="f"><span>Email</span><input name="email" type="email" maxLength={200} value={f.email} onChange={set('email')} /></label>
          {u ? <label className="f"><span>Username</span><input value={u.username} disabled /></label>
            : <label className="f"><span>Username <span className="req">*</span></span><input name="username" maxLength={60} autoComplete="off" value={f.username} onChange={set('username')} /></label>}
          <label className="f"><span>Role <span className="req">*</span> <span className="dim">— what they can do</span></span>
            <select name="role" value={f.role} onChange={set('role')}><Options list={model.roles} /></select></label>
          <label className="f"><span>Group <span className="dim">— which pages they can open</span></span>
            <select name="group_id" value={f.group_id} onChange={set('group_id')}><Options list={groups.map((x) => ({ value: String(x.id), label: x.name }))} blank="— Not enrolled —" /></select></label>
          <div className="full dim" id="grp-hint">{hint}</div>
          {!u ? (
            <label className="f full"><span>Temporary password <span className="req">*</span></span>
              <input name="password" type="text" autoComplete="new-password" placeholder="8+ chars, letters and numbers" value={f.password} onChange={set('password')} />
              <span className="dim mt-6">User must change it at first sign-in.</span></label>
          ) : null}
          <label className="check full"><input type="checkbox" name="is_active" checked={self ? true : f.is_active} disabled={self} onChange={set('is_active')} /> Active</label>
          {self ? <div className="full alert info">You cannot deactivate or demote yourself if you are the last Admin.</div> : null}
        </form>
        {u ? (
          <>
            <h3 className="mt-16 mb-12">Security</h3>
            <div className="row">
              <button type="button" className="btn sm" id="rpw" onClick={async () => {
                const r = await action('reset-password', null, ['Reset password', `Generate a temporary password for ${u.full_name}? Their sessions will be signed out.`, { okText: 'Reset' }]);
                if (r) setTemp(r.temporary_password);
              }}>Reset password</button>
              <button type="button" className="btn sm" id="r2fa" disabled={!u.totp_enabled}
                onClick={() => action('reset-2fa', '2FA reset', ['Reset 2FA', `Remove 2FA from ${u.full_name}? They can set it up again from Profile.`, { okText: 'Reset 2FA', danger: true }])}>Reset 2FA</button>
              <button type="button" className="btn sm" id="unlock" onClick={() => action('unlock', 'Account unlocked')}>Unlock</button>
            </div>
          </>
        ) : null}
      </Modal>
      {temp ? (
        <Modal title="Temporary password" size="sm" onClose={() => setTemp(null)} footer={<button type="button" className="btn primary" onClick={() => setTemp(null)}>Done</button>}>
          <p className="muted m-0">Share this securely. It is shown once.</p>
          <div className="secret mt-12">{temp}</div>
        </Modal>
      ) : null}
    </>
  );
}
