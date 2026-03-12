import {
  corsHeaders,
  getDB,
  getTenant,
  ensureSchema,
  loadCanonicalSnapshot,
} from '../_lib/sync-store.js';

function jsonResponse(body, status = 200, request = null, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders(request),
      ...extraHeaders,
    },
  });
}

function buildRevisionHeaders(revision) {
  const safe = Number.isFinite(Number(revision)) ? Math.max(0, Number(revision)) : 0;
  return {
    ETag: `W/"vsc-state-${safe}"`,
    'X-VSC-State-Revision': String(safe),
  };
}

function matchesIfNoneMatch(request, etag) {
  const raw = String(request?.headers?.get('If-None-Match') || '').trim();
  if (!raw || !etag) return false;
  if (raw === '*') return true;
  return raw.split(',').map((value) => value.trim()).includes(etag);
}

function optionsHeaders(request) {
  return {
    ...corsHeaders(request),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, X-Requested-With, X-VSC-Tenant, X-VSC-User, X-VSC-Token',
    'Access-Control-Expose-Headers': 'Content-Type, Content-Length, ETag, X-VSC-State-Revision',
    'Access-Control-Max-Age': '86400',
    'cache-control': 'no-store',
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
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
      return jsonResponse(
        { ok: false, error: 'missing_d1_binding', remote_sync_allowed: false },
        501,
        request
      );
    }

    const tenant = getTenant(request);
    await ensureSchema(db);
    const result = await loadCanonicalSnapshot(db, tenant);
    const revisionHeaders = buildRevisionHeaders(result.revision || 0);

    if (matchesIfNoneMatch(request, revisionHeaders.ETag)) {
      return new Response(null, {
        status: 304,
        headers: {
          ...optionsHeaders(request),
          ...revisionHeaders,
        },
      });
    }

    return jsonResponse(
      {
        ok: true,
        tenant,
        exists: !!result.exists,
        revision: result.revision || 0,
        meta: result.meta || null,
        snapshot: result.snapshot || null,
      },
      200,
      request,
      revisionHeaders
    );
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: 'sync_pull_failed',
        detail: String(error?.message || error || 'unknown_error'),
      },
      500,
      request
    );
  }
}
