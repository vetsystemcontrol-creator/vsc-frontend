// vsc-cloud-sync.js — sincronização manual robusta (offline-first)
(() => {
  'use strict';

  const SYNC_KEY = 'vsc_last_sync';
  const SNAPSHOT_CACHE_KEY = 'vsc_last_snapshot_meta';
  const TENANT = 'tenant-default';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';
  const SYNC_TARGET_MODE_KEY = 'vsc_sync_target_mode';
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

  function getSyncTargetMode() {
    try {
      return String(localStorage.getItem(SYNC_TARGET_MODE_KEY) || '').trim().toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function resolveRemoteBase() {
    try {
      const proto = String(location.protocol || '').toLowerCase();
      if (proto === 'file:') return REMOTE_BASE;
      if (proto === 'http:' && isLocalDev()) {
        return getSyncTargetMode() === 'local' ? location.origin : REMOTE_BASE;
      }
    } catch (_) {}
    return location.origin;
  }

  function status() {
    return {
      tenant: TENANT,
      syncing: !!isSyncing,
      last_sync: localStorage.getItem(SYNC_KEY) || null,
      api_base: resolveRemoteBase(),
      target_mode: getSyncTargetMode() || (isLocalDev() ? 'remote' : 'same-origin'),
    };
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

  function getClientSessionId() {
    try {
      return String(
        localStorage.getItem('vsc_session_id') ||
        sessionStorage.getItem('vsc_session_id') ||
        ''
      ).trim();
    } catch (_) {
      return '';
    }
  }

  function buildCommonHeaders() {
    const headers = {
      Accept: 'application/json',
      'X-VSC-Tenant': TENANT,
    };
    const token = getSyncToken();
    const sessionId = getClientSessionId();
    if (token) headers['X-VSC-Token'] = token;
    if (sessionId) headers['X-VSC-Client-Session'] = sessionId;
    return headers;
  }

  function isCrossOriginUrl(url) {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch (_) {
      return false;
    }
  }

  function withTenantParam(url) {
    try {
      const u = new URL(url, location.href);
      if (!u.searchParams.get('tenant')) u.searchParams.set('tenant', TENANT);
      return u.toString();
    } catch (_) {
      return url;
    }
  }

  function buildSnapshotRequestOptions(url, headers = {}) {
    const crossOrigin = isCrossOriginUrl(url);
    const baseHeaders = { Accept: 'application/json', ...headers };
    if (crossOrigin) {
      // Evita preflight desnecessário em pull público cross-origin.
      delete baseHeaders['If-None-Match'];
      delete baseHeaders['X-VSC-Tenant'];
      delete baseHeaders['X-VSC-Token'];
      delete baseHeaders['X-VSC-Client-Session'];
      return {
        method: 'GET',
        headers: baseHeaders,
        cache: 'no-store',
        credentials: 'omit',
      };
    }
    return {
      method: 'GET',
      headers: baseHeaders,
      cache: 'no-store',
      credentials: 'include',
    };
  }

  function apiCandidates() {
    const base = resolveRemoteBase();
    const urls = [];
    const preferLocalOnly = isLocalDev() && getSyncTargetMode() === 'local';

    if (base) {
      urls.push(withTenantParam(`${base}/api/sync/pull`));
      urls.push(withTenantParam(`${base}/api/state?action=pull`));
    }

    if (!preferLocalOnly && location.origin && base !== location.origin && !isLocalDev()) {
      urls.push(withTenantParam(`${location.origin}/api/sync/pull`));
      urls.push(withTenantParam(`${location.origin}/api/state?action=pull`));
    }

    if (preferLocalOnly || !isLocalDev()) {
      urls.push(withTenantParam('/api/sync/pull'));
      urls.push(withTenantParam('/api/state?action=pull'));
    }

    return Array.from(new Set(urls));
  }

  function makeTimeoutController(timeoutMs) {
    const controller = new AbortController();
    const safeTimeout = Math.max(1, Number(timeoutMs) || 1);
    const timer = setTimeout(() => {
      try {
        controller.abort(new Error(`timeout_${safeTimeout}ms`));
      } catch (_) {
        try { controller.abort(); } catch (__){}
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
      const credentials = options && Object.prototype.hasOwnProperty.call(options, 'credentials') ? options.credentials : 'include';
      return await fetch(url, { ...options, credentials, signal: wrapped.controller.signal });
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
    const revision = Number(
      body && body.revision ||
      body && body.meta && body.meta.state_revision ||
      0
    ) || 0;

    return {
      rows,
      stores: stores.length,
      revision,
      score: (rows * 1000000) + (revision * 1000) + stores.length,
    };
  }

  function readSnapshotCacheMeta() {
    try {
      return JSON.parse(localStorage.getItem(SNAPSHOT_CACHE_KEY) || '{}') || {};
    } catch (_) {
      return {};
    }
  }

  function writeSnapshotCacheMeta(meta) {
    try {
      localStorage.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify(meta || {}));
    } catch (_) {}
  }

  async function fetchCandidate(url) {
    const cacheMeta = readSnapshotCacheMeta();
    const knownEtag = cacheMeta[url] && cacheMeta[url].etag ? String(cacheMeta[url].etag) : '';
    const headers = buildCommonHeaders();
    if (knownEtag) headers['If-None-Match'] = knownEtag;
    const requestOptions = buildSnapshotRequestOptions(url, headers);

    const response = await fetchWithTimeout(
      url,
      requestOptions,
      SNAPSHOT_TIMEOUT_MS,
      `snapshot_timeout_${SNAPSHOT_TIMEOUT_MS}ms`
    );

    if (response.status === 304) {
      return {
        url,
        body: null,
        not_modified: true,
        metrics: {
          rows: Number(cacheMeta[url] && cacheMeta[url].rows || 0) || 0,
          stores: Number(cacheMeta[url] && cacheMeta[url].stores || 0) || 0,
          revision: Number(cacheMeta[url] && cacheMeta[url].revision || 0) || 0,
          score: Number(cacheMeta[url] && cacheMeta[url].score || 0) || 0,
        },
      };
    }

    if (!response.ok) {
      throw new Error(`pull_http_${response.status}`);
    }

    const body = await response.json();
    if (!(body && body.ok && body.snapshot && body.snapshot.data)) {
      throw new Error('pull_invalid_payload');
    }

    const metrics = snapshotMetrics(body);
    writeSnapshotCacheMeta({
      ...cacheMeta,
      [url]: {
        etag: response.headers.get('ETag') || null,
        rows: metrics.rows,
        stores: metrics.stores,
        revision: metrics.revision,
        score: metrics.score,
      },
    });

    return {
      url,
      body,
      not_modified: false,
      metrics,
    };
  }

  async function fetchSnapshot() {
    const urls = apiCandidates();
    let lastErr = null;
    let best = null;
    let saw304 = false;

    for (const url of urls) {
      try {
        const candidate = await fetchCandidate(url);

        if (candidate.not_modified) {
          saw304 = true;
          try {
            console.info('[VSC_SYNC] snapshot não modificado', {
              url: candidate.url,
              revision: candidate.metrics.revision,
            });
          } catch (_) {}
          if (!best || candidate.metrics.score > best.metrics.score) best = candidate;
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

        if (!best || candidate.metrics.score > best.metrics.score) best = candidate;

        if (!isLocalDev()) {
          return { ok: true, payload: candidate.body, source: candidate.url, not_modified: false };
        }
      } catch (err) {
        lastErr = err;
        try {
          console.warn('[VSC_SYNC] snapshot falhou', { url, error: String(err && (err.message || err) || err) });
        } catch (_) {}
      }
    }

    if (best && best.body) {
      try {
        console.info('[VSC_SYNC] snapshot escolhido', {
          url: best.url,
          rows: best.metrics.rows,
          stores: best.metrics.stores,
          revision: best.metrics.revision,
        });
      } catch (_) {}
      return { ok: true, payload: best.body, source: best.url, not_modified: false };
    }

    if ((best && best.not_modified) || saw304) {
      return { ok: true, payload: null, source: best && best.url || null, not_modified: true };
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

      try {
        const empresaRows = filteredData.empresa;
        if (Array.isArray(empresaRows) && empresaRows.length) {
          localStorage.setItem('vsc_empresa_v1', JSON.stringify(empresaRows[0]));
        }
      } catch (_) {}

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
      const result = await fetchSnapshot();
      if (result.not_modified) {
        localStorage.setItem(SYNC_KEY, nowIso());
        notifyUI('success', '', { phase: 'pull', not_modified: true });
        return { ok: true, pulled: false, not_modified: true };
      }

      const applied = await applySnapshot(result.payload.snapshot);
      localStorage.setItem(SYNC_KEY, nowIso());
      notifyUI('success', '', { phase: 'pull', applied, source: result.source });
      return { ok: true, pulled: true, applied, source: result.source };
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
      const openItems = Number(relayStatus && (relayStatus.total_open ?? relayStatus.pending) || 0) || 0;

      if (openItems > 0) {
        localStorage.setItem(SYNC_KEY, nowIso());
        notifyUI(
          'partial',
          `Envio parcial concluído. ${openItems} item(ns) seguem em segundo plano.`,
          { phase: 'push', pushResult, pending: openItems }
        );
        return {
          ok: false,
          error: 'push_pending',
          partial: true,
          pushed: !!(pushResult && (pushResult.ackedDelta || pushResult.acked || pushResult.last_sent)),
          pushResult,
          pending: openItems,
        };
      }

      const result = await fetchSnapshot();
      if (result.not_modified) {
        localStorage.setItem(SYNC_KEY, nowIso());
        notifyUI('success', '', { phase: 'push+pull', pushResult, not_modified: true });
        return {
          ok: true,
          pushed: !!(pushResult && pushResult.ackedDelta),
          pushResult,
          not_modified: true,
        };
      }

      const applied = await applySnapshot(result.payload.snapshot);
      localStorage.setItem(SYNC_KEY, nowIso());
      notifyUI('success', '', { phase: 'push+pull', pushResult, applied, source: result.source });
      return {
        ok: true,
        pushed: !!(pushResult && pushResult.ackedDelta),
        pushResult,
        applied,
        source: result.source,
      };
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
