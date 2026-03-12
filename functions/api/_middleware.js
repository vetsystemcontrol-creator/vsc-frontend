const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/app\.vetsystemcontrol\.com\.br$/i,
  /^https?:\/\/localhost(?::\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
];

const ALLOW_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'X-VSC-Tenant',
  'X-VSC-User',
  'X-VSC-Token',
].join(', ');

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const EXPOSE_HEADERS = 'Content-Type, Content-Length, ETag';

function resolveOrigin(request) {
  const origin = String(request.headers.get('Origin') || '').trim();
  if (!origin) return '*';
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin)) ? origin : 'https://app.vetsystemcontrol.com.br';
}

function mergeVary(existing, incoming) {
  const parts = new Set(
    String(existing || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
  for (const item of String(incoming || '').split(',').map((v) => v.trim()).filter(Boolean)) {
    parts.add(item);
  }
  return [...parts].join(', ');
}

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': resolveOrigin(request),
    'Access-Control-Allow-Methods': ALLOW_METHODS,
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
}

export async function onRequest(context) {
  const { request, next } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  const response = await next();
  const headers = new Headers(response.headers);
  const extra = corsHeaders(request);

  for (const [key, value] of Object.entries(extra)) {
    if (key.toLowerCase() === 'vary') {
      headers.set('Vary', mergeVary(headers.get('Vary'), value));
      continue;
    }
    headers.set(key, value);
  }

  headers.set('Cache-Control', 'no-store');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
