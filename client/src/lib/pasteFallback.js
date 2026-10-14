// Some browsers (notably Safari and Firefox) don't send a paste event to a dropdown or a date box. On Ctrl/Cmd+V there we wait a moment and, if no
// paste event arrived, read the clipboard directly (the browser may ask once for permission) and hand the text to `apply(text, element)`.
export function pasteFallback(e, apply) {
  if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'v') return;
  const el = e.target;
  if (!el || !(el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'date'))) return;
  let got = false;
  const mark = () => { got = true; };
  document.addEventListener('paste', mark, true);
  setTimeout(() => {
    document.removeEventListener('paste', mark, true);
    if (got || !navigator.clipboard || !navigator.clipboard.readText) return;
    navigator.clipboard.readText().then((t) => { if (t) apply(t, el); }).catch(() => { /* permission refused */ });
  }, 150);
}
