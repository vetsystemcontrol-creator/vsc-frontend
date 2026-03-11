const CACHE = "vsc-static-v3";
const CORE = [
  "/index.html",
  "/login.html",
  "/dashboard.html",
  "/topbar.html",
  "/manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async ()=>{
    const cache = await caches.open(CACHE);
    try{ await cache.addAll(CORE); }catch(_){ /* fail-closed: shell continua via network */ }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async ()=>{
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k===CACHE)?null:caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(req, { cache: 'no-store' });
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match("/login.html")) ||
               (await cache.match("/dashboard.html")) ||
               (await cache.match("/index.html")) ||
               new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req, { cache: 'no-store' });
      const ct = res.headers.get("content-type") || "";
      const status = res.status;
      const p = url.pathname || '';
      const cacheableAsset = /\.(css|js|png|jpg|jpeg|svg|webp|gif|woff2?|ttf)$/i.test(p);

      if (res.ok && status < 300 && cacheableAsset && !ct.includes('text/html')) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      return new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
    }
  })());
});
