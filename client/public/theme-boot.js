/* Runs in <head> before paint: applies the last known theme + appearance so pages don't flash.
   Authoritative values are re-applied by common.js from /api/branding and /api/auth/me. */
(function () {
  var c = {};
  try { c = JSON.parse(localStorage.getItem('phub-theme') || '{}') || {}; } catch (e) { c = {}; }
  var d = document.documentElement;
  var mode = c.mode === 'dark' || c.mode === 'light' ? c.mode : 'system';
  var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  d.setAttribute('data-theme', /^[a-z]+$/.test(c.theme || '') ? c.theme : 'midnight');
  d.setAttribute('data-mode', mode === 'system' ? (prefersLight ? 'light' : 'dark') : mode);
  if (c.accent && /^#[0-9a-fA-F]{6}$/.test(c.accent)) {
    d.style.setProperty('--accent', c.accent);
    if (c.contrast) d.style.setProperty('--accent-contrast', c.contrast);
  }
})();
/* Tab icon: put the logo icon used last time on the page before it paints (src/lib/favicon.js keeps it), so a refresh doesn't fall back to the built-in icon. */
(function () {
  try {
    var href = localStorage.getItem('favicon:current');
    var link = document.querySelector('link[rel="icon"]');
    if (href && link && (/^data:image\//.test(href) || href.charAt(0) === '/')) { link.setAttribute('href', href); link.setAttribute('type', 'image/png'); }
  } catch (e) { /* storage unavailable */ }
})();
