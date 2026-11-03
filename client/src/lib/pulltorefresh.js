// Pull down to refresh for the installed iPhone/Android app. A home-screen app has no browser bar, and iOS gives it no pull-to-refresh of its own.
// Only runs in standalone mode, only when the page (and whatever is being touched) is scrolled to the very top.
const THRESHOLD = 80;
export function initPullToRefresh() {
  const standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  if (!standalone || !('ontouchstart' in window)) return;
  const ind = document.createElement('div');
  ind.setAttribute('aria-hidden', 'true');
  ind.style.cssText = 'position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 56px);z-index:700;width:36px;height:36px;margin-left:-18px;border-radius:50%;background:var(--surface,#fff);color:var(--accent,#2563eb);border:1px solid var(--border-2,#ccc);box-shadow:0 2px 8px rgba(0,0,0,.25);display:grid;place-items:center;font-size:18px;font-weight:700;opacity:0;pointer-events:none;transform:translateY(-60px)';
  ind.textContent = '↓';
  document.body.appendChild(ind);
  let y0 = 0, pulling = false, dist = 0;
  const blocked = (el) => {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.classList && (n.classList.contains('modal-backdrop') || n.classList.contains('full') || n.classList.contains('rowmenu'))) return true;
      if (n.scrollTop > 0) return true;                      // an inner scroller (table, panel) isn't at its top
    }
    return false;
  };
  const reset = () => { ind.style.transition = 'transform .2s, opacity .2s'; ind.style.opacity = '0'; ind.style.transform = 'translateY(-60px)'; pulling = false; dist = 0; };
  window.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || (window.scrollY || document.documentElement.scrollTop) > 0 || blocked(e.target)) { pulling = false; return; }
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { pulling = false; return; }
    y0 = e.touches[0].clientY; pulling = true; dist = 0; ind.style.transition = 'none';
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const d = e.touches[0].clientY - y0;
    if (d <= 0 || (window.scrollY || 0) > 0) { if (d <= 0) reset(); return; }
    dist = d * 0.5;
    ind.style.opacity = String(Math.min(1, dist / THRESHOLD));
    ind.style.transform = `translateY(${Math.min(dist, 110) - 60}px) rotate(${dist >= THRESHOLD ? 180 : 0}deg)`;
  }, { passive: true });
  const end = () => {
    if (!pulling) return;
    if (dist >= THRESHOLD) { ind.style.transition = 'transform .15s'; ind.style.transform = 'translateY(40px)'; ind.textContent = '⟳'; setTimeout(() => window.location.reload(), 120); }
    else reset();
  };
  window.addEventListener('touchend', end, { passive: true });
  window.addEventListener('touchcancel', reset, { passive: true });
}
