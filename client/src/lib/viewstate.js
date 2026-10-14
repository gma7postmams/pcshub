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
