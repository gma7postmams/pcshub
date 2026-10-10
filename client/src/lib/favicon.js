// Browser-tab icon = the logo set on the Branding page, with a transparent background.
// The logo is drawn on a canvas; if it has a plain solid background (a white or coloured box around it, as JPEGs and many PNGs do)
// that background is removed by flood-filling inwards from the edges (so white inside the artwork itself is kept), the empty margin is
// trimmed, and the result is centred on a square 64×64 PNG. A logo that is already transparent is only trimmed and squared.
// The result is cached in localStorage per logo URL, so later page loads don't redo the work.
const SIZE = 64;
const PAD = 3;
const CACHE_KEY = (url) => `favicon:v1:${url}`;

function iconLink() {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  if (!link.dataset.defaultHref) link.dataset.defaultHref = link.getAttribute('href') || '';
  return link;
}
// The icon in use is also remembered (CURRENT_KEY) so /theme-boot.js can put it on the page straight away on the next load or refresh —
// otherwise the built-in icon shows (and some browsers keep it) until the branding has been fetched.
const CURRENT_KEY = 'favicon:current';
const setIcon = (href, isDefault) => {
  const link = iconLink(); link.type = 'image/png'; link.removeAttribute('sizes'); link.href = href;
  try { if (isDefault) localStorage.removeItem(CURRENT_KEY); else localStorage.setItem(CURRENT_KEY, href); } catch (e) { /* storage unavailable */ }
};

/** Remove a solid background connected to the image edges. Returns true if one was found and removed. */
function removeBackground(img, w, h) {
  const d = img.data;
  const px = (x, y) => (y * w + x) * 4;
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  if (corners.some((i) => d[i + 3] < 200)) return false;   // already transparent at the corners: nothing to remove
  const bg = [0, 1, 2].map((c) => Math.round(corners.reduce((a, i) => a + d[i + c], 0) / 4));
  const dist = (i) => Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]);
  if (corners.some((i) => dist(i) > 40)) return false;   // the corners differ: not a plain backdrop, leave the image alone
  const TOL = 42;
  const seen = new Uint8Array(w * h);
  const queue = [];
  const push = (x, y) => { const k = y * w + x; if (!seen[k]) { seen[k] = 1; queue.push(k); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (queue.length) {
    const k = queue.pop();
    const x = k % w;
    const y = (k - x) / w;
    const i = k * 4;
    const dd = dist(i);
    if (dd <= TOL) {
      d[i + 3] = 0;   // backdrop: expand to the neighbours
      if (x > 0) push(x - 1, y);
      if (x < w - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < h - 1) push(x, y + 1);
    } else if (dd < TOL * 2) {
      d[i + 3] = Math.min(d[i + 3], Math.round((255 * (dd - TOL)) / TOL));   // anti-aliased fringe: fade it out instead of leaving a halo
    }
  }
  return true;
}

function build(image) {
  const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
  const w = Math.max(1, Math.round(image.naturalWidth * scale));
  const h = Math.max(1, Math.round(image.naturalHeight * scale));
  const work = document.createElement('canvas');
  work.width = w; work.height = h;
  const g = work.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h);
  removeBackground(data, w, h);
  g.putImageData(data, 0, 0);
  // trim to the visible artwork
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data.data[(y * w + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;   // nothing visible
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const out = document.createElement('canvas');
  out.width = SIZE; out.height = SIZE;
  const o = out.getContext('2d');
  const fit = Math.min((SIZE - PAD * 2) / cw, (SIZE - PAD * 2) / ch);
  const dw = Math.round(cw * fit);
  const dh = Math.round(ch * fit);
  o.imageSmoothingQuality = 'high';
  o.drawImage(work, x0, y0, cw, ch, Math.round((SIZE - dw) / 2), Math.round((SIZE - dh) / 2), dw, dh);
  return out.toDataURL('image/png');
}

/** Point the tab icon at the branding logo (url), or back at the built-in icon when there is none. */
export function applyFavicon(url) {
  const link = iconLink();
  if (!url) { setIcon(link.dataset.defaultHref || '/icons/icon-192.png', true); return; }
  try { const hit = localStorage.getItem(CACHE_KEY(url)); if (hit) { setIcon(hit); return; } } catch (e) { /* storage unavailable */ }
  const image = new Image();
  image.onload = () => {
    let href = null;
    try { href = build(image); } catch (e) { href = null; }   // e.g. a canvas the browser won't read: use the logo as it is
    setIcon(href || url);
    if (href) { try { localStorage.setItem(CACHE_KEY(url), href); } catch (e) { /* full: fine */ } }
  };
  image.onerror = () => setIcon(link.dataset.defaultHref || '/icons/icon-192.png', true);
  image.src = url;
}
