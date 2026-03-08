const CACHE = "vsc-static-v4";
const CORE = [
  "/index.html",
  "/login.html",
  "/manifest.webmanifest"
];

function isSameOriginGet(req, url) {
  return req.method === "GET" && url.origin === self.location.origin;
}

function isHtmlLikeRequest(req) {
  return req.mode === "navigate" || req.destination === "document" || req.destination === "iframe";
}

function shouldCache(req, res) {
  if (!res || !res.ok || res.status >= 300) return false;
  const url = new URL(req.url);
  const ct = String(res.headers.get("content-type") || "").toLowerCase();
  if (url.pathname === "/sw.js" || url.pathname === "/topbar.html") return false;
  if (ct.includes("text/html")) return false;
  return ct.includes("text/") || ct.includes("javascript") || ct.includes("css") || ct.includes("image") || ct.includes("font") || ct.includes("svg") || ct.includes("json");
}

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
  if (!isSameOriginGet(req, url)) return;

  if (isHtmlLikeRequest(req)) {
    event.respondWith((async () => {
      try {
        return await fetch(req, { cache: "no-store" });
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match("/404.html")) ||
          new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) return cached;

    try {
      const res = await fetch(req, { cache: "no-store" });
      if (shouldCache(req, res)) {
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      return new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  })());
});
