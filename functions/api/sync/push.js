import {
  getDB,
  getTenant,
  getUserLabel,
  ensureSchema,
  ingestOperation,
} from "../_lib/sync-store.js";
import { buildOptionsResponse, jsonResponse } from "../_lib/cors.js";

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
    const operations = Array.isArray(body?.operations) ? body.operations : [];

    if (!operations.length) {
      return jsonResponse(
        request,
        { ok: false, error: "operations_required" },
        400,
        {},
        { methods: "POST, OPTIONS" }
      );
    }

    if (operations.length > 200) {
      return jsonResponse(
        request,
        { ok: false, error: "batch_too_large", limit: 200 },
        413,
        {},
        { methods: "POST, OPTIONS" }
      );
    }

    const tenant = getTenant(request);
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

    return jsonResponse(
      request,
      {
        ok,
        tenant,
        received: operations.length,
        acked: ack_ids.length,
        ack_ids,
        duplicates,
        rejected,
        state_revision: stateRevision,
      },
      status,
      {},
      { methods: "POST, OPTIONS" }
    );
  } catch (error) {
    return jsonResponse(
      request,
      {
        ok: false,
        error: "sync_push_failed",
        detail: String(error?.message || error || "unknown_error"),
      },
      500,
      {},
      { methods: "POST, OPTIONS" }
    );
  }
}
