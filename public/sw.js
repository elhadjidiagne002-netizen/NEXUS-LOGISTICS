// Service worker NEXUS Logistics.
// - Navigations : réseau d'abord, sinon la page « / » gardée en cache.
//   On met en cache « / » et JAMAIS « /index.html » : Cloudflare Pages répond 308 sur
//   /index.html, et resservir une réponse redirigée à une navigation casse l'app
//   (incident déjà vécu sur My shop, CV et NEXUS le 01/10/2026).
// - /assets/* (noms à empreinte, immuables) : cache d'abord.
// - Appels /api : jamais mis en cache (la file hors ligne de l'app s'en charge).
const CACHE = 'nexus-logistics-v2'; // v2 : fin du mode démo (purge des fichiers PGlite)

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(new Request('/', { cache: 'reload' }))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && !res.redirected && url.pathname === '/') caches.open(CACHE).then((c) => c.put('/', res.clone()));
      return res;
    }).catch(async () => (await caches.match('/')) ?? Response.error()));
    return;
  }
  if (url.pathname.startsWith('/assets/') || /\.(svg|png|webmanifest|wasm|data)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((res) => {
      if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});
