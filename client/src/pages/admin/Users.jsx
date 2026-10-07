import { useCallback, useEffect, useState } from 'react';
import { get, post, put } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/util.js';
import { useSession } from '../../context.jsx';
import { PlusIcon } from '../../components/Icons.jsx';
import { Empty, Modal, Options, RoleBadge, useConfirm, useForm, useToast } from '../../components/ui.jsx';
import { keyLabels } from './labels.js';

export default function Users({ model }) {
  const s = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState(null);
  const [groups, setGroups] = useState([]);
  const [editing, setEditing] = useState(null); // null | {} new | user
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState(() => new Set());

  const load = useCallback(async () => {
    const [u, g] = await Promise.all([get('/api/admin/users'), get('/api/admin/groups')]);
    setList(u); setGroups(g);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!list) return <Empty>Loading…</Empty>;
  const term = q.trim().toLowerCase();
  const shown = term
    ? list.filter((u) => [u.full_name, u.username, u.email, u.role, u.group_name].some((x) => (x || '').toLowerCase().includes(term)))
    : list;
  const selectable = shown.filter((u) => u.id !== s.user.id);
  const allOn = selectable.length > 0 && selectable.every((u) => picked.has(u.id));
  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const removePicked = async () => {
    const ids = [...picked];
    const names = list.filter((u) => picked.has(u.id)).map((u) => u.full_name);
    const what = ids.length === 1 ? names[0] : `${ids.length} users`;
    if (!(await confirm('Delete users', `Permanently delete ${what}? Their records stay, but they can no longer sign in. This cannot be undone.`, { okText: 'Delete', danger: true }))) return;
    try {
      const r = await post('/api/admin/users/delete', { ids });
      toast(r.deleted === 1 ? 'User deleted' : `${r.deleted} users deleted`);
      setPicked(new Set());
      load();
    } catch (e) { toast(e.message, 'err'); }
  };
  const locked = (u) => u.locked_until && new Date(u.locked_until) > new Date();

  return (
    <div className="card">
      <div className="card-head">
        <h2>Users <span className="dim">{term ? `${shown.length} of ${list.length}` : list.length}</span></h2>
        <div className="row">
          {picked.size ? <button type="button" className="btn danger sm" id="del-sel" onClick={removePicked}>Delete selected ({picked.size})</button> : null}
          <button type="button" className="btn primary sm" id="add" onClick={() => setEditing({})}><PlusIcon /> Add user</button>
        </div>
      </div>
      <div className="filters">
        <input type="search" placeholder="Search name, username, email, role or group…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
      </div>
      <div className="table-wrap">
        <table className="t wl">
          <thead><tr><th className="chk"><input type="checkbox" checked={allOn} disabled={!selectable.length} onChange={() => setPicked(allOn ? new Set() : new Set(selectable.map((u) => u.id)))} aria-label="Select all users" /></th><th>Name</th><th>Username</th><th>Role</th><th>Group</th><th>Status</th><th>2FA</th><th>Last login</th><th /></tr></thead>
          <tbody>
            {!shown.length ? <tr><td colSpan={9} className="empty">No users match your search.</td></tr> : null}
            {shown.map((u) => (
              <tr key={u.id}>
                <td className="chk"><input type="checkbox" checked={picked.has(u.id)} disabled={u.id === s.user.id} title={u.id === s.user.id ? 'You cannot delete yourself' : undefined} onChange={() => toggle(u.id)} aria-label={`Select ${u.full_name}`} /></td>
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
                <td>{u.totp_enabled ? <span className="yes">On</span> : u.twofa_required ? <span className="dim">Awaiting setup</span> : <span className="no">OFF</span>}</td>
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
      await (u ? put(`/api/admin/users/${u.id}`, body) : post('/api/admin/users', body));
      toast('User saved'); onSaved();
    } catch (e) { toast(e.message, 'err'); }
  };
  const action = async (path, msg, confirmArgs, extra = {}) => {
    if (confirmArgs && !(await confirm(...confirmArgs))) return null;
    try {
      const r = await post(`/api/admin/users/${u.id}/${path}`, extra);
      if (msg) { toast(msg); onSaved(); }
      return r;
    } catch (e) { toast(e.message, 'err'); return null; }
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
              {u.twofa_required
                ? <button type="button" className="btn sm" id="tfa-off"
                  onClick={() => action('2fa', '2FA disabled', ['Disable 2FA', `Turn 2FA off for ${u.full_name}? Their authenticator is removed.`, { okText: 'Disable 2FA', danger: true }],
                    { enabled: false })}>Disable 2FA</button>
                : <button type="button" className="btn sm" id="tfa-on"
                  onClick={() => action('2fa', '2FA enabled', ['Enable 2FA', `Turn 2FA on for ${u.full_name}? They must set up an authenticator at their next use.`, { okText: 'Enable 2FA' }],
                    { enabled: true })}>Enable 2FA</button>}
              <button type="button" className="btn sm" id="r2fa" disabled={!u.totp_enabled}
                onClick={() => action('reset-2fa', '2FA reset', ['Reset 2FA', `Remove 2FA from ${u.full_name}? They can set it up again from Profile.`, { okText: 'Reset 2FA', danger: true }])}>Reset 2FA</button>
              <button type="button" className="btn sm" id="unlock" onClick={() => action('unlock', 'Account unlocked')}>Unlock</button>
              {!self ? <button type="button" className="btn sm danger" id="del-user" onClick={async () => {
                if (!(await confirm('Delete user', `Permanently delete ${u.full_name}? Their records stay, but they can no longer sign in. This cannot be undone.`, { okText: 'Delete', danger: true }))) return;
                try { await post('/api/admin/users/delete', { ids: [u.id] }); toast('User deleted'); onSaved(); } catch (e) { toast(e.message, 'err'); }
              }}>Delete user</button> : null}
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
