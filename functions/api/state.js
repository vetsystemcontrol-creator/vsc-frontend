import {
  getDB,
  isD1Like,
  getUserLabel,
  ensureSchema,
  ingestOperation,
  loadCanonicalSnapshot,
} from "./_lib/sync-store.js";
import {
  buildJsonResponse,
  buildOptionsResponse,
  buildSnapshotMetaHeaders,
  getCapabilities as getLegacyCapabilities,
  loadSnapshot,
  matchesIfNoneMatch,
  saveSnapshot,
} from "./_lib/cloud-store.js";
import { buildRevisionHeaders, composeHeaders } from "./_lib/cors.js";

function readTenant(request, url) {
  const fromHeader = request.headers.get("X-VSC-Tenant");
  const fromQuery = url.searchParams.get("tenant");
  return String(fromHeader || fromQuery || "tenant-default").trim() || "tenant-default";
}

async function buildCapabilities(request, env) {
  const db = getDB(env);
  const legacy = await getLegacyCapabilities(env).catch(() => ({
    ok: true,
    available: true,
    remote_sync_allowed: !!db,
  }));

  return buildJsonResponse(request, {
    ok: true,
    available: true,
    local_static_mode: !!legacy.local_static_mode,
    remote_sync_allowed: !!(db || legacy.remote_sync_allowed),
    binding_ok: !!isD1Like(db),
    action: "capabilities",
    endpoints: {
      state_capabilities: "/api/state?action=capabilities",
      state_pull: "/api/state?action=pull",
      state_push: "/api/state?action=push",
      sync_push: "/api/sync/push",
      sync_pull: "/api/sync/pull",
      legacy_outbox: "/api/outbox",
    },
  });
}

async function handlePull(request, env, tenant) {
  const db = getDB(env);

  if (db) {
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

    return buildJsonResponse(
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
      revisionHeaders
    );
  }

  const legacy = await loadSnapshot(env, tenant, false);
  if (!legacy.ok) {
    return buildJsonResponse(
      request,
      { ok: false, action: "pull", tenant, error: legacy.error || "pull_failed" },
      503
    );
  }

  const metaHeaders = buildSnapshotMetaHeaders(legacy.meta || {});
  if (metaHeaders.ETag && matchesIfNoneMatch(request, metaHeaders.ETag)) {
    return new Response(null, {
      status: 304,
      headers: composeHeaders(request, metaHeaders, {
        methods: "GET, OPTIONS",
      }),
    });
  }

  return buildJsonResponse(
    request,
    {
      ok: true,
      action: "pull",
      tenant,
      ...legacy,
    },
    200,
    metaHeaders
  );
}

async function handlePush(request, env, tenant) {
  const db = getDB(env);
  let body = null;

  try {
    body = await request.json();
  } catch (_) {
    return buildJsonResponse(
      request,
      { ok: false, action: "push", tenant, error: "invalid_json" },
      400
    );
  }

  if (Array.isArray(body?.operations)) {
    if (!db) {
      return buildJsonResponse(
        request,
        { ok: false, error: "missing_d1_binding", remote_sync_allowed: false },
        501
      );
    }

    const operations = body.operations;
    if (!operations.length) {
      return buildJsonResponse(request, { ok: false, error: "operations_required" }, 400);
    }

    if (operations.length > 200) {
      return buildJsonResponse(
        request,
        { ok: false, error: "batch_too_large", limit: 200 },
        413
      );
    }

    const userLabel = getUserLabel(request);
    await ensureSchema(db);

    const ack_ids = [];
    const duplicates = [];
    const rejected = [];
    let stateRevision = null;

    for (const rawOp of operations) {
      const result = await ingestOperation(db, tenant, userLabel, rawOp);

      if (!result.ok) {
        rejected.push({ code: result.code, op_id: result.operation?.op_id || "" });
        continue;
      }

      ack_ids.push(result.ack_id);
      if (result.duplicate) duplicates.push(result.ack_id);
      if (Number.isFinite(Number(result.state_revision))) {
        stateRevision = Number(result.state_revision);
      }
    }

    const ok = ack_ids.length > 0 && rejected.length === 0;
    const status = rejected.length ? 207 : 200;

    return buildJsonResponse(request, {
      ok,
      tenant,
      received: operations.length,
      acked: ack_ids.length,
      ack_ids,
      duplicates,
      rejected,
      state_revision: stateRevision,
    }, status);
  }

  if (body && typeof body === "object" && body.snapshot && typeof body.snapshot === "object") {
    const result = await saveSnapshot(env, tenant, body.snapshot, {
      source: body.source || "manual-browser-sync",
      exported_at: body.snapshot?.meta?.exported_at,
    });

    if (!result.ok) {
      return buildJsonResponse(
        request,
        { ok: false, action: "push", tenant, error: result.error || "push_failed" },
        503
      );
    }

    return buildJsonResponse(request, {
      ok: true,
      action: "push",
      tenant,
      ...result,
    }, 200, buildSnapshotMetaHeaders(result.meta || {}));
  }

  return buildJsonResponse(
    request,
    { ok: false, action: "push", tenant, error: "missing_operations_or_snapshot" },
    400
  );
}

export async function onRequestOptions(context) {
  return buildOptionsResponse(context.request);
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const action = String(url.searchParams.get("action") || "capabilities")
      .trim()
      .toLowerCase();
    const tenant = readTenant(request, url);

    if (action === "capabilities") return buildCapabilities(request, env);
    if (action === "pull") return handlePull(request, env, tenant);

    return buildJsonResponse(
      request,
      { ok: false, error: "unsupported_action", action },
      400
    );
  } catch (error) {
    return buildJsonResponse(
      request,
      {
        ok: false,
        error: "state_get_failed",
        detail: String(error?.message || error || "unknown_error"),
      },
      500
    );
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const action = String(url.searchParams.get("action") || "")
      .trim()
      .toLowerCase();
    const tenant = readTenant(request, url);

    if (action === "push") return handlePush(request, env, tenant);

    return buildJsonResponse(
      request,
      { ok: false, error: "unsupported_action", action },
      400
    );
  } catch (error) {
    return buildJsonResponse(
      request,
      {
        ok: false,
        error: "state_post_failed",
        detail: String(error?.message || error || "unknown_error"),
      },
      500
    );
  }
}
