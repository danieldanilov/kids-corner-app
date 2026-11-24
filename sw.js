// Kids Corner service worker: app shell and catalog JSON cached so the Home Screen app opens instantly.
// Never caches video or audio, range requests, Torrentio, the resolver, TorBox or YouTube.
const VERSION = 'c6ddd84219f6';
const PRECACHE = ["./","css/app.css","css/toys.css","icons/apple-touch-icon.png","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","./index.html","js/art.js","js/data.js","js/fake-player.js","js/gate.js","js/main.js","js/parent.js","js/playback.js","js/playui.js","js/rules.js","js/secrets.js","js/sound.js","js/store.js","js/toys.js","js/views.js","manifest.webmanifest","player/engine.js","player/index.js","player/learned.js","player/mse.js","player/probe.js","player/remux-worker.js","player/remux.js","player/select.js","player/silent.js","player/sources.js","player/vendor/MEDIABUNNY-LICENSE.txt","player/vendor/mediabunny.min.mjs","player/youtube.js","voice/index.json"];
const SHELL = 'kc-shell-' + VERSION, DATA = 'kc-data', VOICE = 'kc-voice', IMG = 'kc-img';
const IMG_MAX = 800;
const DATA_HOSTS = ['danieldanilov.github.io/kids-stremio-catalog/', 'v3-cinemeta.strem.io/meta/'];
const IMG_HOSTS = ['images.metahub.space', 'episodes.metahub.space', 'i.ytimg.com', 'yt3.googleusercontent.com', 'yt3.ggpht.com', 'static.libsyn.com', 'image.simplecastcdn.com', 'megaphone.imgix.net', 'is1-ssl.mzstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('kc-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trim(cacheName, max) {
  const c = await caches.open(cacheName);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}

function staleWhileRevalidate(e, cacheName) {
  return caches.open(cacheName).then(async (c) => {
    const hit = await c.match(e.request);
    const fresh = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    if (hit) { e.waitUntil(fresh); return hit; }
    return fresh;
  });
}

async function cacheFirst(e, cacheName, max) {
  const c = await caches.open(cacheName);
  const hit = await c.match(e.request);
  if (hit) return hit;
  const r = await fetch(e.request);
  if (r.ok || r.type === 'opaque') { c.put(e.request, r.clone()); if (max) e.waitUntil(trim(cacheName, max)); }
  return r;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;          // video/audio byte ranges: never touched
  const dest = req.destination;
  if (dest === 'video' || dest === 'audio' || dest === 'iframe') return;
  const url = new URL(req.url);
  const hostPath = url.host + url.pathname;
  // Catalog JSON first: the Kids Corner addon shares this origin (danieldanilov.github.io) but not this scope.
  if (DATA_HOSTS.some(p => hostPath.startsWith(p)) && url.pathname.endsWith('.json')) { e.respondWith(staleWhileRevalidate(e, DATA)); return; }
  const here = url.origin === self.location.origin && url.href.startsWith(self.registration.scope);

  if (here) {
    if (url.pathname.includes('/voice/') && url.pathname.endsWith('.m4a')) { e.respondWith(cacheFirst(e, VOICE)); return; }
    if (url.pathname.includes('/testbed/')) return;
    if (req.mode === 'navigate') { e.respondWith(caches.match(new URL('./', self.registration.scope).href, { ignoreSearch: true }).then(r => r || fetch(req))); return; }
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req)));
    return;
  }
  if (dest === 'image' || IMG_HOSTS.includes(url.host)) { if (IMG_HOSTS.includes(url.host)) e.respondWith(cacheFirst(e, IMG, IMG_MAX)); return; }
  // Everything else (Torrentio, the resolver, TorBox CDN, YouTube, podcast audio): straight to the network.
});
