import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { del, post } from '../lib/api.js';
import { isoDate } from '../lib/util.js';
import { useConfirm, useToast } from './ui.jsx';

// PSD Daily Plug List — Excel mode. An editable grid that works like the Workload Tracker's Excel mode: click a cell and type, drag to select a
// range, click a row number / column heading to select whole rows / columns, copy / cut / paste with Excel, Delete clears, Ctrl+Z / Ctrl+Y undo
// and redo, Add Row puts a new row on top, and nothing is saved until "Save changes" (one all-or-nothing request to /api/plugs/batch).
const COLS = ['plug_date', 'plug_id', 'prog_name', 'psd', 'account_by'];
const HEAD = { plug_date: 'DATE', plug_id: 'PLUG ID', prog_name: 'PROG. NAME / PROJ. TITLE', psd: 'PSD', account_by: 'ACCOUNT BY' };
const MAXLEN = { plug_date: 10, plug_id: 200, prog_name: 300, psd: 200, account_by: 100 };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
let keySeq = 0;
const newKey = () => `n${Date.now()}-${keySeq++}`;

// "2026-10-12", "10/12/2026", "10/12/26", "Oct 12 2026" → 2026-10-12 (anything else is left as typed and rejected on Save)
export function normDate(text) {
  const t = String(text ?? '').trim();
  if (!t || ISO.test(t)) return t;
  const pad = (n) => String(n).padStart(2, '0');
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return `${y}-${pad(m[1])}-${pad(m[2])}`; }
  if (/[a-z]/i.test(t)) { const d = new Date(`${t} UTC`); if (!Number.isNaN(d.getTime())) return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
  return t;
}

// Tab-separated text in / out, with Excel's quoting for cells that contain tabs, line breaks or quotes
function parseTsv(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  const out = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === '\t') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
}
const tsvCell = (x) => (/[\t\n"]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);

const fromServer = (r) => ({ _key: `s${r.id}`, id: r.id, plug_date: r.plug_date, plug_id: r.plug_id || '', prog_name: r.prog_name || '', psd: r.psd || '', account_by: r.account_by || '' });
const isEmptyRow = (r) => COLS.every((k) => k === 'plug_date' || !String(r[k] ?? '').trim());

function GridMenu({ x, y, children, ...rest }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.maxHeight = `${window.innerHeight - 16}px`;
    el.style.overflowY = 'auto';
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  }, [x, y]);
  return <div ref={ref} className="xl-menu" style={{ left: x, top: y }} {...rest}>{children}</div>;
}

/**
 * source: the rows the Table view would show ({ rows, total }); every time it is replaced (a reload, another day…) the grid starts again from it.
 * Reports the number of unsaved rows through onDirty so the page can ask before leaving. toolbar(node) lets the page place Add Row / Save in its own bar.
 */
