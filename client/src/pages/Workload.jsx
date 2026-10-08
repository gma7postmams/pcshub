import { cloneElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, patch, post, put } from '../lib/api.js';
import { fmtBreakdate, fmtDate, isoDate } from '../lib/util.js';
import { useSession } from '../context.jsx';
import { ColumnIcon, DownloadIcon, LockIcon, PlusIcon, SearchIcon, UploadIcon } from '../components/Icons.jsx';
import { DateChip, DateRange, FilterSelect, PlatformCell, Pager, RowMenu, SortTh, TypePill, UnitsPills, WorkDate } from '../components/wl.jsx';
import { Empty, Modal, Options, useConfirm, useDebounced, useForm, useToast } from '../components/ui.jsx';
import PresenceAvatars from '../components/PresenceAvatars.jsx';

// Workload Tracker — ONE table. "Units Concerned" says which team(s) a plug is for; the tabs
// (All / VGFX / VEDIT / Audio) are filters over it. Fields, per-tab columns and the Platform rules come
// from /api/workload/meta (field types follow the red notes in the Sept 2026 template:
// dropdown / Date / Open). Table mode = read + add/edit form; Excel mode = editable grid with batch save.
const PAGE = 50;
const GRID_LIMIT = 200;
const CARDS_BELOW = 900;   // window width under which table rows become cards
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isLocked = (workDate, locks) => !!workDate && (locks || []).some((l) => workDate >= l.from_date && workDate <= l.to_date);
const lockNote = (workDate, locks) => { const hit = (locks || []).find((l) => workDate >= l.from_date && workDate <= l.to_date); return hit ? (hit.note || `${hit.from_date} – ${hit.to_date}`) : ''; };
const withCurrent = (list, v) => (v && !list.includes(v) ? [...list, v] : list);
const firstLine = (s) => String(s || '').split('\n')[0];
// Breakdate / Time text -> the 'YYYY-MM-DDTHH:MM' the grid cell stores. Accepts what the web table and the Excel export show
// ('Sep 28, 2026 4:00 PM', 'Sep 28, 2026', or day-first '28 Sep 2026 4:00 PM' from other locales) as well as ISO.
// Returns null if it isn't a date/time.
const MON3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function toBreakdateIso(t) {
  const s = String(t || '').trim();
  const pad = (n) => String(n).padStart(2, '0');
  const clock = (hh, mm, ap) => { let h = hh ? Number(hh) % 12 : 0; if (ap && ap.toUpperCase() === 'PM') h += 12; return `${pad(h)}:${mm || '00'}`; };
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s);
  if (iso) return `${iso[1]}T${iso[2] || '00:00'}`;
  let m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?$/i.exec(s);
  if (m) { const mon = MON3.indexOf(m[1].toLowerCase()); return mon < 0 ? null : `${m[3]}-${pad(mon + 1)}-${pad(Number(m[2]))}T${clock(m[4], m[5], m[6])}`; }
  m = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?$/i.exec(s);
  if (m) { const mon = MON3.indexOf(m[2].toLowerCase()); return mon < 0 ? null : `${m[3]}-${pad(mon + 1)}-${pad(Number(m[1]))}T${clock(m[4], m[5], m[6])}`; }
  return null;
}
// Both teams' times in one pasted cell ('VGFX  Sep 28, 2026 4:00 PM' / 'VEDIT  Sep 28, 2026 10:00 PM', on separate lines, with
// the label on its own line, or run together as copied from the web table's pills) -> { breakdate_vgfx, breakdate_vedit }
// The Sept 2026 template writes times as "VGFX: Sep 1, 10am" / "VEDIT: SEP 3, 12nn" — no year, no minutes. Such lines are rewritten to the full form this app
// reads ("VGFX  Sep 1, 2026 10:00 AM") before parsing, so a Breakdate column pasted from the template is no longer silently dropped. Other text is left alone.
const BD_LOOSE = /^(VGFX|VEDIT)\b\s*[:\-\u2013]?\s*([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:\s*,\s*|\s+)?(\d{4})?(?:\s*,?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|nn|mn)\b)?/i;
function normBreakdate(raw, defaultYear) {
  return String(raw ?? '').split('\n').map((line) => {
    const m = BD_LOOSE.exec(line.trim());
    if (!m) return line;
    const mon = MON3.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mon < 0 || +m[3] < 1 || +m[3] > 31) return line;
    let time = '';
    if (m[7]) {
      let h = m[5] ? +m[5] : 12;
      let ap = m[7].toLowerCase();
      if (ap === 'nn') { h = 12; ap = 'pm'; } else if (ap === 'mn') { h = 12; ap = 'am'; }
      if (h < 1 || h > 12) return line;
      time = ` ${h}:${m[6] || '00'} ${ap.toUpperCase()}`;
    }
    return `${m[1].toUpperCase()}  ${MON3[mon][0].toUpperCase()}${MON3[mon].slice(1)} ${+m[3]}, ${m[4] || defaultYear}${time}${line.trim().slice(m[0].length)}`;
  }).join('\n');
}
const BD_DATE = '(?:[A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4}(?:\\s+\\d{1,2}:\\d{2}\\s*(?:AM|PM))?|\\d{1,2}\\s+[A-Za-z]{3,9}\\.?,?\\s+\\d{4}(?:\\s+\\d{1,2}:\\d{2}\\s*(?:AM|PM)?)?|\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2})?)';
const BD_PAIR = new RegExp(`(VGFX|VEDIT)\\s*[:\\-\\u2013]?\\s*(${BD_DATE})`, 'gi');
function parseBreakdatePairs(raw) {
  const out = {};
  for (const m of String(raw || '').matchAll(BD_PAIR)) {
    const iso = toBreakdateIso(m[2]);
    if (iso) out[m[1].toUpperCase() === 'VGFX' ? 'breakdate_vgfx' : 'breakdate_vedit'] = iso;
  }
  return out;
}
// ---- Excel mode: ONE Breakdate / Time cell for both teams (like Table mode) ----
// The row still stores two times (breakdate_vgfx / breakdate_vedit); the grid cell shows them as labelled lines
//   VGFX  Sep 28, 2026 4:00 PM
//   VEDIT  Sep 28, 2026 10:00 PM
// and reads whatever is typed / pasted back into the two times. 'breakdate_vgfx' is the column's key.
const BD_TEAMS = ['VGFX', 'VEDIT'];
const bdField = (t) => (t === 'VGFX' ? 'breakdate_vgfx' : 'breakdate_vedit');
const MONTH3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtBdText(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v || '');
  if (!m) return String(v || '');
  const date = `${MONTH3[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  if (m[4] === '00' && m[5] === '00') return date;
  const h = +m[4];
  return `${date} ${h % 12 || 12}:${m[5]} ${h >= 12 ? 'PM' : 'AM'}`;
}
const bdTeams = (unitTeams, units) => { const t = ((unitTeams || {})[units] || []).filter((x) => x === 'VGFX' || x === 'VEDIT'); return t.length ? t : BD_TEAMS; };
const bdText = (row, unitTeams) => bdTeams(unitTeams, row.units_concerned).filter((t) => row[bdField(t)]).map((t) => `${t}  ${fmtBdText(row[bdField(t)])}`).join('\n');
/** Text typed / pasted into the cell -> the fields to change on the row. `replace` (paste / clear) treats the text as the whole
    new content; otherwise (typing) a line that is only half written leaves that team's time as it was. */
function bdApply(row, text, unitTeams, replace) {
  const teams = bdTeams(unitTeams, row.units_concerned);
  const raw = normBreakdate(text, /^\d{4}/.test(row.work_date || '') ? row.work_date.slice(0, 4) : new Date().getFullYear());
  const patch = {};
  if (!raw.trim()) { teams.forEach((t) => { patch[bdField(t)] = ''; }); return patch; }
  const upper = raw.toUpperCase();
  if (!BD_TEAMS.some((t) => upper.includes(t))) {
    // no VGFX / VEDIT label: one date goes to the row's only team (else VGFX); two dates go VGFX then VEDIT
    const isos = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(toBreakdateIso);
    if (isos.length === 1 && isos[0]) patch[bdField(teams.length === 1 ? teams[0] : 'VGFX')] = isos[0];
    else if (isos.length > 1 && isos.every(Boolean)) isos.slice(0, teams.length).forEach((iso, i) => { patch[bdField(teams[i])] = iso; });
    return patch;
  }
  const pairs = parseBreakdatePairs(raw);
  if (replace && !Object.keys(pairs).length) return patch;   // pasted something that isn't a time: leave the cell alone
  BD_TEAMS.forEach((t) => {
    const key = bdField(t);
    if (pairs[key]) patch[key] = pairs[key];
    else if (teams.includes(t) && (replace || !upper.includes(t))) patch[key] = '';   // that team's line was removed
  });
  return patch;
}
const BD_DEF = { multiline: true, max: 300, hint: 'VGFX  Sep 28, 2026 4:00 PM' };
/** The merged Breakdate / Time grid cell. While it is being edited it shows exactly what was typed; when it loses focus (or a paste /
    undo changes it) it shows the times as the row now holds them. */
function BreakdateCellInput({ text, onText, disabled, epoch, ...rest }) {
  const [draft, setDraft] = useState(null);
  useEffect(() => { setDraft(null); }, [epoch]);
  return (
    <GridCellInput def={BD_DEF} value={draft ?? text} disabled={disabled} onBlur={() => setDraft(null)}
      onChange={(e) => { setDraft(e.target.value); onText(e.target.value); }} {...rest} />
  );
}
/** Put text on the clipboard. Uses the async API where the page allows it (https / localhost), else a hidden textarea + copy command. */
async function writeClipboard(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* fall through to the older way */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  const prev = document.activeElement;
  ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  if (prev && prev.focus) prev.focus({ preventScroll: true });
  return ok;
}
const newKey = () => `n${Math.random().toString(36).slice(2)}`;

/** Platform suggested by the Plug ID prefix (same rules as the template's Platform formula). null = none. */
// PSD and PROG. NAME / PROJ. TITLE come from the PSD Daily Plug List: when the Plug ID matches a plug on that Work Date's list, fill them in
// if they are blank, or still hold what the previous Plug ID's entry had put there (so changing the Plug ID updates them, typed values stay).
function fillFromPlug(row, prevRow, find) {
  const plug = find(row.work_date, row.plug_id);
  if (!plug) return row;
  const old = prevRow ? find(prevRow.work_date, prevRow.plug_id) : null;
  // _autoPsd / _autoProg remember what was filled in, so it can be replaced when the Plug ID changes while anything typed by hand is kept
  const replaceable = (cur, auto, oldVal) => !cur || cur === auto || (!!old && cur === oldVal);
  const next = { ...row };
  if (replaceable(row.psd, row._autoPsd, old && old.psd)) { next.psd = plug.psd; next._autoPsd = plug.psd; }
  if (replaceable(row.prog_name, row._autoProg, old && old.prog_name)) { next.prog_name = plug.prog_name; next._autoProg = plug.prog_name; }
  return next;
}
function derivePlatform(rules, plug) {
  const text = String(plug || '');
  for (const r of rules) if (new RegExp(r.pattern, 'i').test(text)) return r.platform;
  return null;
}
/** Changing the Plug ID re-fills Platform only if it was empty or still holds the previous automatic value. */
function withAutoPlatform(rules, row, k, val) {
  const next = { ...row, [k]: val };
  if (k !== 'plug_id') return next;
  const before = derivePlatform(rules, row.plug_id);
  if (!row.platform || row.platform === before) next.platform = derivePlatform(rules, val) || '';
  return next;
}

// Audio Guide: dropdown "N/A" or "Date" (then pick the date). Stored as 'N/A' or YYYY-MM-DD.
// On the All tab, filtering Units to ONE kind of work shows that team's columns: Audio only -> the Audio columns (Length, Others, Status ...), VGFX / VEDIT only
// -> the main columns (without the Audio-only ones); a mix, or no filter -> everything.
function viewForUnits(meta, units) {
  const teams = units ? meta.unitTeams[units] : null;
  if (!teams) return 'ALL';
  if (teams.length === 1 && teams[0] === 'AUDIO') return 'AUDIO';
  if (!teams.includes('AUDIO')) return 'VGFX';
  return 'ALL';
}
function AudioGuideInput({ value, onChange, disabled }) {
  const v = value || '';
  const isDate = ISO.test(v);
  const isText = !!v && !isDate && v !== 'N/A';
  const [textMode, setTextMode] = useState(isText);   // "Text" stays chosen while the box is still empty
  useEffect(() => { if (v) setTextMode(isText); }, [v, isText]);
  const mode = isDate ? 'DATE' : (textMode || isText) ? 'TEXT' : v;
  const emit = (x) => onChange({ target: { value: x } });
  const pick = (m) => {
    setTextMode(m === 'TEXT');
    emit(m === 'DATE' ? isoDate() : m === 'TEXT' ? (isText ? v : '') : m);
  };
  return (
    <div className="ag">
      <select value={mode} disabled={disabled} aria-label="Audio Guide: N/A, date or text" onChange={(e) => pick(e.target.value)}>
        <option value="">—</option>
        <option value="N/A">N/A</option>
        <option value="DATE">Date</option>
        <option value="TEXT">Text</option>
      </select>
      {isDate ? <input type="date" value={v} disabled={disabled} onChange={(e) => emit(e.target.value)} /> : null}
      {mode === 'TEXT' ? <input type="text" maxLength={200} value={isText ? v : ''} disabled={disabled} onChange={(e) => emit(e.target.value)} /> : null}
    </div>
  );
}

// Artwork / STB: either a DATE (date picker) or plain TEXT (open text box) — pick which with the little dropdown. Stored as one value:
// 'YYYY-MM-DD' for a date, anything else for text. Switching the kind clears the box, since the two don't convert into each other.
function DateOrTextInput({ value, onChange, disabled, max, label = 'Artwork / STB' }) {
  const v = value || '';
  const [mode, setMode] = useState(!v || ISO.test(v) ? 'date' : 'text');   // an empty one starts as a date, like the column always did
  useEffect(() => { if (v) setMode(ISO.test(v) ? 'date' : 'text'); }, [v]);   // follows the value (e.g. a full date typed as text becomes a date)
  const emit = (x) => onChange({ target: { value: x } });
  return (
    <div className="ag">
      <select value={mode} disabled={disabled} aria-label={`${label}: date or text`} onChange={(e) => { setMode(e.target.value); emit(''); }}>
        <option value="date">Date</option>
        <option value="text">Text</option>
      </select>
      {mode === 'date'
        ? <input type="date" value={ISO.test(v) ? v : ''} disabled={disabled} onChange={(e) => emit(e.target.value)} />
        : <input type="text" maxLength={max || 200} value={v} disabled={disabled} onChange={(e) => emit(e.target.value)} />}
    </div>
  );
}

// Textarea that grows to fit its content (used in the Excel grid so pasted text is never cut off)
function AutoTextarea({ value, ...props }) {
  const ref = useRef(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight + 2, 32)}px`;
  }, []);
  useLayoutEffect(fit, [fit, value]);
  useEffect(() => { window.addEventListener('resize', fit); return () => window.removeEventListener('resize', fit); }, [fit]);
  return <textarea ref={ref} value={value} {...props} />;
}

