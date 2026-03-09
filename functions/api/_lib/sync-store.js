const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function corsHeaders(request) {
  const origin = request?.headers?.get?.('Origin') || '';
  if (!origin) {
    return {
      'Access-Control-Allow-Origin': '*',
      Vary: 'Origin',
    };
  }
  if (/^https:\/\/app\.vetsystemcontrol\.com\.br$/i.test(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return { 'Access-Control-Allow-Origin': '*', Vary: 'Origin' };
}

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request) },
  });
}

function options(request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-VSC-Tenant, X-VSC-User, X-VSC-Token',
      'Access-Control-Max-Age': '86400',
      'cache-control': 'no-store',
    },
  });
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
  const entity = normStr(op.entity || op.store || 'UNKNOWN', 120) || 'UNKNOWN';
  const entityId = normStr(op.entity_id || op.target_id || op.ref_id || op.id || '', 160);
  const opId = normStr(op.op_id || op.id || '', 160);
  const deviceId = normStr(op.device_id || '', 160);
  const baseRevision = normNum(op.base_revision, 0);
  const entityRevision = Math.max(1, normNum(op.entity_revision, baseRevision + 1));
  const dedupeKey = normStr(op.dedupe_key || [entity, entityId, action, String(baseRevision), String(entityRevision)].join(':'), 300);
  const payload = op.payload ?? null;
  const createdAt = normStr(op.created_at || op.updated_at || nowIso(), 40) || nowIso();
  const status = normStr(op.status || 'PENDING', 40) || 'PENDING';
  const store = inferStore({ entity, action, payload, store: op.store || op.store_name || '' });
  return {
    op_id: opId,
    entity,
    store,
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

const ENTITY_TO_STORE = Object.freeze({
  clientes: 'clientes_master',
  clientes_master: 'clientes_master',
  fornecedores: 'fornecedores_master',
  fornecedores_master: 'fornecedores_master',
  produtos: 'produtos_master',
  produtos_master: 'produtos_master',
  produtos_lotes: 'produtos_lotes',
  animais: 'animais_master',
  animais_master: 'animais_master',
  atendimentos: 'atendimentos_master',
  atendimentos_master: 'atendimentos_master',
  servicos: 'servicos_master',
  servicos_master: 'servicos_master',
  exames: 'exames_master',
  exames_master: 'exames_master',
  contas_pagar: 'contas_pagar',
  contas_receber: 'contas_receber',
  fechamentos: 'fechamentos',
  user_profiles: 'user_profiles',
  repro_cases: 'repro_cases',
  repro_events: 'repro_events',
  repro_exams: 'repro_exams',
  repro_foaling: 'repro_foaling',
  repro_pregnancy: 'repro_pregnancy',
  repro_protocols: 'repro_protocols',
  repro_tasks: 'repro_tasks',
  animal_vitals_history: 'animal_vitals_history',
  animal_vaccines: 'animal_vaccines',
  estoque_movimentos: 'estoque_movimentos',
  estoque_saldos: 'estoque_saldos',
  import_ledger: 'import_ledger',
  billing_events: 'billing_events',
  tenant_subscription: 'tenant_subscription',
  auth_users: 'auth_users',
  auth_roles: 'auth_roles',
  auth_role_permissions: 'auth_role_permissions',
  auth_sessions: 'auth_sessions',
  auth_audit_log: 'auth_audit_log',
  business_audit_log: 'business_audit_log',
  config_params: 'config_params',
  config_audit_log: 'config_audit_log',
  backup_events: 'backup_events',
  db_backups: 'db_backups',
  sys_meta: 'sys_meta',
});

function inferStore({ entity = '', payload = null, store = '' } = {}) {
  const direct = normStr(store, 120).toLowerCase();
  if (direct) return direct;
  const e = normStr(entity, 120).toLowerCase();
  if (ENTITY_TO_STORE[e]) return ENTITY_TO_STORE[e];
  if (payload && typeof payload === 'object') {
    if (typeof payload.__store === 'string' && payload.__store.trim()) return normStr(payload.__store, 120).toLowerCase();
    if (payload.cliente) return 'clientes_master';
    if (payload.fornecedor) return 'fornecedores_master';
    if (payload.produto) return 'produtos_master';
    if (payload.animal) return 'animais_master';
    if (payload.atendimento) return 'atendimentos_master';
    if (payload.servico) return 'servicos_master';
    if (payload.exame) return 'exames_master';
  }
  return e || 'unknown_records';
}

function extractCanonicalPayload(op) {
  const payload = op?.payload;
  if (!payload || typeof payload !== 'object') return payload ?? null;

  const preferredKeys = ['cliente', 'fornecedor', 'produto', 'animal', 'atendimento', 'servico', 'exame', 'record', 'data'];
  for (const key of preferredKeys) {
    if (payload[key] && typeof payload[key] === 'object') {
      return { ...payload[key] };
    }
  }

  const cleaned = { ...payload };
  delete cleaned.action;
  delete cleaned.op;
  delete cleaned.__origin;
  delete cleaned.__store;
  return cleaned;
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

    CREATE TABLE IF NOT EXISTS canonical_records (
      tenant TEXT NOT NULL,
      store_name TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      payload_json TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      source_op_id TEXT,
      PRIMARY KEY (tenant, store_name, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_canonical_records_tenant_store
      ON canonical_records (tenant, store_name, updated_at);
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

async function materializeCanonicalRecord(db, tenant, op) {
  const storeName = normStr(op.store || inferStore(op), 120).toLowerCase() || 'unknown_records';
  const updatedAt = nowIso();
  const revision = normNum(op.entity_revision, 1);
  const action = String(op.action || 'upsert').toLowerCase();

  if (action === 'delete' || action === 'remove' || action === 'archive') {
    await db.prepare(`
      INSERT INTO canonical_records (tenant, store_name, entity_id, payload_json, deleted, revision, updated_at, source_op_id)
      VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7)
      ON CONFLICT(tenant, store_name, entity_id) DO UPDATE SET
        payload_json=excluded.payload_json,
        deleted=1,
        revision=excluded.revision,
        updated_at=excluded.updated_at,
        source_op_id=excluded.source_op_id
    `).bind(tenant, storeName, op.entity_id, JSON.stringify({ id: op.entity_id, deleted_at: updatedAt }), revision, updatedAt, op.op_id).run();
    return;
  }

  const payload = extractCanonicalPayload(op);
  const record = (payload && typeof payload === 'object') ? { ...payload } : { value: payload };
  if (!record.id && op.entity_id) record.id = op.entity_id;
  if (!record.updated_at) record.updated_at = updatedAt;

  await db.prepare(`
    INSERT INTO canonical_records (tenant, store_name, entity_id, payload_json, deleted, revision, updated_at, source_op_id)
    VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7)
    ON CONFLICT(tenant, store_name, entity_id) DO UPDATE SET
      payload_json=excluded.payload_json,
      deleted=0,
      revision=excluded.revision,
      updated_at=excluded.updated_at,
      source_op_id=excluded.source_op_id
  `).bind(tenant, storeName, op.entity_id, JSON.stringify(record), revision, updatedAt, op.op_id).run();
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

  await materializeCanonicalRecord(db, tenant, op);

  return {
    ok: true,
    duplicate: false,
    ack_id: op.op_id,
    dedupe_key: op.dedupe_key,
    received_at: receivedAt,
  };
}

async function buildCanonicalSnapshot(db, tenant) {
  await ensureSchema(db);
  const rows = await db.prepare(`
    SELECT store_name, entity_id, payload_json, deleted, revision, updated_at
    FROM canonical_records
    WHERE tenant = ?1
    ORDER BY store_name ASC, updated_at ASC, entity_id ASC
  `).bind(tenant).all();
  const results = Array.isArray(rows?.results) ? rows.results : [];
  const data = {};
  for (const row of results) {
    const store = String(row.store_name || '').trim();
    if (!store) continue;
    if (!data[store]) data[store] = [];
    if (Number(row.deleted || 0) === 1) continue;
    try {
      const obj = JSON.parse(row.payload_json || 'null');
      if (obj && typeof obj === 'object') data[store].push(obj);
    } catch (_) {}
  }
  const stores = Object.keys(data).sort();
  return {
    ok: true,
    exists: stores.length > 0,
    meta: {
      tenant,
      exported_at: nowIso(),
      source: 'canonical_records',
      stores: stores.length,
    },
    snapshot: {
      meta: {
        format: 'vsc_backup_stream_v1',
        exported_at: nowIso(),
        source: 'canonical_records',
      },
      schema: {
        db_name: 'vsc_db',
        db_version: 34,
        stores,
      },
      data,
    },
  };
}

export {
  JSON_HEADERS,
  json,
  options,
  corsHeaders,
  getDB,
  getTenant,
  getUserLabel,
  ensureSchema,
  ingestOperation,
  buildCanonicalSnapshot,
};
