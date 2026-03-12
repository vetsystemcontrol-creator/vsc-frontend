import {
  getDB,
  getTenant,
  ensureSchema,
  loadCanonicalSnapshot,
} from "../_lib/sync-store.js";
import {
  buildOptionsResponse,
  buildRevisionHeaders,
  composeHeaders,
  jsonResponse,
  matchesIfNoneMatch,
} from "../_lib/cors.js";

export async function onRequestOptions(context) {
  return buildOptionsResponse(context.request, { methods: "GET, OPTIONS" });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const db = getDB(env);
    if (!db) {
      return jsonResponse(
        request,
        { ok: false, error: "missing_d1_binding", remote_sync_allowed: false },
        501
      );
    }

    const tenant = getTenant(request);
    await ensureSchema(db);

    const result = await loadCanonicalSnapshot(db, tenant);
    const revisionHeaders = buildRevisionHeaders(result.revision || 0);

    if (matchesIfNoneMatch(request, revisionHeaders.ETag)) {
      return new Response(null, {
        status: 304,
        headers: composeHeaders(request, revisionHeaders, {
          methods: "GET, OPTIONS",
        }),
      });
    }

    return jsonResponse(
      request,
      {
        ok: true,
        tenant,
        exists: !!result.exists,
        revision: result.revision || 0,
        meta: result.meta || null,
        snapshot: result.snapshot || null,
      },
      200,
      revisionHeaders,
      { methods: "GET, OPTIONS" }
    );
  } catch (error) {
    return jsonResponse(
      request,
      {
        ok: false,
        error: "sync_pull_failed",
        detail: String(error?.message || error || "unknown_error"),
      },
      500,
      {},
      { methods: "GET, OPTIONS" }
    );
  }
}
