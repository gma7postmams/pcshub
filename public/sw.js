/* Promotional Content Hub service worker
 * - Precaches static shell assets (CSS/JS/icons) for fast loads
 * - Never caches /api/* or authenticated HTML pages (per-user, access-controlled)
 * - Shows /offline.html when a navigation fails offline
 */
const VERSION = 'phub-v5';
const SHELL = [
  '/css/app.css', '/js/theme-boot.js',
  '/js/common.js', '/js/login.js', '/js/dashboard.js', '/js/ingest.js', '/js/workload.js',
  '/js/approval.js', '/js/reports.js', '/js/admin.js', '/js/profile.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/manifest.webmanifest',
  '/offline.html',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  // Static assets: stale-while-revalidate
  if (/^\/(css|js|icons)\//.test(url.pathname) || url.pathname === '/manifest.webmanifest') {
    e.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
