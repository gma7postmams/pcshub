// Firefox (and Safari) send no paste to a dropdown or a date box, so Ctrl/Cmd+V does nothing there. The usual way round it: on Ctrl/Cmd+V the focus moves for a moment
// to a hidden text box, which does receive the paste; the copied text goes to `apply(text, element)` and the focus returns. No clipboard permission is needed.
export function pasteFallback(e, apply) {
  if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'v') return;
  const el = e.target;
  if (!el || !(el.tagName === 'SELECT' || (el.tagName === 'INPUT' && (el.type === 'date' || el.type === 'datetime-local')))) return;
  const ne = e.nativeEvent || e;
  if (ne.__pasteBox) return;   // nested handlers see the same key press: one hidden box only
  ne.__pasteBox = true;
  let host = e.currentTarget && e.currentTarget.nodeType === 1 ? e.currentTarget : el.parentNode;
  if (host && (host.tagName === 'INPUT' || host.tagName === 'SELECT')) host = host.parentNode;
  if (!host) return;
  const ta = document.createElement('textarea');
  ta.setAttribute('aria-hidden', 'true');
  ta.tabIndex = -1;
  ta.style.cssText = 'position:fixed;left:-1000px;top:0;width:1px;height:1px;opacity:0;';
  host.appendChild(ta);
  ta.focus();
  let done = false;
  let timer = 0;
  const finish = () => { if (done) return; done = true; clearTimeout(timer); try { el.focus({ preventScroll: true }); } catch (err) { /* gone */ } ta.remove(); };   // focus goes back first, so nothing sees the editor lose focus
  ta.addEventListener('paste', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const text = ev.clipboardData ? ev.clipboardData.getData('text/plain') : '';
    finish();
    if (text) apply(text, el);
  });
  timer = setTimeout(finish, 800);
}
