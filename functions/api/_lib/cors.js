const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/app\.vetsystemcontrol\.com\.br$/i,
  /^https?:\/\/localhost(?::\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
];

const ALLOWED_REQUEST_HEADERS = [
  "content-type",
  "authorization",
  "x-requested-with",
  "x-vsc-tenant",
  "x-vsc-user",
  "x-vsc-token",
];

const DEFAULT_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEFAULT_EXPOSE_HEADERS =
  "Content-Type, Content-Length, ETag, X-VSC-State-Revision";
const DEFAULT_VARY =
  "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

function normalizeHeaderName(value) {
  return String(value || "").trim().toLowerCase();
}

function mergeCsvUnique(...chunks) {
  const out = [];
  const seen = new Set();

  for (const chunk of chunks) {
    for (const item of String(chunk || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }

  return out.join(", ");
}

export function mergeVary(existing, incoming = DEFAULT_VARY) {
  return mergeCsvUnique(existing, incoming);
}

export function resolveOrigin(request) {
  const origin = String(request?.headers?.get("Origin") || "").trim();

  if (!origin) return "*";

  if (ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))) {
    return origin;
  }

  return "https://app.vetsystemcontrol.com.br";
}

export function resolveAllowHeaders(request, extraAllowedHeaders = []) {
  const allowed = new Set(
    [...ALLOWED_REQUEST_HEADERS, ...extraAllowedHeaders.map(normalizeHeaderName)].filter(
      Boolean
    )
  );

  const requested = String(
    request?.headers?.get("Access-Control-Request-Headers") || ""
  )
    .split(",")
    .map(normalizeHeaderName)
    .filter(Boolean);

  if (!requested.length) {
    return [...allowed].join(", ");
  }

  const reflected = requested.filter((name) => allowed.has(name));
  return (reflected.length ? reflected : [...allowed]).join(", ");
}

export function corsHeaders(
  request,
  {
    methods = DEFAULT_ALLOW_METHODS,
    exposeHeaders = DEFAULT_EXPOSE_HEADERS,
    extraAllowedHeaders = [],
  } = {}
) {
  return {
    "Access-Control-Allow-Origin": resolveOrigin(request),
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": resolveAllowHeaders(
      request,
      extraAllowedHeaders
    ),
    "Access-Control-Expose-Headers": mergeCsvUnique(exposeHeaders),
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: DEFAULT_VARY,
  };
}

export function composeHeaders(request, extraHeaders = {}, corsOptions = {}) {
  const headers = new Headers(corsHeaders(request, corsOptions));

  for (const [key, value] of Object.entries(extraHeaders || {})) {
    if (value == null || value === "") continue;

    if (String(key).toLowerCase() === "vary") {
      headers.set("Vary", mergeVary(headers.get("Vary"), value));
      continue;
    }

    headers.set(key, value);
  }

  return headers;
}

export function buildOptionsResponse(
  request,
  { methods = DEFAULT_ALLOW_METHODS, extraHeaders = {}, ...rest } = {}
) {
  return new Response(null, {
    status: 204,
    headers: composeHeaders(request, extraHeaders, { methods, ...rest }),
  });
}

export function applyCors(request, response, corsOptions = {}) {
  const headers = new Headers(response.headers);
  const extra = corsHeaders(request, corsOptions);

  for (const [key, value] of Object.entries(extra)) {
    if (String(key).toLowerCase() === "vary") {
      headers.set("Vary", mergeVary(headers.get("Vary"), value));
      continue;
    }
    headers.set(key, value);
  }

  headers.set("Cache-Control", "no-store");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonResponse(
  request,
  body,
  status = 200,
  extraHeaders = {},
  corsOptions = {}
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: composeHeaders(
      request,
      {
        "content-type": "application/json; charset=utf-8",
        ...extraHeaders,
      },
      corsOptions
    ),
  });
}

export function buildRevisionHeaders(revision) {
  const safeRevision = Number.isFinite(Number(revision))
    ? Math.max(0, Number(revision))
    : 0;

  return {
    ETag: `W/"vsc-state-${safeRevision}"`,
    "X-VSC-State-Revision": String(safeRevision),
  };
}

export function matchesIfNoneMatch(request, etag) {
  const raw = String(request?.headers?.get("If-None-Match") || "").trim();

  if (!raw || !etag) return false;
  if (raw === "*") return true;

  return raw
    .split(",")
    .map((value) => value.trim())
    .includes(etag);
}
