import { useCallback, useEffect, useRef, useState } from 'react';
import { del, get, post, put } from '../../lib/api.js';
import { Empty, Modal, useConfirm, useForm, useToast } from '../../components/ui.jsx';

const LABEL = { platform: 'Ingest Platform', workload_platform: 'Workload Platform', plug_type: 'Plug Type' };

export default function Dropdowns() {
  const toast = useToast();
  const confirm = useConfirm();
  const [d, setD] = useState(null);
  const [editing, setEditing] = useState(null);
  const fileRef = useRef(null);
  const [picked, setPicked] = useState(() => new Set());   // option ids ticked for batch delete

  const load = useCallback(async () => setD(await get('/api/admin/dropdowns')), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <Empty>Loading…</Empty>;

  const remove = async (r) => {
    if (!(await confirm('Delete option', `Delete "${r.value}"?`, { okText: 'Delete', danger: true }))) return;
    try { await del(`/api/admin/dropdowns/${r.id}`); toast('Deleted'); load(); } catch (e) { toast(e.message, 'err'); }
  };

  const toggle = (id) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleMany = (ids, on) => setPicked((p) => { const n = new Set(p); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); return n; });
  const removePicked = async () => {
    const chosen = d.rows.filter((r) => picked.has(r.id));
    if (!chosen.length) return;
    const inUse = chosen.filter((r) => r.usage > 0).length;
    const msg = `Delete ${chosen.length} option(s)?${inUse ? ` ${inUse} of them are in use and will be kept (deactivate those instead).` : ''}`;
    if (!(await confirm('Delete options', msg, { okText: 'Delete', danger: true }))) return;
    try {
      const r = await post('/api/admin/dropdowns/delete', { ids: chosen.map((x) => x.id) });
      toast(`${r.deleted} deleted${r.kept.length ? `, ${r.kept.length} kept (in use)` : ''}`, r.kept.length && !r.deleted ? 'err' : undefined);
      setPicked(new Set());
      load();
    } catch (e) { toast(e.message, 'err'); }
  };

  // Import: a JSON file made by Export. Missing options are added, existing ones only get their Active flag updated.
  const importFile = async (file) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    let json;
    try { json = JSON.parse(await file.text()); } catch (e) { toast('That file is not valid JSON', 'err'); return; }
    try {
      const r = await post('/api/admin/dropdowns/import', json);
      toast(`Imported: ${r.added} added, ${r.updated} updated, ${r.unchanged} unchanged`);
      load();
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
    <div className="row mb-12">
      {picked.size ? <button type="button" className="btn danger sm" id="dd-del-sel" onClick={removePicked}>Delete selected ({picked.size})</button> : null}
      <span className="grow" />
      <a className="btn sm" href="/api/admin/dropdowns/export" download>Export JSON</a>
      <button type="button" className="btn sm" onClick={() => fileRef.current && fileRef.current.click()}>Import JSON</button>
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => importFile(e.target.files[0])} />
    </div>
    <div className="grid grid-2">
      {d.categories.map((cat) => {
        const rows = d.rows.filter((r) => r.category === cat);
        return (
          <div className="card" key={cat}>
            <div className="card-head"><h2>{LABEL[cat] || cat} <span className="dim">{rows.length}</span></h2></div>
            <AddForm cat={cat} onAdded={load} />
            <div className="table-wrap">
              <table className="t wl">
                <thead><tr><th className="chk"><input type="checkbox" disabled={!rows.length} checked={rows.length > 0 && rows.every((r) => picked.has(r.id))} onChange={(e) => toggleMany(rows.map((r) => r.id), e.target.checked)} aria-label={`Select all ${LABEL[cat] || cat}`} /></th><th>Value</th><th className="num">Used</th><th>Active</th><th /></tr></thead>
                <tbody>
                  {rows.length ? rows.map((r) => (
                    <tr key={r.id}>
                      <td className="chk"><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.value}`} /></td>
                      <td>{r.value}</td><td className="num">{r.usage}</td>
                      <td>{r.is_active ? <span className="yes">Yes</span> : <span className="no">NO</span>}</td>
                      <td className="right nowrap">
                        <button type="button" className="btn sm" onClick={() => setEditing(r)}>Edit</button>{' '}
                        <button type="button" className="btn sm ghost" disabled={r.usage > 0} title={r.usage ? 'In use — deactivate instead' : undefined} onClick={() => remove(r)}>Delete</button>
                      </td>
                    </tr>
                  )) : <tr><td colSpan={5} className="empty">No options yet</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      {editing ? <EditOption r={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} /> : null}
    </div>
    </>
  );
}

function AddForm({ cat, onAdded }) {
  const toast = useToast();
  const [value, setValue] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try { await post('/api/admin/dropdowns', { category: cat, value }); toast('Added'); setValue(''); onAdded(); } catch (ex) { toast(ex.message, 'err'); }
  };
  return (
    <form className="filters" data-add={cat} onSubmit={submit}>
      <input name="value" placeholder={`Add ${LABEL[cat] || cat}…`} maxLength={200} className="grow" value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="btn sm primary">Add</button>
    </form>
  );
}

function EditOption({ r, onClose, onSaved }) {
  const toast = useToast();
  const [f, set] = useForm({ value: r.value, is_active: r.is_active });
  const save = async () => {
    try { await put(`/api/admin/dropdowns/${r.id}`, f); toast('Saved'); onSaved(); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal title={`Edit ${LABEL[r.category]} option`} size="sm" onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" onClick={save}>Save</button></>}>
      <form className="stack" onSubmit={(e) => e.preventDefault()}>
        <label className="f"><span>Value</span><input maxLength={200} value={f.value} onChange={set('value')} /></label>
        <label className="check"><input type="checkbox" checked={f.is_active} onChange={set('is_active')} /> Active (shown in forms)</label>
        {r.usage ? <div className="alert info">Renaming updates the {r.usage} existing record(s) that use it.</div> : null}
      </form>
    </Modal>
  );
}
