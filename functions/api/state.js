import {
  storageEngine,
  ensureStorage,
  tenantFromRequest,
  actorFromRequest,
  parseJsonBody,
  readSnapshot,
  writeSnapshot,
  listRecentOperations,
  json,
  badRequest,
  MAX_SNAPSHOT_BYTES,
} from './_lib/cloud-store.js';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = String(url.searchParams.get('action') || 'capabilities').trim().toLowerCase();

  try {
    const storage = await ensureStorage(env);
    const engine = storageEngine(env);

    if (request.method === 'GET' && action === 'capabilities') {
      const available = engine !== 'none';
      return json({
        ok: true,
        action: 'capabilities',
        available,
        engine,
        canonical_mode: available ? 'cloud-canonical-snapshot' : 'browser-only',
        max_snapshot_bytes: MAX_SNAPSHOT_BYTES,
        local_static_mode: false,
        remote_sync_allowed: available,
        endpoints: {
          sync_push: '/api/sync/push',
          outbox: '/api/outbox',
          state: '/api/state?action=capabilities',
          state_push: '/api/state?action=push',
          state_pull: '/api/state?action=pull',
          state_ops: '/api/state?action=ops',
        },
      });
    }

    if (request.method === 'GET' && action === 'pull') {
      const tenant = tenantFromRequest(request);
      const metaOnly = String(url.searchParams.get('meta_only') || '') === '1';
      const current = await readSnapshot(env, tenant);
      if (!current) {
        return json({ ok: true, exists: false, tenant, engine });
      }
      return json({
        ok: true,
        exists: true,
        engine,
        meta: current.meta,
        snapshot: metaOnly ? undefined : current.snapshot,
      });
    }

    if (request.method === 'GET' && action === 'ops') {
      const tenant = tenantFromRequest(request);
      const items = await listRecentOperations(env, tenant, Number(url.searchParams.get('limit') || 50));
      return json({ ok: true, engine, tenant, items });
    }

    if (request.method === 'POST' && action === 'push') {
      const { body } = await parseJsonBody(request);
      const tenant = tenantFromRequest(request, body);
      if (!body || typeof body !== 'object') return badRequest('invalid_body');
      if (!body.snapshot || typeof body.snapshot !== 'object') return badRequest('snapshot_missing');

      const saved = await writeSnapshot(env, tenant, body.snapshot, {
        source: String(body.source || 'browser-cloud-sync'),
        actor: actorFromRequest(request),
      });

      return json({ ok: true, engine, meta: saved.meta });
    }

    return badRequest('unsupported_action', 400, { action, method: request.method });
  } catch (err) {
    const code = String(err && err.message ? err.message : err || 'state_error');
    if (code === 'invalid_json') return badRequest(code, 400);
    if (code === 'snapshot_too_large') return badRequest(code, 413);
    if (code === 'snapshot_missing' || code === 'snapshot_schema_missing' || code === 'snapshot_data_missing') {
      return badRequest(code, 400);
    }
    return json({ ok: false, error: code }, 500);
  }
}

export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
