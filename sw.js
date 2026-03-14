const SHELL_CACHE = "vsc-shell-v4";
const ASSET_CACHE = "vsc-assets-v4";
const CORE = [
  "/index.html",
  "/login.html",
  "/dashboard.html",
  "/topbar.html",
  "/manifest.webmanifest",
  "/assets/styles.css",
  "/assets/css/vsc-premium-enterprise.css",
  "/modules/vsc_db.js",
  "/modules/auth.js",
  "/modules/auth_guard.js",
  "/modules/ui-global.js",
  "/modules/vsc-cloud-sync.js",
  "/modules/vsc-outbox-relay.js",
  "/modules/vsc-attachments-relay.js",
  "/modules/vsc-sync-ui.js"
];

async function pruneCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => ([SHELL_CACHE, ASSET_CACHE].includes(k) ? null : caches.delete(k))));
}

async function shellCache() {
  return caches.open(SHELL_CACHE);
}

async function assetCache() {
  return caches.open(ASSET_CACHE);
}

function isCacheableAsset(url, response) {
  const p = url.pathname || "";
  const ct = response.headers.get("content-type") || "";
  if (!response.ok || response.status >= 300) return false;
  if (/\.html?$/i.test(p) || ct.includes("text/html")) return false;
  return /\.(css|js|mjs|png|jpg|jpeg|svg|webp|gif|woff2?|ttf|ico)$/i.test(p);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await shellCache();
    try { await cache.addAll(CORE); } catch (_) {}
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await pruneCaches();
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await shellCache();
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        if (fresh && fresh.ok) {
          cache.put(req, fresh.clone()).catch(() => {});
          return fresh;
        }
      } catch (_) {}
      return (await cache.match(req)) ||
             (await cache.match("/dashboard.html")) ||
             (await cache.match("/login.html")) ||
             (await cache.match("/index.html")) ||
             new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await assetCache();
    const cached = await cache.match(req);
    const networkPromise = fetch(req, { cache: "no-store" })
      .then((res) => {
        if (isCacheableAsset(url, res)) cache.put(req, res.clone()).catch(() => {});
        return res;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(networkPromise);
      return cached;
    }

    const networkRes = await networkPromise;
    if (networkRes) return networkRes;

    const shell = await shellCache();
    return (await shell.match(req)) || new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } });
  })());
});
