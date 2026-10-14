// Filters, search, dates and sort stay put when the page is refreshed. Kept in sessionStorage (per browser tab, gone when the tab / app is
// closed), so a shared computer never shows the last person's filters; where storage is blocked the page simply starts fresh.
const KEY = (page) => `pulse:view:${page}`;
export function loadView(page, fallback) {
  try {
    const raw = sessionStorage.getItem(KEY(page));
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? { ...fallback, ...v } : fallback;
  } catch (e) { return fallback; }
}
export function saveView(page, value) {
  try { sessionStorage.setItem(KEY(page), JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
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