function FieldInput({ def, value, onChange, disabled, lookups, auto }) {
  const v = value ?? '';
  // date and time picked together (the browser's own calendar + time picker); 15-minute steps
  if (def.kind === 'datetime') return <input type="datetime-local" step={900} value={v} disabled={disabled} onChange={onChange} />;
  if (def.kind === 'audio_guide') return <AudioGuideInput value={v} onChange={onChange} disabled={disabled} />;
  if (def.kind === 'date_or_text') return <DateOrTextInput value={v} onChange={onChange} disabled={disabled} max={def.max} label={def.label} />;
  if (def.kind === 'date') return <input type="date" value={v} disabled={disabled} onChange={onChange} />;
  if (def.kind === 'select') {
    const list = def.lookup ? withCurrent(lookups[def.lookup] || [], v) : def.options;
    return <select value={v} disabled={disabled} onChange={onChange}><Options list={list} blank={def.required ? 'Select…' : '—'} /></select>;
  }
  if (def.multiline && auto) return <AutoTextarea maxLength={def.max} placeholder={def.hint} value={v} disabled={disabled} onChange={onChange} />;
  if (def.multiline) return <textarea maxLength={def.max} placeholder={def.hint} value={v} disabled={disabled} onChange={onChange} />;
  return <input maxLength={def.max} placeholder={def.hint} value={v} disabled={disabled} onChange={onChange} />;
}

