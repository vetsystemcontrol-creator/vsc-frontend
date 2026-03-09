
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function getDB(env) {
  return env?.DB || env?.D1 || env?.VSC_DB || null;
}

function getTenant(request) {
  const raw = request.headers.get('X-VSC-Tenant') || 'tenant-default';
  return String(raw).trim().slice(0, 120) || 'tenant-default';
}

function getUserLabel(request) {
  const raw = request.headers.get('X-VSC-User') || 'anonymous';
  return String(raw).trim().slice(0, 120) || 'anonymous';
}

function normStr(v, max = 200) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function normNum(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeOperation(op = {}) {
  const action = normStr(op.action || op.op || 'upsert', 40).toLowerCase() || 'upsert';
  const entity = normStr(op.entity || 'UNKNOWN', 120) || 'UNKNOWN';
  const entityId = normStr(op.entity_id || op.target_id || op.ref_id || op.id || '', 160);
  const opId = normStr(op.op_id || op.id || '', 160);
  const deviceId = normStr(op.device_id || '', 160);
  const baseRevision = normNum(op.base_revision, 0);
  const entityRevision = Math.max(1, normNum(op.entity_revision, baseRevision + 1));
  const dedupeKey = normStr(op.dedupe_key || [entity, entityId, action, String(baseRevision), String(entityRevision)].join(':'), 300);
  const payload = op.payload ?? null;
  const createdAt = normStr(op.created_at || op.updated_at || nowIso(), 40) || nowIso();
  const status = normStr(op.status || 'PENDING', 40) || 'PENDING';
  return {
    op_id: opId,
    entity,
    entity_id: entityId,
    action,
    payload,
    created_at: createdAt,
    status,
    device_id: deviceId,
    base_revision: baseRevision,
    entity_revision: entityRevision,
    dedupe_key: dedupeKey,
  };
}

async function ensureSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sync_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant TEXT NOT NULL,
      op_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT,
      device_id TEXT,
      user_label TEXT,
      created_at_client TEXT,
      received_at TEXT NOT NULL,
      base_revision INTEGER NOT NULL DEFAULT 0,
      entity_revision INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'ACKED'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_operations_tenant_op_id
      ON sync_operations (tenant, op_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_operations_tenant_dedupe_key
      ON sync_operations (tenant, dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_sync_operations_tenant_entity
      ON sync_operations (tenant, entity, entity_id);
    CREATE INDEX IF NOT EXISTS idx_sync_operations_received_at
      ON sync_operations (received_at);
  `);
}

async function findDuplicate(db, tenant, op) {
  let row = null;
  if (op.op_id) {
    row = await db.prepare(`SELECT id, op_id, dedupe_key, received_at FROM sync_operations WHERE tenant = ?1 AND op_id = ?2 LIMIT 1`)
      .bind(tenant, op.op_id).first();
  }
  if (!row && op.dedupe_key) {
    row = await db.prepare(`SELECT id, op_id, dedupe_key, received_at FROM sync_operations WHERE tenant = ?1 AND dedupe_key = ?2 LIMIT 1`)
      .bind(tenant, op.dedupe_key).first();
  }
  return row || null;
}

async function ingestOperation(db, tenant, userLabel, rawOp) {
  const op = normalizeOperation(rawOp);
  if (!op.op_id) {
    return { ok: false, code: 'missing_op_id', operation: op };
  }
  if (!op.entity_id) {
    return { ok: false, code: 'missing_entity_id', operation: op };
  }

  const existing = await findDuplicate(db, tenant, op);
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      ack_id: op.op_id,
      dedupe_key: op.dedupe_key,
      received_at: existing.received_at,
    };
  }

  const receivedAt = nowIso();
  const payloadJson = JSON.stringify(op.payload ?? null);
  await db.prepare(`
    INSERT INTO sync_operations (
      tenant, op_id, dedupe_key, entity, entity_id, action, payload_json,
      device_id, user_label, created_at_client, received_at,
      base_revision, entity_revision, status
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'ACKED')
  `).bind(
    tenant,
    op.op_id,
    op.dedupe_key,
    op.entity,
    op.entity_id,
    op.action,
    payloadJson,
    op.device_id,
    userLabel,
    op.created_at,
    receivedAt,
    op.base_revision,
    op.entity_revision,
  ).run();

  return {
    ok: true,
    duplicate: false,
    ack_id: op.op_id,
    dedupe_key: op.dedupe_key,
    received_at: receivedAt,
  };
}

export {
  JSON_HEADERS,
  json,
  getDB,
  getTenant,
  getUserLabel,
  ensureSchema,
  ingestOperation,
};
