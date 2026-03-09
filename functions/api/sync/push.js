
import { JSON_HEADERS, json, getDB, getTenant, getUserLabel, ensureSchema, ingestOperation } from '../_lib/sync-store.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = getDB(env);
  if (!db) {
    return json({ ok: false, error: 'missing_d1_binding', remote_sync_allowed: false }, 501);
  }

  const body = await request.json().catch(() => ({}));
  const operations = Array.isArray(body?.operations) ? body.operations : [];
  if (!operations.length) {
    return json({ ok: false, error: 'operations_required' }, 400);
  }
  if (operations.length > 200) {
    return json({ ok: false, error: 'batch_too_large', limit: 200 }, 413);
  }

  const tenant = getTenant(request);
  const userLabel = getUserLabel(request);
  await ensureSchema(db);

  const ack_ids = [];
  const duplicates = [];
  const rejected = [];

  for (const rawOp of operations) {
    const result = await ingestOperation(db, tenant, userLabel, rawOp);
    if (!result.ok) {
      rejected.push({ code: result.code, op_id: result.operation?.op_id || '' });
      continue;
    }
    ack_ids.push(result.ack_id);
    if (result.duplicate) {
      duplicates.push(result.ack_id);
    }
  }

  const ok = ack_ids.length > 0 && rejected.length === 0;
  const status = rejected.length ? 207 : 200;
  return new Response(JSON.stringify({
    ok,
    tenant,
    received: operations.length,
    acked: ack_ids.length,
    ack_ids,
    duplicates,
    rejected,
  }), { status, headers: JSON_HEADERS });
}
