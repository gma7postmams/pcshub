const fs = require('fs');
const db = require('./db');
const { INDEX_HTML } = require('./middleware');

// The app's name comes from Administration > Branding (app_settings.app_name). Everything the browser reads BEFORE the React app runs —
// the page <title>, the home-screen / PWA name (manifest), the iOS home-screen name — is filled in here, so it follows the Branding name
// instead of a name baked into the build.
const DEFAULT_NAME = 'Promotional Content Hub';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function branding() {
  try {
    const { rows } = await db.query(`SELECT key, value FROM app_settings WHERE key IN ('app_name','tagline')`);
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return { name: (s.app_name || '').trim() || DEFAULT_NAME, tagline: (s.tagline || '').trim() };
  } catch (e) { return { name: DEFAULT_NAME, tagline: '' }; }
}

/** The label under a home-screen icon (about 12 characters fit): the whole name if short, else as many whole words as fit. */
function shortName(name) {
  if (name.length <= 12) return name;
  const words = name.split(/\s+/);
  let out = '';
  for (const w of words) { const next = out ? `${out} ${w}` : w; if (next.length > 12) break; out = next; }
  return out || name.slice(0, 12);
}

let html = null;
function template() {
  if (html === null) html = fs.readFileSync(INDEX_HTML, 'utf8');
  return html;
}

/** index.html with the current app name in the <title>, plus <meta name="app-name"> (the React app reads it, so there is no flash of another name). */
async function indexHtml() {
  const { name } = await branding();
  return template()
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(name)}</title>`)
    .replace('</head>', `<meta name="app-name" content="${esc(name)}">\n<meta name="apple-mobile-web-app-title" content="${esc(shortName(name))}">\n</head>`);
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
    base.name = name;
    base.short_name = shortName(name);
    if (tagline) base.description = tagline;
    res.set('Cache-Control', 'no-cache').type('application/manifest+json').send(JSON.stringify(base));
  } catch (e) { next(e); }
}

module.exports = { sendApp, manifest, shortName, DEFAULT_NAME };
