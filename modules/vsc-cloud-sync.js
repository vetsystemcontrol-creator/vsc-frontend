// vsc-cloud-sync.js — refatoração do fluxo manual de sincronização
(() => {
  'use strict';

  const SYNC_KEY = 'vsc_last_sync';
  const TENANT = 'tenant-default';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';
  const SNAPSHOT_TIMEOUT_MS = 20_000;
  const MANUAL_PUSH_BUDGET_MS = 45_000;
  const SYNC_REMOTE_BASE_KEYS = ['vsc_sync_remote_base', 'vsc_remote_base', 'vsc_api_base'];
  const SYNC_TOKEN_KEYS = ['vsc_local_token', 'vsc_token', 'VSC_SYNC_TOKEN'];
  const SYNC_TARGET_MODE_KEY = 'vsc_sync_target_mode';
  const SYNC_ETAG_KEY = 'vsc_last_sync_etag';
  const AUTO_SYNC_SESSION_KEY = 'vsc_auto_sync_bootstrap';
  const AUTO_SYNC_MIN_INTERVAL_MS = 60_000;

  let isSyncing = false;

  function nowIso() {
    return new Date().toISOString();
  }

  function notifyUI(status, message = '', extra = {}) {
    try {
      window.dispatchEvent(new CustomEvent('vsc:sync:status', {
        detail: {
          status,
          message,
          tenant: TENANT,
          timestamp: nowIso(),
          ...extra,
        },
      }));
    } catch (_) {}
  }

  function status() {
    return {
      tenant: TENANT,
      syncing: !!isSyncing,
      last_sync: localStorage.getItem(SYNC_KEY) || null,
    };
  }

  function getHost() {
    try {
      return String(location.hostname || '').toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function isLocalDev() {
    const host = getHost();
    return host === '127.0.0.1' || host === 'localhost';
  }

  function readStorageValue(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      if (!key) continue;
      try {
        const value = String(localStorage.getItem(key) || sessionStorage.getItem(key) || '').trim();
        if (value) return value;
      } catch (_) {}
    }
    return '';
  }

  function sanitizeBaseUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    return value.replace(/\/+$/, '');
  }

  function getConfiguredRemoteBase() {
    return sanitizeBaseUrl(readStorageValue(SYNC_REMOTE_BASE_KEYS) || REMOTE_BASE);
  }

  function getTargetMode() {
    return String(readStorageValue(SYNC_TARGET_MODE_KEY) || 'remote').trim().toLowerCase();
  }

  function getSyncToken() {
    return readStorageValue(SYNC_TOKEN_KEYS);
  }

  function buildCommonHeaders(url = '') {
    const headers = {
      'Accept': 'application/json',
      'X-VSC-Tenant': TENANT,
    };
    const token = getSyncToken();
    if (token) headers['X-VSC-Token'] = token;
    const cachedEtag = readSnapshotEtag(url);
    if (cachedEtag) headers['If-None-Match'] = cachedEtag;
    return headers;
  }

  function readSnapshotEtag(url = '') {
    try {
      const raw = String(localStorage.getItem(SYNC_ETAG_KEY) || '').trim();
      if (!raw) return '';
      const map = JSON.parse(raw);
      if (url && map && typeof map === 'object' && typeof map[url] === 'string') return map[url];
      if (map && typeof map === 'object' && typeof map.__default === 'string') return map.__default;
      return '';
    } catch (_) {
      return '';
    }
  }

  function writeSnapshotEtag(url, etag) {
    try {
      const raw = String(localStorage.getItem(SYNC_ETAG_KEY) || '').trim();
      const map = raw ? JSON.parse(raw) : {};
      if (etag) {
        map[url] = String(etag);
        map.__default = String(etag);
      } else if (url && map && typeof map === 'object') {
        delete map[url];
      }
      localStorage.setItem(SYNC_ETAG_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  function apiCandidates() {
    const remoteBase = getConfiguredRemoteBase() || REMOTE_BASE;
    const relative = ['/api/sync/pull', '/api/state?action=pull'];
    const absolute = [
      `${remoteBase}/api/sync/pull`,
      `${remoteBase}/api/state?action=pull`,
    ];

    try {
      const proto = String(location.protocol || '').toLowerCase();
      if (proto === 'file:') return absolute;
      if (proto === 'http:' && isLocalDev()) {
        return getTargetMode() === 'local' ? relative : [...absolute, ...relative];
      }
    } catch (_) {}

    return relative;
  }

  function makeTimeoutController(timeoutMs) {
    const controller = new AbortController();
    const safeTimeout = Math.max(1, Number(timeoutMs) || 1);
    const timer = setTimeout(() => {
      try {
        controller.abort(new Error(`timeout_${safeTimeout}ms`));
      } catch (_) {
        try { controller.abort(); } catch (_) {}
      }
    }, safeTimeout);
    return {
      controller,
      clear() { clearTimeout(timer); },
    };
  }

  async function fetchWithTimeout(url, options, timeoutMs, label) {
    const wrapped = makeTimeoutController(timeoutMs);
    try {
      return await fetch(url, { ...options, signal: wrapped.controller.signal });
    } catch (err) {
      const name = err && err.name ? String(err.name) : '';
      if (name === 'AbortError' || String(err || '').includes('timeout_')) {
        throw new Error(label || `timeout_${timeoutMs}ms`);
      }
      throw err;
    } finally {
      wrapped.clear();
    }
  }

  function snapshotMetrics(body) {
    const data = body && body.snapshot && body.snapshot.data && typeof body.snapshot.data === 'object'
      ? body.snapshot.data
      : {};
    const stores = Object.keys(data);
    let rows = 0;
    for (const storeName of stores) {
      const list = data[storeName];
      if (Array.isArray(list)) rows += list.length;
    }
    const revision = Number(body && body.revision || body && body.meta && body.meta.state_revision || 0) || 0;
    return {
      rows,
      stores: stores.length,
      revision,
      score: (rows * 1000000) + (revision * 1000) + stores,
    };
  }

  async function fetchCandidate(url) {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: buildCommonHeaders(url),
        cache: 'no-store',
      },
      SNAPSHOT_TIMEOUT_MS,
      `snapshot_timeout_${SNAPSHOT_TIMEOUT_MS}ms`
    );

    if (response.status === 304) {
      return {
        url,
        notModified: true,
        body: null,
        metrics: { rows: 0, stores: 0, revision: 0, score: 0 },
      };
    }

    if (!response.ok) {
      throw new Error(`pull_http_${response.status}`);
    }

    const body = await response.json();
    if (!(body && body.ok && body.snapshot && body.snapshot.data)) {
      throw new Error('pull_invalid_payload');
    }

    writeSnapshotEtag(url, response.headers.get('ETag') || '');

    return {
      url,
      body,
      metrics: snapshotMetrics(body),
    };
  }

  async function fetchSnapshot() {
    const urls = apiCandidates();
    let lastErr = null;
    let best = null;

    for (const url of urls) {
      try {
        const candidate = await fetchCandidate(url);

        if (candidate.notModified) {
          if (!best) best = candidate;
          if (!isLocalDev()) return null;
          continue;
        }

        try {
          console.info('[VSC_SYNC] snapshot candidato', {
            url: candidate.url,
            rows: candidate.metrics.rows,
            stores: candidate.metrics.stores,
            revision: candidate.metrics.revision,
          });
        } catch (_) {}

        if (!best || candidate.metrics.score > best.metrics.score) {
          best = candidate;
        }

        // Fora do DEV local, não precisamos comparar todas as origens.
        if (!isLocalDev()) {
          return candidate.body;
        }
      } catch (err) {
        lastErr = err;
        try {
          console.warn('[VSC_SYNC] snapshot falhou', { url, error: String(err && (err.message || err) || err) });
        } catch (_) {}
      }
    }

    if (best) {
      if (best.notModified) return null;
      try {
        console.info('[VSC_SYNC] snapshot escolhido', {
          url: best.url,
          rows: best.metrics.rows,
          stores: best.metrics.stores,
          revision: best.metrics.revision,
        });
      } catch (_) {}
      return best.body;
    }

    throw lastErr || new Error('pull_failed');
  }

  function mirrorEmpresaCache(rows) {
    try {
      const list = Array.isArray(rows) ? rows : [];
      const record = list.find((item) => item && (item.id === 'empresa_local' || item.key === 'empresa_local')) || list[0] || null;
      if (!record || typeof record !== 'object') return;
      localStorage.setItem('vsc_empresa_v1', JSON.stringify(record));
      localStorage.setItem('empresa_configurada', '1');
      localStorage.setItem('vsc_empresa_v1_meta', JSON.stringify({ version: 1, savedAt: nowIso(), source: 'cloud-sync' }));
    } catch (_) {}
  }

  async function countPendingOutbox() {
    try {
      const relay = await resolveRelay();
      const status = relay && typeof relay.status === 'function' ? relay.status() : null;
      const pending = Number(status && status.pending || 0) || 0;
      if (pending > 0) return pending;
    } catch (_) {}

    try {
      if (!(window.VSC_DB && typeof window.VSC_DB.openDB === 'function')) return 0;
      const db = await window.VSC_DB.openDB();
      try {
        if (!db.objectStoreNames.contains('sync_queue')) return 0;
        return await new Promise((resolve) => {
          const tx = db.transaction(['sync_queue'], 'readonly');
          const st = tx.objectStore('sync_queue');
          const req = st.indexNames && st.indexNames.contains('status') ? st.index('status').count('PENDING') : st.getAll();
          req.onsuccess = () => {
            if (typeof req.result === 'number') return resolve(req.result || 0);
            const rows = Array.isArray(req.result) ? req.result : [];
            resolve(rows.filter((item) => String(item && item.status || '').toUpperCase() === 'PENDING').length);
          };
          req.onerror = () => resolve(0);
        });
      } finally {
        try { db.close(); } catch (_) {}
      }
    } catch (_) {
      return 0;
    }
  }

  async function applySnapshot(snapshot) {
    if (!snapshot || !snapshot.data) {
      return { ok: true, importedStores: [], notModified: true };
    }

    const db = await window.VSC_DB.openDB();
    try {
      const localStores = Array.from(db.objectStoreNames || []);
      const protectedStores = new Set([
        'auth_users',
        'auth_sessions',
        'auth_audit_log',
        'auth_role_permissions',
        'auth_roles',
        'backup_events',
        'db_backups',
        'attachments_queue',
      ]);

      const filteredData = {};
      for (const [store, rows] of Object.entries(snapshot.data || {})) {
        if (localStores.includes(store) && !protectedStores.has(store)) {
          filteredData[store] = Array.isArray(rows) ? rows : [];
        }
      }

      const filteredSchema = {
        ...(snapshot.schema || {}),
        db_name: (snapshot.schema && snapshot.schema.db_name) || 'vsc_db',
        stores: Object.keys(filteredData),
      };

      await window.VSC_DB.importDump(
        {
          meta: snapshot.meta || {},
          schema: filteredSchema,
          data: filteredData,
        },
        { mode: 'merge_newer' }
      );

      if (filteredData.empresa) mirrorEmpresaCache(filteredData.empresa);

      return { ok: true, importedStores: Object.keys(filteredData) };
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  async function pullNow() {
    if (isSyncing) return { ok: false, error: 'sync_in_progress' };
    if (!navigator.onLine) {
      notifyUI('offline');
      return { ok: false, error: 'offline' };
    }

    isSyncing = true;
    notifyUI('syncing');

    try {
      const payload = await fetchSnapshot();
      if (!payload) {
        localStorage.setItem(SYNC_KEY, nowIso());
        notifyUI('success', '', { phase: 'pull', applied: { ok: true, importedStores: [], notModified: true } });
        return { ok: true, pulled: false, notModified: true, applied: { ok: true, importedStores: [], notModified: true } };
      }
      const applied = await applySnapshot(payload.snapshot);
      localStorage.setItem(SYNC_KEY, nowIso());
      notifyUI('success', '', { phase: 'pull', applied });
      return { ok: true, pulled: true, applied };
    } catch (err) {
      notifyUI('error', String(err && (err.message || err) || 'pull_failed'));
      throw err;
    } finally {
      isSyncing = false;
    }
  }

  async function resolveRelay() {
    let relay = (window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === 'function') ? window.VSC_RELAY : null;
    if (!relay && typeof window.VSC_LOAD_RELAY === 'function') {
      try {
        relay = await window.VSC_LOAD_RELAY();
      } catch (_) {
        relay = null;
      }
    }
    return relay;
  }

  async function manualSync() {
    if (isSyncing) return { ok: false, error: 'sync_in_progress' };
    if (!navigator.onLine) {
      notifyUI('offline');
      return { ok: false, error: 'offline' };
    }

    isSyncing = true;
    notifyUI('syncing');

    try {
      const relay = await resolveRelay();
      let pushResult = null;

      if (relay && typeof relay.syncNow === 'function') {
        pushResult = await relay.syncNow({
          budgetMs: MANUAL_PUSH_BUDGET_MS,
          keepAliveOnBudget: true,
        });
      }

      const relayStatus = relay && typeof relay.status === 'function' ? relay.status() : null;
      const openItems = Number(relayStatus && relayStatus.total_open || relayStatus && relayStatus.pending || 0) || 0;

      if (openItems > 0) {
        localStorage.setItem(SYNC_KEY, nowIso());
        notifyUI(
          'partial',
          `Envio parcial concluído. ${openItems} item(ns) seguem em segundo plano.`,
          { phase: 'push', pushResult, pending: openItems }
        );
        return {
          ok: true,
          partial: true,
          pushed: !!pushResult,
          pushResult,
          pending: openItems,
        };
      }

      const payload = await fetchSnapshot();
      const applied = payload ? await applySnapshot(payload.snapshot) : { ok: true, importedStores: [], notModified: true };
      localStorage.setItem(SYNC_KEY, nowIso());
      notifyUI('success', '', { phase: 'push+pull', pushResult, applied });
      return { ok: true, pushed: !!pushResult, pushResult, applied, notModified: !payload };
    } catch (err) {
      notifyUI('error', String(err && (err.message || err) || 'manual_sync_failed'));
      throw err;
    } finally {
      isSyncing = false;
    }
  }

  async function autoBootstrapSync(reason = 'boot') {
    if (isSyncing) return { ok: false, skipped: true, reason: 'sync_in_progress' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, skipped: true, reason: 'offline' };

    const lastRunRaw = sessionStorage.getItem(AUTO_SYNC_SESSION_KEY) || '0';
    const lastRun = Number(lastRunRaw) || 0;
    if (Date.now() - lastRun < AUTO_SYNC_MIN_INTERVAL_MS) {
      return { ok: false, skipped: true, reason: 'rate_limited' };
    }

    sessionStorage.setItem(AUTO_SYNC_SESSION_KEY, String(Date.now()));

    const pending = await countPendingOutbox();
    if (pending > 0) {
      return await manualSync();
    }

    return await pullNow();
  }

  try {
    window.addEventListener('online', () => {
      autoBootstrapSync('online').catch(() => {});
    });
    window.addEventListener('focus', () => {
      if (document.visibilityState === 'visible') autoBootstrapSync('focus').catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') autoBootstrapSync('visible').catch(() => {});
    });
    setTimeout(() => { autoBootstrapSync('startup').catch(() => {}); }, 1200);
  } catch (_) {}

  window.VSC_CLOUD_SYNC = {
    status,
    pullNow,
    manualSync,
    syncNow: manualSync,
    autoBootstrapSync,
    getLastSync: () => localStorage.getItem(SYNC_KEY) || null,
  };
})();
