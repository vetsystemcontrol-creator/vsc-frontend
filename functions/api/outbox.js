import {
  getDB,
  getTenant,
  getUserLabel,
  ensureSchema,
  ingestOperation,
} from "./_lib/sync-store.js";
import { buildOptionsResponse, jsonResponse } from "./_lib/cors.js";

export async function onRequestOptions(context) {
  return buildOptionsResponse(context.request, { methods: "POST, OPTIONS" });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const db = getDB(env);
    if (!db) {
      return jsonResponse(
        request,
        { ok: false, error: "missing_d1_binding", remote_sync_allowed: false },
        501,
        {},
        { methods: "POST, OPTIONS" }
      );
    }

    const body = await request.json().catch(() => ({}));
    const tenant = getTenant(request);
    const userLabel = getUserLabel(request);

    await ensureSchema(db);

    const result = await ingestOperation(db, tenant, userLabel, {
      store: body?.store,
      entity: body?.entity,
      entity_id: body?.entity_id,
      record_id: body?.record_id,
      action: body?.action || body?.op,
      op: body?.op,
      op_id: body?.op_id,
      payload: body?.payload,
      device_id: body?.device_id,
      base_revision: body?.base_revision,
      entity_revision: body?.entity_revision,
      dedupe_key: body?.dedupe_key,
      created_at: body?.created_at,
      status: body?.status,
    });

    if (!result.ok) {
      return jsonResponse(
        request,
        { ok: false, error: result.code },
        400,
        {},
        { methods: "POST, OPTIONS" }
      );
    }

    return jsonResponse(
      request,
      {
        ok: true,
        ack_id: result.ack_id,
        duplicate: !!result.duplicate,
        tenant,
        store_name: result.store_name || null,
      },
      200,
      {},
      { methods: "POST, OPTIONS" }
    );
  } catch (error) {
    return jsonResponse(
      request,
      {
        ok: false,
        error: "legacy_outbox_failed",
        detail: String(error?.message || error || "unknown_error"),
      },
      500,
      {},
      { methods: "POST, OPTIONS" }
    );
  }
}
