// Offline-first service worker: the whole app (about 300 KB with fonts) is
// cached on install, so dictionary, phrasebook and translation work with no
// signal. Bump VERSION whenever any cached file changes.
const VERSION = 'mog-v8';
const FILES = [
  './', 'index.html', 'app.js', 'api.js', 'online.js', 'translit.js', 'data/lexicon.json', 'manifest.webmanifest', 'icon.svg',
  'fonts/noto-sans-myanmar-myanmar-400-normal.woff2', 'fonts/noto-sans-myanmar-myanmar-700-normal.woff2',
  'fonts/noto-sans-bengali-bengali-400-normal.woff2', 'fonts/noto-sans-bengali-bengali-700-normal.woff2',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Data file: network first so new words arrive when online; everything else cache first.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/data/lexicon.json')) {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
