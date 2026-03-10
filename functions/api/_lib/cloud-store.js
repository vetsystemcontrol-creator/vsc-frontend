function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return { 'Access-Control-Allow-Origin': '*' };
  if (/^https:\/\/app\.vetsystemcontrol\.com\.br$/i.test(origin)) {
    return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
    return { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' };
  }
  return { 'Access-Control-Allow-Origin': '*' };
}

async function sha256HexFromString(str) {
  const bytes = new TextEncoder().encode(String(str || ''));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeTenant(raw) {
  const v = String(raw || 'tenant-default').trim().toLowerCase();
  return v.replace(/[^a-z0-9._:-]+/g, '-').slice(0, 180) || 'tenant-default';
}

function isD1Like(db) {
  return !!(db && typeof db.prepare === 'function' && typeof db.exec === 'function');
}

function getBinding(env) {
  if (!env) return null;
  const db = env.DB || env.D1 || env.VSC_DB || null;
  return isD1Like(db) ? db : null;
}

async function ensureD1Schema(db) {
  const stmts = [
    "CREATE TABLE IF NOT EXISTS vsc_state_snapshots (tenant TEXT PRIMARY KEY, revision TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, saved_at TEXT NOT NULL, exported_at TEXT, source TEXT, snapshot_json TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_vsc_state_saved_at ON vsc_state_snapshots(saved_at)",
  ];
  for (const sql of stmts) {
    try { await db.prepare(sql).run(); } catch (e) {
      if (!String(e?.message || e).includes('already exists')) throw e;
    }
  }
}

export async function getCapabilities(env) {
  return {
    ok: true,
    available: true,
    local_static_mode: false,
    remote_sync_allowed: !!(getBinding(env) || env?.VSC_STATE_BUCKET || env?.STATE_BUCKET || env?.R2),
    storage_mode: getBinding(env) ? 'd1' : ((env?.VSC_STATE_BUCKET || env?.STATE_BUCKET || env?.R2) ? 'object-store' : 'none'),
  };
}

export async function saveSnapshot(env, tenant, snapshot, meta = {}) {
  const normTenant = normalizeTenant(tenant);
  const savedAt = new Date().toISOString();
  const exportedAt = snapshot?.meta?.exported_at || meta.exported_at || savedAt;
  const snapshotJson = JSON.stringify(snapshot || {});
  const sha256 = await sha256HexFromString(snapshotJson);
  const bytes = new TextEncoder().encode(snapshotJson).length;
  const revision = meta.revision || `${savedAt.replace(/[-:.TZ]/g, '')}-${sha256.slice(0, 12)}`;
  const source = String(meta.source || 'manual-sync').slice(0, 120);

  const db = getBinding(env);
  if (db) {
    await ensureD1Schema(db);
    await db.prepare(`
      INSERT INTO vsc_state_snapshots (tenant, revision, sha256, bytes, saved_at, exported_at, source, snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant) DO UPDATE SET
        revision=excluded.revision,
        sha256=excluded.sha256,
        bytes=excluded.bytes,
        saved_at=excluded.saved_at,
        exported_at=excluded.exported_at,
        source=excluded.source,
        snapshot_json=excluded.snapshot_json
    `).bind(normTenant, revision, sha256, bytes, savedAt, exportedAt, source, snapshotJson).run();
    return {
      ok: true,
      exists: true,
      meta: { tenant: normTenant, revision, sha256, bytes, saved_at: savedAt, exported_at: exportedAt, source },
    };
  }

  const bucket = env?.VSC_STATE_BUCKET || env?.STATE_BUCKET || env?.R2 || null;
  if (bucket && typeof bucket.put === 'function') {
    const key = `vsc-state/${normTenant}.json`;
    const payload = JSON.stringify({
      meta: { tenant: normTenant, revision, sha256, bytes, saved_at: savedAt, exported_at: exportedAt, source },
      snapshot,
    });
    await bucket.put(key, payload, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    });
    return {
      ok: true,
      exists: true,
      meta: { tenant: normTenant, revision, sha256, bytes, saved_at: savedAt, exported_at: exportedAt, source },
    };
  }

  return { ok: false, error: 'storage_not_configured' };
}

export async function loadSnapshot(env, tenant, metaOnly = false) {
  const normTenant = normalizeTenant(tenant);
  const db = getBinding(env);
  if (db) {
    await ensureD1Schema(db);
    const row = await db.prepare(`
      SELECT tenant, revision, sha256, bytes, saved_at, exported_at, source, snapshot_json
      FROM vsc_state_snapshots
      WHERE tenant = ?
      LIMIT 1
    `).bind(normTenant).first();
    if (!row) return { ok: true, exists: false, meta: { tenant: normTenant } };
    const meta = {
      tenant: row.tenant,
      revision: row.revision,
      sha256: row.sha256,
      bytes: row.bytes,
      saved_at: row.saved_at,
      exported_at: row.exported_at,
      source: row.source,
    };
    return {
      ok: true,
      exists: true,
      meta,
      snapshot: metaOnly ? null : JSON.parse(row.snapshot_json || '{}'),
    };
  }

  const bucket = env?.VSC_STATE_BUCKET || env?.STATE_BUCKET || env?.R2 || null;
  if (bucket && typeof bucket.get === 'function') {
    const obj = await bucket.get(`vsc-state/${normTenant}.json`);
    if (!obj) return { ok: true, exists: false, meta: { tenant: normTenant } };
    const text = await obj.text();
    const payload = JSON.parse(text || '{}');
    return {
      ok: true,
      exists: !!payload?.meta,
      meta: payload?.meta || { tenant: normTenant },
      snapshot: metaOnly ? null : (payload?.snapshot || null),
    };
  }

  return { ok: false, error: 'storage_not_configured', meta: { tenant: normTenant } };
}

export function buildJsonResponse(request, body, status = 200) {
  return json(body, status, corsHeaders(request));
}

export function buildOptionsResponse(request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-VSC-Tenant, X-VSC-User, X-VSC-Token',
      'Access-Control-Max-Age': '86400',
      'cache-control': 'no-store',
    },
  });
}
