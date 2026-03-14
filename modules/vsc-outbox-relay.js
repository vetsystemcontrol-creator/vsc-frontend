/*! 
 * VSC-OUTBOX-RELAY — Transactional Outbox Message Relay (Premium)
 * ============================================================
 * SGQT 8.0 — Confiabilidade Máxima
 *
 * Objetivo:
 *  - Drenar a fila IDB (sync_queue) rapidamente quando há backlog (ex.: pós-restore)
 *  - Fail-closed (não derruba o app)
 *  - Idempotência no receptor (op_id) → safe retry
 *  - Lotes adaptativos + backoff apenas em erro
 *
 * Compatibilidade:
 *  - Preferencial: POST /api/sync/push  { operations: [...] }
 *  - Fallback legado: POST /api/outbox { entity, entity_id, op, payload }
 *
 * Depende de:
 *  - IndexedDB: DB "vsc_db" (ou definido em window.VSC_DB_NAME)
 *  - Store: sync_queue
 *
 * Expõe:
 *  - window.VSC_RELAY.start()
 *  - window.VSC_RELAY.stop()
 *  - window.VSC_RELAY.status()
 *  - window.VSC_RELAY.syncNow()
 */
(() => {
  'use strict';

  // ──────────────────────────────────────────────────────────
  // Config (enterprise defaults)
  // ──────────────────────────────────────────────────────────
  const DB_NAME      = (window.VSC_DB_NAME || 'vsc_db');
  const STORE_OUTBOX = 'sync_queue';
  const API_CAPABILITIES_URL = '/api/state?action=capabilities';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';
  const SYNC_TARGET_MODE_KEY = 'vsc_sync_target_mode';
  const NETWORK_TIMEOUT_MS = 20_000;

  // Ritmo: rápido com backlog, econômico quando ocioso
  const ACTIVE_TICK_MS = 250;   // quando há pendências
  const IDLE_TICK_MS   = 15_000; // quando não há pendências

  // Lote adaptativo (pós-restore precisa drenar rápido)
  const MIN_BATCH = 10;
  const MAX_BATCH = 150;

  // Erros → backoff (somente quando falha)
  const BASE_BACKOFF_MS = 500;
  const MAX_BACKOFF_MS  = 10_000;

  // Limite de retries por evento (auditoria)
  const MAX_RETRIES = 7;

  // ──────────────────────────────────────────────────────────
  // Estado
  // ──────────────────────────────────────────────────────────
  let _enabled = true;
  let _running = false;
  let _stopRequested = false;
  let _lastError = null;
  let _lastCycleAt = null;
  let _inFlight = null; // promise
  let _capabilities = null;
  let _capabilitiesCheckedAt = 0;
  let _stats = {
    pending: 0,
    sent: 0,
    acked: 0,
    failedBatches: 0,
    lastRateOps: 0,
    lastBatchSize: 0,
    lastDurationMs: 0,
  };

  // ──────────────────────────────────────────────────────────
  // Small helpers
  // ──────────────────────────────────────────────────────────
  function _now() { return Date.now(); }
  function normalizeTenantId(raw) {
    try {
      const value = String(raw || 'tenant-default')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._:-]+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 120);
      return value || 'tenant-default';
    } catch (_) {
      return 'tenant-default';
    }
  }


  async function _getRuntimeContext() {
    try {
      if (window.VSC_DB && typeof window.VSC_DB.getRuntimeContext === 'function') {
        return await window.VSC_DB.getRuntimeContext();
      }
    } catch (_) {}
    try {
      const raw = localStorage.getItem('vsc_user') || sessionStorage.getItem('vsc_user') || 'null';
      const u = JSON.parse(raw);
      return {
        tenant: normalizeTenantId(localStorage.getItem('vsc_tenant') || sessionStorage.getItem('vsc_tenant') || 'tenant-default'),
        userLabel: String((u && (u.username || u.nome || u.name || u.id || u.email)) || 'anonymous').slice(0, 120),
        sessionId: String(localStorage.getItem('vsc_session_id') || sessionStorage.getItem('vsc_session_id') || '').slice(0, 120),
        token: String(localStorage.getItem('vsc_local_token') || sessionStorage.getItem('vsc_local_token') || localStorage.getItem('vsc_token') || sessionStorage.getItem('vsc_token') || '').trim(),
      };
    } catch (_) {
      return { tenant: 'tenant-default', userLabel: 'anonymous', sessionId: '', token: '' };
    }
  }

  function _getSyncTargetMode() {
    try {
      return String(localStorage.getItem(SYNC_TARGET_MODE_KEY) || '').trim().toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function _isCrossOriginUrl(url) {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch (_) {
      return false;
    }
  }

  function _withTenantParam(url, tenant) {
    try {
      const u = new URL(url, location.href);
      if (!u.searchParams.get('tenant')) u.searchParams.set('tenant', normalizeTenantId(tenant || 'tenant-default'));
      return u.toString();
    } catch (_) {
      return url;
    }
  }

  async function _fetchWithTimeout(url, options = {}, timeoutMs = NETWORK_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try { controller.abort(); } catch (_) {}
    }, Math.max(1, Number(timeoutMs) || 1));
    try {
      const credentials = Object.prototype.hasOwnProperty.call(options, 'credentials') ? options.credentials : 'include';
      return await fetch(url, { ...options, credentials, signal: controller.signal });
    } catch (err) {
      if (String(err && err.name || '') === 'AbortError') {
        throw new Error(`network_timeout_${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function _emitProgress(extra = {}) {
    const detail = {
      ok: !_lastError,
      error: _lastError ? String(_lastError) : null,
      running: _running,
      ..._stats,
      ...extra,
    };

    // Prefer UI adapter if present
    if (window.VSC_SYNC_UI && typeof window.VSC_SYNC_UI.onProgress === 'function') {
      try { window.VSC_SYNC_UI.onProgress(detail); } catch (_) {}
    }

    // Also emit DOM event for any listeners
    try {
      window.dispatchEvent(new CustomEvent('vsc:sync-progress', { detail }));
    } catch (_) {}
  }

  function _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function _isLocalStaticMode() {
    try {
      const proto = String(location.protocol || '').toLowerCase();
      if (proto === 'file:') return true;
    } catch (_) {}
    return false;
  }

  function _isWranglerDev() {
    try {
      const host = String(location.hostname || '').toLowerCase();
      const proto = String(location.protocol || '').toLowerCase();
      // wrangler pages dev serve via http em 127.0.0.1 ou localhost com porta
      return proto === 'http:' && (host === '127.0.0.1' || host === 'localhost');
    } catch (_) {}
    return false;
  }

  function _apiBase() {
    const mode = _getSyncTargetMode();
    if (_isLocalStaticMode()) return REMOTE_BASE;
    if (_isWranglerDev()) {
      if (mode === 'local') return '';
      return REMOTE_BASE;
    }
    return '';
  }

  function _apiUrl(path) {
    return `${_apiBase()}${path}`;
  }

  async function _readCapabilities() {
    const now = _now();
    if (_capabilities && (now - _capabilitiesCheckedAt) < 15000) return _capabilities;

    try {
      const ctx = await _getRuntimeContext();
      const tenant = normalizeTenantId(ctx.tenant || 'tenant-default');
      const capabilitiesUrl = _withTenantParam(_apiUrl(API_CAPABILITIES_URL), tenant);
      const crossOrigin = _isCrossOriginUrl(capabilitiesUrl);
      const userLabel = ctx.userLabel || 'anonymous';
      const clientSession = ctx.sessionId || '';
      const syncToken = ctx.token || '';
      const headers = {
        'Accept': 'application/json',
        'X-VSC-Tenant': tenant,
        'X-VSC-User': userLabel,
        'X-VSC-Client-Session': clientSession,
      };
      if (syncToken) headers['X-VSC-Token'] = syncToken;

      const res = await _fetchWithTimeout(capabilitiesUrl, {
        method: 'GET',
        headers,
        cache: 'no-store',
        credentials: crossOrigin ? 'omit' : 'include',
      }, NETWORK_TIMEOUT_MS);
      if (!res.ok) {
        _capabilities = {
          ok: false,
          available: false,
          remote_sync_allowed: false,
          local_static_mode: false,
          reason: 'capabilities-http-' + res.status,
          status: res.status,
        };
      } else {
        const body = await res.json().catch(() => ({}));
        const authorized = body.authorized !== false;
        _capabilities = {
          ok: body.ok !== false && authorized,
          available: body.available !== false,
          remote_sync_allowed: body.remote_sync_allowed !== false && authorized,
          local_static_mode: !!body.local_static_mode,
          reason: body.reason || body.auth_error || '',
          status: res.status,
          authorized,
          auth_required: !!body.auth_required,
          auth_mode: body.auth_mode || null,
          degraded_auth: !!body.degraded_auth,
          body,
        };
      }
    } catch (err) {
      _capabilities = {
        ok: false,
        available: false,
        remote_sync_allowed: false,
        local_static_mode: false,
        reason: String(err || 'capabilities-fetch-failed'),
      };
    }
    _capabilitiesCheckedAt = now;
    return _capabilities;
  }

  function _openDB() {
    return new Promise((resolve, reject) => {
      try {
        if (window.VSC_DB && typeof window.VSC_DB.openDB === 'function') {
          Promise.resolve(window.VSC_DB.openDB()).then(resolve).catch(reject);
          return;
        }
      } catch (_) {}

      const req = indexedDB.open(DB_NAME);
      req.onerror = () => reject(req.error || new Error('IDB open failed'));
      req.onsuccess = () => resolve(req.result);
    });
  }

  function _tx(db, mode = 'readonly') {
    return db.transaction([STORE_OUTBOX], mode).objectStore(STORE_OUTBOX);
  }

  function _reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IDB request failed'));
    });
  }

  async function _countPending(db) {
    const store = _tx(db, 'readonly');
    // Prefer index if exists
    if (store.indexNames && store.indexNames.contains('status')) {
      const idx = store.index('status');
      const countReq = idx.count('PENDING');
      return await _reqToPromise(countReq);
    }
    // Fallback: scan (slower but safe)
    const all = await _reqToPromise(store.getAll());
    return (all || []).filter(e => e && e.status === 'PENDING').length;
  }

  async function _refreshPendingStats(db = null) {
    let handle = db;
    let shouldClose = false;
    try {
      if (!handle) {
        handle = await _openDB();
        shouldClose = true;
      }
      const pending = await _countPending(handle);
      _stats.pending = pending;
      return pending;
    } finally {
      if (shouldClose && handle) {
        try { handle.close(); } catch (_) {}
      }
    }
  }

  async function _readPendingBatch(db, limit) {
    const store = _tx(db, 'readonly');

    // Ideal: status index + cursor
    if (store.indexNames && store.indexNames.contains('status')) {
      const idx = store.index('status');
      const out = [];
      return await new Promise((resolve, reject) => {
        const req = idx.openCursor('PENDING');
        req.onerror = () => reject(req.error || new Error('cursor failed'));
        req.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor || out.length >= limit) return resolve(out);
          out.push(cursor.value);
          cursor.continue();
        };
      });
    }

    // Fallback: getAll + filter
    const all = await _reqToPromise(store.getAll());
    const pending = (all || []).filter(e => e && _isPendingStatus(e.status));
    // Sort stable by created_at/id to keep deterministic drain
    pending.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    return pending.slice(0, limit);
  }

  async function _markBatch(db, ids, patch) {
    const store = _tx(db, 'readwrite');
    for (const id of ids) {
      const rec = await _reqToPromise(store.get(id));
      if (!rec) continue;
      Object.assign(rec, patch);
      await _reqToPromise(store.put(rec));
    }
  }

  async function _applyPushResult(db, batch, resp) {
    const rows = Array.isArray(batch) ? batch : [];
    if (!rows.length) return { acked: 0, rejected: 0, pending: 0 };

    const ackIds = new Set(((resp && Array.isArray(resp.ack_ids)) ? resp.ack_ids : []).map((v) => String(v || '')));
    const rejectedRaw = (resp && Array.isArray(resp.rejected)) ? resp.rejected : [];
    const rejectedByOpId = new Map(
      rejectedRaw
        .filter((item) => item && (item.op_id || item.id))
        .map((item) => [String(item.op_id || item.id), item])
    );

    const granularAckAvailable = ackIds.size > 0 || rejectedRaw.length > 0;
    const canAckWholeBatch = !granularAckAvailable && resp && resp.ok === true;

    const store = _tx(db, 'readwrite');
    const now = _now();
    let acked = 0;
    let rejected = 0;
    let pending = 0;

    for (const ev of rows) {
      if (!ev || !ev.id) continue;
      const rec = await _reqToPromise(store.get(ev.id));
      if (!rec) continue;

      const ackedById = ackIds.has(String(ev.op_id || ev.id || ''));
      const rejectedMeta = rejectedByOpId.get(String(ev.op_id || ev.id || '')) || null;

      if (ackedById || canAckWholeBatch) {
        rec.status = 'DONE';
        rec.done_at = now;
        rec.last_ack = resp || null;
        rec.last_error = null;
        acked += 1;
      } else if (rejectedMeta) {
        rec.retry_count = Number(rec.retry_count || 0) + 1;
        rec.last_error = String(rejectedMeta.code || rejectedMeta.error || 'sync_rejected');
        rec.last_rejected = rejectedMeta;
        if (rec.retry_count >= MAX_RETRIES) {
          rec.status = 'DEAD';
          rec.dead_at = now;
        } else {
          rec.status = 'PENDING';
        }
        rejected += 1;
      } else {
        // Resposta parcial/indeterminada: nunca confirmar como DONE.
        rec.status = 'PENDING';
        rec.last_error = 'sync_ack_indeterminate';
        rec.last_ack = resp || null;
        pending += 1;
      }

      await _reqToPromise(store.put(rec));
    }

    return { acked, rejected, pending };
  }

  function _computeBatchSize(pending) {
    if (pending <= 0) return 0;
    // Heurística simples: mais backlog → lote maior
    if (pending >= 2000) return MAX_BATCH;
    if (pending >= 500) return Math.min(MAX_BATCH, 120);
    if (pending >= 200) return Math.min(MAX_BATCH, 80);
    if (pending >= 50)  return Math.min(MAX_BATCH, 40);
    return Math.max(MIN_BATCH, 20);
  }

  // ──────────────────────────────────────────────────────────
  // Network: push
  // ──────────────────────────────────────────────────────────
  async function _pushBatchSyncPush(batch) {
    const ctx = await _getRuntimeContext();
    const tenant = normalizeTenantId(ctx.tenant || 'tenant-default');
    const userLabel = ctx.userLabel || 'anonymous';
    const clientSession = ctx.sessionId || '';
    const syncToken = ctx.token || '';

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-VSC-Tenant': tenant,
      'X-VSC-User': userLabel,
      'X-VSC-Client-Session': clientSession,
    };
    if (syncToken) headers['X-VSC-Token'] = syncToken;

    const pushUrl = _withTenantParam(_apiUrl('/api/sync/push'), tenant);
    const crossOrigin = _isCrossOriginUrl(pushUrl);
    const res = await _fetchWithTimeout(pushUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operations: batch }),
      credentials: crossOrigin ? 'omit' : 'include',
    }, NETWORK_TIMEOUT_MS);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`sync/push failed ${res.status} ${text}`);
    }

    return await res.json().catch(() => ({ ok: true }));
  }

  async function _pushBatchLegacyOutbox(batch) {
    const ctx = await _getRuntimeContext();
    const tenant = normalizeTenantId(ctx.tenant || 'tenant-default');
    const userLabel = ctx.userLabel || 'anonymous';
    const clientSession = ctx.sessionId || '';
    const syncToken = ctx.token || '';

    for (const ev of batch) {
      const body = {
        entity: ev.entity,
        entity_id: ev.entity_id,
        op: ev.op,
        payload: ev.payload,
        op_id: ev.op_id,
      };
      const legacyUrl = _withTenantParam(_apiUrl('/api/outbox'), tenant);
      const crossOrigin = _isCrossOriginUrl(legacyUrl);
      const res = await _fetchWithTimeout(legacyUrl, {
        method: 'POST',
        headers: (() => { const h = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-VSC-Tenant': tenant,
          'X-VSC-User': userLabel,
          'X-VSC-Client-Session': clientSession,
        }; if (syncToken) h['X-VSC-Token'] = syncToken; return h; })(),
        body: JSON.stringify(body),
        credentials: crossOrigin ? 'omit' : 'include',
      }, NETWORK_TIMEOUT_MS);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`outbox failed ${res.status} ${text}`);
      }
    }
    return { ok: true };
  }

  async function _pushBatch(batch) {
    const caps = await _readCapabilities();
    if (!caps || caps.remote_sync_allowed === false) {
      const reason = (caps && caps.reason) ? caps.reason : 'remote-sync-disabled';
      throw new Error(reason);
    }
    // Prefer /api/sync/push
    try {
      return await _pushBatchSyncPush(batch);
    } catch (e) {
      const msg = String(e || '');
      const recoverable = msg.includes(' 404 ') || msg.includes(' 405 ') || msg.includes(' 501 ') || msg.includes('unsupported_action') || msg.includes('Cannot');
      if (recoverable) {
        return await _pushBatchLegacyOutbox(batch);
      }
      throw e;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Core loop
  // ──────────────────────────────────────────────────────────
  async function _drainLoop({ force = false, budgetMs = 0 } = {}) {
    if (_inFlight) return _inFlight;

    _inFlight = (async () => {
      _stopRequested = false;
      _running = true;
      _lastError = null;
      _emitProgress();

      let backoffMs = 0;
      const startedAt = _now();
      let budgetExceeded = false;

      try {
        while (_enabled && !_stopRequested) {
          if (force && budgetMs > 0 && (_now() - startedAt) >= budgetMs) {
            budgetExceeded = true;
            break;
          }

          _lastCycleAt = _now();
          const t0 = _now();

          const db = await _openDB();
          try {
            const pending = await _countPending(db);
            _stats.pending = pending;

            if (pending <= 0) {
              _stats.lastBatchSize = 0;
              _stats.lastRateOps = 0;
              _stats.lastDurationMs = _now() - t0;
              _emitProgress({ idle: true, budgetExceeded });
              if (force) break;
              await _sleep(IDLE_TICK_MS);
              continue;
            }

            const caps = await _readCapabilities();
            if (!caps || caps.remote_sync_allowed === false) {
              _stats.lastBatchSize = 0;
              _stats.lastRateOps = 0;
              _stats.lastDurationMs = _now() - t0;
              _emitProgress({
                idle: true,
                capabilities: caps || null,
                local_static_mode: !!(caps && caps.local_static_mode),
                remote_sync_allowed: false,
                budgetExceeded,
              });
              if (force) break;
              await _sleep(IDLE_TICK_MS);
              continue;
            }

            const batchSize = _computeBatchSize(pending);
            const batch = await _readPendingBatch(db, batchSize);
            const ids = batch.map(e => e.id).filter(Boolean);

            _stats.lastBatchSize = batch.length;

            if (ids.length) {
              await _markBatch(db, ids, { status: 'SENDING', sending_at: _now() });
            }

            const resp = await _pushBatch(batch);
            const applyResult = await _applyPushResult(db, batch, resp);

            _stats.sent += batch.length;
            _stats.acked += Number(applyResult.acked || 0);

            const dt = _now() - t0;
            _stats.lastDurationMs = dt;
            _stats.lastRateOps = dt > 0 ? Math.round((batch.length * 1000) / dt) : batch.length;

            backoffMs = 0;
            _emitProgress({ pushed: batch.length, budgetExceeded });

            if (force && budgetMs > 0 && (_now() - startedAt) >= budgetMs) {
              budgetExceeded = true;
              break;
            }

            await _sleep(ACTIVE_TICK_MS);

          } finally {
            try { db.close(); } catch (_) {}
          }
        }
      } catch (err) {
        _lastError = err;
        _stats.failedBatches += 1;

        try {
          const db = await _openDB();
          try {
            const store = _tx(db, 'readwrite');
            const all = await _reqToPromise(store.getAll());
            for (const rec of (all || [])) {
              if (!rec) continue;
              if (String(rec.status || '').trim().toUpperCase() !== 'SENDING') continue;
              rec.retry_count = (rec.retry_count || 0) + 1;
              rec.last_error = String(err || '');
              if (rec.retry_count >= MAX_RETRIES) {
                rec.status = 'DEAD';
                rec.dead_at = _now();
              } else {
                rec.status = 'PENDING';
              }
              await _reqToPromise(store.put(rec));
            }
          } finally {
            try { db.close(); } catch (_) {}
          }
        } catch (_) {
        }

        backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(BASE_BACKOFF_MS, (backoffMs || BASE_BACKOFF_MS) * 2));
        _emitProgress({ error: String(err || ''), backoffMs, capabilities: _capabilities || null, local_static_mode: !!(_capabilities && _capabilities.local_static_mode), remote_sync_allowed: !!(_capabilities && _capabilities.remote_sync_allowed), budgetExceeded });
        await _sleep(backoffMs);

      } finally {
        _running = false;
        _stopRequested = false;
        _inFlight = null;
        _emitProgress({ budgetExceeded });
      }
    })();

    return _inFlight;
  }

  // ──────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────
  const VSC_RELAY = {
    start() {
      _enabled = true;
      // Kick background drain (non-forced)
      _drainLoop({ force: false }).catch(() => {});
      return true;
    },

    stop() {
      _stopRequested = true;
      _enabled = false;
      return true;
    },

    async syncNow(options = {}) {
      _enabled = true;
      const budgetMs = Math.max(0, Number(options && options.budgetMs) || 0);
      const keepAliveOnBudget = !(options && options.keepAliveOnBudget === false);
      const startedAt = _now();
      await _refreshPendingStats().catch(() => {});
      await _drainLoop({ force: true, budgetMs });
      const pending = await _refreshPendingStats().catch(() => Number(_stats.pending || 0) || 0);
      const status = this.status();
      const elapsedMs = _now() - startedAt;
      const budgetExceeded = budgetMs > 0 && elapsedMs >= budgetMs && pending > 0;
      if (budgetExceeded && keepAliveOnBudget) {
        this.start();
      }
      return {
        ...status,
        ok: !status.lastError && pending === 0,
        pending,
        total_open: pending,
        elapsedMs,
        budgetMs,
        budgetExceeded,
        continuedInBackground: budgetExceeded && keepAliveOnBudget,
        ackedDelta: Number(status.last_sent || status.acked || 0) || 0,
      };
    },

    // Compatibilidade retroativa: módulos legados ainda chamam relay.kick()
    kick() {
      return this.syncNow();
    },

    status() {
      const lastError = _lastError ? String(_lastError) : null;
      return {
        enabled: _enabled,
        running: _running,
        lastError,
        last_error: lastError,
        lastCycleAt: _lastCycleAt,
        last_run: _lastCycleAt,
        last_sent: Number(_stats.acked || _stats.sent || 0) || 0,
        pending: Number(_stats.pending || 0) || 0,
        total_open: Number(_stats.pending || 0) || 0,
        api_base: _apiBase(),
        sent: Number(_stats.sent || 0) || 0,
        acked: Number(_stats.acked || 0) || 0,
        last_batch: Number(_stats.lastBatchSize || 0) || 0,
        last_batch_size: Number(_stats.lastBatchSize || 0) || 0,
        last_duration_ms: Number(_stats.lastDurationMs || 0) || 0,
        local_static_mode: !!(_capabilities && _capabilities.local_static_mode),
        remote_sync_allowed: !!(_capabilities && _capabilities.remote_sync_allowed),
        capabilities: _capabilities ? { ..._capabilities } : null,
        stats: { ..._stats },
      };
    },
  };

  window.VSC_RELAY = VSC_RELAY;

  
  function _autoStartRelay() {
    try {
      if (!_enabled) _enabled = true;
      VSC_RELAY.start();
    } catch (_) {}
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _autoStartRelay, { once: true });
    } else {
      _autoStartRelay();
    }
  } catch (_) {
    _autoStartRelay();
  }

  try {
    window.addEventListener('online', _autoStartRelay);
    window.addEventListener('focus', _autoStartRelay);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') _autoStartRelay();
    });
  } catch (_) {}

  try {
    setInterval(() => {
      try {
        const st = VSC_RELAY.status();
        if (st && st.enabled && !st.running) {
          VSC_RELAY.start();
        }
      } catch (_) {}
    }, 30000);
  } catch (_) {}

})();
