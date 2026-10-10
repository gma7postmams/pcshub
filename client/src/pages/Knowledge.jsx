import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { del, get, post, put } from '../lib/api.js';
import { fmtDateTime } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { DownloadIcon, FileIcon, PencilIcon, TrashIcon, UploadIcon } from '../components/Icons.jsx';
import { Empty, Modal, useConfirm, useToast } from '../components/ui.jsx';

const size = (n) => {
  const b = Number(n) || 0;
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
};
const looksPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const titleFrom = (name) => name.replace(/\.pdf$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled';

/** Tags input: chips plus a text box (Enter or comma adds one); existing tags are offered as suggestions. */
function TagsInput({ value, onChange, suggestions = [] }) {
  const [text, setText] = useState('');
  const add = (raw) => {
    const t = raw.replace(/\s+/g, ' ').trim().slice(0, 30);
    if (t && !value.some((x) => x.toLowerCase() === t.toLowerCase()) && value.length < 10) onChange([...value, t]);
    setText('');
  };
  return (
    <div className="tagsin">
      {value.map((t) => <span key={t} className="tag">{t}<button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>×</button></span>)}
      <input
        value={text} list="kb-tags" maxLength={30} placeholder={value.length ? '' : 'Add a tag (Enter)'}
        onChange={(e) => { if (e.target.value.endsWith(',')) add(e.target.value.slice(0, -1)); else setText(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); add(text); } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1)); }}
        onBlur={() => add(text)}
      />
      <datalist id="kb-tags">{suggestions.filter((t) => !value.includes(t)).map((t) => <option key={t} value={t} />)}</datalist>
    </div>
  );
}

