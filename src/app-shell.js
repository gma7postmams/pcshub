const fs = require('fs');
const db = require('./db');
const path = require('path');
const { INDEX_HTML } = require('./middleware');
const appIcon = require('./app-icon');

// The app's name comes from Administration > Branding (app_settings.app_name). Everything the browser reads BEFORE the React app runs —
// the page <title>, the home-screen / PWA name (manifest), the iOS home-screen name — is filled in here, so it follows the Branding name
// instead of a name baked into the build.
const DEFAULT_NAME = 'PULSE';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function branding() {
  try {
    const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key IN ('app_name','tagline','logo_icon_path','logo_dark_icon_path')`);
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    // The square icon the browser drew from the uploaded logo (light-mode one, else dark-mode one) is the installed-app icon. No icon (no logo, or one
    // uploaded before icons were made) means the built-in PULSE icons: a logo that is not square must never be used as is, it would be stretched.
    const logo = [s.logo_icon_path, s.logo_dark_icon_path].find((u) => u && u.startsWith('/uploads/branding/')) || '';
    return { name: (s.app_name || '').trim() || DEFAULT_NAME, tagline: (s.tagline || '').trim(), logo };
  } catch (e) { return { name: DEFAULT_NAME, tagline: '', logo: '' }; }
}

/** The file the home-screen icon is made from (the uploaded logo's square icon, else the built-in one) and a tag that changes when it does. */
async function iconSource() {
  const { logo } = await branding();
  const own = logo ? path.join(__dirname, '..', 'uploads', 'branding', path.basename(logo)) : '';
  const file = own && fs.existsSync(own) ? own : path.join(path.dirname(INDEX_HTML), 'icons', 'icon-512.png');
  let m = 0; try { m = Math.round(fs.statSync(file).mtimeMs); } catch (e) { /* missing: the route falls back */ }
  return { file, tag: `${appIcon.VERSION}-${m}` };
}

/** GET /app-icon/180.png (also 192, 512): the home-screen icon with the logo filling its tile (see src/app-icon.js). */
async function appIconRoute(req, res, next) {
  try {
    const size = Number(req.params.size);
    if (![120, 152, 167, 180, 192, 512].includes(size)) return res.sendStatus(404);
    const { file } = await iconSource();
    const png = appIcon.render(file, size);
    res.set('Cache-Control', 'public, max-age=300');
    if (png) return res.type('png').send(png);
    return res.sendFile(file);   // could not be re-fitted: the icon as it was saved
  } catch (e) { return next(e); }
}

/** The label under a home-screen icon (about 12 characters fit): the whole name if short, else as many whole words as fit. */
function shortName(name) {
  if (name.length <= 12) return name;
  const words = name.split(/\s+/);
  let out = '';
  for (const w of words) { const next = out ? `${out} ${w}` : w; if (next.length > 12) break; out = next; }
  return out || name.slice(0, 12);
}

let html = null; let htmlAt = 0;
/** index.html, re-read whenever `npm run build` has replaced it (so a rebuild never leaves pages pointing at deleted bundles). */
function template() {
  const at = fs.statSync(INDEX_HTML).mtimeMs;
  if (html === null || at !== htmlAt) { html = fs.readFileSync(INDEX_HTML, 'utf8'); htmlAt = at; }
  return html;
}

/** index.html with the current app name in the <title>, plus <meta name="app-name"> (the React app reads it, so there is no flash of another name). */
async function indexHtml() {
  const { name } = await branding();
  const { tag } = await iconSource();
  return template()
    .replace(/(<link rel="apple-touch-icon" href=")[^"]*(")/, (m, a, b) => `${a}/app-icon/180.png?v=${tag}${b}`)
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(name)}</title>`)
    .replace('</head>', `<meta name="app-name" content="${esc(name)}">\n<meta name="apple-mobile-web-app-title" content="${esc(shortName(require('./mailer').shortName() || name))}">\n</head>`);
}

/** Express handler: the app shell, optionally with a status code. */
const sendApp = (status) => async (req, res, next) => {
  try {
    const body = await indexHtml();
    if (status) res.status(status);
    res.type('html').send(body);
  } catch (e) { next(e); }
};

/** GET /manifest.webmanifest — the file in client/public with name, short_name and description taken from Branding. */
async function manifest(req, res, next) {
  try {
    const base = JSON.parse(fs.readFileSync(INDEX_HTML.replace(/index\.html$/, 'manifest.webmanifest'), 'utf8'));
    const { name, tagline } = await branding();
    const { tag } = await iconSource();
    base.icons = ['any', 'maskable'].flatMap((purpose) => [192, 512].map((n) => ({ src: `/app-icon/${n}.png?v=${tag}`, sizes: `${n}x${n}`, type: 'image/png', purpose })));
    const app = require('./mailer').shortName() || name;   // installed-app name: the short product name (PULSE) when set, else the Branding name
    base.name = app;
    base.short_name = shortName(app);
    if (tagline) base.description = tagline;
    res.set('Cache-Control', 'no-cache').type('application/manifest+json').send(JSON.stringify(base));
  } catch (e) { next(e); }
}

module.exports = { sendApp, manifest, appIconRoute, shortName, DEFAULT_NAME };
