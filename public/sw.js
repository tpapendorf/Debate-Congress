'use strict';
/* Keeps the app's own files on this device so it opens without a connection.
   Always asks the server first, so a new version is picked up whenever online. */
const SHELL = 'congress-shell-v1', FONTS = 'congress-fonts-v1';
const FILES = ['/', '/styles.css', '/offline.js', '/app.js', '/teams.js', '/training.js', '/drills.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, FONTS].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), ms); p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Fonts: use the saved copy if there is one.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }).catch(() => new Response('', { status: 504 })));
    return;
  }
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const isPage = req.mode === 'navigate';
  const key = isPage ? '/' : url.pathname;
  if (!isPage && !FILES.includes(key)) return;
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    try {
      const res = await withTimeout(fetch(req), 5000);
      if (res.ok) c.put(key, res.clone());
      return res;
    } catch {
      return (await c.match(key)) || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
