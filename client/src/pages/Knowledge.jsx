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

// Knowledge Base — reference PDFs. Everyone with the page can open/download them;
// Admin/Manager (knowledge.write) can drag & drop new PDFs, rename and delete.
export default function Knowledge() {
  const s = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const canWrite = s.can('knowledge.write');
  const inputRef = useRef(null);
  const dragDepth = useRef(0);

  const [meta, setMeta] = useState({ maxMb: 25, maxFiles: 10 });
  const [docs, setDocs] = useState(null);
  const [q, setQ] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState([]); // per-file problems from the last upload
  const [edit, setEdit] = useState(null);

  const load = useCallback(async () => {
    try { setDocs(await get('/api/knowledge')); } catch (e) { toast(e.message, 'err'); setDocs([]); }
  }, [toast]);

  useEffect(() => {
    get('/api/knowledge/meta').then(setMeta).catch(() => {});
    load();
  }, [load]);

  // Upload flow: choose / drop a PDF, then name it. The title is required before anything is sent.
  const [draft, setDraft] = useState(null);   // { file, title }

  const pick = useCallback((fileList) => {
    const files = [...fileList];
    if (!files.length || busy) return;
    if (inputRef.current) inputRef.current.value = '';
    setReport([]);
    const f = files[0];
    const err = files.length > 1 ? 'Upload one PDF at a time' : !looksPdf(f) ? 'Not a PDF file' : f.size > meta.maxMb * 1024 * 1024 ? `Larger than ${meta.maxMb} MB` : '';
    if (err) { setReport([{ filename: f.name, error: err }]); return; }
    setDraft({ file: f, title: '' });
  }, [busy, meta]);

  const upload = useCallback(async () => {
    if (!draft || busy) return;
    const title = draft.title.trim();
    if (!title) { toast('Name the document first', 'err'); return; }
    const fd = new FormData();
    fd.append('title', title);
    fd.append('files', draft.file);
    setBusy(true);
    try {
      await post('/api/knowledge', fd);
      toast('Document added');
      setDraft(null);
      await load();
    } catch (e) {
      const r = e.data && e.data.results && e.data.results[0];
      toast(r ? r.error : e.message, 'err');
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
    return t ? docs.filter((d) => d.title.toLowerCase().includes(t) || d.filename.toLowerCase().includes(t)) : docs;
  }, [docs, q]);

  const remove = async (d) => {
    if (!(await confirm('Delete document', `Permanently delete "${d.title}"? The PDF file is removed from the server.`, { okText: 'Delete', danger: true }))) return;
    try { await del(`/api/knowledge/${d.id}`); toast('Deleted'); load(); } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <main className="container wide wl-page">
      <div className="page-head">
        <div><h1>Knowledge Base</h1><div className="sub">Reference documents (PDF){docs ? ` · ${docs.length}` : ''}</div></div>
        {canWrite ? (
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => inputRef.current && inputRef.current.click()}>
              <UploadIcon /> Upload PDF
            </button>
          </div>
        ) : null}
      </div>

      {canWrite ? (
        <>
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => pick(e.target.files)} />
          <div
            className={`dropzone${over ? ' over' : ''}${busy ? ' busy' : ''}`}
            role="button"
            tabIndex={0}
            aria-label="Drop a PDF here or press Enter to browse"
            onClick={() => !busy && inputRef.current && inputRef.current.click()}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); inputRef.current && inputRef.current.click(); } }}
            {...zone}
          >
            <UploadIcon />
            <div>
              <strong>{busy ? 'Uploading…' : over ? 'Drop to upload' : 'Drag & drop a PDF here'}</strong>
              <div className="muted">{busy ? 'Please wait' : `or click to browse · one PDF at a time, up to ${meta.maxMb} MB · you will name it next`}</div>
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
                    </td>
                    <td className="dim">{size(d.size_bytes)}</td>
                    <td className="dim">{d.uploaded_name || '—'}</td>
                    <td className="dim">{fmtDateTime(d.created_at)}</td>
                    <td className="doc-actions">
                      <a className="iconbtn" title="Download" aria-label={`Download ${d.title}`} href={`/api/knowledge/${d.id}/file?download=1`}><DownloadIcon /></a>
                      {canWrite ? (
                        <>
                          <button type="button" className="iconbtn" title="Rename" aria-label={`Rename ${d.title}`} onClick={() => setEdit({ id: d.id, title: d.title })}><PencilIcon /></button>
                          <button type="button" className="iconbtn" title="Delete" aria-label={`Delete ${d.title}`} onClick={() => remove(d)}><TrashIcon /></button>
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
          title="Add document"
          size="sm"
          onClose={() => { if (!busy) setDraft(null); }}
          footer={(
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
              <button type="button" className="btn primary" disabled={busy || !draft.title.trim()} onClick={upload}>{busy ? 'Uploading…' : 'Upload'}</button>
            </>
          )}
        >
          <label className="f">
            <span>Document name <span className="req">*</span></span>
            <input
              autoFocus
              value={draft.title}
              maxLength={200}
              placeholder="e.g. Promo ingest guidelines"
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); upload(); } }}
            />
          </label>
          <div className="dim mt-12">File: {draft.file.name} · {size(draft.file.size)}</div>
        </Modal>
      ) : null}

      {edit ? (
        <Modal
          title="Rename document"
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
                  try { await put(`/api/knowledge/${edit.id}`, { title: edit.title }); setEdit(null); toast('Renamed'); load(); } catch (e) { toast(e.message, 'err'); }
                }}
              >Save</button>
            </>
          )}
        >
          <label className="f">
            <span>Title</span>
            <input value={edit.title} maxLength={200} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          </label>
        </Modal>
      ) : null}
    </main>
  );
}
