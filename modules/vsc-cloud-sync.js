// vsc-cloud-sync.js
// Sync manual seguro: push manual (quando houver relay) + pull canônico do Cloudflare.
// Regras:
// - sem auto-sync ao voltar online
// - fallback determinístico /api/sync/pull -> /api/state?action=pull
// - aplica apenas stores compatíveis com o IndexedDB local atual
// - expõe window.VSC_CLOUD_SYNC
(() => {
  'use strict';

  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';
  const SYNC_KEY = 'vsc_last_sync';
  const RETRY_LIMIT = 3;
  const RETRY_DELAY_MS = 1200;
  const DEFAULT_TENANT = 'tenant-default';

  let _running = false;
  let _lastError = null;
  let _lastPullAt = null;
  let _lastSkippedStores = [];

  function sleep(ms){ return new Promise((r) => setTimeout(r, ms)); }
  function nowIso(){ return new Date().toISOString(); }

  function isLocalStaticMode(){
    try {
      const proto = String(location.protocol || '').toLowerCase();
      const host = String(location.hostname || '').toLowerCase();
      if (proto === 'file:') return true;
      if (host === '127.0.0.1' || host === 'localhost') return true;
    } catch (_) {}
    return false;
  }

  function apiUrl(path){
    return `${isLocalStaticMode() ? REMOTE_BASE : ''}${path}`;
  }

  function readTenant(){
    try {
      const raw = localStorage.getItem('vsc_sync_tenant') || DEFAULT_TENANT;
      return String(raw || DEFAULT_TENANT).trim() || DEFAULT_TENANT;
    } catch (_) {
      return DEFAULT_TENANT;
    }
  }

  function readUserLabel(){
    try {
      const raw = JSON.parse(localStorage.getItem('vsc_user') || 'null');
      return String((raw && (raw.username || raw.nome || raw.name || raw.id)) || 'anonymous').slice(0, 120);
    } catch (_) {
      return 'anonymous';
    }
  }

  function emit(detail){
    const safe = {
      pending: Number(detail && detail.pending || 0) || 0,
      running: !!(detail && detail.running),
      error: detail && detail.error ? String(detail.error) : null,
      local_static_mode: isLocalStaticMode(),
      remote_sync_allowed: detail && typeof detail.remote_sync_allowed === 'boolean' ? detail.remote_sync_allowed : true,
      lastPullAt: _lastPullAt,
      skippedStores: Array.isArray(_lastSkippedStores) ? _lastSkippedStores.slice() : [],
      ...detail,
    };
    try {
      window.dispatchEvent(new CustomEvent('vsc:sync-progress', { detail: safe }));
    } catch (_) {}
  }

  async function withRetry(fn, label){
    let last = null;
    for (let i = 1; i <= RETRY_LIMIT; i += 1) {
      try { return await fn(); } catch (err) {
        last = err;
        try { console.warn(`[VSC_CLOUD_SYNC] ${label} tentativa ${i}/${RETRY_LIMIT} falhou`, err); } catch (_) {}
        if (i < RETRY_LIMIT) await sleep(RETRY_DELAY_MS * i);
      }
    }
    throw last || new Error(`${label}_failed`);
  }

  async function fetchPullSnapshot(){
    const tenant = readTenant();
    const headers = {
      'Accept': 'application/json',
      'X-VSC-Tenant': tenant,
      'X-VSC-User': readUserLabel(),
    };

    const endpoints = [
      apiUrl('/api/sync/pull'),
      apiUrl('/api/state?action=pull'),
    ];

    let lastErr = null;
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { method: 'GET', headers, cache: 'no-store' });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`${url} -> ${res.status} ${text}`);
        }
        const body = await res.json();
        if (body && body.ok === false) {
          throw new Error(body.detail || body.error || 'pull_failed');
        }
        return body;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('pull_failed');
  }

  async function getLocalStoreNames(){
    if (!(window.VSC_DB && typeof window.VSC_DB.openDB === 'function')) {
      throw new Error('vsc_db_unavailable');
    }
    const db = await window.VSC_DB.openDB();
    try {
      return Array.from(db.objectStoreNames || []);
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  function filterSnapshotToLocalStores(snapshot, localStoreNames){
    const incoming = (snapshot && snapshot.data && typeof snapshot.data === 'object') ? snapshot.data : {};
    const allowed = new Set(localStoreNames || []);
    const filteredData = {};
    const skipped = [];

    Object.keys(incoming).forEach((storeName) => {
      if (allowed.has(storeName)) {
        filteredData[storeName] = Array.isArray(incoming[storeName]) ? incoming[storeName] : [];
      } else {
        skipped.push(storeName);
      }
    });

    const originalSchemaStores = Array.isArray(snapshot && snapshot.schema && snapshot.schema.stores)
      ? snapshot.schema.stores
      : Object.keys(incoming);

    const filteredSchemaStores = originalSchemaStores.filter((entry) => {
      const storeName = typeof entry === 'string' ? entry : String(entry && entry.name || '');
      return !!storeName && allowed.has(storeName);
    });

    return {
      skipped,
      dump: {
        meta: snapshot && snapshot.meta ? { ...snapshot.meta } : { exported_at: nowIso() },
        schema: {
          ...(snapshot && snapshot.schema ? snapshot.schema : {}),
          stores: filteredSchemaStores,
        },
        data: filteredData,
      },
    };
  }

  async function applySnapshot(snapshot){
    const localStoreNames = await getLocalStoreNames();
    const { skipped, dump } = filterSnapshotToLocalStores(snapshot, localStoreNames);
    _lastSkippedStores = skipped.slice();

    if (!(window.VSC_DB && typeof window.VSC_DB.importDump === 'function')) {
      throw new Error('vsc_db_import_unavailable');
    }

    const result = await window.VSC_DB.importDump(dump, { mode: 'replace_store' });
    try {
      localStorage.setItem(SYNC_KEY, nowIso());
    } catch (_) {}
    return { result, skipped, importedStores: Object.keys(dump.data || {}) };
  }

  async function pullCanonicalSnapshot(){
    const body = await withRetry(fetchPullSnapshot, 'pull');
    const snapshot = body && body.snapshot ? body.snapshot : null;
    if (!snapshot || typeof snapshot !== 'object') {
      return { ok: true, exists: false, skipped: [], importedStores: [] };
    }
    const applied = await applySnapshot(snapshot);
    _lastPullAt = nowIso();
    return {
      ok: true,
      tenant: body.tenant || readTenant(),
      revision: Number(body.revision || 0) || 0,
      exists: !!body.exists,
      ...applied,
    };
  }

  async function pushPending(){
    if (window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === 'function') {
      return await window.VSC_RELAY.syncNow();
    }
    return { ok: true, skipped: true, reason: 'relay_unavailable' };
  }

  async function manualSync(){
    if (_running) return { ok: false, error: 'sync_already_running' };
    _running = true;
    _lastError = null;
    emit({ running: true });
    try {
      const push = await pushPending();
      const pull = await pullCanonicalSnapshot();
      emit({
        running: false,
        error: null,
        pending: (window.VSC_RELAY && window.VSC_RELAY.status) ? Number(window.VSC_RELAY.status().pending || 0) || 0 : 0,
        skippedStores: pull.skipped || [],
      });
      return { ok: true, push, pull };
    } catch (err) {
      _lastError = err;
      emit({ running: false, error: String(err && (err.message || err) || 'sync_failed') });
      throw err;
    } finally {
      _running = false;
    }
  }

  const api = {
    manualSync,
    syncNow: manualSync,
    pullNow: pullCanonicalSnapshot,
    pullCanonicalSnapshot,
    status(){
      return {
        running: _running,
        error: _lastError ? String(_lastError.message || _lastError) : null,
        last_sync: (() => { try { return localStorage.getItem(SYNC_KEY) || null; } catch (_) { return null; } })(),
        last_pull_at: _lastPullAt,
        skipped_stores: _lastSkippedStores.slice(),
        tenant: readTenant(),
        local_static_mode: isLocalStaticMode(),
        remote_sync_allowed: true,
      };
    },
    getLastSync(){
      try { return localStorage.getItem(SYNC_KEY) || null; } catch (_) { return null; }
    },
  };

  window.VSC_CLOUD_SYNC = api;
})();