// Knowledge Base — reference PDFs. Everyone with the page can open/download them;
// Admin/Manager (knowledge.write) can drag & drop new PDFs, rename and delete.
export default function Knowledge() {
  const s = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const canWrite = s.can('knowledge.write');
  const inputRef = useRef(null);
  const dragDepth = useRef(0);

  const [meta, setMeta] = useState({ maxMb: 25, maxFiles: 20, trashDays: 30 });
  const [docs, setDocs] = useState(null);
  const [q, setQ] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState([]); // per-file problems from the last upload
  const [edit, setEdit] = useState(null);
  const [tag, setTag] = useState('');            // tag filter
  const [trash, setTrash] = useState(null);      // null = closed; { days, docs } = the Trash list

  const load = useCallback(async () => {
    try { setDocs(await get('/api/knowledge')); } catch (e) { toast(e.message, 'err'); setDocs([]); }
  }, [toast]);

  useEffect(() => {
    get('/api/knowledge/meta').then(setMeta).catch(() => {});
    load();
  }, [load]);

  // Upload flow: choose / drop one or more PDFs, check or change each name, optionally add tags, then upload.
  const [draft, setDraft] = useState(null);   // { items: [{ file, title }], tags: [] }

  const pick = useCallback((fileList) => {
    const files = [...fileList];
    if (!files.length || busy) return;
    if (inputRef.current) inputRef.current.value = '';
    const problems = [];
    const ok = [];
    files.forEach((f) => {
      const err = !looksPdf(f) ? 'Not a PDF file' : f.size > meta.maxMb * 1024 * 1024 ? `Larger than ${meta.maxMb} MB` : !f.size ? 'The file is empty' : '';
      if (err) problems.push({ filename: f.name, error: err }); else ok.push(f);
    });
    if (ok.length > meta.maxFiles) { ok.slice(meta.maxFiles).forEach((f) => problems.push({ filename: f.name, error: `More than ${meta.maxFiles} files at once` })); ok.length = meta.maxFiles; }
    setReport(problems);
    if (ok.length) setDraft({ items: ok.map((f) => ({ file: f, title: titleFrom(f.name) })), tags: [] });
  }, [busy, meta]);

  const upload = useCallback(async () => {
    if (!draft || busy) return;
    if (draft.items.some((i) => !i.title.trim())) { toast('Every document needs a name', 'err'); return; }
    const fd = new FormData();
    fd.append('titles', JSON.stringify(draft.items.map((i) => i.title.trim())));
    fd.append('tags', JSON.stringify(draft.tags));
    draft.items.forEach((i) => fd.append('files', i.file));
    setBusy(true);
    try {
      const out = await post('/api/knowledge', fd);
      const bad = (out.results || []).filter((r) => !r.ok);
      toast(`${(out.results || []).length - bad.length} document${(out.results || []).length - bad.length === 1 ? '' : 's'} added`);
      setReport(bad.map((r) => ({ filename: r.filename, error: r.error })));
      setDraft(null);
      await load();
    } catch (e) {
      const rs = (e.data && e.data.results) || [];
      if (rs.length) { setReport(rs.filter((r) => !r.ok).map((r) => ({ filename: r.filename, error: r.error }))); setDraft(null); } else toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }, [busy, draft, load, toast]);

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const zone = canWrite ? {
    onDragEnter: (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current += 1; setOver(true); },
    onDragOver: (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
    onDragLeave: (e) => { if (!hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setOver(false); },
    onDrop: (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current = 0; setOver(false); pick(e.dataTransfer.files); },
  } : {};

  // Dropping a file beside the zone must not make the browser navigate away to the PDF
  useEffect(() => {
    if (!canWrite) return undefined;
    const stop = (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, [canWrite]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!docs) return [];
    return docs.filter((d) => (!tag || (d.tags || []).includes(tag))
      && (!t || d.title.toLowerCase().includes(t) || d.filename.toLowerCase().includes(t) || (d.tags || []).some((x) => x.toLowerCase().includes(t))));
  }, [docs, q, tag]);
  const allTags = useMemo(() => {
    const n = new Map();
    (docs || []).forEach((d) => (d.tags || []).forEach((t) => n.set(t, (n.get(t) || 0) + 1)));
    return [...n.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  }, [docs]);
  useEffect(() => { if (tag && !allTags.some(([t]) => t === tag)) setTag(''); }, [allTags, tag]);

  const remove = async (d) => {
    if (!(await confirm('Move to Trash', `Move "${d.title}" to the Trash? You can restore it for ${meta.trashDays} days.`, { okText: 'Move to Trash', danger: true }))) return;
    try { await del(`/api/knowledge/${d.id}`); toast('Moved to Trash'); load(); if (trash) openTrash(); } catch (e) { toast(e.message, 'err'); }
  };
  const openTrash = async () => { try { setTrash(await get('/api/knowledge/trash')); } catch (e) { toast(e.message, 'err'); } };
  const restore = async (d) => { try { await post(`/api/knowledge/${d.id}/restore`, {}); toast('Restored'); await load(); openTrash(); } catch (e) { toast(e.message, 'err'); } };
  const purge = async (d) => {
    if (!(await confirm('Delete forever', `Permanently delete "${d.title}"? The PDF file is removed from the server and cannot be restored.`, { okText: 'Delete forever', danger: true }))) return;
    try { await del(`/api/knowledge/${d.id}/purge`); toast('Deleted'); openTrash(); } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <main className="container wide wl-page">
      <h1 className="sr-only">Knowledge Base</h1>
      {canWrite ? (
        <>
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(e) => pick(e.target.files)} />
          <div
            className={`dropzone${over ? ' over' : ''}${busy ? ' busy' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="Drop PDFs here or press Enter to browse"
            onClick={() => !busy && inputRef.current && inputRef.current.click()}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); inputRef.current && inputRef.current.click(); } }}
            {...zone}
          >
            <UploadIcon />
            <div>
              <strong>{busy ? 'Uploading…' : over ? 'Drop to upload' : 'Drag & drop PDFs here'}</strong>
              <div className="muted">{busy ? 'Please wait' : `or click to browse · up to ${meta.maxFiles} PDFs at once, ${meta.maxMb} MB each · you can name them next`}</div>
            </div>
          </div>
          {report.length ? (
            <div className="alert warn mt-12">
              <strong>{report.length === 1 ? '1 file was not added' : `${report.length} files were not added`}</strong>
              <ul className="m-0">{report.map((r, i) => <li key={i}>{r.filename} — {r.error}</li>)}</ul>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="card mt-12">
        <div className="filters">
          <input type="search" placeholder="Search documents" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" />
          {allTags.length ? (
            <span className="kb-tags">
              <button type="button" className={`tag-filter${!tag ? ' on' : ''}`} onClick={() => setTag('')}>All</button>
              {allTags.map(([t, n]) => <button key={t} type="button" className={`tag-filter${tag === t ? ' on' : ''}`} onClick={() => setTag(tag === t ? '' : t)}>{t} <i>{n}</i></button>)}
            </span>
          ) : null}
          {canWrite ? <button type="button" className="btn sm" id="kb-trash-btn" onClick={openTrash}><TrashIcon /> Trash</button> : null}
          {docs ? <span className="dim kb-count" aria-live="polite">{q.trim() && shown.length !== docs.length ? `${shown.length} of ${docs.length}` : docs.length} PDF{docs.length === 1 ? '' : 's'}</span> : null}
        </div>
        {docs === null ? <Empty>Loading…</Empty> : !shown.length ? (
          <Empty>{docs.length ? 'No documents match your search.' : canWrite ? 'No documents yet. Add a PDF above to create the first one.' : 'No documents have been added yet.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="t wl">
              <thead><tr><th>Document</th><th>Size</th><th>Added by</th><th>Added</th><th /></tr></thead>
              <tbody>
                {shown.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <a className="doc-link" href={`/api/knowledge/${d.id}/file`} target="_blank" rel="noopener noreferrer">
                        <FileIcon /><span>{d.title}</span>
                      </a>
                      {d.filename !== `${d.title}.pdf` ? <div className="dim mono doc-file">{d.filename}</div> : null}
                      {(d.tags || []).length ? <div className="doc-tags">{d.tags.map((t) => <button key={t} type="button" className="tag" onClick={() => setTag(t)} title={`Show only “${t}”`}>{t}</button>)}</div> : null}
                    </td>
                    <td className="dim">{size(d.size_bytes)}</td>
                    <td className="dim">{d.uploaded_name || '—'}</td>
                    <td className="dim">{fmtDateTime(d.created_at)}</td>
                    <td className="doc-actions">
                      <a className="iconbtn" title="Download" aria-label={`Download ${d.title}`} href={`/api/knowledge/${d.id}/file?download=1`}><DownloadIcon /></a>
                      {canWrite ? (
                        <>
                          <button type="button" className="iconbtn" title="Rename / tags" aria-label={`Rename or tag ${d.title}`} onClick={() => setEdit({ id: d.id, title: d.title, tags: d.tags || [] })}><PencilIcon /></button>
                          <button type="button" className="iconbtn" title="Move to Trash" aria-label={`Move ${d.title} to Trash`} onClick={() => remove(d)}><TrashIcon /></button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {draft ? (
        <Modal
          title={`Add ${draft.items.length === 1 ? 'document' : `${draft.items.length} documents`}`}
          size="md"
          onClose={() => { if (!busy) setDraft(null); }}
          footer={(
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className="btn primary" disabled={busy || draft.items.some((i) => !i.title.trim())} onClick={upload}>{busy ? 'Uploading…' : `Upload${draft.items.length > 1 ? ` ${draft.items.length}` : ''}`}</button>
            </>
          )}
        >
          <div className="kb-draft">
            {draft.items.map((it, idx) => (
              <div key={`${it.file.name}-${idx}`} className="kb-draft-row">
                <label className="f">
                  <span>{draft.items.length === 1 ? 'Document name' : `Name ${idx + 1}`} <span className="req">*</span></span>
                  <input
                    autoFocus={idx === 0} value={it.title} maxLength={200} placeholder="e.g. Promo ingest guidelines"
                    onChange={(e) => setDraft({ ...draft, items: draft.items.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x)) })}
                  />
                </label>
                <div className="dim doc-file">{it.file.name} · {size(it.file.size)}
                  {draft.items.length > 1 ? <button type="button" className="linkbtn" onClick={() => { const items = draft.items.filter((_, i) => i !== idx); if (items.length) setDraft({ ...draft, items }); else setDraft(null); }}>Remove</button> : null}
                </div>
              </div>
            ))}
          </div>
          <label className="f mt-12">
            <span>Tags <span className="dim">(optional{draft.items.length > 1 ? ', applied to all' : ''})</span></span>
            <TagsInput value={draft.tags} onChange={(tags) => setDraft({ ...draft, tags })} suggestions={allTags.map(([t]) => t)} />
          </label>
        </Modal>
      ) : null}

      {edit ? (
        <Modal
          title="Rename / tags"
          size="sm"
          onClose={() => setEdit(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button
                type="button"
                className="btn primary"
                disabled={!edit.title.trim()}
                onClick={async () => {
                  try { await put(`/api/knowledge/${edit.id}`, { title: edit.title, tags: edit.tags }); setEdit(null); toast('Saved'); load(); } catch (e) { toast(e.message, 'err'); }
                }}
              >Save</button>
            </>
          )}
        >
          <label className="f">
            <span>Title</span>
            <input value={edit.title} maxLength={200} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          </label>
          <label className="f mt-12">
            <span>Tags</span>
            <TagsInput value={edit.tags} onChange={(tags) => setEdit({ ...edit, tags })} suggestions={allTags.map(([t]) => t)} />
          </label>
        </Modal>
      ) : null}

      {trash ? (
        <Modal title="Trash" size="md" onClose={() => setTrash(null)} footer={<button type="button" className="btn" onClick={() => setTrash(null)}>Close</button>}>
          <p className="dim m-0">Deleted documents stay here for {trash.days} days, then the file is removed for good.</p>
          {!trash.docs.length ? <Empty>The Trash is empty.</Empty> : (
            <table className="t wl mt-12">
              <thead><tr><th>Document</th><th>Deleted</th><th /></tr></thead>
              <tbody>
                {trash.docs.map((d) => (
                  <tr key={d.id}>
                    <td><FileIcon /> {d.title}<div className="dim mono doc-file">{d.filename} · {size(d.size_bytes)}</div></td>
                    <td className="dim">{fmtDateTime(d.deleted_at)}{d.deleted_name ? <div>by {d.deleted_name}</div> : null}</td>
                    <td className="doc-actions">
                      <button type="button" className="btn sm" onClick={() => restore(d)}>Restore</button>
                      <button type="button" className="btn sm danger" onClick={() => purge(d)}>Delete forever</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      ) : null}
    </main>
  );
}
