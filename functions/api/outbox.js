import {
  ensureStorage,
  storageEngine,
  tenantFromRequest,
  parseJsonBody,
  appendOperations,
  json,
  badRequest,
} from './_lib/cloud-store.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    await ensureStorage(env);
    const engine = storageEngine(env);
    if (engine === 'none') return badRequest('storage_unavailable', 501);

    const { body } = await parseJsonBody(request);
    if (!body || typeof body !== 'object') return badRequest('invalid_body');
    const tenant = tenantFromRequest(request, body);
    const operation = {
      op_id: body.op_id || body.id,
      entity: body.entity || body.store,
      entity_id: body.entity_id || body.record_id || (body.payload && body.payload.id),
      action: body.op || body.action || 'UPSERT',
      payload: body.payload || {},
      device_id: body.device_id || null,
      base_revision: body.base_revision || 0,
      entity_revision: body.entity_revision || 0,
      created_at: body.created_at || new Date().toISOString(),
    };

    const result = await appendOperations(env, tenant, [operation]);
    return json({
      ok: true,
      engine,
      tenant,
      accepted: result.accepted,
      duplicates: result.duplicates,
      received_at: result.received_at,
    });
  } catch (err) {
    const code = String(err && err.message ? err.message : err || 'outbox_error');
    if (code === 'invalid_json' || code === 'invalid_body' || code === 'operation_invalid' || code === 'operation_missing_op_id') {
      return badRequest(code, 400);
    }
    return json({ ok: false, error: code }, 500);
  }
}