export default function PlugGrid({ source, canWrite, defaultDate, limit, onDirty, onSaved, registerToolbar }) {
  const toast = useToast();
  const confirm = useConfirm();
  const boxRef = useRef(null);
  const drag = useRef(null);
  const moveRef = useRef(null);
  const hist = useRef({ past: [], future: [], tag: null });
  const internalClip = useRef(null);
  const pasteSeen = useRef(false);
  const [rows, setRows] = useState([]);
  const [sel, setSel] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [epoch, setEpoch] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRows((source.rows || []).map(fromServer));
    setSel(null); setCtx(null); setEpoch((e) => e + 1);
    hist.current = { past: [], future: [], tag: null };
  }, [source]);

  const dirtyCount = rows.filter((r) => r._dirty).length;
  useEffect(() => { if (onDirty) onDirty(dirtyCount); }, [dirtyCount]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (onDirty) onDirty(0); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirtyCount) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyCount]);

  // ---- undo / redo ----
  const pushHistory = (tag) => {
    const h = hist.current;
    if (tag && h.tag === tag) return;
    h.tag = tag || null;
    h.past.push(rows);
    if (h.past.length > 100) h.past.shift();
    h.future = [];
  };
  const restore = (next) => { hist.current.tag = null; setRows(next); setEpoch((v) => v + 1); setSel((s) => (s && s.r0 < next.length && s.r1 < next.length ? s : null)); };
  const undo = () => { const h = hist.current; if (!h.past.length) return; h.future.push(rows); restore(h.past.pop()); };
  const redo = () => { const h = hist.current; if (!h.future.length) return; h.past.push(rows); restore(h.future.pop()); };

  // ---- selection ----
  const norm = sel ? { rLo: Math.min(sel.r0, sel.r1), rHi: Math.max(sel.r0, sel.r1), cLo: Math.min(sel.c0, sel.c1), cHi: Math.max(sel.c0, sel.c1) } : null;
  const nR = rows.length;
  const nC = COLS.length;
  const isText = (el) => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  const focusBox = () => { if (boxRef.current) boxRef.current.focus({ preventScroll: true }); try { window.getSelection().removeAllRanges(); } catch (e) { /* nothing */ } };
  const startSel = (kind, r, c, e) => {
    if (!nR) return;
    if (e.button === 2) {
      const n = norm;
      const inside = !!n && (kind === 'all' || (kind === 'row' ? r >= n.rLo && r <= n.rHi : kind === 'col' ? c >= n.cLo && c <= n.cHi : r >= n.rLo && r <= n.rHi && c >= n.cLo && c <= n.cHi));
      if (!inside) setSel(kind === 'row' ? { r0: r, c0: 0, r1: r, c1: nC - 1 } : kind === 'col' ? { r0: 0, c0: c, r1: nR - 1, c1: c } : kind === 'all' ? { r0: 0, c0: 0, r1: nR - 1, c1: nC - 1 } : { r0: r, c0: c, r1: r, c1: c });
      drag.current = null; e.preventDefault(); focusBox();
      return;
    }
    drag.current = kind;
    const ext = e.shiftKey && sel;
    let next;
    if (kind === 'row') next = ext ? { r0: sel.r0, c0: 0, r1: r, c1: nC - 1 } : { r0: r, c0: 0, r1: r, c1: nC - 1 };
    else if (kind === 'col') next = ext ? { r0: 0, c0: sel.c0, r1: nR - 1, c1: c } : { r0: 0, c0: c, r1: nR - 1, c1: c };
    else if (kind === 'all') { next = { r0: 0, c0: 0, r1: nR - 1, c1: nC - 1 }; drag.current = null; } else next = ext ? { ...sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c };
    setSel(next);
    if (kind !== 'cell' || next.r0 !== next.r1 || next.c0 !== next.c1) { e.preventDefault(); focusBox(); }
  };
  moveRef.current = (e) => {
    const kind = drag.current;
    if (!kind) return;
    if (!(e.buttons & 1)) { drag.current = null; return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !el.closest || !sel) return;
    let next = null;
    if (kind === 'row') { const tr = el.closest('tr[data-ri]'); if (tr) next = { ...sel, r1: +tr.dataset.ri, c0: 0, c1: nC - 1 }; } else {
      const hit = el.closest('[data-c]');
      if (!hit) return;
      if (kind === 'col') next = { ...sel, r0: 0, r1: nR - 1, c1: +hit.dataset.c };
      else if (hit.dataset.r !== undefined) next = { ...sel, r1: +hit.dataset.r, c1: +hit.dataset.c };
    }
    if (!next || (next.r0 === sel.r0 && next.c0 === sel.c0 && next.r1 === sel.r1 && next.c1 === sel.c1)) return;
    setSel(next);
    if (next.r0 !== next.r1 || next.c0 !== next.c1) focusBox();
  };
  useEffect(() => {
    const move = (e) => moveRef.current && moveRef.current(e);
    const up = () => { drag.current = null; };
    const down = (e) => {   // a click outside the grid (and outside its menu / toolbar buttons) drops the selection
      if (e.target.closest && e.target.closest('.xl-box, .xl-menu, [data-keep-sel]')) return;
      setSel(null); setCtx(null);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); window.addEventListener('mousedown', down);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.removeEventListener('mousedown', down); };
  }, []);
  useEffect(() => {
    if (!ctx) return undefined;
    const close = () => setCtx(null);
    const key = (e) => { if (e.key === 'Escape') setCtx(null); };
    window.addEventListener('scroll', close, true); window.addEventListener('resize', close); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); window.removeEventListener('keydown', key); };
  }, [ctx]);
  const cellMouseDown = (ri, ci) => (e) => {
    startSel('cell', ri, ci, e);
    if (e.button === 2 || e.shiftKey || isText(e.target)) return;
    e.preventDefault();
    const f = e.currentTarget.querySelector('input');
    if (f) { f.focus(); try { const n = f.value.length; f.setSelectionRange(n, n); } catch (err) { /* not text */ } }
  };
  const selClass = (r, c) => {
    const n = norm;
    if (!n || r < n.rLo || r > n.rHi || c < n.cLo || c > n.cHi) return '';
    const single = n.rLo === n.rHi && n.cLo === n.cHi;
    return `xl-sel${single ? ' xl-single' : ''}${sel && r === sel.r0 && c === sel.c0 ? ' xl-active' : ''}${r === n.rLo ? ' xl-t' : ''}${r === n.rHi ? ' xl-b' : ''}${c === n.cLo ? ' xl-l' : ''}${c === n.cHi ? ' xl-r' : ''}`;
  };
  const rowInSel = (r) => !!norm && r >= norm.rLo && r <= norm.rHi;
  const colInSel = (c) => !!norm && c >= norm.cLo && c <= norm.cHi;
  const wholeRows = !!norm && norm.cLo === 0 && norm.cHi === nC - 1;

  // ---- editing ----
  const setCell = (key, k, val) => {
    if (!canWrite) return;
    pushHistory(`${key}:${k}`);
    setRows((rs) => rs.map((r) => (r._key === key ? { ...r, [k]: val, _dirty: true } : r)));
  };
  const clearSel = () => {
    if (!norm || !canWrite) return;
    pushHistory(null); setEpoch((v) => v + 1);
    setRows((rs) => rs.map((r, ri) => {
      if (ri < norm.rLo || ri > norm.rHi) return r;
      const c = { ...r };
      for (let ci = norm.cLo; ci <= norm.cHi; ci++) c[COLS[ci]] = '';
      return { ...c, _dirty: true };
    }));
  };
  const addRow = () => {
    pushHistory(null);
    setRows((rs) => [{ _key: newKey(), _new: true, _dirty: false, plug_date: (rs.length && rs[0].plug_date) || defaultDate || isoDate(), plug_id: '', prog_name: '', psd: '', account_by: '' }, ...rs]);
    setSel({ r0: 0, c0: 0, r1: 0, c1: 0 });
    requestAnimationFrame(() => {
      const box = boxRef.current;
      if (!box) return;
      box.scrollTop = 0;
      const f = box.querySelector('tbody tr:first-child td[data-c="1"] input');
      if (f) f.focus({ preventScroll: true });
    });
  };
  const deleteRows = async () => {
    setCtx(null);
    if (!norm || !canWrite) return;
    const target = rows.slice(norm.rLo, norm.rHi + 1);
    const saved = target.filter((r) => !r._new);
    if (saved.length && !(await confirm(`Delete ${saved.length} plug${saved.length === 1 ? '' : 's'}`, `Permanently delete ${saved.length === 1 ? `"${saved[0].plug_id}"` : `these ${saved.length} plugs`} from the plug list? This cannot be undone.`, { okText: 'Delete', danger: true }))) return;
    const gone = new Set(target.filter((r) => r._new).map((r) => r._key));
    let failure = null;
    for (const r of saved) {
      try { await del(`/api/plugs/${r.id}`); gone.add(r._key); } catch (e) { failure = e; break; }
    }
    setRows((rs) => rs.filter((r) => !gone.has(r._key)));
    hist.current = { past: [], future: [], tag: null };
    setSel(null);
    if (failure) toast(failure.message, 'err'); else toast(`Deleted ${target.length} row${target.length === 1 ? '' : 's'}`);
    if (saved.some((r) => gone.has(r._key)) && onSaved) onSaved({ keepRows: true });
  };

  // ---- copy / cut / paste ----
  const tsvOf = () => {
    if (!norm) return '';
    return rows.slice(norm.rLo, norm.rHi + 1).map((r) => COLS.slice(norm.cLo, norm.cHi + 1).map((k) => tsvCell(String(r[k] ?? ''))).join('\t')).join('\n');
  };
  const copyOut = (cut) => {
    if (!norm) return;
    const text = tsvOf();
    internalClip.current = text;
    try { if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) navigator.clipboard.writeText(text); } catch (e) { /* the event path below covers it */ }
    if (cut) clearSel();
  };
  const gridCopy = (cut) => (e) => {
    if (isText(e.target) && !(norm && (norm.rLo !== norm.rHi || norm.cLo !== norm.cHi))) return;   // plain text copy inside one cell
    if (!norm) return;
    e.preventDefault();
    const text = tsvOf();
    internalClip.current = text;
    e.clipboardData.setData('text/plain', text);
    if (cut && canWrite) clearSel();
  };
  const applyPaste = (rawText) => {
    if (!canWrite) return true;
    const block = parseTsv(rawText);
    if (!block.length) return true;
    const multi = !!norm && (norm.rLo !== norm.rHi || norm.cLo !== norm.cHi);
    const single = block.length === 1 && block[0].length === 1;
    if (single && !multi && isText(document.activeElement) && boxRef.current && boxRef.current.contains(document.activeElement)) return false;   // let the browser type it into the cell
    const r0 = norm ? norm.rLo : 0;
    const c0 = norm ? norm.cLo : 0;
    const bR = block.length;
    const bC = Math.max(...block.map((r) => r.length));
    const selR = norm ? norm.rHi - norm.rLo + 1 : 0;
    const selC = norm ? norm.cHi - norm.cLo + 1 : 0;
    const tileR = multi && selR > bR && selR % bR === 0 ? selR : bR;
    const tileC = multi && selC > bC && selC % bC === 0 ? selC : bC;
    pushHistory(null); setEpoch((v) => v + 1);
    setRows((rs) => {
      let next = rs;
      if (r0 + tileR > next.length) next = [...next, ...Array.from({ length: r0 + tileR - next.length }, () => ({ _key: newKey(), _new: true, plug_date: (rs[rs.length - 1] && rs[rs.length - 1].plug_date) || defaultDate || isoDate(), plug_id: '', prog_name: '', psd: '', account_by: '' }))];
      return next.map((row, ri) => {
        const bi = ri - r0;
        if (bi < 0 || bi >= tileR) return row;
        const c = { ...row };
        for (let ci = 0; ci < tileC; ci++) {
          const k = COLS[c0 + ci];
          if (!k) break;
          const raw = (block[bi % bR][ci % bC]) ?? '';
          c[k] = k === 'plug_date' ? normDate(raw) : raw.replace(/\s*\n\s*/g, ' ').trim();
        }
        return { ...c, _dirty: true };
      });
    });
    setSel({ r0, c0, r1: r0 + tileR - 1, c1: Math.min(c0 + tileC - 1, nC - 1) });
    focusBox();
    return true;
  };
  const gridPaste = (e) => {
    pasteSeen.current = true;
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!text) return;
    if (applyPaste(text)) e.preventDefault();
  };
  const menuPaste = async () => {
    setCtx(null);
    let text = null;
    try { if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) text = await navigator.clipboard.readText(); } catch (e) { text = null; }
    if (!text) text = internalClip.current;
    if (!text) { toast('Nothing to paste yet — copy something first', 'err'); return; }
    applyPaste(text);
  };

  const gridKey = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (mod && !e.altKey && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {   // Enter moves to the cell below (Shift+Enter: above)
      const td = e.target.closest('td[data-r]');
      if (td) {
        e.preventDefault();
        const nx = boxRef.current && boxRef.current.querySelector(`td[data-r="${Number(td.dataset.r) + (e.shiftKey ? -1 : 1)}"][data-c="${td.dataset.c}"] input`);
        if (nx) { nx.focus(); try { const len = nx.value.length; nx.setSelectionRange(len, len); } catch (err) { /* nothing */ } }
      }
      return;
    }
    if (mod && !e.altKey && !isText(e.target) && sel) {
      const key = e.key.toLowerCase();
      if (key === 'c' || (key === 'x' && canWrite)) { e.preventDefault(); copyOut(key === 'x'); return; }
      if (key === 'v' && canWrite) { pasteSeen.current = false; setTimeout(() => { if (!pasteSeen.current) menuPaste(); }, 150); return; }
    }
    if (isText(e.target)) return;
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); if (nR) setSel({ r0: 0, c0: 0, r1: nR - 1, c1: nC - 1 }); } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); clearSel(); } else if (e.key === 'Escape') setSel(null);
  };

  // ---- save ----
  const save = useCallback(async () => {
    const idx = [];
    const out = [];
    rows.forEach((r, i) => {
      if (!r._dirty || (r._new && isEmptyRow(r))) return;
      const date = normDate(r.plug_date);
      idx.push(i);
      out.push({ id: r.id, plug_date: date, plug_id: r.plug_id, prog_name: r.prog_name, psd: r.psd, account_by: r.account_by });
    });
    if (!out.length) { toast('Nothing to save'); return; }
    setSaving(true);
    try {
      const res = await post('/api/plugs/batch', { rows: out });
      const c = res.copied;
      toast(`Saved — ${res.added} added, ${res.updated} updated${c && c.created ? ` · ${c.created} copied to the Workload Tracker` : ''}`);
      if (onSaved) onSaved({ dates: out.map((x) => x.plug_date) });
    } catch (e) {
      toast(String(e.message).replace(/^Row (\d+):/, (_, n) => `Grid row ${idx[+n - 1] + 1}:`), 'err');
    } finally { setSaving(false); }
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // the page's own button bar shows Add Row / Save changes
  useEffect(() => {
    if (registerToolbar) registerToolbar({ addRow, save, saving, dirtyCount, selCount: norm ? norm.rHi - norm.rLo + 1 : 0, wholeRows, deleteRows });
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (registerToolbar) registerToolbar(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="table-wrap xl-box wl-fit" id="grid" ref={boxRef} tabIndex={-1} onCopy={gridCopy(false)} onCut={gridCopy(true)} onPaste={gridPaste} onKeyDown={gridKey}
        onContextMenu={(e) => { if (!sel || !rows.length) return; e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }); }}>
        <table className="t xl plug-xl">
          <thead>
            <tr>
              <th className="rn" title="Select all" onMouseDown={(e) => startSel('all', 0, 0, e)} />
              {COLS.map((k, ci) => (
                <th key={k} className={`xl-colhead${colInSel(ci) ? ' hl' : ''}`} title="Click to select the column" data-c={ci} onMouseDown={(e) => startSel('col', 0, ci, e)}>{HEAD[k]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((r, ri) => (
              <tr key={r._key} data-ri={ri} className={r._dirty ? 'dirty' : ''}>
                <td className={`rn${rowInSel(ri) ? ' hl' : ''}`} title="Click to select the whole row (Ctrl+C to copy)" onMouseDown={(e) => startSel('row', ri, 0, e)}>{ri + 1}</td>
                {COLS.map((k, ci) => (
                  <td key={k} data-k={k} data-r={ri} data-c={ci} onMouseDown={cellMouseDown(ri, ci)} onBlur={() => { hist.current.tag = null; if (k === 'plug_date' && r.plug_date !== normDate(r.plug_date)) setCell(r._key, k, normDate(r.plug_date)); }}
                    onFocus={(e) => { if (isText(e.target)) setSel((s) => (s && s.r0 === ri && s.r1 === ri && s.c0 === ci && s.c1 === ci ? s : { r0: ri, c0: ci, r1: ri, c1: ci })); }}
                    className={selClass(ri, ci)}>
                    <div className="xl-cell" data-value={`${r[k] ?? ''}​`}>
                      <input maxLength={MAXLEN[k]} value={r[k] ?? ''} disabled={!canWrite} placeholder={k === 'plug_date' ? 'YYYY-MM-DD' : undefined} onChange={(e) => setCell(r._key, k, e.target.value)} />
                    </div>
                  </td>
                ))}
              </tr>
            )) : <tr><td colSpan={COLS.length + 1} className="empty xl-empty"><div className="xl-empty-msg">{canWrite ? 'No plugs in this view. Use “Add Row” to start.' : 'No plugs in this view.'}</div></td></tr>}
          </tbody>
        </table>
      </div>
      {ctx ? (
        <GridMenu x={ctx.x} y={ctx.y} onMouseDown={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()}>
          <button type="button" disabled={!canWrite || !hist.current.past.length} onClick={() => { setCtx(null); undo(); }}>Undo<span>Ctrl+Z</span></button>
          <button type="button" disabled={!canWrite || !hist.current.future.length} onClick={() => { setCtx(null); redo(); }}>Redo<span>Ctrl+Y</span></button>
          <hr />
          <button type="button" disabled={!canWrite} onClick={() => { setCtx(null); copyOut(true); }}>Cut<span>Ctrl+X</span></button>
          <button type="button" onClick={() => { setCtx(null); copyOut(false); }}>Copy<span>Ctrl+C</span></button>
          <button type="button" disabled={!canWrite} onClick={menuPaste}>Paste<span>Ctrl+V</span></button>
          <hr />
          <button type="button" disabled={!canWrite} onClick={() => { setCtx(null); clearSel(); }}>Delete<span>Del</span></button>
          {wholeRows ? <button type="button" disabled={!canWrite} onClick={deleteRows}>Delete row{norm.rHi > norm.rLo ? 's' : ''}</button> : null}
        </GridMenu>
      ) : null}
      {source.total > limit ? <div className="pager"><span>Showing {rows.filter((r) => !r._new).length} of {source.total} plugs — use the pager below or narrow the View to edit the rest.</span></div> : null}
    </>
  );
}