// Excel mode only: every cell is plain text you can type OR paste into — no date picker, no dropdown — closer
// to how an actual spreadsheet cell behaves. Validation (a real date, a valid Platform, etc.) still happens
// when you hit Save, same as any other grid error. `onKeyDown`/`onFocus` are wired in by the grid for range
// selection and copy/paste; they pass straight through.
// A right-click menu that always fits in the window: it opens where you clicked, then moves up / left just enough that none of it is cut off
// (the menus are taller than the old fixed allowance, so the bottom items disappeared when you right-clicked near the bottom of the window).
function FitMenu({ x, y, children, ...rest }) {
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

function GridCellInput({ def, value, onChange, disabled, ...rest }) {
  const v = value ?? '';
  // The wrapper's hidden ::after copies the text (data-value) so the cell is exactly as wide (and, for multi-line
  // fields, as tall) as its content — nothing is cropped — while the real input/textarea fills that same box.
  // (no placeholder text: an empty cell stays empty like a spreadsheet's, and a hint such as "Filled from the PSD Daily Plug List" would be cut off in a narrow column)
  const Field = def.multiline ? 'textarea' : 'input';
  return (
    <div className={`xl-cell${def.multiline ? ' multi' : ''}`} data-value={`${v}\u200b`}>
      <Field maxLength={def.max} value={v} disabled={disabled} onChange={onChange} rows={def.multiline ? 1 : undefined} {...rest} />
    </div>
  );
}

// One table cell turned into its own editor. Enter or clicking away saves, Esc cancels; dropdowns save as soon as you pick.
// A failed save (e.g. an invalid value) keeps the editor open with the message shown.
function CellEditor({ def, initial, lookups, onSave, onCancel }) {
  const [val, setVal] = useState(initial ?? '');
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const finished = useRef(false);
  const field = () => box.current && box.current.querySelector('input, select, textarea');
  useEffect(() => {
    const el = def.kind === 'date_or_text' && box.current ? box.current.querySelector('input') : field();   // Artwork / STB: the date / text box, not its format dropdown
    if (!el) return;
    el.focus();
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) el.setSelectionRange(el.value.length, el.value.length);
    // dropdowns open straight away; date fields open focused (the browser's own picker would swallow Enter while it is open)
    try { if (el.tagName === 'SELECT') el.showPicker(); } catch (e) { /* needs a user gesture; the field is focused anyway */ }
  }, []);
  const save = async (value) => {
    if (finished.current) return;
    finished.current = true;
    setBusy(true);
    try { await onSave(value); } catch (e) {
      finished.current = false;
      setBusy(false);
      setTimeout(() => { const el = field(); if (el) el.focus(); }, 0);
    }
  };
  const change = (e) => {
    const nv = e.target.value;
    setVal(nv);
    if (def.kind === 'select') save(nv);
  };
  const blur = (e) => { if (box.current && !box.current.contains(e.relatedTarget)) save(val); };
  const key = (e) => {
    if (e.key === 'Escape') { finished.current = true; onCancel(); return; }
    const tag = e.target.tagName;
    if (e.key === 'Enter' && tag !== 'SELECT' && (tag !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) { e.preventDefault(); save(val); }
  };
  return (
    <div className={`cell-editor${busy ? ' busy' : ''}`} ref={box} onBlur={blur} onKeyDown={key}>
      <FieldInput auto def={def} value={val} lookups={lookups} disabled={busy} onChange={change} />
    </div>
  );
}

export default function Workload() {
  const s = useSession();
  const toast = useToast();
  const confirm = useConfirm();
  const canWrite = s.can('workload.write');

  const [meta, setMeta] = useState(null);
  const [lookups, setLookups] = useState({ workload_platform: [], plug_type: [], program: [] });
  const [tab, setTab] = useState('ALL');
  const [mode, setMode] = useState('table');
  const [filt, setFilt] = useState({ q: '', units: '', platform: '', plug_type: '', from: '', to: '' });
  const [stats, setStats] = useState(null);   // summary cards + tab badges
  const [offset, setOffset] = useState(0);
  const [sort, setSortState] = useState({ k: '', dir: 'asc' });   // clicked column header (Table mode)
  const setSort = (s2) => { setSortState(s2); setOffset(0); };
  const [data, setData] = useState(null);   // table mode: { total, rows } | { error }
  const [grid, setGrid] = useState(null);   // excel mode: { total, rows } | { error }
  const [gridSel, setGridSel] = useState(null);   // { r0, c0, r1, c1 } — row/col INDICES into (grid.rows, cols); null = nothing selected
  const [form, setForm] = useState(null);   // null | { rec } (rec null = new)
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);   // { id, k } while one table cell is open for editing
  const [addingColumn, setAddingColumn] = useState(false);
  const [managingLocks, setManagingLocks] = useState(false);
  const [importing, setImporting] = useState(false);
  // Table mode: selected rows (ids), "every row matching the filters" (Admin), and the delete-all dialog
  const [picked, setPicked] = useState(() => new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const lastPick = useRef(null);
  const keysRef = useRef(null);
  const pasteRef = useRef(null);
  const tblMouse = useRef({});         // latest mouse handlers for dragging across rows (assigned every render)
  const tblDrag = useRef(null);        // { idx, x, y, moved } while the mouse is down on a row
  const tblSuppress = useRef(false);   // swallow the click that ends a drag / Shift / Ctrl+click, so it doesn't open a cell editor
  const [tctx, setTctx] = useState(null);   // Table mode: right-click menu position { x, y } | null
  const tblHist = useRef({ past: [], future: [] });   // Table-mode undo / redo (delete, cut, paste, cell edit)
  const fileRef = useRef(null);
  const boxRef = useRef(null);    // Excel mode: the focusable wrapper that receives copy / cut / paste / Delete for a range or whole rows
  const drag = useRef(null);      // Excel mode: 'cell' | 'row' | 'col' while the mouse is held down selecting
  const moveRef = useRef(null);   // Excel mode: latest mouse-move handler for drag selection (kept fresh every render)
  const pasteSeen = useRef(false);   // did the browser send its own paste event for the Ctrl/Cmd+V just pressed?
  const internalClip = useRef(null);   // Excel mode: the last text copied inside the grid (right-click Paste falls back to it where the browser blocks reading the clipboard)
  const hist = useRef({ past: [], future: [], tag: null });   // Excel mode: undo / redo snapshots of the grid rows
  const [epoch, setEpoch] = useState(0);   // bumped whenever the grid is changed from outside a cell's own typing (paste, undo, clear …)
  const [ctx, setCtx] = useState(null);   // Excel mode: right-click menu position { x, y } | null
  useEffect(() => { setEditing(null); setGridSel(null); }, [tab, mode, offset]);
  useEffect(() => {
    if (!tctx) return undefined;
    const close = () => setTctx(null);
    const down = (e) => { if (!(e.target.closest && e.target.closest('.xl-menu'))) close(); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', down);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); window.removeEventListener('keydown', key); };
  }, [tctx]);
  useEffect(() => {
    if (!ctx) return undefined;
    const close = () => setCtx(null);
    const down = (e) => { if (!(e.target.closest && e.target.closest('.xl-menu'))) close(); };
    const key = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', down);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); window.removeEventListener('keydown', key); };
  }, [ctx]);
  useEffect(() => {
    // a click anywhere outside the grid (and its right-click menu) drops the selection
    if (!gridSel) return undefined;
    const outside = (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if ((boxRef.current && boxRef.current.contains(t)) || t.closest('.xl-menu') || t.closest('[data-keep-sel]')) return;   // the toolbar buttons that act ON the selection (Set Priority, Delete Rows) must not drop it first
      setGridSel(null);
    };
    window.addEventListener('mousedown', outside);
    return () => window.removeEventListener('mousedown', outside);
  }, [gridSel]);
  useEffect(() => {
    // Esc drops the current selection (a row, column or range), wherever the keyboard focus is
    if (!gridSel) return undefined;
    const esc = (e) => {
      if (e.key !== 'Escape') return;
      setGridSel(null);
      const el = document.activeElement;
      if (el && boxRef.current && boxRef.current.contains(el) && el !== boxRef.current) el.blur();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [gridSel]);
  useEffect(() => {
    const up = () => { drag.current = null; };
    const move = (e) => { if (moveRef.current) moveRef.current(e); };
    window.addEventListener('mouseup', up);
    window.addEventListener('mousemove', move);
    return () => { window.removeEventListener('mouseup', up); window.removeEventListener('mousemove', move); };
  }, []);
  const q = useDebounced(filt.q, 300);
  // a different tab / filter / search is a different set of rows: drop the selection
  useEffect(() => { setPicked(new Set()); setAllMatching(false); lastPick.current = null; }, [tab, mode, filt.units, filt.platform, filt.plug_type, filt.from, filt.to, q]);
  // Table-mode keyboard + mouse (one set of window listeners that always call the latest handlers, assigned further down every render)
  useEffect(() => {
    const key = (e) => { if (keysRef.current) keysRef.current(e); };
    const paste = (e) => { if (pasteRef.current) pasteRef.current(e); };
    const move = (e) => { if (tblMouse.current.move) tblMouse.current.move(e); };
    const up = (e) => { if (tblMouse.current.up) tblMouse.current.up(e); };
    const down = (e) => { if (tblMouse.current.down) tblMouse.current.down(e); };
    window.addEventListener('keydown', key);
    window.addEventListener('paste', paste);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('mousedown', down);
    return () => {
      window.removeEventListener('keydown', key); window.removeEventListener('paste', paste);
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.removeEventListener('mousedown', down);
    };
  }, []);
  const viewKey = meta && tab === 'ALL' ? viewForUnits(meta, filt.units) : tab;   // which column set to show (see viewForUnits)
  const isGrid = mode === 'excel';   // on the All tab the Excel grid holds the rows still waiting for a team (see load below); on a team tab, that team's rows

  // Rows are one line each (Remarks wraps), so a wide table scrolls sideways inside the card, like Excel.
  // Phones and small tablets show each row as a card instead.
  const [winW, setWinW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setWinW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const cards = mode === 'table' && winW < CARDS_BELOW;

  const loadMeta = useCallback(() => {
    Promise.all([get('/api/workload/meta'), get('/api/dropdowns?categories=workload_platform,plug_type,program')])
      .then(([m, dd]) => { setMeta(m); setLookups(dd); })
      .catch((e) => toast(e.message, 'err'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(loadMeta, []); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useCallback((extra = {}) => {
    const p = new URLSearchParams(extra);
    if (tab !== 'ALL') p.set('team', tab);
    ['units', 'platform', 'plug_type', 'from', 'to'].forEach((k) => { if (filt[k]) p.set(k, filt[k]); });
    if (!isGrid && q) p.set('q', q);
    if (!isGrid && sort.k && extra.limit !== undefined) { p.set('sort', sort.k); p.set('dir', sort.dir); }   // only the table's own list; counts and exports ignore it
    return p;
  }, [tab, filt.units, filt.platform, filt.plug_type, filt.from, filt.to, q, isGrid, sort.k, sort.dir]);

  // Tab badges (the counts next to All / VGFX / VEDIT / Audio) follow every filter except the team tab
  const loadStats = useCallback(async () => {
    if (!meta) return;
    const p = query();
    p.delete('team');
    p.set('today', isoDate());
    try { setStats(await get(`/api/workload/stats?${p}`)); } catch (e) { /* cards just stay as they were */ }
  }, [meta, query]);

  const load = useCallback(async () => {
    if (!meta) return;
    loadStats();
    try {
      if (isGrid) {
        // All tab: the rows nobody has given a team yet — e.g. plugs just copied from the PSD Daily Plug List. A Units filter you choose still wins.
        const d = await get(`/api/workload?${query({ limit: GRID_LIMIT, ...(tab === 'ALL' ? { units: meta.notSet } : {}) })}`);
        hist.current = { past: [], future: [], tag: null };
        setGrid({ total: d.total, rows: d.rows.map((r) => ({ ...r, _key: `r${r.id}`, _dirty: false })) });
      } else {
        setData(await get(`/api/workload?${query({ limit: PAGE, offset })}`));
      }
    } catch (e) {
      (isGrid ? setGrid : setData)({ error: e.message, rows: [], total: 0 });
    }
  }, [meta, isGrid, tab, query, offset, loadStats]);

  useEffect(() => { load(); }, [load]);

  // ---- unsaved-change protection (Excel mode) ----
  const dirtyCount = isGrid && grid && grid.rows ? grid.rows.filter((r) => r._dirty).length : 0;
  useEffect(() => {
    if (!dirtyCount) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirtyCount]);
  const okToLeave = async () => dirtyCount === 0
    || !!(await confirm('Discard unsaved changes?', `${dirtyCount} row(s) in the grid have unsaved changes. Leave without saving?`, { okText: 'Discard', danger: true }));

  const changeTab = async (t) => { if (t === tab || !(await okToLeave())) return; setTab(t); setOffset(0); };
  const changeMode = async (m) => { if (m === mode || !(await okToLeave())) return; setMode(m); setOffset(0); };
  const setF = (k) => async (e) => {
    const val = e.target.value;
    if (k !== 'q' && !(await okToLeave())) return;
    setFilt((f) => ({ ...f, [k]: val }));
    setOffset(0);
  };

  const setRange = async ({ from, to }) => {
    if (!(await okToLeave())) return;
    setFilt((f) => ({ ...f, from, to }));
    setOffset(0);
  };

  // ---- click-to-edit: save ONE cell (PATCH writes only that column, so other people's edits to the row are kept) ----
  const saveCell = async (r, k, value) => {
    if (String(value ?? '') === String(r[k] ?? '')) { setEditing((cur) => (cur && cur.id === r.id && cur.k === k ? null : cur)); return; }
    try {
      const out = await patch(`/api/workload/${r.id}`, { field: k, value });
      const before = r[k] ?? '';
      pushTbl({ label: 'cell edit', undo: () => patch(`/api/workload/${r.id}`, { field: k, value: before }), redo: () => patch(`/api/workload/${r.id}`, { field: k, value }) });
      setData((d) => (d && d.rows ? { ...d, rows: d.rows.map((x) => (x.id === r.id ? { ...x, ...out.values } : x)) } : d));
      // close only THIS cell's editor: the person may already have opened another cell while this one was saving
      setEditing((cur) => (cur && cur.id === r.id && cur.k === k ? null : cur));
      if (['work_date', 'units_concerned', 'platform', 'plug_type'].includes(k)) load();   // may change the row's place, filters or the counts
    } catch (e) { toast(e.message, 'err'); throw e; }
  };

  // ---- Excel export (sheets mirror the template: MAIN + AUDIO, or just the open team tab) ----
  const exportXlsx = async () => {
    try {
      const res = await fetch(`/api/workload/export?${query()}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'PromoHub' } });
      if (!res.ok) {
        let msg = `Export failed (${res.status})`;
        try { msg = (await res.json()).error || msg; } catch (e) { /* not JSON */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const now = new Date();
      a.download = `Workload_${tab}_${MONTH_ABBR[now.getMonth()]}_${now.getFullYear()}.xlsx`;   // tab is already 'ALL' or a team key like 'VGFX', both already upper case
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    } catch (e) { toast(e.message, 'err'); }
  };

  // ---- Import: reads a .xlsx shaped like this page's own Export (MAIN/AUDIO sheets, matching headers) ----
  const importFile = async (file) => {
    if (!file) return;
    const form2 = new FormData();
    form2.append('file', file);
    setImporting(true);
    try {
      const out = await post('/api/workload/import', form2);
      const bits = [`${out.created} row${out.created === 1 ? '' : 's'} imported`];
      if (out.skipped) bits.push(`${out.skipped} skipped`);
      if (out.newColumns && out.newColumns.length) bits.push(`new column${out.newColumns.length === 1 ? '' : 's'}: ${out.newColumns.join(', ')}`);
      toast(bits.join(' — '), out.skipped ? 'err' : undefined);
      if (out.errors && out.errors.length) console.warn('Import errors:', out.errors);
      if (out.newColumns && out.newColumns.length) loadMeta();
      load();
    } catch (e) { toast(e.message, 'err'); } finally { setImporting(false); if (fileRef.current) fileRef.current.value = ''; }
  };


  // ---- Excel mode: undo / redo. Typing in one cell is one step; a paste, clear, cut or row add / remove is one step each. ----
  const pushHistory = (tag) => {
    const h = hist.current;
    if (tag && h.tag === tag) return;   // still typing in the same cell: same undo step
    h.tag = tag || null;
    h.past.push(grid.rows);
    if (h.past.length > 100) h.past.shift();
    h.future = [];
  };
  const restoreRows = (rows) => {
    hist.current.tag = null;
    setGrid((g) => ({ ...g, rows }));
    setEpoch((v) => v + 1);
    setGridSel((sel) => (sel && sel.r0 < rows.length && sel.r1 < rows.length ? sel : null));
  };
  const undo = () => { const h = hist.current; if (!h.past.length) return; h.future.push(grid.rows); restoreRows(h.past.pop()); };
  const redo = () => { const h = hist.current; if (!h.future.length) return; h.past.push(grid.rows); restoreRows(h.future.pop()); };
  // ---- PSD Daily Plug List lookups for the grid (plugs of the dates on screen, fetched once per date) ----
  const plugCache = useRef(new Map());   // 'YYYY-MM-DD' -> plugs of that day
  const ensurePlugDates = useCallback(async (dates) => {
    const need = [...new Set(dates.filter((d) => d && ISO.test(d) && !plugCache.current.has(d)))].sort();
    if (!need.length) return;
    need.forEach((d) => plugCache.current.set(d, []));   // mark as asked, so a re-render doesn't ask again
    try {
      const { rows } = await get(`/api/plugs?from=${need[0]}&to=${need[need.length - 1]}&limit=5000`);
      rows.forEach((r) => { const list = plugCache.current.get(r.plug_date); if (list) list.push(r); });
    } catch (e) { need.forEach((d) => plugCache.current.delete(d)); }
  }, []);
  useEffect(() => { if (grid && grid.rows) ensurePlugDates(grid.rows.map((r) => r.work_date)); }, [grid, ensurePlugDates]);
  const findPlug = (date, plugId) => {
    const id = firstLine(plugId).trim().toUpperCase();
    return id ? (plugCache.current.get(date) || []).find((p) => p.plug_id.toUpperCase() === id) || null : null;
  };
  // one place that knows how to put a value into a grid cell (the merged Breakdate / Time cell is text for both teams' times)
  const setCellValue = (row, k, val, replace) => {
    if (k === 'breakdate_vgfx') return { ...row, ...bdApply(row, val, meta.unitTeams, replace) };
    const next = withAutoPlatform(meta.platformRules, row, k, val);
    return k === 'plug_id' || k === 'work_date' ? fillFromPlug(next, row, findPlug) : next;
  };
  const setCell = (key, k, val) => {
    if (!canWrite) return;
    pushHistory(`${key}:${k}`);
    setGrid((g) => ({ ...g, rows: g.rows.map((r) => (r._key === key ? { ...setCellValue(r, k, val, false), _dirty: true } : r)) }));
  };
  const xlKeys = () => meta.views[viewKey].filter((k) => k !== 'breakdate_vedit');   // the grid's columns: VGFX + VEDIT times share one

  // ---- Excel mode: works like a spreadsheet ----
  // Click a cell, drag or Shift+click for a range; click a ROW NUMBER to select the whole row (drag / Shift+click for
  // several rows), a column header for the whole column, the corner for everything. Ctrl+C / Ctrl+X / Ctrl+V copy,
  // cut and paste whole rows or any range as tab-separated text (so it also pastes into / from a real Excel sheet),
  // pasting past the last row adds new rows, one copied value fills a selected range, Delete clears the selection.
  // (Excel mode only — Table mode's click-to-edit and the New/Edit form keep their pickers/dropdowns.)
  const normSel = () => (gridSel ? {
    rLo: Math.min(gridSel.r0, gridSel.r1), rHi: Math.max(gridSel.r0, gridSel.r1),
    cLo: Math.min(gridSel.c0, gridSel.c1), cHi: Math.max(gridSel.c0, gridSel.c1),
  } : null);
  const isTextTarget = (el) => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  const focusBox = () => { if (boxRef.current) boxRef.current.focus({ preventScroll: true }); try { window.getSelection().removeAllRanges(); } catch (err) { /* nothing to clear */ } };
  const startSel = (kind, r, c, e) => {
    const nR = grid.rows.length; const nC = xlKeys().length;
    if (!nR || !nC) return;
    if (e.button === 2) {
      // right-click: keep a selection that already covers this spot, otherwise select just this cell / row / column
      const n = normSel();
      const inside = !!n && (kind === 'all' || (kind === 'row' ? r >= n.rLo && r <= n.rHi : kind === 'col' ? c >= n.cLo && c <= n.cHi : r >= n.rLo && r <= n.rHi && c >= n.cLo && c <= n.cHi));
      if (!inside) setGridSel(kind === 'row' ? { r0: r, c0: 0, r1: r, c1: nC - 1 } : kind === 'col' ? { r0: 0, c0: c, r1: nR - 1, c1: c } : kind === 'all' ? { r0: 0, c0: 0, r1: nR - 1, c1: nC - 1 } : { r0: r, c0: c, r1: r, c1: c });
      drag.current = null;
      e.preventDefault(); focusBox();
      return;
    }
    drag.current = kind;
    const ext = e.shiftKey && gridSel;
    let next;
    if (kind === 'row') next = ext ? { r0: gridSel.r0, c0: 0, r1: r, c1: nC - 1 } : { r0: r, c0: 0, r1: r, c1: nC - 1 };
    else if (kind === 'col') next = ext ? { r0: 0, c0: gridSel.c0, r1: nR - 1, c1: c } : { r0: 0, c0: c, r1: nR - 1, c1: c };
    else if (kind === 'all') { next = { r0: 0, c0: 0, r1: nR - 1, c1: nC - 1 }; drag.current = null; }
    else next = ext ? { ...gridSel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c };
    setGridSel(next);
    const multi = next.r0 !== next.r1 || next.c0 !== next.c1;
    if (kind !== 'cell' || multi) { e.preventDefault(); focusBox(); }   // the wrapper (not one cell's input) now owns the keyboard
  };
  const extendSel = (kind, r, c) => {
    if (drag.current !== kind || !gridSel) return;
    const nR = grid.rows.length; const nC = xlKeys().length;
    const next = kind === 'row' ? { ...gridSel, r1: r, c0: 0, c1: nC - 1 }
      : kind === 'col' ? { ...gridSel, r0: 0, r1: nR - 1, c1: c }
        : { ...gridSel, r1: r, c1: c };
    if (next.r0 === gridSel.r0 && next.c0 === gridSel.c0 && next.r1 === gridSel.r1 && next.c1 === gridSel.c1) return;
    setGridSel(next);
    if (next.r0 !== next.r1 || next.c0 !== next.c1) focusBox();
  };
  // Drag-selecting: follow the pointer with a window-level mousemove and look up the cell under it, because a mouse
  // drag that starts inside a text box does not reliably fire mouseenter on the cells it passes over.
  moveRef.current = (e) => {
    const kind = drag.current;
    if (!kind) return;
    if (!(e.buttons & 1)) { drag.current = null; return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !el.closest) return;
    if (kind === 'row') { const tr = el.closest('tr[data-ri]'); if (tr) extendSel('row', +tr.dataset.ri, 0); return; }
    const hit = el.closest('[data-c]');
    if (!hit) return;
    if (kind === 'col') extendSel('col', 0, +hit.dataset.c);
    else if (hit.dataset.r !== undefined) extendSel('cell', +hit.dataset.r, +hit.dataset.c);
  };
  // Mouse down anywhere in a cell (its padding included, not just the text box) selects it and puts the cursor in it
  const cellMouseDown = (ri, ci) => (e) => {
    startSel('cell', ri, ci, e);
    if (e.button === 2 || e.shiftKey || isTextTarget(e.target)) return;
    e.preventDefault();
    const f = e.currentTarget.querySelector('input, textarea');
    if (f) { f.focus(); try { const n = f.value.length; f.setSelectionRange(n, n); } catch (err) { /* not a text control */ } }
  };
  // Real spreadsheets quote a cell's text (wrapping in "…", doubling any internal ") when it contains a tab or a
  // newline, so a multi-line cell (Remarks, VO, ...) survives being copied as part of a larger range. Match that.
  const tsvCell = (v) => { const s = String(v ?? ''); return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const parseTsvBlock = (text) => {
    const rows = []; let row = []; let field = ''; let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === '\t') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* normalize CRLF: skip, \n below ends the row */ }
      else field += c;
    }
    row.push(field); rows.push(row);
    if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();   // trailing blank line
    return rows;
  };
  // 'xl-sel' plus which edges of the range this cell sits on (so only the OUTLINE of a range is drawn, like Excel)
  const selClass = (r, c) => {
    const n = normSel();
    if (!n || r < n.rLo || r > n.rHi || c < n.cLo || c > n.cHi) return '';
    const single = n.rLo === n.rHi && n.cLo === n.cHi;
    return `xl-sel${single ? ' xl-single' : ''}${gridSel && r === gridSel.r0 && c === gridSel.c0 ? ' xl-active' : ''}${r === n.rLo ? ' xl-t' : ''}${r === n.rHi ? ' xl-b' : ''}${c === n.cLo ? ' xl-l' : ''}${c === n.cHi ? ' xl-r' : ''}`;
  };
  const rowInSel = (r) => { const n = normSel(); return !!n && r >= n.rLo && r <= n.rHi; };
  const colInSel = (c) => { const n = normSel(); return !!n && c >= n.cLo && c <= n.cHi; };
  const clearSel = () => {
    const n = normSel();
    if (!n || !canWrite) return;
    const keys = xlKeys();
    pushHistory(null);
    setEpoch((v) => v + 1);
    setGrid((g) => ({
      ...g,
      rows: g.rows.map((row, ri) => {
        if (ri < n.rLo || ri > n.rHi) return row;
        let changed = row;
        for (let ci = n.cLo; ci <= n.cHi; ci++) changed = setCellValue(changed, keys[ci], '', true);
        return { ...changed, _dirty: true };
      }),
    }));
  };
  // Copy (and Cut): a range or whole rows go to the clipboard as tab-separated text. A single cell that is being
  // edited in its own box is left to the browser so normal text copy still works.
  const selectionTsv = (cols) => {
    const n = normSel();
    if (!n) return '';
    const tsv = [];
    for (let r = n.rLo; r <= n.rHi; r++) {
      const row = grid.rows[r];
      tsv.push(cols.slice(n.cLo, n.cHi + 1).map((k) => tsvCell(row && (k === 'breakdate_vgfx' ? bdText(row, meta.unitTeams) : row[k]))).join('\t'));
    }
    return tsv.join('\n');
  };
  const copiedToast = (cut) => {
    const n = normSel();
    if (!n) return;
    const nr = n.rHi - n.rLo + 1;
    toast(`${cut ? 'Cut' : 'Copied'} ${nr} row${nr === 1 ? '' : 's'} × ${n.cHi - n.cLo + 1} column${n.cHi === n.cLo ? '' : 's'}`);
  };
  const gridCopy = (cols, cut) => (e) => {
    const n = normSel();
    if (!n) return;
    if (n.rLo === n.rHi && n.cLo === n.cHi && isTextTarget(e.target)) return;
    const text = selectionTsv(cols);
    e.clipboardData.setData('text/plain', text);
    internalClip.current = text;
    e.preventDefault();
    copiedToast(cut);
    if (cut) clearSel();
  };
  // Right-click menu actions (the clipboard is written / read directly, since no keyboard copy event is involved)
  const menuCopy = async (cols, cut) => {
    setCtx(null);
    if (!normSel() || (cut && !canWrite)) return;
    const text = selectionTsv(cols);
    internalClip.current = text;
    const ok = await writeClipboard(text);
    if (!ok) toast('Could not reach the system clipboard — Ctrl+C still works', 'err');
    else copiedToast(cut);
    if (cut) clearSel();
  };
  const menuPaste = async (cols) => {
    setCtx(null);
    if (!canWrite) return;
    let text = null;
    try { if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) text = await navigator.clipboard.readText(); } catch (err) { text = null; }
    if (text == null || text === '') text = internalClip.current;   // this address may not let a page read the clipboard: use what was last copied in the grid
    if (text == null || text === '') { toast('Nothing to paste yet — copy something first, or press Ctrl+V', 'err'); return; }
    doPaste(text, cols, true);   // from the menu there is no browser paste to fall back on, so a single value is applied here too
  };
  // Paste: starts at the top-left of the selection (a selected row starts at its first column). Rows past the end are
  // added as new rows, one copied value (or a block that divides the selection evenly) is repeated to fill the selected
  // range, and a single value pasted into one cell is left to the browser.
  const newRowDefaults = () => {
    const last = grid.rows.length ? grid.rows[grid.rows.length - 1].work_date : '';
    return { _key: newKey(), _new: true, _dirty: true, work_date: last || filt.from || isoDate(), units_concerned: filt.units || meta.tabDefaultUnits[tab] };
  };
  // Returns false when the paste should be left to the browser (a single value into one ordinary cell); true when the grid took it.
  const doPaste = (rawText, cols, force, el) => {
    const sel0 = normSel();
    // A Breakdate / Time cell holding BOTH teams (a VGFX line + a VEDIT line) pasted with a row / other cell selected
    // fills that row's VGFX and VEDIT times together — never extra rows.
    const bdText0 = normBreakdate(rawText, new Date().getFullYear());
    if (sel0 && Object.keys(parseBreakdatePairs(bdText0)).length && bdText0.replace(BD_PAIR, '').replace(/["\s]+/g, '') === '') {
      if (!canWrite) return true;
      pushHistory(null);
      setEpoch((v) => v + 1);
      setGrid((g) => ({ ...g, rows: g.rows.map((row, ri) => (ri >= sel0.rLo && ri <= sel0.rHi ? { ...row, ...bdApply(row, rawText, meta.unitTeams, true), _dirty: true } : row)) }));
      return true;
    }
    const block = parseTsvBlock(rawText);
    const n = normSel();
    const r0 = n ? n.rLo : 0;
    const c0 = n ? n.cLo : 0;
    const bR = block.length;
    const bC = Math.max(1, ...block.map((row) => row.length));
    const multi = !!n && (n.rHi > n.rLo || n.cHi > n.cLo);
    // text as a spreadsheet sends it for ONE cell (no quotes or trailing line break added around it) can simply be pasted by the browser
    const plain = block.every((row) => row.length === 1) && block.map((row) => row[0]).join('\n') === rawText.replace(/\r\n?/g, '\n');
    if (!force && bR === 1 && bC === 1 && !multi && plain && !(sel0 && cols[sel0.cLo] === 'breakdate_vgfx')) return false;   // a single value into one ordinary cell: normal paste
    // Text from OUTSIDE the grid that is one column with line breaks in it (a 2-line note, a pasted paragraph) is ONE value: all its lines go into
    // every selected cell (a multi-line cell keeps the line breaks; a one-line cell such as PSD gets the lines side by side) — it is never dealt out
    // one line per cell or spilled into the rows below. Text copied inside the grid, and anything with tabs (a real table), still goes cell by cell.
    // (Also a single cell copied from Excel / Sheets, which wraps it in quotes and adds a final line break: those are removed here.)
    const inGrid = internalClip.current != null && String(internalClip.current).replace(/\r\n?/g, '\n') === rawText.replace(/\r\n?/g, '\n');
    if (n && bC === 1 && cols[c0] && ((bR > 1 && !inGrid) || (!multi && bR === 1 && !plain))) {
      if (!multi && plain && el && el.tagName === 'TEXTAREA') return false;   // one multi-line cell with the cursor in it: the browser inserts the whole text at the cursor
      if (!canWrite) return true;
      const textFor = (col) => block.map((row) => row[0]).join(meta.fields[col] && meta.fields[col].multiline ? '\n' : ' ');
      pushHistory(null);
      setEpoch((v) => v + 1);
      setGrid((g) => ({
        ...g,
        rows: g.rows.map((row, ri) => {
          if (ri < n.rLo || ri > n.rHi) return row;
          let changed = row;
          for (let ci = n.cLo; ci <= n.cHi; ci++) { const col = cols[ci]; if (col) changed = setCellValue(changed, col, textFor(col), true); }
          return { ...changed, _dirty: true };
        }),
      }));
      setGridSel({ r0: n.rLo, c0: n.cLo, r1: n.rHi, c1: n.cHi });
      focusBox();
      return true;
    }
    if (!canWrite) return true;
    const selR = n ? n.rHi - n.rLo + 1 : 0;
    const selC = n ? n.cHi - n.cLo + 1 : 0;
    let tileR = multi && selR > bR && selR % bR === 0 ? selR : bR;
    const tileC = multi && selC > bC && selC % bC === 0 ? selC : bC;
    const roomLeft = Math.max(1, GRID_LIMIT - r0);   // the server saves at most 200 changed rows at a time
    if (tileR > roomLeft) { toast(`Only the first ${roomLeft} rows were pasted (200 rows per save)`, 'err'); tileR = roomLeft; }
    pushHistory(null);
    setEpoch((v) => v + 1);
    setGrid((g) => {
      let rows = g.rows;
      if (r0 + tileR > rows.length) rows = [...rows, ...Array.from({ length: r0 + tileR - rows.length }, () => newRowDefaults())];
      return {
        ...g,
        rows: rows.map((row, ri) => {
          const bi = ri - r0;
          if (bi < 0 || bi >= tileR) return row;
          let changed = row;
          for (let ci = 0; ci < tileC; ci++) {
            const col = cols[c0 + ci];
            if (!col) break;
            changed = setCellValue(changed, col, (block[bi % bR][ci % bC]) ?? '', true);
          }
          return { ...changed, _dirty: true };
        }),
      };
    });
    setGridSel({ r0, c0, r1: r0 + tileR - 1, c1: Math.min(c0 + tileC - 1, cols.length - 1) });
    focusBox();
    return true;
  };
  // Right-click on a row number: put the copied rows in ABOVE this row as new rows (nothing is overwritten)
  const menuInsertRows = async (cols) => {
    setCtx(null);
    const n = normSel();
    if (!canWrite || !n) return;
    let text = null;
    try { if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) text = await navigator.clipboard.readText(); } catch (err) { text = null; }
    if (text == null || text === '') text = internalClip.current;
    if (text == null || text === '') { toast('Nothing to insert yet — copy one or more rows first', 'err'); return; }
    const block = parseTsvBlock(text).slice(0, GRID_LIMIT);
    pushHistory(null);
    setEpoch((v) => v + 1);
    setGrid((g) => {
      const fresh = block.map((cells) => {
        let row = newRowDefaults();
        cells.forEach((raw, ci) => { if (cols[ci]) row = setCellValue(row, cols[ci], raw, true); });
        return row;
      });
      const rows = [...g.rows];
      rows.splice(n.rLo, 0, ...fresh);
      return { ...g, rows };
    });
    setGridSel({ r0: n.rLo, c0: 0, r1: n.rLo + block.length - 1, c1: cols.length - 1 });
    focusBox();
  };
  // Right-click → Delete row(s): removes the selected whole rows (saved ones are deleted on the server too, after a confirmation)
  // Set / remove Priority on the rows of the selection (Table mode does it in the New / Edit form). The row's Breakdate / Time cell turns red; Save changes keeps it.
  const togglePriority = () => {
    const n = normSel();
    if (!n || !canWrite || !grid) return;
    const make = !grid.rows.slice(n.rLo, n.rHi + 1).every((r) => r.is_priority);
    setCtx(null);
    pushHistory(null);
    setGrid((g) => ({ ...g, rows: g.rows.map((r, i) => (i >= n.rLo && i <= n.rHi ? { ...r, is_priority: make, _dirty: true } : r)) }));
  };
  const deleteSelectedRows = async () => {
    setCtx(null);
    const n = normSel();
    if (!n || !canWrite) return;
    const target = grid.rows.slice(n.rLo, n.rHi + 1);
    const saved = target.filter((r) => !r._new);
    if (saved.length && !(await confirm(`Delete ${saved.length} row${saved.length === 1 ? '' : 's'}`, `Permanently delete ${saved.length === 1 ? `"${firstLine(saved[0].plug_id)}"` : `these ${saved.length} rows`}? This cannot be undone.`, { okText: 'Delete', danger: true }))) return;
    const gone = new Set(target.filter((r) => r._new).map((r) => r._key));
    let failure = null;
    for (const r of saved) {
      try { await del(`/api/workload/${r.id}`); gone.add(r._key); } catch (err) { failure = err; break; }
    }
    const deletedSaved = saved.filter((r) => gone.has(r._key)).length;
    setGrid((g) => ({ ...g, rows: g.rows.filter((r) => !gone.has(r._key)), total: g.total - deletedSaved }));
    hist.current = { past: [], future: [], tag: null };   // a deleted saved row can't be brought back by undo
    setGridSel(null);
    if (deletedSaved) loadStats();
    if (failure) toast(failure.message, 'err'); else toast(`Deleted ${target.length} row${target.length === 1 ? '' : 's'}`);
  };
  const gridPaste = (cols) => (e) => {
    pasteSeen.current = true;
    if (doPaste(e.clipboardData.getData('text/plain'), cols, false, e.target)) e.preventDefault();
  };
  // Keys while the wrapper (not a cell's own text box) has focus, i.e. after selecting rows / columns / a range
  const gridKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && ['z', 'y'].includes(e.key.toLowerCase())) {
      // grid-wide undo / redo (also while a cell has the cursor: the browser's own per-box undo doesn't know about pastes or other cells)
      e.preventDefault();
      if (e.key.toLowerCase() === 'y' || e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') {
      // With the cursor in ONE cell that has text, the first Ctrl/Cmd+A selects the text inside that cell (like typing in any box); pressing it again —
      // or with a row, column or several cells selected, or in an empty cell — selects every cell of the grid.
      const t = e.target;
      const several = !!gridSel && (gridSel.r0 !== gridSel.r1 || gridSel.c0 !== gridSel.c1);
      if (!several && isTextTarget(t) && t.tagName !== 'SELECT' && typeof t.value === 'string' && t.value.length && !(t.selectionStart === 0 && t.selectionEnd === t.value.length)) return;
      e.preventDefault();
      if (grid && grid.rows.length) { setGridSel({ r0: 0, c0: 0, r1: grid.rows.length - 1, c1: xlKeys().length - 1 }); focusBox(); }
      return;
    }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      // like a spreadsheet: Enter moves to the cell below (Shift+Enter: above); Tab / Shift+Tab move sideways natively
      const td = e.target.closest('td[data-r]');
      if (td) {
        e.preventDefault();
        const next = boxRef.current && boxRef.current.querySelector(`td[data-r="${Number(td.dataset.r) + (e.shiftKey ? -1 : 1)}"][data-c="${td.dataset.c}"] input, td[data-r="${Number(td.dataset.r) + (e.shiftKey ? -1 : 1)}"][data-c="${td.dataset.c}"] textarea`);
        if (next) { next.focus(); try { const len = next.value.length; next.setSelectionRange(len, len); } catch (err) { /* not a text control */ } }
      }
      return;
    }
    // Copy / cut / paste with a whole row, column or range selected (the grid box itself has the focus, no cell has the cursor). Browsers send no copy or cut
    // event when nothing is selected as text, so Ctrl/Cmd+C and +X are done here; for +V the browser's own paste event is used when it arrives, else the clipboard is read.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !isTextTarget(e.target) && gridSel) {
      const key = e.key.toLowerCase();
      if (key === 'c' || (key === 'x' && canWrite)) { e.preventDefault(); menuCopy(xlKeys(), key === 'x'); return; }
      if (key === 'v' && canWrite) {
        pasteSeen.current = false;
        setTimeout(() => { if (!pasteSeen.current) menuPaste(xlKeys()); }, 150);
        return;
      }
    }
    if (isTextTarget(e.target)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (grid.rows.length) setGridSel({ r0: 0, c0: 0, r1: grid.rows.length - 1, c1: xlKeys().length - 1 });
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && gridSel) {
      e.preventDefault();
      clearSel();
    } else if (e.key === 'Escape') setGridSel(null);
  };
  const isEmptyRow = (r) => meta.views[viewKey].filter((k) => k !== 'work_date' && k !== 'units_concerned').every((k) => !String(r[k] ?? '').trim());
  const addRow = () => { pushHistory(null); addRowNow(); };
  // A new row goes to the TOP of the grid (row 1), with the cursor in its first cell and the grid scrolled up to it — not at the bottom, out of sight.
  const addRowNow = () => {
    setGrid((g) => {
      const top = g.rows.length ? g.rows[0].work_date : '';
      return { ...g, rows: [{ _key: newKey(), _new: true, _dirty: false, work_date: top || filt.from || isoDate(), units_concerned: filt.units || meta.tabDefaultUnits[tab] }, ...g.rows] };
    });
    setGridSel({ r0: 0, c0: 0, r1: 0, c1: 0 });
    requestAnimationFrame(() => {
      const box = boxRef.current;
      if (!box) return;
      box.scrollTop = 0;
      const first = box.querySelector('tbody tr:first-child td[data-c="0"] input, tbody tr:first-child td[data-c="0"] textarea');
      if (first) first.focus({ preventScroll: true });
    });
  };
  const removeRow = async (r) => {
    if (!r._new) {
      if (!(await confirm('Delete row', `Permanently delete "${firstLine(r.plug_id)}"?`, { okText: 'Delete', danger: true }))) return;
      try { await del(`/api/workload/${r.id}`); toast('Deleted'); } catch (e) { toast(e.message, 'err'); return; }
    }
    if (r._new) pushHistory(null); else hist.current = { past: [], future: [], tag: null };   // a deleted saved row can't be brought back by undo
    setGrid((g) => ({ ...g, rows: g.rows.filter((x) => x._key !== r._key), total: r._new ? g.total : g.total - 1 }));
    setGridSel(null);   // row indices shift after a removal; avoid a stale selection pointing at the wrong row
    if (!r._new) loadStats();
  };
  // ---- table-mode delete (per row) ----
  const deleteItem = async (r) => {
    const what = `${firstLine(r.plug_id)}${r.work_date ? ` (${fmtDate(r.work_date)})` : ''}`;
    if (!(await confirm('Delete workload item', `Permanently delete "${what}"? This cannot be undone.`, { okText: 'Delete', danger: true }))) return;
    try {
      await del(`/api/workload/${r.id}`);
      toast('Deleted');
      if (data && data.rows.length === 1 && offset > 0) setOffset(Math.max(0, offset - PAGE)); // last row on this page
      else load();
    } catch (e) { toast(e.message, 'err'); }
  };
  // ---- Table mode: select rows by dragging across them (or Shift / Ctrl+click), with the same shortcuts as Excel mode ----
  const total = data && data.total ? data.total : 0;
  const isAdminUser = !!(s.user && s.user.role === 'Admin');
  const pageRows = data && data.rows ? data.rows : [];
  const pickable = pageRows.filter((r) => !isLocked(r.work_date, meta.locks));   // a row in a locked period can't be deleted, so it can't be selected
  const pickedCount = allMatching ? total : picked.size;
  const pageAllPicked = !!pickable.length && pickable.every((r) => allMatching || picked.has(r.id));
  const clearPicks = () => { setPicked(new Set()); setAllMatching(false); lastPick.current = null; };
  const rangeIds = (a, b) => pageRows.slice(Math.min(a, b), Math.max(a, b) + 1).filter((r) => !isLocked(r.work_date, meta.locks)).map((r) => r.id);
  const selectPage = () => { setAllMatching(false); setPicked(new Set(pickable.map((r) => r.id))); };
  const selectAllMatching = () => { setPicked(new Set(pickable.map((r) => r.id))); setAllMatching(true); };
  const toPayload = (r) => [...Object.keys(meta.fields), 'is_priority'].reduce((o, k) => ({ ...o, [k]: r[k] }), {});   // a row as the batch endpoint takes it (no id)

  // undo / redo of what Table mode does straight on the server: delete / cut, paste and single-cell edits
  const pushTbl = (entry) => { const h = tblHist.current; h.past.push(entry); if (h.past.length > 50) h.past.shift(); h.future = []; };
  const stepTbl = async (from, to, verb) => {
    const e = tblHist.current[from].pop();
    if (!e) { toast(`Nothing to ${verb}`); return; }
    try { await e[verb](); tblHist.current[to].push(e); toast(`${verb === 'undo' ? 'Undone' : 'Redone'}: ${e.label}`); } catch (err) { tblHist.current[from].push(e); toast(err.message, 'err'); }
    clearPicks();
    load();
    loadStats();
  };
  const undoTbl = () => stepTbl('past', 'future', 'undo');
  const redoTbl = () => stepTbl('future', 'past', 'redo');

  const afterBulk = (out) => {
    const bits = [`${out.deleted} row${out.deleted === 1 ? '' : 's'} deleted`];
    if (out.skipped) bits.push(`${out.skipped} skipped — in a locked period`);
    toast(bits.join(' — '), out.skipped ? 'err' : undefined);
    clearPicks();
    if (offset > 0 && out.deleted >= pageRows.length) setOffset(Math.max(0, offset - PAGE)); else load();
    loadStats();
  };
  const deleteSelected = async (verb = 'Delete') => {
    if (allMatching) { setDeletingAll(true); return; }
    const ids = [...picked];
    if (!ids.length) return;
    const n = ids.length;
    const what = `${n} row${n === 1 ? '' : 's'}`;
    if (!(await confirm(`${verb} ${what}`, verb === 'Cut'
      ? `Cut the ${what} you selected? They leave the tracker; Ctrl+V puts them back, or Ctrl+Z undoes it.`
      : `Permanently delete the ${what} you selected? Ctrl+Z can undo it.`, { okText: verb, danger: true }))) return;
    const snapshot = pageRows.filter((r) => picked.has(r.id)).map(toPayload);
    try {
      const out = await post('/api/workload/bulk-delete', { ids });
      if (out.deleted && !out.skipped) {
        let current = ids;
        pushTbl({
          label: `${verb.toLowerCase()} ${what}`,
          undo: async () => { current = (await post('/api/workload/batch', { rows: snapshot })).createdIds || []; },
          redo: async () => { await post('/api/workload/bulk-delete', { ids: current }); },
        });
      }
      afterBulk(out);
    } catch (e) { toast(e.message, 'err'); }
  };
  // Copy the selected rows as tab-separated text — the same layout Excel mode copies and pastes
  const copyPicked = async () => {
    const rows = pageRows.filter((r) => picked.has(r.id));
    if (!rows.length) return false;
    const text = rows.map((r) => tableCols.map((k) => tsvCell(k === 'breakdate_vgfx' ? bdText(r, meta.unitTeams) : r[k])).join('\t')).join('\n');
    internalClip.current = text;
    const ok = await writeClipboard(text);
    const elsewhere = picked.size - rows.length;
    toast(ok ? `Copied ${rows.length} row${rows.length === 1 ? '' : 's'}${elsewhere > 0 ? ` (${elsewhere} selected on other pages not included)` : ''}` : 'Could not reach the clipboard', ok ? undefined : 'err');
    return ok;
  };
  const cutPicked = async () => { if (await copyPicked()) await deleteSelected('Cut'); };
  // Paste rows (copied from here, Excel mode or a spreadsheet) as NEW Workload rows
  const pasteRows = async (text) => {
    if (!canWrite) return;
    const block = parseTsvBlock(text).filter((cells) => cells.some((c) => String(c).trim() !== ''));
    if (!block.length) return;
    if (block.length > 200) toast('Only the first 200 rows are pasted at a time', 'err');
    const rows = block.slice(0, 200).map((cells) => {
      let row = {};
      cells.forEach((raw, ci) => { if (tableCols[ci]) row = setCellValue(row, tableCols[ci], raw, true); });
      if (!row.work_date) row.work_date = filt.from || isoDate();
      if (!row.units_concerned && tab !== 'ALL') row.units_concerned = meta.tabDefaultUnits[tab];
      return row;
    });
    const what = `${rows.length} row${rows.length === 1 ? '' : 's'}`;
    if (!(await confirm(`Paste ${what}`, `Add ${what} from the clipboard to the Workload Tracker as new items?`, { okText: 'Paste' }))) return;
    try {
      let ids = (await post('/api/workload/batch', { rows })).createdIds || [];
      pushTbl({
        label: `paste ${what}`,
        undo: async () => { await post('/api/workload/bulk-delete', { ids }); },
        redo: async () => { ids = (await post('/api/workload/batch', { rows })).createdIds || []; },
      });
      toast(`${what} pasted`);
      load();
      loadStats();
    } catch (e) { toast(e.message, 'err'); }
  };

  // right-click a row: select it (unless it is already part of the selection) and open the same menu Excel mode has
  const rowMenu = (e, r) => {
    const t = e.target;
    if (t.closest && t.closest('.editing, .cell-editor-inline, input, select, textarea')) return;   // inside an open editor keep the browser's own menu
    e.preventDefault();
    if (!rowLocked(r) && !(allMatching || picked.has(r.id))) { setAllMatching(false); setPicked(new Set([r.id])); lastPick.current = r.id; }
    setTctx({ x: e.clientX, y: e.clientY });
  };
  const menuPasteRows = async () => {
    setTctx(null);
    let text = null;
    try { if (navigator.clipboard && navigator.clipboard.readText && window.isSecureContext) text = await navigator.clipboard.readText(); } catch (err) { text = null; }
    if (text == null || text === '') text = internalClip.current;   // plain-http addresses can't read the clipboard: use what was last copied here
    if (text == null || text === '') { toast('Nothing to paste yet — copy some rows first, or press Ctrl+V', 'err'); return; }
    pasteRows(text);
  };

  // mouse: press on a row and drag over others to select them; Shift+click extends, Ctrl/Cmd+click adds or removes one row
  const rowDown = (e, r, idx) => {
    if (e.button !== 0) return;
    const t = e.target;
    if (t.closest && t.closest('.actions-cell, .editing, .cell-editor-inline, input, select, textarea, button, a')) return;
    const holdClick = () => { tblSuppress.current = true; setTimeout(() => { tblSuppress.current = false; }, 150); };
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      holdClick();
      if (!rowLocked(r)) {
        setAllMatching(false);
        setPicked((cur) => { const n = new Set(cur); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; });
        lastPick.current = r.id;
      }
      return;
    }
    if (e.shiftKey && lastPick.current != null) {
      const from = pageRows.findIndex((x) => x.id === lastPick.current);
      if (from >= 0) { e.preventDefault(); holdClick(); setAllMatching(false); setPicked(new Set(rangeIds(from, idx))); return; }
    }
    tblDrag.current = { idx, x: e.clientX, y: e.clientY, moved: false, last: idx, id: r.id };
  };
  tblMouse.current.move = (e) => {
    const d = tblDrag.current;
    if (!d) return;
    if (!(e.buttons & 1)) { tblDrag.current = null; return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const tr = el && el.closest ? el.closest('#tbl tr[data-id]') : null;
    const now = tr ? pageRows.findIndex((r) => String(r.id) === tr.dataset.id) : d.last;
    if (!d.moved && now === d.idx && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;   // still a click
    if (!d.moved) { d.moved = true; tblSuppress.current = true; lastPick.current = d.id; const box = document.getElementById('tbl'); if (box) box.classList.add('selecting'); }
    d.last = now;
    if (window.getSelection) window.getSelection().removeAllRanges();
    setAllMatching(false);
    setPicked(new Set(rangeIds(d.idx, now)));
  };
  tblMouse.current.up = () => {
    const d = tblDrag.current;
    tblDrag.current = null;
    const box = document.getElementById('tbl');
    if (box) box.classList.remove('selecting');
    if (d && d.moved) setTimeout(() => { tblSuppress.current = false; }, 150);
  };
  tblMouse.current.down = (e) => {   // a click anywhere outside the table (and its bar / dialogs) drops the selection
    if (!(picked.size || allMatching)) return;
    const t = e.target;
    if (t && t.closest && !t.closest('#tbl, .sel-bar, .modal-backdrop, .xl-menu')) clearPicks();
  };
  const saveGrid = async () => {
    const idx = [];
    const rows = [];
    grid.rows.forEach((r, i) => {
      if (!r._dirty || (r._new && isEmptyRow(r))) return;
      const { _key, _dirty, _new, _autoPsd, _autoProg, ...rest } = r; // eslint-disable-line no-unused-vars
      idx.push(i);
      rows.push(rest);
    });
    if (!rows.length) { toast('Nothing to save'); return; }
    setSaving(true);
    try {
      const out = await post('/api/workload/batch', { rows });
      toast(`Saved — ${out.created} added, ${out.updated} updated`);
      await load();
    } catch (e) {
      // Server numbers rows within the changed set; show the grid row number instead
      toast(String(e.message).replace(/^Row (\d+):/, (_, n) => `Grid row ${idx[+n - 1] + 1}:`), 'err');
    } finally { setSaving(false); }
  };

  // The table (Table and Excel mode) scrolls inside its own box that ends near the bottom of the window — a tall table used to put its sideways scroll
  // bar below the last row, out of sight until you scrolled the whole page down. Measured again when the window, the mode, the tab or a filter changes.
  const hasMeta = !!meta;
  useLayoutEffect(() => {
    const fit = () => {
      const el = document.querySelector('.wl-fit');
      if (!el) return;
      el.style.maxHeight = 'none';
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.maxHeight = `${Math.max(240, Math.round(window.innerHeight - top - 80))}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [hasMeta, mode, tab, cards, winW, filt.units, filt.platform, filt.plug_type, filt.from, filt.to, !!data, !!grid]);

  if (!meta) return <main className="container wide"><Empty>Loading…</Empty></main>;

  // Table-mode shortcuts — the same ones Excel mode has: Ctrl/Cmd+A select all, +C copy, +X cut, +V paste, +Z undo, +Y redo, Delete, Esc
  // (ignored while typing in a field, with a cell editor or dialog open, and in Excel mode / the plug list, which have their own)
  const tableKeysOk = (e) => {
    if (isGrid || !canWrite) return false;
    const el = e.target;
    if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return false;
    return !(document.querySelector('.modal-backdrop') || form || addingColumn || managingLocks || deletingAll || editing);
  };
  keysRef.current = (e) => {
    if (e.defaultPrevented || e.altKey || !tableKeysOk(e)) return;
    const key = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (key === 'a') {
        e.preventDefault();
        if (pageAllPicked && !allMatching && isAdminUser && total > pageRows.length) selectAllMatching(); else selectPage();   // pressed again: every matching row (Admin)
      } else if (key === 'c') {
        if (picked.size && !(window.getSelection && String(window.getSelection()))) { e.preventDefault(); copyPicked(); }
      } else if (key === 'x') {
        if (picked.size) { e.preventDefault(); cutPicked(); }
      } else if (key === 'z') { e.preventDefault(); if (e.shiftKey) redoTbl(); else undoTbl(); }
      else if (key === 'y') { e.preventDefault(); redoTbl(); }
      return;   // Ctrl+V arrives as a paste event (below)
    }
    if (key === 'escape') clearPicks();
    else if ((key === 'delete' || key === 'backspace') && pickedCount) { e.preventDefault(); deleteSelected(); }
  };
  pasteRef.current = (e) => {
    if (!tableKeysOk(e)) return;
    const text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!text || !text.trim()) return;
    e.preventDefault();
    pasteRows(text);
  };

  const isAll = tab === 'ALL';
  const cols = meta.views[viewKey];   // raw column list (Table mode's tableCols below merges the two Breakdate / Time columns; Excel mode does the same)
  // Table mode only: Breakdate/Time (VGFX) and (VEDIT) merge into ONE column/cell, holding one or two pills —
  // 'breakdate_vgfx' is kept as that column's position; breakdateCell() below decides what actually shows in it.
  const tableCols = cols.filter((k) => k !== 'breakdate_vedit');
  const selNow = isGrid ? normSel() : null;                                   // Excel mode: what is selected right now
  const selRows = selNow && grid && grid.rows ? grid.rows.slice(selNow.rLo, selNow.rHi + 1) : [];
  const allPrio = selRows.length > 0 && selRows.every((r) => r.is_priority);
  const wholeRowsSel = !!selNow && selNow.cLo === 0 && selNow.cHi === tableCols.length - 1 && selRows.length > 0;   // a row number was clicked
  const head = (k) => (k === 'breakdate_vgfx' ? 'Breakdate / Time' : meta.fields[k].label);   // table header only; Excel mode reads meta.fields directly and keeps the (VGFX)/(VEDIT) labels
  const firstLineOf = (t) => String(t || '').split('\n');
  // every cell except Remarks stays on one line: line breaks in pasted text are shown as " · "
  const oneLine = (t) => String(t ?? '').replace(/\s*\n+\s*/g, ' · ');

  // Cells wrap (pasted line breaks kept) instead of being cut off; data-label feeds the card layout.
  const cellView = (r, k) => {
    const val = r[k];
    const common = { key: k, 'data-k': k, 'data-label': head(k) };
    switch (k) {
      case 'work_date': return <td {...common}><WorkDate value={val} />{isLocked(val, meta.locks) ? <span className="row-lock" title={`Locked: ${lockNote(val, meta.locks)}`}><LockIcon /></span> : null}</td>;
      case 'platform': return <td {...common}><PlatformCell value={val} /></td>;
      case 'units_concerned': return <td {...common}>{val ? <UnitsPills value={val} unitTeams={meta.unitTeams} /> : <span className="chip c-gray unset" title="Copied from the PSD Daily Plug List — click to choose the team(s). It shows under All until then.">Set units</span>}</td>;
      case 'plug_type': return <td {...common}><TypePill value={val} /></td>;
      case 'plug_id': {
        const [first, ...rest] = firstLineOf(val);
        return (
          <td {...common}>
            <span className="strong">{first}</span>
            {rest.length ? <span className="dim-inline"> · {rest.join(' · ')}</span> : null}
          </td>
        );
      }
      case 'prog_name':
        return (
          <td {...common}>
            {val ? <span className="strong">{oneLine(val)}</span> : null}
          </td>
        );
      case 'script':
      case 'art_stb': return <td {...common}>{val ? (ISO.test(val) ? <DateChip>{fmtDate(val)}</DateChip> : oneLine(val)) : null}</td>;   // a date shows as a chip, text as text
      case 'audio_guide': return <td {...common}><DateChip hue="fuchsia">{val ? (ISO.test(val) ? fmtDate(val) : oneLine(val)) : null}</DateChip></td>;
      case 'breakdate_vgfx': return <td {...common}><DateChip hue="purple">{fmtBreakdate(val)}</DateChip></td>;   // same colour as VGFX in Units Concerned
      case 'breakdate_vedit': return <td {...common}><DateChip hue="orange">{fmtBreakdate(val)}</DateChip></td>;   // same colour as VEDIT in Units Concerned
      case 'remarks': return <td {...common}>{val ? <div className="rem">{val}</div> : null}</td>;
      default:
        return <td {...common}>{meta.fields[k].kind === 'date' ? <DateChip>{fmtDate(val)}</DateChip> : oneLine(val)}</td>;
    }
  };

  // Managers click a cell to edit just that cell (nothing else opens); viewers just read.
  const rowLocked = (r) => isLocked(r.work_date, meta.locks);
  const cell = (r, k) => {
    const td = cellView(r, k);
    if (!canWrite) return td;
    if (rowLocked(r)) return cloneElement(td, { title: `Locked: ${lockNote(r.work_date, meta.locks)}` });
    if (editing && editing.id === r.id && editing.k === k) {
      return (
        <td key={k} data-k={k} data-label={head(k)} className="editing" onClick={(e) => e.stopPropagation()}>
          <CellEditor def={meta.fields[k]} initial={r[k]} lookups={lookups} onSave={(value) => saveCell(r, k, value)} onCancel={() => setEditing(null)} />
        </td>
      );
    }
    if (k === 'plug_id') {   // no free-text Plug ID: choose it from the PSD Daily Plug List in the edit form
      const openForm = () => setForm({ rec: r });
      return cloneElement(td, {
        className: 'editable', title: 'Click to choose the plug from the PSD Daily Plug List', tabIndex: 0,
        onClick: (e) => { e.stopPropagation(); openForm(); },
        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); openForm(); } },
      });
    }
    const open = () => setEditing({ id: r.id, k });
    return cloneElement(td, {
      className: 'editable', title: 'Click to edit', tabIndex: 0,
      onClick: (e) => { e.stopPropagation(); open(); },
      onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } },
    });
  };

  // The merged Breakdate/Time column/cell: one or two pills (VGFX purple, VEDIT orange) depending on which
  // team(s) the row involves. Each pill is its own click target, editing only that underlying field — the
  // outer cell isn't one clickable unit the way every other column is, since it can hold two values at once.
  const breakdateCell = (r) => {
    const teams = meta.unitTeams[r.units_concerned] || [];
    const parts = [];
    if (teams.includes('VGFX')) parts.push({ k: 'breakdate_vgfx', hue: 'purple', tag: 'VGFX' });
    if (teams.includes('VEDIT')) parts.push({ k: 'breakdate_vedit', hue: 'orange', tag: 'VEDIT' });
    const locked = canWrite && rowLocked(r);
    return (
      <td key="breakdate_vgfx" data-k="breakdate_vgfx" className={r.is_priority ? 'prio' : undefined} title={locked ? `Locked: ${lockNote(r.work_date, meta.locks)}` : undefined}>
        <span className="chips bd-chips">
          {!parts.length && !r.units_concerned ? <DateChip hue="gray">PENDING</DateChip> : null}
          {parts.map(({ k, hue, tag }) => {
            if (editing && editing.id === r.id && editing.k === k) {
              return (
                <span key={k} className="cell-editor-inline" onClick={(e) => e.stopPropagation()}>
                  <CellEditor def={meta.fields[k]} initial={r[k]} lookups={lookups} onSave={(value) => saveCell(r, k, value)} onCancel={() => setEditing(null)} />
                </span>
              );
            }
            const clickable = canWrite && !locked;
            return (
              <span
                key={k} className={clickable ? 'wl-pill-edit' : ''} tabIndex={clickable ? 0 : undefined} title={clickable ? 'Click to edit' : undefined}
                onClick={clickable ? (e) => { e.stopPropagation(); setEditing({ id: r.id, k }); } : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === 'Enter') { e.preventDefault(); setEditing({ id: r.id, k }); } } : undefined}
              >
                {r[k]
                  ? <DateChip hue={hue}><span className="chip-tag">{tag}</span>{fmtBreakdate(r[k])}</DateChip>
                  : <DateChip hue="gray"><span className="chip-tag">{tag}</span>PENDING</DateChip>}
              </span>
            );
          })}
        </span>
      </td>
    );
  };

  const tabCount = { ALL: stats && stats.total, VGFX: stats && stats.vgfx, VEDIT: stats && stats.vedit, AUDIO: stats && stats.audio };

  return (
    <main className="container wide wl-page">
      <div className="page-head">
        <div><h1>Workload Tracker</h1><div className="sub">Track and monitor promotional plug workloads across VGFX, VEDIT and Audio.</div></div>
        <div className="actions"><PresenceAvatars path="/workload" /></div>
      </div>

      {!lookups.workload_platform.length || !lookups.plug_type.length ? (
        <div className="alert warn mb-12">
          {!lookups.workload_platform.length ? 'No Workload Platform options exist yet. ' : ''}
          {!lookups.plug_type.length ? 'No Plug Type options exist yet. ' : ''}
          {s.canPage('/admin') ? <>Add them in <Link to="/admin#dropdowns">Admin → Dropdowns</Link>.</> : 'Ask an Admin to add them.'}
        </div>
      ) : null}

      <div className="card wl-card">
        <div className="wl-tabbar">
          <div className="tabs" id="section-tabs">
            {meta.tabs.map((t) => (
              <button key={t.key} type="button" className={tab === t.key ? 'on' : ''} onClick={() => changeTab(t.key)}>
                {t.label}<span className="count">{tabCount[t.key] ?? '–'}</span>
              </button>
            ))}
          </div>
          <div className="wl-tabactions">
            <div className="segmented" id="mode-seg">
              <button type="button" className={mode === 'table' ? 'on' : ''} onClick={() => changeMode('table')}>Table</button>
              <button type="button" className={mode === 'excel' ? 'on' : ''} onClick={() => changeMode('excel')}>Excel</button>
            </div>
            {canWrite ? (
              <>
                <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={(e) => importFile(e.target.files[0])} />
                <button type="button" className="btn" id="import-btn" disabled={importing} onClick={() => fileRef.current.click()}>
                  <UploadIcon /> {importing ? 'Importing…' : 'Import'}
                </button>
              </>
            ) : null}
            <button type="button" className="btn" id="export-btn" onClick={exportXlsx}><DownloadIcon /> Export</button>
            {s.canPage('/admin') ? (
              <>
                <button type="button" className="btn" id="add-column-btn" onClick={() => setAddingColumn(true)}><ColumnIcon /> Add Column</button>
              </>
            ) : null}
            {canWrite && isGrid && !isAll ? <button type="button" className="btn" id="add-row" onClick={addRow}><PlusIcon /> Add Row</button> : null}
            {canWrite && isGrid && selRows.length ? <button type="button" className="btn" id="priority-btn" data-keep-sel onClick={togglePriority} title="Highlights the Breakdate / Time of the selected row(s)">{allPrio ? 'Remove Priority' : 'Set Priority'}</button> : null}
            {canWrite && isGrid && wholeRowsSel ? <button type="button" className="btn danger" id="delete-rows-btn" data-keep-sel onClick={deleteSelectedRows}>Delete {selRows.length > 1 ? `${selRows.length} Rows` : 'Row'}</button> : null}
            {s.canPage('/admin') ? <button type="button" className="btn" id="lock-dates-btn" onClick={() => setManagingLocks(true)}><LockIcon /> Lock Dates</button> : null}
            {canWrite && !isGrid ? (
              <button type="button" className="btn primary" id="new-btn" onClick={() => setForm({ rec: null })}><PlusIcon /> New Workload</button>
            ) : null}
            {canWrite && isGrid ? (
              <button type="button" className="btn primary" id="save-grid" disabled={saving || !dirtyCount} onClick={saveGrid}>
                {saving ? 'Saving…' : `Save changes${dirtyCount ? ` (${dirtyCount})` : ''}`}
              </button>
            ) : null}
          </div>
        </div>

        <div className="wl-filters">
          {!isGrid ? (
            <label className="wl-search">
              <SearchIcon />
              <input type="search" placeholder="Search plug ID, PSD, program, billable party, remarks…" value={filt.q} onChange={setF('q')} />
            </label>
          ) : null}
          <FilterSelect label="Units" value={filt.units} onChange={setF('units')}><Options list={[...meta.units, meta.notSet]} blank="All" /></FilterSelect>
          <FilterSelect label="Platform" value={filt.platform} onChange={setF('platform')}><Options list={lookups.workload_platform} blank="All" /></FilterSelect>
          <FilterSelect label="Plug Type" value={filt.plug_type} onChange={setF('plug_type')}><Options list={lookups.plug_type} blank="All" /></FilterSelect>
          <DateRange from={filt.from} to={filt.to} onChange={setRange} />
        </div>

        {isGrid ? (
          <>
            <div className={`table-wrap xl-box${cards ? '' : ' wl-fit'}`} id="grid" ref={boxRef} tabIndex={-1} onCopy={gridCopy(tableCols)} onCut={gridCopy(tableCols, true)} onPaste={gridPaste(tableCols)} onKeyDown={gridKey}
              onContextMenu={(e) => { if (!gridSel || !grid || grid.error || !grid.rows.length) return; e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY }); }}>
              {!grid ? <Empty>Loading…</Empty>
                : grid.error ? <Empty>{grid.error}</Empty>
                  : (
                    <table className={`t xl v-${viewKey.toLowerCase()}`}>
                      <thead>
                        <tr>
                          <th className="rn" title="Select all" onMouseDown={(e) => startSel('all', 0, 0, e)} />
                          {tableCols.map((k, ci) => (
                            <th key={k} className={`xl-colhead${colInSel(ci) ? ' hl' : ''}`} title="Click to select the column"
                              data-c={ci} onMouseDown={(e) => startSel('col', 0, ci, e)}>{head(k)}</th>
                          ))}
                          {canWrite ? <th /> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {grid.rows.length ? grid.rows.map((r, ri) => (
                          <tr key={r._key} data-ri={ri} className={`${r._dirty ? 'dirty' : ''}${r.is_priority ? ' prio-row' : ''}`.trim()}>
                            <td className={`rn${rowInSel(ri) ? ' hl' : ''}`} title="Click to select the whole row (Ctrl+C to copy)"
                              onMouseDown={(e) => startSel('row', ri, 0, e)}>{ri + 1}{r.is_priority ? <i className="prio-dot" title="Priority" /> : null}</td>
                            {tableCols.map((k, ci) => (
                              <td key={k} data-k={k} data-r={ri} data-c={ci} onMouseDown={cellMouseDown(ri, ci)} onBlur={() => { hist.current.tag = null; }}
                                onFocus={(e) => { if (isTextTarget(e.target)) setGridSel((sel) => (sel && sel.r0 === ri && sel.r1 === ri && sel.c0 === ci && sel.c1 === ci ? sel : { r0: ri, c0: ci, r1: ri, c1: ci })); }}
                                className={`${selClass(ri, ci)}${r.is_priority && k === 'breakdate_vgfx' ? ' prio' : ''}`.trim()}>
                                {k === 'breakdate_vgfx' ? (
                                  <BreakdateCellInput text={bdText(r, meta.unitTeams)} epoch={epoch} disabled={!canWrite} onText={(t) => setCell(r._key, k, t)}
                                    placeholder={!r.units_concerned || (meta.unitTeams[r.units_concerned] || []).some((t) => t === 'VGFX' || t === 'VEDIT') ? 'PENDING' : undefined} />
                                ) : (
                                  <GridCellInput
                                    def={meta.fields[k]} value={r[k]} disabled={!canWrite}
                                    onChange={(e) => setCell(r._key, k, e.target.value)}
                                  />
                                )}
                              </td>
                            ))}
                            {canWrite ? <td className="right nowrap"><button type="button" className="btn sm ghost" onClick={() => removeRow(r)}>{r._new ? 'Remove' : 'Delete'}</button></td> : null}
                          </tr>
                        )) : <tr><td colSpan={tableCols.length + 2} className="empty">{isAll
                          ? <>No rows are waiting for a team. Plugs copied from the PSD Daily Plug List show up here until you set their Units Concerned — pick VGFX, VEDIT or Audio to edit a team’s rows.</>
                          : <>No {meta.tabs.find((t) => t.key === tab).label} rows match these filters.{canWrite ? ' Use “Add Row” to start.' : ''}</>}</td></tr>}
                      </tbody>
                    </table>
                  )}
            </div>
            {ctx ? (() => {
              const nSel = normSel();
              const wholeRows = !!nSel && nSel.cLo === 0 && nSel.cHi === tableCols.length - 1;
              return (
                <FitMenu x={ctx.x} y={ctx.y} onMouseDown={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()}>
                  <button type="button" disabled={!canWrite || !hist.current.past.length} onClick={() => { setCtx(null); undo(); }}>Undo<span>Ctrl+Z</span></button>
                  <button type="button" disabled={!canWrite || !hist.current.future.length} onClick={() => { setCtx(null); redo(); }}>Redo<span>Ctrl+Y</span></button>
                  <hr />
                  <button type="button" disabled={!canWrite} onClick={() => menuCopy(tableCols, true)}>Cut<span>Ctrl+X</span></button>
                  <button type="button" onClick={() => menuCopy(tableCols, false)}>Copy<span>Ctrl+C</span></button>
                  <button type="button" disabled={!canWrite} onClick={() => menuPaste(tableCols)}>Paste<span>Ctrl+V</span></button>
                  {wholeRows ? <button type="button" disabled={!canWrite} onClick={() => menuInsertRows(tableCols)}>Insert copied row(s) above</button> : null}
                  <hr />
                  <button type="button" disabled={!canWrite} onClick={togglePriority}>{allPrio ? 'Remove priority' : 'Set priority'}</button>
                  <hr />
                  <button type="button" disabled={!canWrite} onClick={() => { setCtx(null); clearSel(); }}>Delete<span>Del</span></button>
                  {wholeRows ? <button type="button" disabled={!canWrite} onClick={deleteSelectedRows}>Delete row{nSel.rHi > nSel.rLo ? 's' : ''}</button> : null}
                </FitMenu>
              );
            })() : null}
            {grid && grid.total > GRID_LIMIT ? (
              <div className="pager"><span>Showing the first {GRID_LIMIT} of {grid.total} rows — narrow the date range to edit the rest.</span></div>
            ) : null}
          </>
        ) : (
          <>
            {canWrite && data && data.rows && data.rows.length ? (
              <div className="sel-bar">
                {pickedCount ? (
                  <span className="sel-count">
                    {allMatching ? <>All <strong>{total}</strong> matching rows selected</> : <><strong>{pickedCount}</strong> selected</>}
                    {!allMatching && pageAllPicked && isAdminUser && total > pageRows.length ? <span className="dim">Press Ctrl+A again to select all {total} matching rows</span> : null}
                    <button type="button" className="linkbtn" onClick={clearPicks}>Clear</button>
                  </span>
                ) : <span className="dim sel-count">Tick the boxes (or drag across rows; Shift / Ctrl+click to extend) · Ctrl+A selects all</span>}
                <span className="grow" />
                <button type="button" className="btn danger sm" disabled={!pickedCount} onClick={() => deleteSelected()}>Delete selected{pickedCount ? ` (${pickedCount})` : ''}</button>
                {isAdminUser ? <button type="button" className="btn danger sm" onClick={() => setDeletingAll(true)} title="Delete every row that matches the current tab and filters">Delete all…</button> : null}
              </div>
            ) : null}
            <div className={`table-wrap${cards ? '' : ' wl-fit'}`} id="tbl" onClickCapture={(e) => {
              if (tblSuppress.current) { tblSuppress.current = false; e.stopPropagation(); e.preventDefault(); return; }   // the click that ended a drag / Shift / Ctrl+click
              if (canWrite && (picked.size || allMatching) && !(e.target.closest && e.target.closest('.actions-cell, .chk'))) clearPicks();
            }}>
              {!data ? <Empty>Loading…</Empty>
                : data.error ? <Empty>{data.error}</Empty>
                  : !data.rows.length ? <Empty>No workload items match these filters.</Empty>
                    : (
                      <table className={`t wl v-${viewKey.toLowerCase()}${cards ? ' cards' : ''}`}>
                        <thead><tr>{canWrite ? <th className="chk"><input type="checkbox" checked={pageAllPicked} disabled={!pickable.length} onChange={() => (pageAllPicked ? clearPicks() : selectPage())} aria-label="Select all rows on this page" /></th> : null}{tableCols.map((k) => <SortTh key={k} k={k} sort={sort} onSort={setSort}>{head(k)}</SortTh>)}{canWrite ? <th className="right">Actions</th> : null}</tr></thead>
                        <tbody>
                          {data.rows.map((r, idx) => (
                            <tr key={r.id} data-id={r.id}
                              className={`${canWrite ? '' : 'clickable'}${allMatching || picked.has(r.id) ? ' picked' : ''}`.trim()}
                              onMouseDown={canWrite ? (e) => rowDown(e, r, idx) : undefined}
                              onContextMenu={canWrite ? (e) => rowMenu(e, r) : undefined}
                              onClick={canWrite ? undefined : () => setForm({ rec: r })}>
                              {canWrite ? (
                                <td className="chk">
                                  <input type="checkbox" checked={allMatching || picked.has(r.id)} disabled={rowLocked(r)} title={rowLocked(r) ? 'Locked period: cannot be selected' : undefined} aria-label={`Select row ${r.plug_id || r.id}`}
                                    onChange={() => { setAllMatching(false); setPicked((cur) => { const n = new Set(allMatching ? pickable.map((x) => x.id) : cur); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; }); lastPick.current = r.id; }} />
                                </td>
                              ) : null}
                              {tableCols.map((k) => (k === 'breakdate_vgfx' ? breakdateCell(r) : cell(r, k)))}
                              {canWrite ? (
                                <td className="right nowrap actions-cell" onClick={(e) => e.stopPropagation()}>
                                  <RowMenu
                                  onEdit={() => (rowLocked(r) ? toast(`Locked: ${lockNote(r.work_date, meta.locks)}. An Admin must unlock it first.`, 'err') : setForm({ rec: r }))}
                                  onDuplicate={() => setForm({ rec: null, duplicateFrom: r })}
                                  onDelete={() => (rowLocked(r) ? toast(`Locked: ${lockNote(r.work_date, meta.locks)}. An Admin must unlock it first.`, 'err') : deleteItem(r))}
                                />
                                </td>
                              ) : null}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
            </div>
            <Pager total={total} offset={offset} size={PAGE} onOffset={setOffset} />
            {tctx ? (
              <FitMenu x={tctx.x} y={tctx.y} onMouseDown={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()}>
                <button type="button" disabled={!tblHist.current.past.length} onClick={() => { setTctx(null); undoTbl(); }}>Undo<span>Ctrl+Z</span></button>
                <button type="button" disabled={!tblHist.current.future.length} onClick={() => { setTctx(null); redoTbl(); }}>Redo<span>Ctrl+Y</span></button>
                <hr />
                <button type="button" disabled={!picked.size || allMatching} onClick={() => { setTctx(null); cutPicked(); }}>Cut<span>Ctrl+X</span></button>
                <button type="button" disabled={!picked.size} onClick={() => { setTctx(null); copyPicked(); }}>Copy<span>Ctrl+C</span></button>
                <button type="button" onClick={menuPasteRows}>Paste<span>Ctrl+V</span></button>
                <hr />
                <button type="button" disabled={!pickedCount} onClick={() => { setTctx(null); deleteSelected(); }}>Delete {pickedCount > 1 ? `${pickedCount} rows` : 'row'}<span>Del</span></button>
              </FitMenu>
            ) : null}
          </>
        )}
      </div>

      {deletingAll ? (
        <DeleteAllModal
          total={total}
          scope={[tab === 'ALL' ? 'All tab' : `${meta.tabs.find((t) => t.key === tab).label} tab`, filt.units && `Units: ${filt.units}`, filt.platform && `Platform: ${filt.platform}`, filt.plug_type && `Plug Type: ${filt.plug_type}`,
            (filt.from || filt.to) && `Dates: ${filt.from || '…'} → ${filt.to || '…'}`, q && `Search: “${q}”`].filter(Boolean)}
          filters={{ team: tab === 'ALL' ? undefined : tab, units: filt.units || undefined, platform: filt.platform || undefined, plug_type: filt.plug_type || undefined, from: filt.from || undefined, to: filt.to || undefined, q: q || undefined }}
          onClose={() => setDeletingAll(false)}
          onDone={(out) => { setDeletingAll(false); afterBulk(out); }}
        />
      ) : null}
      {form ? (
        <WorkloadForm
          rec={form.rec}
          duplicateFrom={form.duplicateFrom}
          defaultUnits={tab === 'ALL' ? '' : meta.tabDefaultUnits[tab]}
          meta={meta}
          lookups={lookups}
          canWrite={canWrite}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); load(); }}
        />
      ) : null}
      {addingColumn ? (
        <AddColumnModal
          columns={meta.customColumns || []}
          onClose={() => setAddingColumn(false)}
          onAdded={() => { setAddingColumn(false); loadMeta(); }}
          onChanged={() => { loadMeta(); load(); }}
        />
      ) : null}
      {managingLocks ? (
        <LockManagerModal
          locks={meta.locks}
          onClose={() => setManagingLocks(false)}
          onChanged={loadMeta}
        />
      ) : null}
    </main>
  );
}

// Admin-only: name a new column. It shows up everywhere (Table, Excel grid, the add/edit form, Excel export)
// as a plain open-text field, appended after the template's own columns.
function DeleteAllModal({ total, scope, filters, onClose, onDone }) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { onDone(await post('/api/workload/bulk-delete', { all: true, filters })); } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal title="Delete all rows" onClose={onClose}
      footer={(<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn danger" disabled={busy || typed.trim() !== 'DELETE' || !total} onClick={go}>Delete {total} row{total === 1 ? '' : 's'}</button></>)}>
      <p>This permanently deletes <strong>{total}</strong> Workload row{total === 1 ? '' : 's'} — every row that matches what you are looking at now:</p>
      <ul className="plug-warn" style={{ color: 'inherit' }}>{scope.map((x) => <li key={x}>{x}</li>)}</ul>
      <p>Rows in a locked period are skipped. It cannot be undone — consider an Export first.</p>
      <label className="f"><span>Type <strong>DELETE</strong> to confirm</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim() === 'DELETE' && !busy) go(); }} /></label>
    </Modal>
  );
}

