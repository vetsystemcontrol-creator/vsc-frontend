(() => {
  'use strict';

  const SYNC_TS_KEY = 'vsc_last_sync_at';
  const SYNC_REV_KEY = 'vsc_last_sync_revision';
  const TENANT_KEY = 'vsc_tenant';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';
  const PULL_ENDPOINTS = [
    '/api/sync/pull',
    '/api/state?action=pull',
  ];
  const RETRY_LIMIT = 3;
  const RETRY_DELAY_MS = 1200;

  let isSyncing = false;
  let lastError = null;
  let lastTenant = 'tenant-default';
  let lastRevision = 0;
  let lastPulledAt = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function notifyUI(status, message = '', extra = {}) {
    try {
      window.dispatchEvent(new CustomEvent('vsc:sync:status', {
        detail: {
          status,
          message,
          tenant: lastTenant,
          revision: lastRevision,
          timestamp: new Date().toISOString(),
          ...extra,
        },
      }));
    } catch (_) {}
  }

  function getTenant() {
    try {
      if (window.VSC_RELAY && typeof window.VSC_RELAY.status === 'function') {
        const relayStatus = window.VSC_RELAY.status() || {};
        const relayTenant = relayStatus?.capabilities?.body?.tenant || relayStatus?.tenant || '';
        if (relayTenant) {
          lastTenant = String(relayTenant).trim().slice(0, 120) || 'tenant-default';
          return lastTenant;
        }
      }
    } catch (_) {}

    try {
      const raw = localStorage.getItem(TENANT_KEY) || '';
      if (raw) {
        lastTenant = String(raw).trim().slice(0, 120) || 'tenant-default';
        return lastTenant;
      }
    } catch (_) {}

    return lastTenant;
  }

  function getUserLabel() {
    try {
      const raw = localStorage.getItem('vsc_user') || sessionStorage.getItem('vsc_user') || 'null';
      const user = JSON.parse(raw);
      return String((user && (user.username || user.nome || user.name || user.id)) || 'anonymous').trim().slice(0, 120) || 'anonymous';
    } catch (_) {
      return 'anonymous';
    }
  }

  function getToken() {
    try {
      return String(
        localStorage.getItem('vsc_local_token') ||
        sessionStorage.getItem('vsc_local_token') ||
        localStorage.getItem('vsc_token') ||
        sessionStorage.getItem('vsc_token') ||
        ''
      );
    } catch (_) {
      return '';
    }
  }

  function isLocalStaticMode() {
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

  function apiBase() {
    return isLocalStaticMode() ? REMOTE_BASE : '';
  }

  function apiUrl(path) {
    return `${apiBase()}${path}`;
  }

  async function withRetry(fn, label) {
    let last = null;
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt += 1) {
      try {
        return await fn(attempt);
      } catch (err) {
        last = err;
        try { console.warn(`[VSC_CLOUD_SYNC] ${label} tentativa ${attempt}/${RETRY_LIMIT} falhou:`, err && err.message ? err.message : err); } catch (_) {}
        if (attempt < RETRY_LIMIT) {
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }
    throw last || new Error(`${label}_failed`);
  }

  async function fetchSnapshot() {
    const tenant = getTenant();
    const headers = {
      Accept: 'application/json',
      'X-VSC-Tenant': tenant,
      'X-VSC-User': getUserLabel(),
    };
    const token = getToken();
    if (token) headers['X-VSC-Token'] = token;

    let lastFailure = null;
    for (const endpoint of PULL_ENDPOINTS) {
      try {
        const res = await fetch(apiUrl(endpoint), {
          method: 'GET',
          headers,
          cache: 'no-store',
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`${endpoint} ${res.status} ${txt}`.trim());
        }
        const body = await res.json().catch(() => ({}));
        if (body && body.ok === false) {
          throw new Error(String(body.error || body.detail || `${endpoint} failed`));
        }
        return body || {};
      } catch (err) {
        lastFailure = err;
      }
    }
    throw lastFailure || new Error('pull_failed');
  }

  async function applySnapshot(snapshot) {
    if (!window.VSC_DB || typeof window.VSC_DB.importDump !== 'function') {
      throw new Error('local_import_unavailable');
    }
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.schema || !snapshot.data) {
      throw new Error('invalid_snapshot');
    }
    return await window.VSC_DB.importDump(snapshot, { mode: 'replace_store' });
  }

  async function pullCanonicalSnapshot() {
    if (!navigator.onLine) {
      notifyUI('offline');
      return { ok: false, error: 'offline' };
    }

    notifyUI('syncing', '', { phase: 'pull' });
    const body = await withRetry(fetchSnapshot, 'pull');

    if (body && body.snapshot && body.snapshot.schema && body.snapshot.data) {
      await applySnapshot(body.snapshot);
    }

    const revision = Number(body?.revision || body?.meta?.state_revision || body?.snapshot?.meta?.state_revision || 0) || 0;
    const pulledAt = new Date().toISOString();
    lastRevision = revision;
    lastPulledAt = pulledAt;
    lastTenant = String(body?.tenant || getTenant()).trim().slice(0, 120) || 'tenant-default';
    lastError = null;
    try {
      localStorage.setItem(SYNC_TS_KEY, pulledAt);
      localStorage.setItem(SYNC_REV_KEY, String(revision));
      localStorage.setItem(TENANT_KEY, lastTenant);
    } catch (_) {}

    notifyUI('success', '', { phase: 'pull', revision, tenant: lastTenant, pulled_at: pulledAt });
    return {
      ok: true,
      tenant: lastTenant,
      revision,
      pulled_at: pulledAt,
      exists: !!body?.exists,
      meta: body?.meta || null,
    };
  }

  async function manualSync() {
    if (isSyncing) {
      return {
        ok: false,
        error: 'sync_in_progress',
        tenant: lastTenant,
        revision: lastRevision,
      };
    }
    if (!navigator.onLine) {
      notifyUI('offline');
      return { ok: false, error: 'offline' };
    }

    isSyncing = true;
    notifyUI('syncing', '', { phase: 'push-pull' });

    try {
      if (window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === 'function') {
        await window.VSC_RELAY.syncNow();
        if (typeof window.VSC_RELAY.status === 'function') {
          const st = window.VSC_RELAY.status() || {};
          if (st.lastError || st.last_error) {
            throw new Error(String(st.lastError || st.last_error));
          }
          if (Number(st.pending || 0) > 0) {
            throw new Error('pending_operations_after_push');
          }
        }
      }
      return await pullCanonicalSnapshot();
    } catch (err) {
      lastError = String(err && (err.message || err) || 'sync_failed');
      notifyUI('error', lastError, { phase: 'push-pull' });
      throw err;
    } finally {
      isSyncing = false;
    }
  }

  function status() {
    return {
      syncing: isSyncing,
      isSyncing,
      lastError,
      tenant: lastTenant,
      lastTenant,
      lastRevision,
      lastPulledAt,
      last_sync_at: (() => {
        try { return localStorage.getItem(SYNC_TS_KEY) || lastPulledAt; } catch (_) { return lastPulledAt; }
      })(),
      last_sync_revision: (() => {
        try { return Number(localStorage.getItem(SYNC_REV_KEY) || lastRevision || 0) || 0; } catch (_) { return lastRevision || 0; }
      })(),
    };
  }

  window.VSC_CLOUD_SYNC = {
    pullNow: pullCanonicalSnapshot,
    pullCanonicalSnapshot,
    manualSync,
    syncNow: manualSync,
    status,
    getLastSync() {
      try { return localStorage.getItem(SYNC_TS_KEY) || null; } catch (_) { return null; }
    },
  };
})();
