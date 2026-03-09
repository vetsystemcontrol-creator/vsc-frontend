
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = String(url.searchParams.get('action') || '').trim().toLowerCase();
  if (action !== 'capabilities') {
    return new Response(JSON.stringify({ ok: false, error: 'unsupported_action', action }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  const hasD1 = Boolean(env?.DB || env?.D1 || env?.VSC_DB);
  const remoteSyncAllowed = hasD1 || env?.VSC_SYNC_ENABLED === '1' || env?.VSC_SYNC_ENABLED === 'true';

  return new Response(JSON.stringify({
    ok: true,
    action: 'capabilities',
    available: remoteSyncAllowed,
    storage: hasD1 ? 'd1' : 'browser',
    local_static_mode: false,
    remote_sync_allowed: remoteSyncAllowed,
    endpoints: {
      sync_push: '/api/sync/push',
      outbox: '/api/outbox',
      state: '/api/state?action=capabilities',
    },
  }), {
    status: 200,
    headers: JSON_HEADERS,
  });
}
