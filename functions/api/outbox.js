import { json, options, getDB, getTenant, getUserLabel, ensureSchema, ingestOperation } from './_lib/sync-store.js';

export async function onRequestOptions(context) {
  return options(context.request);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = getDB(env);
  if (!db) {
    return json({ ok: false, error: 'missing_d1_binding', remote_sync_allowed: false }, 501, request);
  }

  const body = await request.json().catch(() => ({}));
  const tenant = getTenant(request);
  const userLabel = getUserLabel(request);
  await ensureSchema(db);

  const result = await ingestOperation(db, tenant, userLabel, {
    entity: body?.entity,
    store: body?.store,
    entity_id: body?.entity_id,
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
    return json({ ok: false, error: result.code }, 400, request);
  }

  return json({ ok: true, ack_id: result.ack_id, duplicate: !!result.duplicate, tenant }, 200, request);
}
