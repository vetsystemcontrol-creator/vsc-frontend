/*! 
 * VSC-OUTBOX-RELAY — Transactional Outbox Message Relay (Premium)
 * ============================================================
 */
(() => {
  'use strict';

  const DB_NAME      = (window.VSC_DB_NAME || 'vsc_db');
  const STORE_OUTBOX = 'sync_queue';
  const API_CAPABILITIES_URL = '/api/state?action=capabilities';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';

  const ACTIVE_TICK_MS = 250;
  const IDLE_TICK_MS   = 15000;
  const MIN_BATCH = 10;
  const MAX_BATCH = 150;
  const BASE_BACKOFF_MS = 500;
  const MAX_BACKOFF_MS  = 10000;
  const MAX_RETRIES = 7;

  let _enabled = true;
  let _running = false;
  let _stopRequested = false;
  let _lastError = null;
  let _lastCycleAt = null;
  let _inFlight = null;
  let _capabilities = null;
  let _capabilitiesCheckedAt = 0;
  let _stats = { pending: 0, sent: 0, acked: 0, failedBatches: 0, lastRateOps: 0, lastBatchSize: 0, lastDurationMs: 0 };

  function _now() { return Date.now(); }
  function _getToken() { return localStorage.getItem('vsc_local_token') || sessionStorage.getItem('vsc_local_token') || ''; }

  function _emitProgress(extra = {}) {
    const detail = { ok: !_lastError, error: _lastError ? String(_lastError) : null, running: _running, ..._stats, ...extra };
    if (window.VSC_SYNC_UI && typeof window.VSC_SYNC_UI.onProgress === 'function') {
      try { window.VSC_SYNC_UI.onProgress(detail); } catch (_) {}
    }
    try { window.dispatchEvent(new CustomEvent('vsc:sync-progress', { detail })); } catch (_) {}
  }

  function _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function _apiBase() {
    const host = String(location.hostname || '').toLowerCase();
    if (location.protocol === 'file:' || host === '127.0.0.1' || host === 'localhost') return REMOTE_BASE;
    return '';
  }

  async function _readCapabilities() {
    const now = _now();
    if (_capabilities && (now - _capabilitiesCheckedAt) < 15000) return _capabilities;
    try {
      const res = await fetch(`${_apiBase()}${API_CAPABILITIES_URL}`, { method: 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      _capabilities = { ok: res.ok, available: body.available !== false, remote_sync_allowed: body.remote_sync_allowed !== false, local_static_mode: !!body.local_static_mode, reason: body.reason || '', status: res.status, body };
    } catch (err) {
      _capabilities = { ok: false, available: false, remote_sync_allowed: false, local_static_mode: false, reason: String(err) };
    }
    _capabilitiesCheckedAt = now;
    return _capabilities;
  }

  function _openDB() {
    return new Promise((resolve, reject) => {
      if (window.VSC_DB && typeof window.VSC_DB.openDB === 'function') {
        Promise.resolve(window.VSC_DB.openDB()).then(resolve).catch(reject);
        return;
      }
      const req = indexedDB.open(DB_NAME);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }

  async function _pushBatch(batch) {
    const token = _getToken();
    const res = await fetch(`${_apiBase()}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VSC-Token': token,
        'X-VSC-Tenant': (window.VSC_CLOUD_SYNC && window.VSC_CLOUD_SYNC.status ? window.VSC_CLOUD_SYNC.status().tenant : 'tenant-default'),
      },
      body: JSON.stringify({ operations: batch }),
    });
    if (!res.ok) throw new Error(`Push failed: ${res.status}`);
    return await res.json();
  }

  async function _drainLoop({ force = false } = {}) {
    if (_inFlight) return _inFlight;
    _inFlight = (async () => {
      _running = true;
      try {
        while (_enabled && !_stopRequested) {
          const db = await _openDB();
          try {
            const tx = db.transaction([STORE_OUTBOX], 'readonly');
            const store = tx.objectStore(STORE_OUTBOX);
            const all = await new Promise(r => { const req = store.getAll(); req.onsuccess = () => r(req.result); });
            const pending = (all || []).filter(e => e && e.status === 'PENDING');
            _stats.pending = pending.length;
            if (pending.length === 0) { if (force) break; await _sleep(IDLE_TICK_MS); continue; }
            const batch = pending.slice(0, MAX_BATCH);
            await _pushBatch(batch);
            const rwTx = db.transaction([STORE_OUTBOX], 'readwrite');
            const rwStore = rwTx.objectStore(STORE_OUTBOX);
            for (const item of batch) { item.status = 'DONE'; item.done_at = _now(); rwStore.put(item); }
            _stats.sent += batch.length;
            _emitProgress();
            await _sleep(ACTIVE_TICK_MS);
          } finally { db.close(); }
        }
      } catch (err) {
        _lastError = err;
        _emitProgress();
        await _sleep(BASE_BACKOFF_MS);
      } finally { _running = false; _inFlight = null; }
    })();
    return _inFlight;
  }

  window.VSC_RELAY = {
    start() { _enabled = true; _drainLoop().catch(() => {}); return true; },
    stop() { _stopRequested = true; _enabled = false; return true; },
    syncNow() { _enabled = true; return _drainLoop({ force: true }); },
    status() { return { enabled: _enabled, running: _running, pending: _stats.pending, sent: _stats.sent }; }
  };
})();
