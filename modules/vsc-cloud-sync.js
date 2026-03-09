(() => {
  'use strict';

  if (window.VSC_CLOUD_SYNC) return;

  const META_KEY = 'vsc_cloud_sync_meta_v3';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';
  const DONE_PURGE_MAX = 5000;

  const state = {
    available: false,
    mode: 'idle',
    syncing: false,
    lastError: null,
    lastResult: null,
    lastPushAt: 0,
    lastPullAt: 0,
    lastCloudRevision: 0,
  };

  function safeJsonParse(v, fb = null){ try{ return JSON.parse(v); }catch(_){ return fb; } }
  function nowIso(){ return new Date().toISOString(); }
  function normalizeDigits(v){ return String(v || '').replace(/\D+/g, ''); }
  function isLocalDev(){
    try{
      const host = String(location.hostname || '').toLowerCase();
      return host === '127.0.0.1' || host === 'localhost' || String(location.protocol || '') === 'file:';
    }catch(_){ return false; }
  }
  function apiBase(){ return isLocalDev() ? REMOTE_BASE : ''; }
  function apiUrl(path){ return `${apiBase()}${path}`; }
  function getSavedMeta(){ try{ return safeJsonParse(localStorage.getItem(META_KEY), {}) || {}; }catch(_){ return {}; } }
  function setSavedMeta(meta){ try{ localStorage.setItem(META_KEY, JSON.stringify(meta || {})); }catch(_){} }

  function getTenantKey(){
    try{
      const empresa = safeJsonParse(localStorage.getItem('vsc_empresa_v1'), null) || safeJsonParse(localStorage.getItem('VSC_EMPRESA_V1'), null);
      const cnpj = normalizeDigits(empresa && (empresa.cnpj || empresa.CNPJ || empresa.documento || empresa.doc));
      if (cnpj) return `tenant-${cnpj}`;
      const nome = String((empresa && (empresa.razao || empresa.nome_fantasia || empresa.nome)) || '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      if (nome) return `tenant-${nome}`;
    }catch(_){ }
    return 'tenant-default';
  }

  function buildHeaders(){
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-VSC-Tenant': getTenantKey() };
    try {
      const user = safeJsonParse(localStorage.getItem('vsc_user'), null);
      headers['X-VSC-User'] = String((user && (user.username || user.nome || user.name || user.id)) || 'anonymous').slice(0, 120);
    } catch (_) {
      headers['X-VSC-User'] = 'anonymous';
    }
    return headers;
  }

  async function ensureCoreReady(){
    try{ if (window.__VSC_DB_READY && typeof window.__VSC_DB_READY.then === 'function') await window.__VSC_DB_READY; }catch(_){ }
    try{ if (window.__VSC_AUTH_READY && typeof window.__VSC_AUTH_READY.then === 'function') await window.__VSC_AUTH_READY; }catch(_){ }
    if (!(window.VSC_DB && typeof window.VSC_DB.importDump === 'function' && typeof window.VSC_DB.openDB === 'function')) {
      throw new Error('VSC_DB indisponível para sync manual.');
    }
  }

  async function apiJSON(url, init){
    const res = await fetch(url, Object.assign({ cache:'no-store', credentials:'omit', mode:'cors' }, init || {}));
    const text = await res.text().catch(()=> '');
    let json = null;
    try{ json = text ? JSON.parse(text) : null; }catch(_){ json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  function emit(detail){
    try{ window.dispatchEvent(new CustomEvent('vsc:sync-progress', { detail })); }catch(_){ }
  }

  async function getCapabilities(force){
    if (!force && state.available) return { ok:true, json:{ available:true, remote_sync_allowed:true } };
    const r = await apiJSON(apiUrl('/api/state?action=capabilities'), { method:'GET', headers:{ 'Accept':'application/json', 'X-VSC-Tenant': getTenantKey() } });
    state.available = !!(r.ok && r.json && r.json.remote_sync_allowed !== false);
    if (!state.available && r.json && r.json.error) state.lastError = String(r.json.error);
    return r;
  }

  async function purgeOutboxStatuses(statuses){
    const wanted = new Set((statuses || []).map((s) => String(s || '').toUpperCase()).filter(Boolean));
    if (!wanted.size) return { ok:true, removed:0 };
    const db = await window.VSC_DB.openDB();
    let removed = 0;
    try{
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['sync_queue'], 'readwrite');
        const st = tx.objectStore('sync_queue');
        const req = st.openCursor();
        req.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (!cursor) return;
          const row = cursor.value || {};
          const status = String(row.status || '').toUpperCase();
          if (wanted.has(status)) {
            removed += 1;
            cursor.delete();
            if (removed >= DONE_PURGE_MAX) return;
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error || new Error('sync_queue_scan_failed'));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('sync_queue_tx_failed'));
        tx.onabort = () => reject(tx.error || new Error('sync_queue_tx_aborted'));
      });
      return { ok:true, removed };
    } finally {
      try{ db.close(); }catch(_){ }
    }
  }

  async function drainOutboxManual(){
    if (!(window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === 'function')) {
      throw new Error('relay_unavailable');
    }
    const result = await window.VSC_RELAY.syncNow();
    const status = window.VSC_RELAY.status ? window.VSC_RELAY.status() : {};
    if (status && status.lastError) {
      throw new Error(String(status.lastError));
    }
    await purgeOutboxStatuses(['DONE']);
    return { ok:true, relay_result: result || null, relay_status: status || null };
  }

  async function pullCanonicalSnapshot(){
    const r = await apiJSON(apiUrl('/api/sync/pull'), { method:'GET', headers:{ 'Accept':'application/json', 'X-VSC-Tenant': getTenantKey() } });
    if (!r.ok || !r.json || !r.json.ok) throw new Error((r.json && r.json.error) || `pull_failed_${r.status}`);
    if (!r.json.exists || !r.json.snapshot) {
      state.lastPullAt = Date.now();
      return { ok:true, skipped:true, reason:'no_remote_state', meta:r.json.meta || null };
    }
    await window.VSC_DB.importDump(r.json.snapshot, { mode:'replace_store' });
    state.lastPullAt = Date.now();
    state.lastCloudRevision = Number(r.json.revision || r.json.meta?.state_revision || 0) || 0;
    setSavedMeta(Object.assign({}, getSavedMeta(), {
      tenant:getTenantKey(),
      last_pulled_at: nowIso(),
      last_cloud_revision: state.lastCloudRevision,
      meta:r.json.meta || null,
    }));
    return r.json;
  }

  async function manualSync(){
    if (state.syncing) return { ok:false, skipped:true, reason:'in_flight' };
    state.syncing = true;
    state.mode = 'manual';
    state.lastError = null;
    emit({ running:true, pending:0, manual:true, local_static_mode:isLocalDev(), remote_sync_allowed:state.available });
    try {
      await ensureCoreReady();
      const caps = await getCapabilities(true);
      if (!(caps.ok && caps.json && caps.json.remote_sync_allowed !== false)) {
        const reason = caps?.json?.error || caps?.json?.reason || 'remote_sync_disabled';
        throw new Error(reason);
      }
      const push = await drainOutboxManual();
      state.lastPushAt = Date.now();
      const pull = await pullCanonicalSnapshot();
      const purge = await purgeOutboxStatuses(['DEAD']);
      state.lastResult = { push, pull, purge };
      setSavedMeta(Object.assign({}, getSavedMeta(), {
        tenant:getTenantKey(),
        last_pushed_at: nowIso(),
        last_result: {
          cloud_revision: state.lastCloudRevision,
          push_acked: Number(push?.relay_status?.acked || 0) || 0,
          pull_exists: !!(pull && pull.exists),
        },
      }));
      emit({ running:false, pending:0, ok:true, manual:true, lastError:null, local_static_mode:isLocalDev(), remote_sync_allowed:true, cloud_revision:state.lastCloudRevision });
      return { ok:true, push, pull, purge };
    } catch (e) {
      state.lastError = String(e && (e.message || e));
      emit({ running:false, pending:0, ok:false, error:state.lastError, manual:true, local_static_mode:isLocalDev(), remote_sync_allowed:state.available });
      return { ok:false, error:state.lastError };
    } finally {
      state.syncing = false;
      state.mode = 'idle';
    }
  }

  window.VSC_CLOUD_SYNC = {
    status(){ return Object.assign({}, state, { tenant:getTenantKey(), meta:getSavedMeta(), apiBase: apiBase() || location.origin }); },
    async syncNow(){ return manualSync(); },
    async pullNow(){ await ensureCoreReady(); await getCapabilities(true); return pullCanonicalSnapshot(); },
    async manualSync(){ return manualSync(); },
  };
})();
