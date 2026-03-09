import { buildJsonResponse, buildOptionsResponse, getCapabilities, loadSnapshot, saveSnapshot } from './_lib/cloud-store.js';

function readTenant(request, url) {
  const fromHeader = request.headers.get('X-VSC-Tenant');
  const fromQuery = url.searchParams.get('tenant');
  return String(fromHeader || fromQuery || 'tenant-default').trim() || 'tenant-default';
}

export async function onRequestOptions(context) {
  return buildOptionsResponse(context.request);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = String(url.searchParams.get('action') || 'capabilities').trim().toLowerCase();
  const tenant = readTenant(request, url);

  if (action === 'capabilities') {
    const caps = await getCapabilities(env);
    return buildJsonResponse(request, {
      ...caps,
      action,
      endpoints: {
        state_capabilities: '/api/state?action=capabilities',
        state_pull: '/api/state?action=pull',
        state_push: '/api/state?action=push',
      },
    });
  }

  if (action === 'pull') {
    const metaOnly = /^(1|true|yes)$/i.test(String(url.searchParams.get('meta_only') || ''));
    const result = await loadSnapshot(env, tenant, metaOnly);
    if (!result.ok) {
      return buildJsonResponse(request, { ok: false, action, tenant, error: result.error || 'pull_failed' }, 503);
    }
    return buildJsonResponse(request, { ok: true, action, tenant, ...result });
  }

  return buildJsonResponse(request, { ok: false, error: 'unsupported_action', action }, 400);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = String(url.searchParams.get('action') || '').trim().toLowerCase();
  const tenant = readTenant(request, url);

  if (action !== 'push') {
    return buildJsonResponse(request, { ok: false, error: 'unsupported_action', action }, 400);
  }

  let body = null;
  try {
    body = await request.json();
  } catch (_) {
    return buildJsonResponse(request, { ok: false, action, tenant, error: 'invalid_json' }, 400);
  }

  if (!body || typeof body !== 'object' || !body.snapshot || typeof body.snapshot !== 'object') {
    return buildJsonResponse(request, { ok: false, action, tenant, error: 'missing_snapshot' }, 400);
  }

  const result = await saveSnapshot(env, tenant, body.snapshot, {
    source: body.source || 'manual-browser-sync',
    exported_at: body.snapshot?.meta?.exported_at,
  });
  if (!result.ok) {
    return buildJsonResponse(request, { ok: false, action, tenant, error: result.error || 'push_failed' }, 503);
  }

  return buildJsonResponse(request, { ok: true, action, tenant, ...result });
}
