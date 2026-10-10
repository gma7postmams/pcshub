import { useCallback, useEffect, useState } from 'react';
import { del, get, post, put } from '../../lib/api.js';
import { PlusIcon } from '../../components/Icons.jsx';
import { Empty, Modal, useConfirm, useToast } from '../../components/ui.jsx';

function PermChips({ perms, catalog }) {
  const pages = catalog.filter((p) => perms.includes(p.key));
  if (!pages.length) return <span className="dim">No pages</span>;
  return (
    <div className="chips">
      {pages.flatMap((p) => [
        <span className="perm-chip" key={p.key}>{p.label}</span>,
        ...p.sections.filter((x) => perms.includes(x.key)).map((x) => <span className="perm-chip sec" key={x.key}>{x.label}</span>),
      ])}
    </div>
  );
}

export default function Groups({ model }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(async () => setList(await get('/api/admin/groups')), []);
  useEffect(() => { load(); }, [load]);

  const remove = async (g) => {
    if (!(await confirm('Delete group', `Delete group "${g.name}"?`, { okText: 'Delete', danger: true }))) return;
    try { await del(`/api/admin/groups/${g.id}`); toast('Group deleted'); load(); } catch (e) { toast(e.message, 'err'); }
  };

  if (!list) return <Empty>Loading…</Empty>;
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2 className="sr-only">Groups</h2>
          <button type="button" className="btn primary sm" id="add" onClick={() => setEditing({})}><PlusIcon /> Add group</button>
        </div>
        <div className="table-wrap">
          {!list.length ? <Empty>No groups yet. Add one, tick the pages it can open, then enroll users in it.</Empty> : (
            <table className="t wl">
              <thead>
                <tr>
                  <th style={{ width: '22%' }}>Group</th>
                  <th style={{ width: '50%' }}>Pages & Sections</th>
                  <th className="num" style={{ width: '8%' }}>Members</th>
                  <th style={{ width: '20%' }} />
                </tr>
              </thead>
              <tbody>
                {list.map((g) => (
                  <tr key={g.id}>
                    <td className="group-col">
                      <strong>{g.name}</strong>
                      {g.description ? <div className="dim">{g.description}</div> : null}
                    </td>
                    <td className="perm-col">
                      <PermChips perms={g.perms} catalog={model.catalog} />
                    </td>
                    <td className="num">{g.members}</td>
                    <td className="right nowrap actions-col">
                      <button type="button" className="btn sm" data-edit={g.id} onClick={() => setEditing(g)}>Edit</button>{' '}
                      <button type="button" className="btn sm ghost" disabled={g.members > 0} title={g.members ? 'Has members' : undefined} onClick={() => remove(g)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <div className="admin-note">Users are enrolled in one group. The group decides which pages and sections they can open; their <strong>role</strong> decides what they can do there. Admin role opens everything.</div>
      {editing ? <GroupForm g={editing.id ? editing : null} catalog={model.catalog} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} /> : null}
    </>
  );
}

function GroupForm({ g, catalog, onClose, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState(g ? g.name : '');
  const [description, setDescription] = useState(g ? g.description || '' : '');
  const [perms, setPerms] = useState(() => new Set(g ? g.perms : []));

  const togglePage = (p) => {
    setPerms((prev) => {
      const next = new Set(prev);
      const on = !next.has(p.key);
      if (on) { next.add(p.key); p.sections.forEach((x) => next.add(x.key)); } else { next.delete(p.key); p.sections.forEach((x) => next.delete(x.key)); }
      return next;
    });
  };
  const toggleKey = (k) => setPerms((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const all = () => setPerms(new Set(catalog.flatMap((p) => [p.key, ...p.sections.map((x) => x.key)])));

  const save = async () => {
    const body = { name, description, perms: [...perms] };
    try {
      if (g) await put(`/api/admin/groups/${g.id}`, body); else await post('/api/admin/groups', body);
      toast('Group saved'); onSaved();
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <Modal
      title={g ? `Edit group — ${g.name}` : 'Add group'}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" id="save" onClick={save}>Save group</button></>}
    >
      <form id="gf" className="stack" noValidate onSubmit={(e) => e.preventDefault()}>
        <div className="form-grid">
          <label className="f"><span>Group name <span className="req">*</span></span><input name="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="f"><span>Description</span><input name="description" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        </div>
        <div>
          <div className="row mb-12">
            <strong className="grow">Pages &amp; sections this group can open</strong>
            <button type="button" className="btn sm ghost" id="all" onClick={all}>Select all</button>
            <button type="button" className="btn sm ghost" id="none" onClick={() => setPerms(new Set())}>Clear</button>
          </div>
          <div className="perm-tree">
            {catalog.map((p) => (
              <div className="perm-page" key={p.key} data-page={p.key}>
                <label className="check"><input type="checkbox" data-kind="page" checked={perms.has(p.key)} onChange={() => togglePage(p)} /> {p.label} <span className="dim mono">{p.path}</span></label>
                {p.sections.length ? (
                  <div className={`perm-sections ${perms.has(p.key) ? '' : 'off'}`}>
                    {p.sections.map((x) => (
                      <label className="check" key={x.key}><input type="checkbox" data-kind="section" checked={perms.has(x.key)} onChange={() => toggleKey(x.key)} /> {x.label}</label>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <div className="dim mt-12">Profile is always available. The Admin page is limited to the Admin role.</div>
        </div>
      </form>
    </Modal>
  );
}
