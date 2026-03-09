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

  function _getToken() {
    return (
      localStorage.getItem('vsc_local_token') ||
      sessionStorage.getItem('vsc_local_token') ||
      ''
    );
  }

  function _safeJsonParse(v, fb = null) {
    try { return JSON.parse(v); } catch (_) { return fb; }
  }

  function _normalizeDigits(v) {
    return String(v || '').replace(/\D+/g, '');
  }

  function _getTenantHeader() {
    try {
      const empresa = _safeJsonParse(localStorage.getItem('vsc_empresa_v1'), null) ||
                      _safeJsonParse(localStorage.getItem('VSC_EMPRESA_V1'), null);
      const cnpj = _normalizeDigits(empresa && (empresa.cnpj || empresa.CNPJ || empresa.documento || empresa.doc));
      if (cnpj) return `tenant-${cnpj}`;
      const nome = String((empresa && (empresa.razao || empresa.nome_fantasia || empresa.nome)) || '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      if (nome) return `tenant-${nome}`;
    } catch (_) {}
    return 'tenant-default';
  }

  function _getUserHeader() {
    try {
      const user = _safeJsonParse(localStorage.getItem('vsc_user'), null);
      return String(user && (user.username || user.nome || user.name || user.id) || 'anonymous').slice(0, 120);
    } catch (_) {}
    return 'anonymous';
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
      const host = String(location.hostname || '').toLowerCase();
      if (proto === 'file:') return true;
      if (host === '127.0.0.1' || host === 'localhost') {
        const forced = String(localStorage.getItem('vsc_allow_local_sync_api') || '').toLowerCase();
        return forced !== '1' && forced !== 'true' && forced !== 'yes';
      }
    } catch (_) {}
    return false;
  }

  async function _readCapabilities() {
    const now = _now();
    if (_capabilities && (now - _capabilitiesCheckedAt) < 15000) return _capabilities;
    if (_isLocalStaticMode()) {
      _capabilities = {
        ok: true,
        available: false,
        remote_sync_allowed: false,
        local_static_mode: true,
        reason: 'local-static-no-api',
      };
      _capabilitiesCheckedAt = now;
      return _capabilities;
    }

    try {
      const res = await fetch(API_CAPABILITIES_URL, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        cache: 'no-store',
      });
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
        _capabilities = {
          ok: body.ok !== false,
          available: body.available !== false,
          remote_sync_allowed: body.remote_sync_allowed !== false,
          local_static_mode: !!body.local_static_mode,
          reason: body.reason || '',
          status: res.status,
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
    const pending = (all || []).filter(e => e && e.status === 'PENDING');
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
    const token = _getToken();
    const res = await fetch('/api/sync/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VSC-Token': token,
        'X-VSC-Tenant': _getTenantHeader(),
        'X-VSC-User': _getUserHeader(),
      },
      body: JSON.stringify({ operations: batch }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`sync/push failed ${res.status} ${text}`);
    }

    return await res.json().catch(() => ({ ok: true }));
  }

  async function _pushBatchLegacyOutbox(batch) {
    // Envia 1 a 1 no endpoint antigo
    const token = _getToken();
    for (const ev of batch) {
      const body = {
        entity: ev.entity,
        entity_id: ev.entity_id,
        op: ev.op,
        payload: ev.payload,
        op_id: ev.op_id,
      };
      const res = await fetch('/api/outbox', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VSC-Token': token,
          'X-VSC-Tenant': _getTenantHeader(),
          'X-VSC-User': _getUserHeader(),
        },
        body: JSON.stringify(body),
      });
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
      // Fallback only if endpoint missing (404) or not implemented
      const msg = String(e || '');
      if (msg.includes('404') || msg.includes('Cannot') || msg.includes('sync/push')) {
        // try legacy
        return await _pushBatchLegacyOutbox(batch);
      }
      throw e;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Core loop
  // ──────────────────────────────────────────────────────────
  async function _drainLoop({ force = false } = {}) {
    if (_inFlight) return _inFlight;

    _inFlight = (async () => {
      _stopRequested = false;
      _running = true;
      _lastError = null;
      _emitProgress();

      let backoffMs = 0;

      try {
        while (_enabled && !_stopRequested) {
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
              _emitProgress({ idle: true });
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
              });
              if (force) break;
              await _sleep(IDLE_TICK_MS);
              continue;
            }

            // Se tiver pendência, drena rápido
            const batchSize = _computeBatchSize(pending);
            const batch = await _readPendingBatch(db, batchSize);
            const ids = batch.map(e => e.id).filter(Boolean);

            _stats.lastBatchSize = batch.length;

            // Mark SENDING (opcional, mas bom para auditoria)
            if (ids.length) {
              await _markBatch(db, ids, { status: 'SENDING', sending_at: _now() });
            }

            const resp = await _pushBatch(batch);

            const ackIds = Array.isArray(resp && resp.ack_ids) && resp.ack_ids.length
              ? resp.ack_ids.map(String)
              : batch.map((ev) => String(ev && ev.op_id || ''));
            const ackedDbIds = batch
              .filter((ev) => ackIds.includes(String(ev && ev.op_id || '')))
              .map((ev) => ev.id)
              .filter(Boolean);
            const pendingDbIds = batch
              .filter((ev) => !ackIds.includes(String(ev && ev.op_id || '')))
              .map((ev) => ev.id)
              .filter(Boolean);

            if (ackedDbIds.length) {
              await _markBatch(db, ackedDbIds, { status: 'DONE', done_at: _now(), last_ack: resp || null });
            }
            if (pendingDbIds.length) {
              await _markBatch(db, pendingDbIds, { status: 'PENDING', updated_at: _now(), last_error: 'partial_ack' });
            }

            _stats.sent += batch.length;
            _stats.acked += ackedDbIds.length;

            const dt = _now() - t0;
            _stats.lastDurationMs = dt;
            _stats.lastRateOps = dt > 0 ? Math.round((batch.length * 1000) / dt) : batch.length;

            backoffMs = 0;
            _emitProgress({ pushed: batch.length });

            // Tick ativo pequeno para não travar UI
            await _sleep(ACTIVE_TICK_MS);

          } finally {
            try { db.close(); } catch (_) {}
          }
        }
      } catch (err) {
        _lastError = err;
        _stats.failedBatches += 1;

        // Reverter status SENDING → PENDING com retry++ quando possível
        try {
          const db = await _openDB();
          try {
            const store = _tx(db, 'readwrite');
            // scan small: convert any SENDING back to PENDING (best-effort)
            const all = await _reqToPromise(store.getAll());
            for (const rec of (all || [])) {
              if (!rec) continue;
              if (rec.status !== 'SENDING') continue;
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
          // ignore
        }

        // Backoff only on errors
        backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(BASE_BACKOFF_MS, (backoffMs || BASE_BACKOFF_MS) * 2));
        _emitProgress({ error: String(err || ''), backoffMs, capabilities: _capabilities || null, local_static_mode: !!(_capabilities && _capabilities.local_static_mode), remote_sync_allowed: !!(_capabilities && _capabilities.remote_sync_allowed) });
        await _sleep(backoffMs);

      } finally {
        _running = false;
        _stopRequested = false;
        _inFlight = null;
        _emitProgress();
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

    syncNow() {
      // Forced drain until idle once (useful for manual button)
      _enabled = true;
      return _drainLoop({ force: true });
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

  // Auto-start when app loads
  try {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      VSC_RELAY.start();
    } else {
      window.addEventListener('DOMContentLoaded', () => VSC_RELAY.start(), { once: true });
    }
  } catch (_) {}

})();
