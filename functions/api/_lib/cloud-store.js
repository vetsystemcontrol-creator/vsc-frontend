const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const MAX_OPERATIONS_PER_PUSH = 250;
const R2_STATE_PREFIX = 'cloud-state/';
const R2_OP_PREFIX = 'cloud-ops/';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function badRequest(error, status = 400, extra = {}) {
  return json({ ok: false, error, ...extra }, status);
}

function nowIso() {
  return new Date().toISOString();
}

function pickDb(env) {
  return (env && (env.DB || env.D1 || env.VSC_DB)) || null;
}

function pickBucket(env) {
  return (env && (env.STATE_BUCKET || env.BACKUPS_BUCKET || env.VSC_STATE_BUCKET)) || null;
}

export function storageEngine(env) {
  if (pickDb(env)) return 'd1';
  if (pickBucket(env)) return 'r2';
  return 'none';
}

export async function ensureStorage(env) {
  const db = pickDb(env);
  if (db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS vsc_snapshots (
        tenant TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT,
        bytes INTEGER,
        saved_at TEXT,
        source TEXT,
        actor TEXT,
        snapshot_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vsc_operation_log (
        id TEXT PRIMARY KEY,
        tenant TEXT NOT NULL,
        op_id TEXT NOT NULL,
        entity TEXT,
        entity_id TEXT,
        action TEXT,
        payload_json TEXT,
        device_id TEXT,
        base_revision INTEGER,
        entity_revision INTEGER,
        created_at TEXT,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACK',
        UNIQUE(tenant, op_id)
      );
      CREATE INDEX IF NOT EXISTS idx_vsc_operation_tenant_received ON vsc_operation_log(tenant, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vsc_operation_tenant_entity ON vsc_operation_log(tenant, entity, entity_id);
    `);
    return { engine: 'd1', db };
  }
  const bucket = pickBucket(env);
  if (bucket) return { engine: 'r2', bucket };
  return { engine: 'none', db: null, bucket: null };
}

export function tenantFromRequest(request, body = null) {
  const url = new URL(request.url);
  const fromQuery = String(url.searchParams.get('tenant') || '').trim();
  const fromHeader = String(request.headers.get('X-VSC-Tenant') || '').trim();
  const fromBody = String(body && body.tenant ? body.tenant : '').trim();
  const raw = fromQuery || fromHeader || fromBody || 'tenant-default';
  const tenant = raw.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160) || 'tenant-default';
  return tenant;
}

export function actorFromRequest(request) {
  const actor = String(request.headers.get('X-VSC-User') || request.headers.get('CF-Connecting-IP') || 'anonymous').trim();
  return actor.slice(0, 160) || 'anonymous';
}

export async function parseJsonBody(request) {
  const text = await request.text();
  if (!text) return { body: {}, raw: '' };
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (_) {
    throw new Error('invalid_json');
  }
  return { body, raw: text };
}

export async function sha256HexFromString(input) {
  const bytes = new TextEncoder().encode(String(input || ''));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot_missing');
  if (!snapshot.schema || typeof snapshot.schema !== 'object') throw new Error('snapshot_schema_missing');
  if (!snapshot.data || typeof snapshot.data !== 'object') throw new Error('snapshot_data_missing');
  return true;
}

function r2StateKey(tenant) {
  return `${R2_STATE_PREFIX}${tenant}/latest.json`;
}

function r2OpKey(tenant, opId) {
  return `${R2_OP_PREFIX}${tenant}/${opId}.json`;
}

export async function readSnapshot(env, tenant) {
  const storage = await ensureStorage(env);
  if (storage.engine === 'd1') {
    const row = await storage.db
      .prepare('SELECT tenant, revision, sha256, bytes, saved_at, source, actor, snapshot_json FROM vsc_snapshots WHERE tenant = ?1')
      .bind(tenant)
      .first();
    if (!row) return null;
    return {
      meta: {
        tenant: row.tenant,
        revision: Number(row.revision || 0),
        sha256: row.sha256 || null,
        bytes: Number(row.bytes || 0),
        saved_at: row.saved_at || null,
        source: row.source || null,
        actor: row.actor || null,
      },
      snapshot: JSON.parse(String(row.snapshot_json || '{}')),
    };
  }
  if (storage.engine === 'r2') {
    const obj = await storage.bucket.get(r2StateKey(tenant));
    if (!obj) return null;
    const parsed = await obj.json();
    return parsed || null;
  }
  return null;
}

export async function writeSnapshot(env, tenant, snapshot, metaInput = {}) {
  validateSnapshot(snapshot);
  const storage = await ensureStorage(env);
  if (storage.engine === 'none') throw new Error('storage_unavailable');

  const snapshotJson = JSON.stringify(snapshot);
  const bytes = new TextEncoder().encode(snapshotJson).byteLength;
  if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('snapshot_too_large');

  const sha256 = await sha256HexFromString(snapshotJson);
  const current = await readSnapshot(env, tenant);
  const savedAt = nowIso();
  const revision = current && current.meta && current.meta.sha256 === sha256
    ? Number(current.meta.revision || 1)
    : Number((current && current.meta && current.meta.revision) || 0) + 1;

  const payload = {
    meta: {
      tenant,
      revision,
      sha256,
      bytes,
      saved_at: savedAt,
      source: metaInput.source || 'browser',
      actor: metaInput.actor || 'anonymous',
    },
    snapshot,
  };

  if (storage.engine === 'd1') {
    await storage.db
      .prepare(`
        INSERT INTO vsc_snapshots (tenant, revision, sha256, bytes, saved_at, source, actor, snapshot_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(tenant) DO UPDATE SET
          revision = excluded.revision,
          sha256 = excluded.sha256,
          bytes = excluded.bytes,
          saved_at = excluded.saved_at,
          source = excluded.source,
          actor = excluded.actor,
          snapshot_json = excluded.snapshot_json
      `)
      .bind(tenant, revision, sha256, bytes, savedAt, payload.meta.source, payload.meta.actor, snapshotJson)
      .run();
  } else {
    await storage.bucket.put(r2StateKey(tenant), JSON.stringify(payload), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: {
        revision: String(revision),
        sha256,
        saved_at: savedAt,
      },
    });
  }

  return payload;
}

function normalizeOperation(op) {
  if (!op || typeof op !== 'object') throw new Error('operation_invalid');
  const opId = String(op.op_id || op.id || '').trim();
  if (!opId) throw new Error('operation_missing_op_id');
  return {
    id: crypto.randomUUID(),
    op_id: opId,
    entity: String(op.entity || op.store || '').trim() || 'unknown',
    entity_id: String(op.entity_id || op.record_id || (op.payload && op.payload.id) || '').trim(),
    action: String(op.action || op.op || 'UPSERT').trim().toUpperCase(),
    payload: op.payload && typeof op.payload === 'object' ? op.payload : {},
    device_id: String(op.device_id || '').trim() || null,
    base_revision: Number(op.base_revision || 0) || 0,
    entity_revision: Number(op.entity_revision || 0) || 0,
    created_at: String(op.created_at || op.ts || nowIso()),
  };
}

export async function appendOperations(env, tenant, operations) {
  const storage = await ensureStorage(env);
  if (storage.engine === 'none') throw new Error('storage_unavailable');
  if (!Array.isArray(operations)) throw new Error('operations_invalid');
  if (operations.length > MAX_OPERATIONS_PER_PUSH) throw new Error('operations_too_many');

  const accepted = [];
  const duplicates = [];
  const receivedAt = nowIso();

  for (const item of operations) {
    const op = normalizeOperation(item);
    if (storage.engine === 'd1') {
      const existing = await storage.db
        .prepare('SELECT op_id FROM vsc_operation_log WHERE tenant = ?1 AND op_id = ?2')
        .bind(tenant, op.op_id)
        .first();
      if (existing) {
        duplicates.push(op.op_id);
        continue;
      }
      await storage.db
        .prepare(`
          INSERT INTO vsc_operation_log (
            id, tenant, op_id, entity, entity_id, action, payload_json,
            device_id, base_revision, entity_revision, created_at, received_at, status
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'ACK')
        `)
        .bind(
          op.id,
          tenant,
          op.op_id,
          op.entity,
          op.entity_id,
          op.action,
          JSON.stringify(op.payload || {}),
          op.device_id,
          op.base_revision,
          op.entity_revision,
          op.created_at,
          receivedAt,
        )
        .run();
      accepted.push(op.op_id);
    } else {
      const key = r2OpKey(tenant, op.op_id);
      const exists = await storage.bucket.head(key);
      if (exists) {
        duplicates.push(op.op_id);
        continue;
      }
      await storage.bucket.put(key, JSON.stringify({ ...op, tenant, received_at: receivedAt }), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
      });
      accepted.push(op.op_id);
    }
  }

  return {
    accepted,
    duplicates,
    received_at: receivedAt,
  };
}

export async function listRecentOperations(env, tenant, limit = 50) {
  const storage = await ensureStorage(env);
  if (storage.engine === 'd1') {
    const rows = await storage.db
      .prepare('SELECT tenant, op_id, entity, entity_id, action, created_at, received_at, status FROM vsc_operation_log WHERE tenant = ?1 ORDER BY received_at DESC LIMIT ?2')
      .bind(tenant, Math.max(1, Math.min(200, Number(limit || 50))))
      .all();
    return rows && Array.isArray(rows.results) ? rows.results : [];
  }
  return [];
}

export {
  JSON_HEADERS,
  MAX_OPERATIONS_PER_PUSH,
  MAX_SNAPSHOT_BYTES,
  json,
  badRequest,
  nowIso,
};
