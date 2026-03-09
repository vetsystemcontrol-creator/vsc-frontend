const CACHE = "vsc-static-v2";
const CORE = [
  "/index.html",
  "/login.html",
  "/dashboard.html",
  "/login",
  "/dashboard",
  "/manifest.webmanifest"
];
self.addEventListener("install", (event) => {
  event.waitUntil((async ()=>{
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
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

  // Only handle same-origin GET
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Navigations: always go network-first (avoid "tela preta" por HTML cacheado/redirects)
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        // network first
        return await fetch(req);
      } catch (e) {
        const cache = await caches.open(CACHE);
        // fallback offline
        return (await cache.match("/login.html")) || (await cache.match("/index.html")) ||
          new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
      }
    })());
    return;
  }

  // Static assets: cache-first
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req);
      const ct = res.headers.get("content-type") || "";
      const status = res.status;

      // Nunca cachear redirects (301/302/307/308) para evitar loops persistidos
      if (res.ok && status < 300 && (ct.includes("text/") || ct.includes("javascript") || ct.includes("css") || ct.includes("image") || ct.includes("font"))) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      return new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
    }
  })());
});
