// vsc-cloud-sync.js — correção anti-travamento do fluxo manual de sincronização
(() => {
  'use strict';

  const SYNC_KEY = 'vsc_last_sync';
  const TENANT = 'tenant-default';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';
  const SNAPSHOT_TIMEOUT_MS = 20_000;
  const MANUAL_PUSH_BUDGET_MS = 45_000;

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

  function apiCandidates() {
    const relative = ['/api/sync/pull', '/api/state?action=pull'];
    const absolute = [
      `${REMOTE_BASE}/api/sync/pull`,
      `${REMOTE_BASE}/api/state?action=pull`,
    ];

    try {
      const proto = String(location.protocol || '').toLowerCase();
      if (proto === 'file:') return absolute;
      const host = String(location.hostname || '').toLowerCase();
      if (proto === 'http:' && (host === '127.0.0.1' || host === 'localhost')) {
        // Em desenvolvimento local, o Worker/D1 local normalmente é separado da base remota.
        // Por isso não podemos parar no primeiro 200: precisamos comparar a riqueza do snapshot.
        return [...relative, ...absolute];
      }
    } catch (_) {}

    return relative;
  }

  function readSyncToken() {
    try {
      return String(
        localStorage.getItem('vsc_local_token') ||
        localStorage.getItem('vsc_token') ||
        sessionStorage.getItem('vsc_local_token') ||
        sessionStorage.getItem('vsc_token') ||
        ''
      ).trim();
    } catch (_) {
      return '';
    }
  }

  function snapshotShapeScore(body) {
    const revision = Number(body && body.revision || body && body.meta && body.meta.state_revision || 0) || 0;
    const data = body && body.snapshot && body.snapshot.data && typeof body.snapshot.data === 'object'
      ? body.snapshot.data
      : {};
    const stores = Object.keys(data);
    let rows = 0;
    for (const store of stores) {
      const list = Array.isArray(data[store]) ? data[store] : [];
      rows += list.length;
    }
    return {
      revision,
      stores: stores.length,
      rows,
      empty: rows === 0,
      score: (rows * 1000) + (revision * 10) + stores,
    };
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

  async function fetchSnapshot() {
    const urls = apiCandidates();
    const token = readSyncToken();
    let lastErr = null;
    let best = null;

    for (const url of urls) {
      try {
        const headers = {
          'Accept': 'application/json',
          'X-VSC-Tenant': TENANT,
        };
        if (token) headers['X-VSC-Token'] = token;

        const response = await fetchWithTimeout(
          url,
          {
            method: 'GET',
            headers,
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

        const shape = snapshotShapeScore(body);
        const candidate = { url, body, shape };

        if (!best || shape.score > best.shape.score) {
          best = candidate;
        }

        // Fora do localhost, manter fast-path tradicional.
        const host = String(location.hostname || '').toLowerCase();
        const isLocalDev = host === '127.0.0.1' || host === 'localhost';
        if (!isLocalDev) {
          return body;
        }
      } catch (err) {
        lastErr = err;
      }
    }

    if (best) {
      try {
        console.info('[VSC_SYNC] snapshot escolhido', {
          url: best.url,
          revision: best.shape.revision,
          stores: best.shape.stores,
          rows: best.shape.rows,
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
      const applied = await applySnapshot(payload.snapshot);
      localStorage.setItem(SYNC_KEY, nowIso());
      notifyUI('success', '', { phase: 'push+pull', pushResult, applied });
      return { ok: true, pushed: !!pushResult, pushResult, applied };
    } catch (err) {
      notifyUI('error', String(err && (err.message || err) || 'manual_sync_failed'));
      throw err;
    } finally {
      isSyncing = false;
    }
  }

  window.VSC_CLOUD_SYNC = {
    status,
    pullNow,
    manualSync,
    syncNow: manualSync,
    getLastSync: () => localStorage.getItem(SYNC_KEY) || null,
  };
})();
