(() => {
  'use strict';

  if (window.VSC_CLOUD_SYNC) return;

  const META_KEY = 'vsc_cloud_sync_meta_v3';
  const REMOTE_BASE = 'https://app.vetsystemcontrol.com.br';

  const state = {
    available: false,
    mode: 'idle',
    syncing: false,
    lastError: null,
    lastResult: null,
    lastPushAt: 0,
    lastPullAt: 0,
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
    if (!(window.VSC_DB && typeof window.VSC_DB.importDump === 'function')) {
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

  async function getCapabilities(force){
    if (!force && state.available) return { ok:true, json:{ available:true, remote_sync_allowed:true } };
    const r = await apiJSON(apiUrl('/api/state?action=capabilities'), { method:'GET', headers:{ 'Accept':'application/json', 'X-VSC-Tenant': getTenantKey() } });
    state.available = !!(r.ok && r.json && r.json.remote_sync_allowed !== false);
    if (!state.available && r.json && r.json.error) state.lastError = String(r.json.error);
    return r;
  }

  async function pullCanonical(){
    const r = await apiJSON(apiUrl('/api/sync/pull'), { method:'GET', headers: buildHeaders() });
    if (!r.ok || !r.json || !r.json.ok) throw new Error((r.json && r.json.error) || `pull_failed_${r.status}`);
    if (!r.json.exists || !r.json.snapshot) return { ok:true, skipped:true, reason:'no_remote_snapshot' };
    await window.VSC_DB.importDump(r.json.snapshot, { mode:'replace_store' });
    state.lastPullAt = Date.now();
    setSavedMeta(Object.assign({}, getSavedMeta(), { tenant:getTenantKey(), last_pulled_at: nowIso(), meta:r.json.meta || null }));
    return r.json;
  }

  function emit(detail){
    try{ window.dispatchEvent(new CustomEvent('vsc:sync-progress', { detail })); }catch(_){ }
  }

  async function manualSync(){
    if (state.syncing) return { ok:false, skipped:true, reason:'in_flight' };
    state.syncing = true;
    state.mode = 'manual';
    state.lastError = null;
    emit({ running:true, manual:true, local_static_mode:isLocalDev(), remote_sync_allowed:state.available });
    try {
      await ensureCoreReady();
      const caps = await getCapabilities(true);
      if (!(caps.ok && caps.json && caps.json.remote_sync_allowed !== false)) {
        const reason = caps?.json?.error || caps?.json?.reason || 'remote_sync_disabled';
        throw new Error(reason);
      }
      let push = { ok:true, skipped:true, reason:'relay_unavailable' };
      if (window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === 'function') {
        push = await window.VSC_RELAY.syncNow();
        if (push && push.ok === false && !push.skipped) throw new Error(push.error || 'push_failed');
      }
      state.lastPushAt = Date.now();
      const pull = await pullCanonical();
      state.lastResult = { push, pull };
      emit({ running:false, ok:true, manual:true, error:null, local_static_mode:isLocalDev(), remote_sync_allowed:true, pending:0 });
      return { ok:true, push, pull };
    } catch (e) {
      state.lastError = String(e && (e.message || e));
      emit({ running:false, ok:false, error:state.lastError, manual:true, local_static_mode:isLocalDev(), remote_sync_allowed:state.available });
      return { ok:false, error:state.lastError };
    } finally {
      state.syncing = false;
      state.mode = 'idle';
    }
  }

  window.VSC_CLOUD_SYNC = {
    status(){ return Object.assign({}, state, { tenant:getTenantKey(), meta:getSavedMeta(), apiBase: apiBase() || location.origin }); },
    async syncNow(){ return manualSync(); },
    async pullNow(){ await ensureCoreReady(); await getCapabilities(true); return pullCanonical(); },
    async manualSync(){ return manualSync(); },
  };
})();
