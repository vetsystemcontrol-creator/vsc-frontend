import {
  json,
  corsHeaders,
  getDB,
  getTenant,
  ensureSchema,
  loadCanonicalSnapshot,
} from '../_lib/sync-store.js';

function optionsHeaders(request) {
  return {
    ...corsHeaders(request),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-VSC-Tenant, X-VSC-User, X-VSC-Token',
    'Access-Control-Expose-Headers': 'Content-Type, Content-Length, ETag',
    'Access-Control-Max-Age': '86400',
    'cache-control': 'no-store',
    'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: optionsHeaders(context.request) });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const db = getDB(env);
    if (!db) {
      return json({ ok: false, error: 'missing_d1_binding', remote_sync_allowed: false }, 501, request);
    }

    const tenant = getTenant(request);
    await ensureSchema(db);
    const result = await loadCanonicalSnapshot(db, tenant);

    return json({
      ok: true,
      tenant,
      exists: !!result.exists,
      revision: result.revision || 0,
      meta: result.meta || null,
      snapshot: result.snapshot || null,
    }, 200, request);
  } catch (error) {
    return json({
      ok: false,
      error: 'sync_pull_failed',
      detail: String(error?.message || error || 'unknown_error'),
    }, 500, request);
  }
}
