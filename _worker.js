const ROOT_REDIRECT = "/login";
const REDIRECT_ALIASES = new Map([
  ["/reproducao", "/reproducao_equina"],
  ["/topbar", "/topbar.html"]
]);

function isSafeMethod(method) {
  return method === "GET" || method === "HEAD";
}

function hasExtension(pathname) {
  return /\/[^/]+\.[A-Za-z0-9]+$/.test(pathname);
}

function makeRequest(request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url.toString(), request);
}

async function fetchAsset(env, requestOrUrl) {
  if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
    return env.ASSETS.fetch(requestOrUrl);
  }
  return fetch(requestOrUrl);
}

async function tryCandidates(env, request, candidates) {
  const tried = new Set();
  for (const pathname of candidates) {
    if (!pathname || tried.has(pathname)) continue;
    tried.add(pathname);
    const response = await fetchAsset(env, makeRequest(request, pathname));
    if (response.status !== 404) return response;
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (!isSafeMethod(request.method)) {
      return fetchAsset(env, request);
    }

    if (pathname === "/") {
      return Response.redirect(new URL(ROOT_REDIRECT, url.origin).toString(), 302);
    }

    const alias = REDIRECT_ALIASES.get(pathname);
    if (alias) {
      return Response.redirect(new URL(alias, url.origin).toString(), 302);
    }

    const direct = await fetchAsset(env, request);
    if (direct.status !== 404) {
      return direct;
    }

    if (hasExtension(pathname)) {
      const notFound = await tryCandidates(env, request, ["/404.html"]);
      if (notFound) {
        return new Response(notFound.body, {
          status: 404,
          headers: notFound.headers
        });
      }
      return new Response("Not Found", { status: 404 });
    }

    const base = pathname !== "/" && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;

    const resolved = await tryCandidates(env, request, [
      `${base}.html`,
      `${base}/`,
      `${base}/index.html`
    ]);
    if (resolved) {
      return resolved;
    }

    const notFound = await tryCandidates(env, request, ["/404.html"]);
    if (notFound) {
      return new Response(notFound.body, {
        status: 404,
        headers: notFound.headers
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};