function AddColumnModal({ columns, onClose, onAdded, onChanged }) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const removeColumn = async (col) => {
    if (!(await confirm(`Delete the "${col.label}" column?`, 'It disappears from the Table, Excel grid, form and export. Values already entered are kept in the database but hidden.', { danger: true }))) return;
    try { await del(`/api/admin/workload-columns/${col.id}`); toast('Column deleted'); onChanged(); } catch (e) { toast(e.message, 'err'); }
  };
  const submit = async () => {
    const name = label.trim();
    if (!name) { toast('Enter a name for the column', 'err'); return; }
    setBusy(true);
    try {
      const out = await post('/api/admin/workload-columns', { label: name });
      toast('Column added');
      onAdded(out.column);
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  return (
    <Modal
      title="Add Column"
      onClose={onClose}
      footer={(
        <>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={submit}>Add</button>
        </>
      )}
    >
      {columns.length ? (
        <>
          <div className="dim" style={{ marginBottom: 8 }}>Added columns</div>
          <ul className="lock-list">
            {columns.map((c) => (
              <li key={c.id}>
                <span><strong>{c.label}</strong></span>
                <button type="button" className="btn" onClick={() => removeColumn(c)}>Delete</button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label className="f full">
          <span>Column name</span>
          <input autoFocus maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Client Approval" />
        </label>
        <div className="full dim">Shows up as a plain text column everywhere — Table, Excel, the form, and the export — for every row.</div>
      </form>
    </Modal>
  );
}

// Admin-only: freeze a date range so its rows can't be edited/deleted, and no new row can be created dated
// inside it. Applies to everyone (Admins included) until the range is unlocked here.
function LockManagerModal({ locks, onClose, onChanged }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!from || !to) { toast('Pick both a From and a To date', 'err'); return; }
    setBusy(true);
    try {
      await post('/api/admin/workload-locks', { from_date: from, to_date: to, note });
      toast('Date range locked');
      setFrom(''); setTo(''); setNote('');
      onChanged();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const remove = async (lock) => {
    if (!(await confirm('Unlock this date range?', `${fmtDate(lock.from_date)} – ${fmtDate(lock.to_date)} will be editable again.`, { danger: true }))) return;
    try { await del(`/api/admin/workload-locks/${lock.id}`); toast('Date range unlocked'); onChanged(); } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <Modal title="Lock Dates" onClose={onClose} footer={<><span className="grow" /><button type="button" className="btn" onClick={onClose}>Close</button></>}>
      <div className="dim" style={{ marginBottom: 12 }}>Rows dated inside a locked range can't be edited, deleted, or added to by anyone — Admins included — until you unlock the range.</div>
      {locks.length ? (
        <ul className="lock-list">
          {locks.map((l) => (
            <li key={l.id}>
              <span><strong>{fmtDate(l.from_date)}</strong> – <strong>{fmtDate(l.to_date)}</strong>{l.note ? <span className="dim"> · {l.note}</span> : null}</span>
              <button type="button" className="btn" onClick={() => remove(l)}>Unlock</button>
            </li>
          ))}
        </ul>
      ) : <div className="dim" style={{ marginBottom: 12 }}>No locked date ranges yet.</div>}
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <label className="f"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="f"><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="f full"><span>Note (optional)</span><input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. September closed" /></label>
        <div className="full"><button type="button" className="btn primary" disabled={busy} onClick={add}>Add lock</button></div>
      </form>
    </Modal>
  );
}

function WorkloadForm({ rec, duplicateFrom, defaultUnits, meta, lookups, canWrite, onClose, onSaved }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const initial = Object.keys(meta.fields).reduce((o, k) => ({ ...o, [k]: (rec && rec[k]) ?? (duplicateFrom && duplicateFrom[k]) ?? '' }), {});
  if (!rec && !duplicateFrom) { initial.work_date = isoDate(); initial.units_concerned = defaultUnits; }
  initial.is_priority = !!(rec && rec.is_priority);   // a duplicate is a new item, so it starts un-prioritised
  const [f, , setAll] = useForm(initial);
  // Plug ID is not typed: it is picked from the PSD Daily Plug List of the chosen Work Date, which fills PSD and PROG. NAME / PROJ. TITLE too
  const session = useSession();
  const [plugs, setPlugs] = useState(null);   // null = loading
  useEffect(() => {
    if (!ISO.test(f.work_date || '')) { setPlugs([]); return undefined; }
    let live = true;
    setPlugs(null);
    get(`/api/plugs?date=${f.work_date}&used=1`).then((d) => { if (live) setPlugs(d.rows); }).catch(() => { if (live) setPlugs([]); });
    return () => { live = false; };
  }, [f.work_date]);
  const findPlugIn = (date, plugId) => {
    const id = firstLine(plugId).trim().toUpperCase();
    return id && plugs ? plugs.find((p) => p.plug_date === date && p.plug_id.toUpperCase() === id) || null : null;
  };
  const set = (k) => (e) => {
    const val = e && e.target ? e.target.value : e;
    setAll((prev) => {
      if (k === 'work_date') {
        // another day has another list: the plug chosen for the old day (and what it filled in) is cleared
        if (val === prev.work_date) return prev;
        const old = findPlugIn(prev.work_date, prev.plug_id);
        const next = withAutoPlatform(meta.platformRules, { ...prev, work_date: val }, 'plug_id', '');
        if (old && next.psd === old.psd) next.psd = '';
        if (old && next.prog_name === old.prog_name) next.prog_name = '';
        return next;
      }
      return withAutoPlatform(meta.platformRules, prev, k, val);
    });
  };
  const pickPlug = (e) => {
    const p = (plugs || []).find((x) => String(x.id) === e.target.value);
    if (p) setAll((prev) => ({ ...withAutoPlatform(meta.platformRules, prev, 'plug_id', p.plug_id), psd: p.psd, prog_name: p.prog_name }));
    else if (e.target.value === '') setAll((prev) => withAutoPlatform(meta.platformRules, prev, 'plug_id', ''));   // "Choose…" again: no plug
  };
  const chosenPlug = findPlugIn(f.work_date, f.plug_id);

  // Audio-only units use the template's Audio sheet columns; everything else uses the main sheet columns
  const teams = meta.unitTeams[f.units_concerned] || [];
  const audioOnly = teams.length === 1 && teams[0] === 'AUDIO';
  const base = meta.views[audioOnly ? 'AUDIO' : 'VGFX'].filter((k) => k !== 'work_date' && k !== 'units_concerned'
    // Breakdate/Time (VGFX or VEDIT): only shown for a team that's actually involved
    && !(k === 'breakdate_vgfx' && !teams.includes('VGFX'))
    && !(k === 'breakdate_vedit' && !teams.includes('VEDIT')));
  // Any row that involves Audio also gets the Audio-only columns (Length, Others)
  const shown = f.units_concerned
    ? [...base, ...(teams.includes('AUDIO') ? meta.audioExtra.filter((k) => !base.includes(k)) : [])]
    : [];
  const bothVgfxVedit = teams.includes('VGFX') && teams.includes('VEDIT');
  // Only one of the two teams involved: drop the "(VGFX)"/"(VEDIT)" suffix since there's no ambiguity to resolve
  const fieldLabel = (k, def) => (!bothVgfxVedit && (k === 'breakdate_vgfx' || k === 'breakdate_vedit') ? 'Breakdate / Time' : def.label);
  const plugText = String(f.plug_id || '').trim();

  const submit = async () => {
    if (!f.work_date) { toast('Work Date is required', 'err'); return; }
    if (!f.units_concerned) { toast('Units Concerned is required', 'err'); return; }
    if (!plugText) { toast('Choose a Plug ID from the PSD Daily Plug List', 'err'); return; }
    setBusy(true);
    try {
      if (rec) await put(`/api/workload/${rec.id}`, f);
      else await post('/api/workload', f);
      toast('Saved');
      onSaved();
    } catch (e) { toast(e.message, 'err'); setBusy(false); }
  };

  const remove = async () => {
    if (!(await confirm('Delete workload item', `Permanently delete "${firstLine(rec.plug_id)}"?`, { okText: 'Delete', danger: true }))) return;
    try { await del(`/api/workload/${rec.id}`); toast('Deleted'); onSaved(); } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <Modal
      title={rec ? `${canWrite ? 'Edit' : 'View'} Workload #${rec.id}` : duplicateFrom ? 'Duplicate Workload' : 'New Workload'}
      onClose={onClose}
      footer={(
        <>
          {rec && canWrite ? <button type="button" className="btn danger" id="del" onClick={remove}>Delete</button> : null}
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>{canWrite ? 'Cancel' : 'Close'}</button>
          {canWrite ? <button type="button" className="btn primary" id="save" disabled={busy} onClick={submit}>Save</button> : null}
        </>
      )}
    >
      <form id="wl-form" className="form-grid" noValidate onSubmit={(e) => e.preventDefault()}>
        <label className="f"><span>Work Date <span className="req">*</span></span>
          <FieldInput def={meta.fields.work_date} value={f.work_date} onChange={set('work_date')} disabled={!canWrite} lookups={lookups} /></label>
        <label className="f"><span>Units Concerned <span className="req">*</span></span>
          <FieldInput def={meta.fields.units_concerned} value={f.units_concerned} onChange={set('units_concerned')} disabled={!canWrite} lookups={lookups} /></label>
        <label className="f full prio-toggle">
          <span>
            <input type="checkbox" checked={!!f.is_priority} disabled={!canWrite} onChange={(e) => setAll((prev) => ({ ...prev, is_priority: e.target.checked }))} />
            {' '}Priority <span className="dim">— highlights this item's Breakdate / Time</span>
          </span>
        </label>
        {!f.units_concerned ? <div className="full dim">Choose Units Concerned to see the fields.</div> : shown.map((k) => {
          const def = meta.fields[k];
          if (k === 'plug_id') {
            // no free-text box: the Plug ID is chosen from the PSD Daily Plug List of the Work Date
            const blocked = !f.work_date ? 'Choose the Work Date first' : plugs === null ? 'Loading the plug list…' : !plugs.length ? 'No PSD Daily Plug List for this date yet' : null;
            const legacy = !!plugText && !!plugs && !chosenPlug;   // saved earlier with a Plug ID that isn't on this day's list: keep it until another is chosen
            return (
              <label key={k} className="f full">
                <span>{fieldLabel(k, def)}<span className="req"> *</span></span>
                <select value={blocked ? '' : chosenPlug ? String(chosenPlug.id) : legacy ? '__current' : ''} onChange={pickPlug} disabled={!canWrite || !!blocked} aria-label="Plug ID — pick from the PSD Daily Plug List">
                  {blocked ? <option value="">{blocked}</option> : (
                    <>
                      <option value="">Pick from the PSD Daily Plug List ({plugs.length})…</option>
                      {legacy ? <option value="__current">{firstLine(f.plug_id)} (not on this day’s list)</option> : null}
                      {plugs.map((p) => <option key={p.id} value={p.id}>{p.plug_id} — {p.prog_name || '(no title)'} · {p.psd || '(no PSD)'}</option>)}
                    </>
                  )}
                </select>
                {plugs && !plugs.length && f.work_date
                  ? <small className="dim">{session.canPage('/plug-list') ? <>Import it, or add the plug, on the <Link to="/plug-list">PSD Daily Plug List</Link> page.</> : 'Ask someone who manages the PSD Daily Plug List to import it.'}</small> : null}
                {plugText && !f.platform ? <small className="dim">{/PD_/i.test(plugText) ? 'PD_ plugs are digital — choose DIGITAL or INTL DIGITAL.' : 'Could not tell the platform from the Plug ID — choose one.'}</small> : null}
              </label>
            );
          }
          return (
            <label key={k} className={`f${def.multiline ? ' full' : ''}`}>
              <span>{fieldLabel(k, def)}{def.required ? <span className="req"> *</span> : null}</span>
              <FieldInput def={def} value={f[k]} onChange={set(k)} disabled={!canWrite} lookups={lookups} />
            </label>
          );
        })}
      </form>
    </Modal>
  );
}
