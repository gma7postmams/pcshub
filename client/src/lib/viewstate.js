// Filters, search, dates and sort stay put when the page is refreshed. Kept in sessionStorage (per browser tab, gone when the tab / app is
// closed), so a shared computer never shows the last person's filters; where storage is blocked the page simply starts fresh.
import { put } from './api.js';
const KEY = (page) => `pulse:view:${page}`;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Sort + filters are also kept on the person's account (set from /api/auth/me), so a new tab, a restart or another device opens the way they left it.
let account = {};
let lastSent = {};
export const setAccountViews = (v) => { account = v && typeof v === 'object' ? v : {}; lastSent = {}; for (const k of Object.keys(account)) lastSent[k] = JSON.stringify(account[k]); };
const ACCT_SKIP = new Set(['from', 'to', 'q']);
const acctPart = (value) => {
  const out = {};
  if (value && value.sort) out.sort = { k: value.sort.k || '', dir: value.sort.dir === 'desc' ? 'desc' : 'asc' };
  if (value && value.filt) { out.filt = {}; for (const [k, v] of Object.entries(value.filt)) if (!ACCT_SKIP.has(k) && typeof v === 'string') out.filt[k] = v; }
  return out;
};
const timers = {};
function pushAccount(page, value) {
  const part = acctPart(value);
  const sig = JSON.stringify(part);
  if (sig === lastSent[page]) return;
  lastSent[page] = sig; account = { ...account, [page]: part };
  clearTimeout(timers[page]);
  timers[page] = setTimeout(() => { put('/api/profile/view-prefs', { page, value: part }).catch(() => { /* best effort */ }); }, 800);
}
export function loadView(page, fallback) {
  try {
    const raw = sessionStorage.getItem(KEY(page));
    if (!raw) return account[page] ? { ...fallback, ...account[page] } : fallback;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return fallback;
    // Saved on an earlier day (an installed app or a tab left open overnight): the date filters, the day being looked at and the page
    // start over, so every list opens on today. Search text, other filters and sort stay.
    if (v.day !== today()) {
      delete v.anchor; delete v.custom; delete v.period; delete v.offset;
      if (v.filt && typeof v.filt === 'object') { v.filt = { ...v.filt }; delete v.filt.from; delete v.filt.to; }
    }
    return { ...fallback, ...v };
  } catch (e) { return fallback; }
}
export function saveView(page, value) {
  try { sessionStorage.setItem(KEY(page), JSON.stringify({ ...value, day: today() })); } catch (e) { /* storage unavailable */ }
  pushAccount(page, value);
}

// ---- a dialog that is open (Add / Edit form) and what has been typed in it: reopened after a refresh, dropped when it is closed or saved ----
const DKEY = (page) => `pulse:dialog:${page}`;
const readDlg = (page) => { try { return JSON.parse(sessionStorage.getItem(DKEY(page))); } catch (e) { return null; } };
const writeDlg = (page, v) => { try { if (v) sessionStorage.setItem(DKEY(page), JSON.stringify(v)); else sessionStorage.removeItem(DKEY(page)); } catch (e) { /* storage unavailable */ } };
/** The dialog that was open: { rec, values } or null. `rec` is whatever the page keeps in its own "which form is open" state. */
export const loadDialog = (page) => { const d = readDlg(page); return d && d.rec !== undefined ? d : null; };
/** The page calls this whenever its "which form is open" state changes (null = closed). */
export function syncDialog(page, rec) {
  if (rec === null || rec === undefined) { writeDlg(page, null); return; }
  const key = JSON.stringify(rec);
  const cur = readDlg(page);
  if (!cur || cur.key !== key) writeDlg(page, { key, rec, values: null });   // a different form: start its typed values from scratch
}
export const loadDialogValues = (page) => { const d = readDlg(page); return d ? d.values : null; };
export function saveDialogValues(page, values) { const d = readDlg(page); if (d) writeDlg(page, { ...d, values }); }

// ---- an inline cell editor that is open, its typed text, and the not-yet-saved "Add Row" row: all come back after a refresh ----
const EKEY = (page) => `pulse:edit:${page}`;
export const loadEdit = (page) => { try { return JSON.parse(sessionStorage.getItem(EKEY(page))) || {}; } catch (e) { return {}; } };
export function patchEdit(page, part) {
  try { sessionStorage.setItem(EKEY(page), JSON.stringify({ ...loadEdit(page), ...part })); } catch (e) { /* storage unavailable */ }
}
/** Text typed into the open cell editor `cellKey` ("id:field"), or `fallback` when nothing was typed / another cell is remembered. */
export function loadCellText(page, cellKey, fallback) {
  const v = loadEdit(page).val;
  return v && v.key === cellKey ? v.text : fallback;
}
export const saveCellText = (page, cellKey, text) => patchEdit(page, { val: { key: cellKey, text } });
/** Keeps the remembered open cell + draft row in step with the page's state; `first` marks the restored cell so its typed text is not wiped on load. */
export function syncEdit(page, cell, draft, prevKey) {
  const key = cell ? `${cell.id}:${cell.k}` : null;
  if (key !== prevKey) patchEdit(page, { cell: cell ? { id: cell.id, k: cell.k } : null, val: null });
  patchEdit(page, { draft: draft || null });
  return key;
}
