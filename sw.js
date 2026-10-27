// I file si aggiornano da soli alla riapertura successiva. Per forzare subito l'aggiornamento
// su tutti i telefoni, cambia VERSION (es. 'v2') quando carichi file nuovi.
const VERSION = 'v2';
const CACHE = 'sudoku1v1-' + VERSION;
const ASSETS = [
  './', './index.html', './style.css', './app.js', './firebase-config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('sudoku1v1-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Firebase talks to its own servers live; only the page's files are cached.
  if (url.hostname !== self.location.hostname && url.hostname !== 'fonts.googleapis.com' && url.hostname !== 'fonts.gstatic.com' && url.hostname !== 'www.gstatic.com') return;

  // Pages: network first so updates arrive, cached app when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res; })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Everything else (app files, fonts): answer from cache at once, refresh it in the background.
  e.respondWith(
    caches.match(req).then(hit => {
      const fresh = fetch(req).then(res => {
        if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      });
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh;
    })
  );
});
