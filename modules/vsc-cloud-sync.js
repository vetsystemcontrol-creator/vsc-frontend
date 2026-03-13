// vsc-cloud-sync.js — refatoração do fluxo manual de sincronização
(() => {
  'use strict';

  const SYNC_KEY = 'vsc_last_sync';
  const TENANT = 'tenant-default';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';
  const SNAPSHOT_TIMEOUT_MS = 20_000;
  const MANUAL_PUSH_BUDGET_MS = 45_000;

  let isSyncing = false;
  let activeSyncPromise = null;

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

  function getSyncToken() {
    try {
      return String(
        localStorage.getItem('vsc_local_token') ||
        sessionStorage.getItem('vsc_local_token') ||
        localStorage.getItem('vsc_token') ||
        sessionStorage.getItem('vsc_token') ||
        ''
      ).trim();
    } catch (_) {
      return '';
    }
  }

  function buildCommonHeaders() {
    const headers = {
      'Accept': 'application/json',
      'X-VSC-Tenant': TENANT,
    };
    const token = getSyncToken();
    if (token) headers['X-VSC-Token'] = token;
    return headers;
  }

  function apiCandidates() {
    const relative = ['/api/sync/pull', '/api/state?action=pull'];
    const absolute = [
      `${REMOTE_BASE}/api/sync/pull`,
      `${REMOTE_BASE}/api/state?action=pull`,
    ];

    try {
      const proto = String(location.protocol || '').toLowerCase();
      if (proto === 'file:') return absolute;
      if (proto === 'http:' && isLocalDev()) {
        // Em desenvolvimento local precisamos comparar local x remoto,
        // porque o D1 do Wrangler pode estar vazio enquanto a produção está populada.
        return [...relative, ...absolute];
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
        headers: buildCommonHeaders(),
        cache: 'no-store',
      },
      SNAPSHOT_TIMEOUT_MS,
      `snapshot_timeout_${SNAPSHOT_TIMEOUT_MS}ms`
    );

    if (!response.ok) {
      throw new Error(`pull_http_${response.status}`);
    }

    const body = await response.json();
    if (!(body && body.ok && body.snapshot && body.snapshot.data)) {
      throw new Error('pull_invalid_payload');
    }

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

  async function applySnapshot(snapshot) {
    if (!snapshot || !snapshot.data) {
      return { ok: true, importedStores: [] };
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

      return { ok: true, importedStores: Object.keys(filteredData) };
    } finally {
      try { db.close(); } catch (_) {}
    }
  }


  function finishSync(result, error) {
    activeSyncPromise = null;
    if (error) throw error;
    return result;
  }

  function reuseActiveSync() {
    if (activeSyncPromise && typeof activeSyncPromise.then === 'function') return activeSyncPromise;
    return null;
  }

  async function pullNow() {
    const reused = reuseActiveSync();
    if (reused) return reused;
    if (!navigator.onLine) {
      notifyUI('offline');
      return { ok: false, error: 'offline' };
    }

    activeSyncPromise = (async () => {
      isSyncing = true;
      notifyUI('syncing');

      try {
        const payload = await fetchSnapshot();
        const applied = await applySnapshot(payload.snapshot);
        localStorage.setItem(SYNC_KEY, nowIso());
        return finishSync({ ok: true, pulled: true, applied }, null);
      } catch (err) {
        notifyUI('error', String(err && (err.message || err) || 'pull_failed'));
        return finishSync(null, err);
      } finally {
        isSyncing = false;
      }
    })();

    return activeSyncPromise.then((result) => {
      notifyUI('success', '', { phase: 'pull', applied: result && result.applied });
      return result;
    });
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
    const reused = reuseActiveSync();
    if (reused) return reused;
    if (!navigator.onLine) {
      notifyUI('offline');
      return { ok: false, error: 'offline' };
    }

    activeSyncPromise = (async () => {
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
          const result = {
            ok: true,
            partial: true,
            pushed: !!pushResult,
            pushResult,
            pending: openItems,
          };
          notifyUI(
            'partial',
            `Envio parcial concluído. ${openItems} item(ns) seguem em segundo plano.`,
            { phase: 'push', pushResult, pending: openItems }
          );
          return finishSync(result, null);
        }

        const payload = await fetchSnapshot();
        const applied = payload ? await applySnapshot(payload.snapshot) : { ok: true, importedStores: [], notModified: true };
        localStorage.setItem(SYNC_KEY, nowIso());
        const result = { ok: true, pushed: !!pushResult, pushResult, applied, notModified: !payload };
        notifyUI('success', '', { phase: 'push+pull', pushResult, applied, notModified: !payload });
        return finishSync(result, null);
      } catch (err) {
        notifyUI('error', String(err && (err.message || err) || 'manual_sync_failed'));
        return finishSync(null, err);
      } finally {
        isSyncing = false;
      }
    })();

    return activeSyncPromise;
  }

  window.VSC_CLOUD_SYNC = {
    status,
    pullNow,
    manualSync,
    syncNow: manualSync,
    getLastSync: () => localStorage.getItem(SYNC_KEY) || null,
  };
})();
