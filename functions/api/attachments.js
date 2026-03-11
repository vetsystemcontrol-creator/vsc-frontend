/**
 * /api/attachments — Upload e download de attachments binários no R2
 *
 * POST /api/attachments?action=upload
 *   Body: { tenant, atendimento_id, attachment_id, filename, mime_type, data_base64 }
 *   → salva no R2 em attachments/{tenant}/{atendimento_id}/{attachment_id}
 *
 * GET /api/attachments?action=download&atendimento_id=X&attachment_id=Y
 *   → retorna o arquivo do R2
 *
 * GET /api/attachments?action=list&atendimento_id=X
 *   → lista attachments de um atendimento
 *
 * POST /api/attachments?action=delete
 *   Body: { atendimento_id, attachment_id }
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function corsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '';
  if (/^https:\/\/app\.vetsystemcontrol\.com\.br$/i.test(origin))
    return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin))
    return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  return { 'Access-Control-Allow-Origin': '*' };
}

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...(request ? corsHeaders(request) : {}) },
  });
}

function getBucket(env) {
  return env?.BACKUPS_BUCKET || null;
}

function getTenant(request) {
  return (
    request.headers.get('X-VSC-Tenant') ||
    new URL(request.url).searchParams.get('tenant') ||
    'tenant-default'
  ).slice(0, 64);
}

function r2Key(tenant, atendimento_id, attachment_id) {
  return `attachments/${tenant}/${atendimento_id}/${attachment_id}`;
}

async function handleUpload(request, env) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: 'r2_not_configured' }, 501, request);

  const tenant = getTenant(request);
  const body = await request.json().catch(() => ({}));
  const { atendimento_id, attachment_id, filename, mime_type, data_base64 } = body;

  if (!atendimento_id || !attachment_id || !data_base64) {
    return json({ ok: false, error: 'atendimento_id, attachment_id e data_base64 são obrigatórios' }, 400, request);
  }

  // Decode base64
  let bytes;
  try {
    const clean = data_base64.replace(/^data:[^;]+;base64,/, '');
    const binary = atob(clean);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch (e) {
    return json({ ok: false, error: 'base64_decode_failed', detail: String(e) }, 400, request);
  }

  const key = r2Key(tenant, atendimento_id, attachment_id);
  const meta = {
    tenant,
    atendimento_id,
    attachment_id,
    filename: String(filename || attachment_id),
    mime_type: String(mime_type || 'application/octet-stream'),
    uploaded_at: new Date().toISOString(),
    bytes: String(bytes.length),
  };

  await bucket.put(key, bytes, {
    httpMetadata: { contentType: meta.mime_type },
    customMetadata: meta,
  });

  return json({ ok: true, key, bytes: bytes.length, meta }, 200, request);
}

async function handleDownload(request, env, url) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: 'r2_not_configured' }, 501, request);

  const tenant = getTenant(request);
  const atendimento_id = url.searchParams.get('atendimento_id');
  const attachment_id = url.searchParams.get('attachment_id');

  if (!atendimento_id || !attachment_id) {
    return json({ ok: false, error: 'atendimento_id e attachment_id obrigatórios' }, 400, request);
  }

  const key = r2Key(tenant, atendimento_id, attachment_id);
  const obj = await bucket.get(key);
  if (!obj) return json({ ok: false, error: 'not_found' }, 404, request);

  const meta = obj.customMetadata || {};
  const headers = new Headers({
    ...corsHeaders(request),
    'content-type': meta.mime_type || 'application/octet-stream',
    'content-disposition': `attachment; filename="${meta.filename || attachment_id}"`,
    'cache-control': 'private, max-age=3600',
  });

  return new Response(obj.body, { status: 200, headers });
}

async function handleList(request, env, url) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: 'r2_not_configured' }, 501, request);

  const tenant = getTenant(request);
  const atendimento_id = url.searchParams.get('atendimento_id');

  const prefix = atendimento_id
    ? `attachments/${tenant}/${atendimento_id}/`
    : `attachments/${tenant}/`;

  const listed = await bucket.list({ prefix, limit: 1000 });
  const items = (listed.objects || []).map(obj => ({
    key: obj.key,
    size: obj.size,
    uploaded_at: obj.uploaded || null,
    meta: obj.customMetadata || {},
  }));

  return json({ ok: true, tenant, atendimento_id, items, total: items.length }, 200, request);
}

async function handleDelete(request, env) {
  const bucket = getBucket(env);
  if (!bucket) return json({ ok: false, error: 'r2_not_configured' }, 501, request);

  const tenant = getTenant(request);
  const body = await request.json().catch(() => ({}));
  const { atendimento_id, attachment_id } = body;

  if (!atendimento_id || !attachment_id) {
    return json({ ok: false, error: 'atendimento_id e attachment_id obrigatórios' }, 400, request);
  }

  const key = r2Key(tenant, atendimento_id, attachment_id);
  await bucket.delete(key);
  return json({ ok: true, key }, 200, request);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type, X-VSC-Tenant, X-VSC-User, X-VSC-Token',
        'access-control-max-age': '86400',
        'cache-control': 'no-store',
      },
    });
  }

  try {
    const action = url.searchParams.get('action') || (method === 'GET' ? 'list' : 'upload');

    if (method === 'GET') {
      if (action === 'download') return await handleDownload(request, env, url);
      if (action === 'list') return await handleList(request, env, url);
      return json({ ok: false, error: 'unknown_action' }, 400, request);
    }

    if (method === 'POST') {
      if (action === 'upload') return await handleUpload(request, env);
      if (action === 'delete') return await handleDelete(request, env);
      return json({ ok: false, error: 'unknown_action' }, 400, request);
    }

    return json({ ok: false, error: 'method_not_allowed' }, 405, request);
  } catch (error) {
    return json({ ok: false, error: 'attachments_failed', detail: String(error?.message || error) }, 500, request);
  }
}
