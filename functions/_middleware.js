/**
 * VSC — Cloudflare Pages Middleware
 * Resolve CORS para os headers customizados do sistema (X-VSC-User, X-VSC-Tenant, X-VSC-Token)
 *
 * COMO FUNCIONA:
 *  - Intercepta TODAS as requisições que passam pelo Pages
 *  - Responde ao preflight (OPTIONS) com os headers corretos
 *  - Adiciona headers CORS em todas as respostas normais
 *
 * DEPLOY:
 *  - Coloque este arquivo na pasta /functions/ do seu projeto
 *  - O Cloudflare Pages carrega automaticamente
 */

// ─── Origens permitidas ──────────────────────────────────────────────────────
// Em produção: apenas o domínio real
// Em desenvolvimento: também permite localhost e 127.0.0.1
const ALLOWED_ORIGINS = [
  'https://app.vetsystemcontrol.com.br',
  'https://vetsystemcontrol.com.br',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
];

// ─── Headers CORS completos ──────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': [
    'Content-Type',
    'Accept',
    'Authorization',
    'X-VSC-Token',
    'X-VSC-Tenant',
    'X-VSC-User',
  ].join(', '),
  'Access-Control-Max-Age': '86400',  // cache preflight por 24h
  'Vary': 'Origin',                   // essencial para CDN não servir cache errado
};

// ─── Middleware principal ────────────────────────────────────────────────────
export async function onRequest({ request, next }) {
  const origin = request.headers.get('Origin') || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin);

  // Preflight (OPTIONS): responde imediatamente sem ir ao servidor
  if (request.method === 'OPTIONS') {
    if (!isAllowed) {
      return new Response('Forbidden', { status: 403 });
    }

    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        ...CORS_HEADERS,
      },
    });
  }

  // Requisição normal: passa adiante e adiciona CORS na resposta
  const response = await next();
  const newResponse = new Response(response.body, response);

  if (isAllowed) {
    newResponse.headers.set('Access-Control-Allow-Origin', origin);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      newResponse.headers.set(key, value);
    }
  }

  return newResponse;
}
