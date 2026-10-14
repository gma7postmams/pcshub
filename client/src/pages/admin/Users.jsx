import { useCallback, useEffect, useState } from 'react';
import { get, post, put } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/util.js';
import { useSession } from '../../context.jsx';
import { PlusIcon } from '../../components/Icons.jsx';
import { Empty, Modal, Options, Pager, RoleBadge, usePageSize, useConfirm, useForm, useToast } from '../../components/ui.jsx';
import { keyLabels } from './labels.js';
import JsonTools from './JsonTools.jsx';

export default function Users({ model }) {
  const s = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState(null);
  const [groups, setGroups] = useState([]);
  const [editing, setEditing] = useState(null); // null | {} new | user
  const [q, setQ] = useState('');
  const [fRole, setFRole] = useState('');
  const [fGroup, setFGroup] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [f2fa, setF2fa] = useState('');
  const [bulk, setBulk] = useState({ action: '', value: '' });
  const [picked, setPicked] = useState(() => new Set());
  const [size, setSize] = usePageSize('users');
  const [offset, setOffset] = useState(0);
  useEffect(() => { setOffset(0); }, [q, fRole, fGroup, fStatus, f2fa]);   // a new search starts on the first page

  const load = useCallback(async () => {
    const [u, g] = await Promise.all([get('/api/admin/users'), get('/api/admin/groups')]);
    setList(u); setGroups(g);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!list) return <Empty>Loading…</Empty>;
  const term = q.trim().toLowerCase();
  const isLocked = (u) => u.locked_until && new Date(u.locked_until) > new Date();
  const shown = list.filter((u) => {
    if (term && ![u.full_name, u.username, u.email, u.role, u.group_name].some((x) => (x || '').toLowerCase().includes(term))) return false;
    if (fRole && u.role !== fRole) return false;
    if (fGroup === 'none' ? u.group_id : fGroup && String(u.group_id) !== fGroup) return false;
    if (fStatus === 'active' && !u.is_active) return false;
    if (fStatus === 'disabled' && u.is_active) return false;
    if (fStatus === 'locked' && !isLocked(u)) return false;
    if (fStatus === 'never' && u.last_login_at) return false;
    if (f2fa === 'on' && !u.totp_enabled) return false;
    if (f2fa === 'off' && u.totp_enabled) return false;
    return true;
  });
  const pageRows = shown.slice(offset, offset + size);
  const filtered = Boolean(term || fRole || fGroup || fStatus || f2fa);
  const clearFilters = () => { setQ(''); setFRole(''); setFGroup(''); setFStatus(''); setF2fa(''); };
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
  const locked = isLocked;
  const BULK_LABEL = { activate: 'Activate', deactivate: 'Deactivate', role: 'Change role', group: 'Change group', 'reset-2fa': 'Reset 2FA', 'sign-out': 'Sign out everywhere', unlock: 'Unlock' };
  const runBulk = async () => {
    const ids = [...picked];
    if (!bulk.action) return;
    if (bulk.action === 'role' && !bulk.value) { toast('Choose a role', 'err'); return; }
    const who = ids.length === 1 ? list.find((u) => u.id === ids[0]).full_name : `${ids.length} users`;
    const detail = { activate: 'They can sign in again.', deactivate: 'They are signed out and cannot sign in.', role: `Their role becomes ${bulk.value}.`,
      group: bulk.value ? `They move to the ${(groups.find((g) => String(g.id) === bulk.value) || {}).name || 'chosen'} group.` : 'They are removed from their group (Profile page only).',
      'reset-2fa': 'Their authenticator is removed; they can set it up again.', 'sign-out': 'Every device is signed out; they sign in again with their password.', unlock: 'Failed-attempt locks are cleared.' }[bulk.action];
    if (!(await confirm(`${BULK_LABEL[bulk.action]}: ${who}`, detail, { okText: BULK_LABEL[bulk.action], danger: ['deactivate', 'reset-2fa'].includes(bulk.action) }))) return;
    try {
      const r = await post('/api/admin/users/bulk', { ids, action: bulk.action, value: bulk.value });
      toast(`${BULK_LABEL[bulk.action]}: ${r.changed} ${r.changed === 1 ? 'user' : 'users'}`);
      setPicked(new Set()); setBulk({ action: '', value: '' }); load();
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <div className="card">
      <div className="filters users-bar">
      <h2 className="sr-only">Users</h2>
        <input type="search" placeholder="Search name, username, email, role or group…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
        <select aria-label="Filter by role" value={fRole} onChange={(e) => setFRole(e.target.value)}><option value="">All roles</option><Options list={model.roles} /></select>
        <select aria-label="Filter by group" value={fGroup} onChange={(e) => setFGroup(e.target.value)}><option value="">All groups</option><option value="none">Not enrolled</option>{groups.map((g) => <option key={g.id} value={String(g.id)}>{g.name}</option>)}</select>
        <select aria-label="Filter by status" value={fStatus} onChange={(e) => setFStatus(e.target.value)}><option value="">Any status</option><option value="active">Active</option><option value="disabled">Disabled</option><option value="locked">Locked</option><option value="never">Never signed in</option></select>
        <select aria-label="Filter by 2FA" value={f2fa} onChange={(e) => setF2fa(e.target.value)}><option value="">Any 2FA</option><option value="on">2FA on</option><option value="off">2FA off</option></select>
        {filtered ? <button type="button" className="btn ghost" onClick={clearFilters}>Clear</button> : null}
        <span className="users-actions">
          {picked.size ? (
            <>
              <select className="sm" aria-label="Bulk action" value={bulk.action} onChange={(e) => setBulk({ action: e.target.value, value: '' })}>
                <option value="">{picked.size} selected — action…</option>
                {Object.entries(BULK_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {bulk.action === 'role' ? <select className="sm" aria-label="New role" value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })}><option value="">Role…</option><Options list={model.roles} /></select> : null}
              {bulk.action === 'group' ? <select className="sm" aria-label="New group" value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })}><Options list={groups.map((x) => ({ value: String(x.id), label: x.name }))} blank="— Not enrolled —" /></select> : null}
              <button type="button" className="btn primary" id="bulk-go" disabled={!bulk.action} onClick={runBulk}>Apply</button>
              <button type="button" className="btn danger" id="del-sel" onClick={removePicked}>Delete ({picked.size})</button>
            </>
          ) : null}
          <JsonTools path="/api/admin/users" onDone={load} summary={(r) => `Imported: ${r.added} added, ${r.existing} already there${r.skipped ? `, ${r.skipped} skipped` : ''}`} />
          <button type="button" className="btn primary" id="add" onClick={() => setEditing({})}><PlusIcon /> Add user</button>
        </span>
      </div>
      <div className="table-wrap">
        <table className="t wl">
          <thead><tr><th className="chk"><input type="checkbox" checked={allOn} disabled={!selectable.length} onChange={() => setPicked(allOn ? new Set() : new Set(selectable.map((u) => u.id)))} aria-label="Select all users" /></th><th>Name</th><th>Username</th><th>Role</th><th>Group</th><th>Status</th><th>2FA</th><th>Last login</th><th /></tr></thead>
          <tbody>
            {!shown.length ? <tr><td colSpan={9} className="empty">No users match your search or filters.</td></tr> : null}
            {pageRows.map((u) => (
              <tr key={u.id}>
                <td className="chk"><input type="checkbox" checked={picked.has(u.id)} disabled={u.id === s.user.id} title={u.id === s.user.id ? 'You cannot delete yourself' : undefined} onChange={() => toggle(u.id)} aria-label={`Select ${u.full_name}`} /></td>
                <td><strong>{u.full_name}</strong>{u.email ? <div className="dim">{u.email}</div> : null}</td>
                <td className="mono">{u.username}</td>
                <td><RoleBadge role={u.role} /></td>
                <td>{u.group_name ? <span className="group-chip">{u.group_name}</span>
                  : (u.role === 'Admin' || u.role === 'System Admin') ? <span className="dim">— (every page)</span> : <span className="pill s-pending">Not enrolled</span>}</td>
                <td>
                  {u.is_active ? <span className="pill s-approved">Active</span> : <span className="pill s-hold">Disabled</span>}
                  {locked(u) ? <> <span className="pill s-rejected">Locked</span></> : null}
                  {u.must_change_password ? <> <span className="pill s-pending">Must change pw</span></> : null}
                </td>
                <td>{u.totp_enabled ? <span className="yes">On{u.twofa_method === 'email' ? ' (email)' : ''}</span> : u.twofa_required ? <span className="dim">Awaiting setup</span> : <span className="no">OFF</span>}</td>
                <td className="dim nowrap">{u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never'}{u.sessions ? <div className="dim">{u.sessions} signed in</div> : null}</td>
                <td className="right"><button type="button" className="btn sm" data-edit={u.id} onClick={() => setEditing(u)}>Manage</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager total={shown.length} offset={Math.min(offset, Math.max(0, (Math.ceil(shown.length / size) - 1) * size))} size={size} onOffset={setOffset} onSize={setSize} />
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
    role: u ? u.role : 'Viewer', force_change: true, mode: 'generate', send_email: false, group_id: u && u.group_id ? String(u.group_id) : '', is_active: u ? u.is_active : true,
  });
  const [temp, setTemp] = useState(null);
  const [resetOpen, setResetOpen] = useState(false);   // the Reset password window
  const [rpMode, setRpMode] = useState('generate');   // 'generate' | 'manual'
  const [rpEmail, setRpEmail] = useState(false);
  const [rpPw, setRpPw] = useState('');
  const [rpForce, setRpForce] = useState(true);   // typed password only: must the user change it at next sign-in?
  const [rpBusy, setRpBusy] = useState(false);
  const [method, setMethod] = useState(u && u.twofa_method === 'email' ? 'email' : 'app');
  const emailOk = s.user.email_2fa_available;

  const g = groups.find((x) => String(x.id) === f.group_id);
  const hint = f.role === 'System Admin' ? 'System Admin: everything, including the whole Administration area.' : f.role === 'Admin' ? 'Admin opens every page regardless of group; in Settings only the Audit Log, Dropdowns and Branding.'
    : g ? `Opens: ${g.perms.filter((k) => !k.includes('.')).map((k) => LABEL[k] || k).join(', ') || 'no pages'} + Profile`
      : 'Not enrolled: user can only open Profile until assigned to a group.';

  const save = async () => {
    const body = { ...f, is_active: self ? true : f.is_active, send_email: f.send_email && !!f.email.trim() };
    try {
      if (u) { await put(`/api/admin/users/${u.id}`, body); toast('User saved'); onSaved(); return; }
      const r = await post('/api/admin/users', { ...body, ...(f.mode === 'generate' ? { password: '' } : {}) });
      if (r.temporary_password) setTemp({ pw: r.temporary_password, sentTo: r.sentTo }); else { toast(r.emailed ? `User saved. Password emailed to ${r.sentTo}` : 'User saved'); onSaved(); }
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
            <div className="full stack" id="pw-block">
              <label className="rp-opt"><input type="radio" name="pwmode" value="generate" checked={f.mode === 'generate'} onChange={() => set('mode')('generate')} /><span>Generate a temporary password <span className="dim">— shown once, for you to pass on</span></span></label>
              <label className="rp-opt"><input type="radio" name="pwmode" value="manual" checked={f.mode === 'manual'} onChange={() => set('mode')('manual')} /><span>Type a temporary password myself</span></label>
              {f.mode === 'manual' ? (
                <>
                  <input name="password" type="text" autoComplete="new-password" aria-label="Temporary password" placeholder="Letters and numbers" value={f.password} onChange={set('password')} />
                  <label className="rp-opt"><input type="checkbox" id="force-change" name="force_change" checked={f.force_change} onChange={set('force_change')} /><span>User must change it at first sign-in</span></label>
                </>
              ) : <span className="dim">The user must change a generated password at first sign-in.</span>}
              <label className="rp-opt"><input type="checkbox" id="send-email" name="send_email" disabled={!f.email.trim()} checked={f.send_email && !!f.email.trim()} onChange={set('send_email')} /><span>Email it to the user <span className="dim">{f.email.trim() ? `— ${f.email.trim()}` : '— fill in the email address first'}</span></span></label>
            </div>
          ) : null}
          <label className="check full"><input type="checkbox" name="is_active" checked={self ? true : f.is_active} disabled={self} onChange={set('is_active')} /> Active</label>
          {self ? <div className="full alert info">You cannot deactivate or demote yourself if you are the last Admin.</div> : null}
        </form>
        {u ? (
          <>
            <h3 className="mt-16 mb-12">Security</h3>
            <div className="row">
              <button type="button" className="btn" id="rpw" onClick={() => { setRpMode('generate'); setRpPw(''); setRpEmail(false); setRpForce(true); setResetOpen(true); }}>Reset password</button>
              <select aria-label="2FA method" id="tfa-method" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="app">2FA by authenticator app</option>
                <option value="email" disabled={!emailOk && method !== 'email'}>2FA by emailed code{emailOk ? '' : ' (not enabled)'}</option>
              </select>
              {u.twofa_required && method !== (u.twofa_method || 'app')
                ? <button type="button" className="btn" id="tfa-switch"
                  onClick={() => action('2fa', '2FA method changed', ['Change 2FA method', `Switch ${u.full_name} to ${method === 'email' ? 'emailed codes' : 'an authenticator app'}? They must set it up again at their next use.`, { okText: 'Change' }],
                    { enabled: true, method })}>Change method</button>
                : null}
              {u.twofa_required
                ? <button type="button" className="btn" id="tfa-off"
                  onClick={() => action('2fa', '2FA disabled', ['Disable 2FA', `Turn 2FA off for ${u.full_name}? Their authenticator is removed.`, { okText: 'Disable 2FA', danger: true }],
                    { enabled: false })}>Disable 2FA</button>
                : <button type="button" className="btn" id="tfa-on"
                  onClick={() => action('2fa', '2FA enabled', ['Enable 2FA', `Turn 2FA on for ${u.full_name}? They must set up an authenticator at their next use.`, { okText: 'Enable 2FA' }],
                    { enabled: true, method })}>Enable 2FA</button>}
              <button type="button" className="btn" id="r2fa" disabled={!u.totp_enabled}
                onClick={() => action('reset-2fa', '2FA reset', ['Reset 2FA', `Remove 2FA from ${u.full_name}? They can set it up again from Profile.`, { okText: 'Reset 2FA', danger: true }])}>Reset 2FA</button>
              <button type="button" className="btn" id="signout" disabled={!u.sessions} title={u.sessions ? undefined : 'Not signed in anywhere'}
                onClick={() => action('sign-out', 'Signed out everywhere', ['Sign out everywhere', `Sign ${u.full_name} out of ${u.sessions} ${u.sessions === 1 ? 'device' : 'devices'}? They sign in again with their password.`, { okText: 'Sign out' }])}>Sign out everywhere{u.sessions ? ` (${u.sessions})` : ''}</button>
              <button type="button" className="btn" id="unlock" disabled={!(u.locked_until && new Date(u.locked_until) > new Date())} title={u.locked_until && new Date(u.locked_until) > new Date() ? undefined : 'This account is not locked'} onClick={() => action('unlock', 'Account unlocked')}>Unlock</button>
              {!self ? <button type="button" className="btn danger" id="del-user" onClick={async () => {
                if (!(await confirm('Delete user', `Permanently delete ${u.full_name}? Their records stay, but they can no longer sign in. This cannot be undone.`, { okText: 'Delete', danger: true }))) return;
                try { await post('/api/admin/users/delete', { ids: [u.id] }); toast('User deleted'); onSaved(); } catch (e) { toast(e.message, 'err'); }
              }}>Delete user</button> : null}
            </div>
          </>
        ) : null}
      </Modal>
      {resetOpen && u ? (
        <Modal title={`Reset password — ${u.full_name}`} size="sm" onClose={() => setResetOpen(false)}
          footer={<><button type="button" className="btn" onClick={() => setResetOpen(false)}>Cancel</button>
            <button type="button" className="btn primary" id="rp-go" disabled={rpBusy || (rpMode === 'manual' && !rpPw)} onClick={async () => {
              setRpBusy(true);
              const r = await action('reset-password', null, null, { mode: rpMode, email: rpEmail, ...(rpMode === 'manual' ? { password: rpPw, force_change: rpForce } : {}) });
              setRpBusy(false);
              if (!r) return;
              setResetOpen(false);
              if (r.temporary_password) setTemp({ pw: r.temporary_password, sentTo: r.sentTo });   // list refreshes when this is closed
              else { onSaved(); toast(r.emailed ? `Temporary password set and emailed to ${r.sentTo}` : 'Temporary password set'); }
}}>Reset password</button></>}>
          <p className="m-0">Their current password stops working now, every device is signed out, and they must choose their own password at their next sign-in{rpMode === 'manual' ? ', unless you untick the box below' : ''}.</p>
          <div className="stack mt-12">
            <label className="rp-opt"><input type="radio" name="rpmode" value="generate" checked={rpMode === 'generate'} onChange={() => setRpMode('generate')} /><span>Generate a temporary password <span className="dim">— shown once, for you to pass on</span></span></label>
            <label className="rp-opt"><input type="radio" name="rpmode" value="manual" checked={rpMode === 'manual'} onChange={() => setRpMode('manual')} /><span>Type a temporary password myself</span></label>
            {rpMode === 'manual' ? <input id="rp-manual" type="text" autoComplete="new-password" placeholder="Letters and numbers" value={rpPw} onChange={(e) => setRpPw(e.target.value)} /> : null}
            {rpMode === 'manual' ? <label className="rp-opt"><input type="checkbox" id="rp-force" checked={rpForce} onChange={(e) => setRpForce(e.target.checked)} /><span>User must change it at next sign-in</span></label> : null}
            <hr className="rp-sep" />
            <label className="rp-opt"><input type="checkbox" id="rp-email" disabled={!u.email} checked={rpEmail && !!u.email} onChange={(e) => setRpEmail(e.target.checked)} /><span>Also email it to the user <span className="dim">{u.email ? `— ${u.email}` : '— this account has no email address'}</span></span></label>
          </div>
        </Modal>
      ) : null}
      {temp ? (
        <Modal title="Temporary password" size="sm" onClose={() => { setTemp(null); onSaved(); }} footer={<button type="button" className="btn primary" onClick={() => { setTemp(null); onSaved(); }}>Done</button>}>
          <p className="muted m-0">{temp.sentTo ? `Also emailed to ${temp.sentTo}. ` : ''}Share this securely. It is shown once.</p>
          <div className="secret mt-12">{temp.pw}</div>
        </Modal>
      ) : null}
    </>
  );
}
