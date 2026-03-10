import { json, corsHeaders, getDB, getTenant, ensureSchema, loadCanonicalSnapshot } from '../_lib/sync-store.js';

export async function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(context.request),
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-VSC-Tenant, X-VSC-User, X-VSC-Token',
      'Access-Control-Max-Age': '86400',
      'cache-control': 'no-store',
    },
  });
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
    return json({ ok: false, error: 'sync_pull_failed', detail: String(error?.message || error || 'unknown_error') }, 500, request);
  }
}
