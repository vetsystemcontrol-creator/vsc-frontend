// vsc-cloud-sync.js — correção anti-travamento do fluxo manual de sincronização
(() => {
  'use strict';

  const SYNC_KEY = 'vsc_last_sync';
  const TENANT = 'tenant-default';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';
  const SNAPSHOT_TIMEOUT_MS = 20_000;
  const SNAPSHOT_PUSH_TIMEOUT_MS = 60_000;
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

  const SNAPSHOT_ALLOWED_STORES = new Set([
    'produtos_master','produtos_lotes','servicos_master','exames_master','clientes_master','animais_master','atendimentos_master','contas_pagar','contas_receber','fornecedores_master','fechamentos','repro_cases','repro_exams','repro_protocols','repro_events','repro_pregnancy','repro_foaling','repro_tasks','config_params','config_audit_log','user_profiles','business_audit_log','estoque_movimentos','estoque_saldos','import_ledger','estoque_reasons','tenant_subscription','billing_events','animais_racas','animais_pelagens','animais_especies','animal_vitals_history','animal_vaccines','documents'
  ]);

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
        return [...relative, ...absolute];
      }
    } catch (_) {}

    return relative;
  }

  function snapshotPushCandidates() {
    const relative = ['/api/state?action=push'];
    const absolute = [`${REMOTE_BASE}/api/state?action=push`];

    try {
      const proto = String(location.protocol || '').toLowerCase();
      if (proto === 'file:') return absolute;
      const host = String(location.hostname || '').toLowerCase();
      if (proto === 'http:' && (host === '127.0.0.1' || host === 'localhost')) {
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

  async function fetchSnapshot() {
    const urls = apiCandidates();
    let lastErr = null;

    for (const url of urls) {
      try {
        const response = await fetchWithTimeout(
          url,
          {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'X-VSC-Tenant': TENANT,
            },
            cache: 'no-store',
          },
          SNAPSHOT_TIMEOUT_MS,
          `snapshot_timeout_${SNAPSHOT_TIMEOUT_MS}ms`
        );

        if (!response.ok) {
          throw new Error(`pull_http_${response.status}`);
        }

        const body = await response.json();
        if (body && body.ok && body.snapshot && body.snapshot.data) {
          return body;
        }

        throw new Error('pull_invalid_payload');
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error('pull_failed');
  }

  function snapshotRowCount(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.data !== 'object' || !snapshot.data) return 0;
    let total = 0;
    for (const rows of Object.values(snapshot.data || {})) {
      if (Array.isArray(rows)) total += rows.length;
    }
    return total;
  }

  function isRemoteSnapshotMeaningful(payload) {
    return snapshotRowCount(payload && payload.snapshot) > 0 || Number(payload && payload.revision || 0) > 0;
  }

  function sanitizeSnapshotForCloud(dump) {
    if (!dump || typeof dump !== 'object' || typeof dump.data !== 'object' || !dump.data) return null;
    const filteredData = {};
    for (const [store, rows] of Object.entries(dump.data || {})) {
      if (!SNAPSHOT_ALLOWED_STORES.has(store)) continue;
      filteredData[store] = Array.isArray(rows)
        ? rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
        : [];
    }

    const stores = Object.keys(filteredData);
    if (!stores.length) return null;

    return {
      meta: {
        app: 'Vet System Control – Equine',
        db_name: (dump.schema && dump.schema.db_name) || 'vsc_db',
        exported_at: nowIso(),
        source: 'browser-local-bootstrap',
      },
      schema: {
        db_name: (dump.schema && dump.schema.db_name) || 'vsc_db',
        exported_at: nowIso(),
        stores,
      },
      data: filteredData,
    };
  }

  async function exportLocalSnapshotForBootstrap() {
    if (!(window.VSC_DB && typeof window.VSC_DB.exportDump === 'function')) return null;
    const dump = await window.VSC_DB.exportDump();
    const snapshot = sanitizeSnapshotForCloud(dump);
    if (!snapshot || snapshotRowCount(snapshot) <= 0) return null;
    return snapshot;
  }

  async function pushBootstrapSnapshot(snapshot) {
    const urls = snapshotPushCandidates();
    let lastErr = null;

    for (const url of urls) {
      try {
        const response = await fetchWithTimeout(
          url,
          {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'X-VSC-Tenant': TENANT,
            },
            body: JSON.stringify({
              snapshot,
              source: 'browser-local-bootstrap',
              replace: true,
            }),
            cache: 'no-store',
          },
          SNAPSHOT_PUSH_TIMEOUT_MS,
          `snapshot_push_timeout_${SNAPSHOT_PUSH_TIMEOUT_MS}ms`
        );

        if (!response.ok) {
          throw new Error(`snapshot_push_http_${response.status}`);
        }

        const body = await response.json().catch(() => ({}));
        if (body && body.ok) return body;
        throw new Error(body && body.error ? String(body.error) : 'snapshot_push_invalid_payload');
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error('snapshot_push_failed');
  }

  async function ensureCloudSeededFromLocal(payload) {
    if (isRemoteSnapshotMeaningful(payload)) return { bootstrapped: false, payload };

    const localSnapshot = await exportLocalSnapshotForBootstrap();
    if (!localSnapshot) return { bootstrapped: false, payload };

    notifyUI('syncing', 'Publicando base local no servidor…', {
      phase: 'bootstrap',
      local_rows: snapshotRowCount(localSnapshot),
    });

    await pushBootstrapSnapshot(localSnapshot);
    const refreshed = await fetchSnapshot();
    return { bootstrapped: true, payload: refreshed };
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
      let payload = await fetchSnapshot();
      const seeded = await ensureCloudSeededFromLocal(payload);
      payload = seeded.payload;
      const applied = await applySnapshot(payload.snapshot);
      localStorage.setItem(SYNC_KEY, nowIso());
      notifyUI('success', '', { phase: seeded.bootstrapped ? 'bootstrap+pull' : 'pull', applied, bootstrapped: seeded.bootstrapped });
      return { ok: true, pulled: true, applied, bootstrapped: seeded.bootstrapped };
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

      let payload = await fetchSnapshot();
      const seeded = await ensureCloudSeededFromLocal(payload);
      payload = seeded.payload;
      const applied = await applySnapshot(payload.snapshot);
      localStorage.setItem(SYNC_KEY, nowIso());
      notifyUI('success', '', { phase: seeded.bootstrapped ? 'push+bootstrap+pull' : 'push+pull', pushResult, applied, bootstrapped: seeded.bootstrapped });
      return { ok: true, pushed: !!pushResult, pushResult, applied, bootstrapped: seeded.bootstrapped };
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
