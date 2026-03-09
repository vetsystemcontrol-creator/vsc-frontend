import {
  ensureStorage,
  storageEngine,
  tenantFromRequest,
  parseJsonBody,
  appendOperations,
  json,
  badRequest,
} from '../_lib/cloud-store.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    await ensureStorage(env);
    const engine = storageEngine(env);
    if (engine === 'none') return badRequest('storage_unavailable', 501);

    const { body } = await parseJsonBody(request);
    const tenant = tenantFromRequest(request, body);
    const operations = Array.isArray(body && body.operations) ? body.operations : null;
    if (!operations) return badRequest('operations_missing');

    const result = await appendOperations(env, tenant, operations);
    return json({
      ok: true,
      engine,
      tenant,
      accepted: result.accepted,
      duplicates: result.duplicates,
      received_at: result.received_at,
      count: result.accepted.length,
    });
  } catch (err) {
    const code = String(err && err.message ? err.message : err || 'sync_push_error');
    if (code === 'invalid_json' || code === 'operations_missing' || code === 'operations_invalid' || code === 'operation_invalid' || code === 'operation_missing_op_id') {
      return badRequest(code, 400);
    }
    if (code === 'operations_too_many') return badRequest(code, 413);
    return json({ ok: false, error: code }, 500);
  }
}
