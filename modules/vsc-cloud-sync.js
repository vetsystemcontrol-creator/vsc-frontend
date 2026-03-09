/* ============================================================
   VSC_CLOUD_SYNC — sincronização manual por snapshot canônico
   - sem auto-sync
   - sem timers em background
   - executa apenas quando o operador clica em Sincronizar
   - push + pull controlados por botão
   ============================================================ */
(() => {
  'use strict';

  if (window.VSC_CLOUD_SYNC) return;

  const META_KEY = 'vsc_cloud_sync_meta_v1';
  const API = '/api/state';
  const EXCLUDED_PAGES = new Set(['login.html', 'topbar.html', '404.html']);

  const state = {
    available: false,
    running: false,
    mode: 'idle',
    lastError: null,
    lastDigest: null,
    lastSyncAt: 0,
    lastResult: null,
  };

  function nowIso(){ return new Date().toISOString(); }
  function safeJsonParse(v, fb = null){ try{ return JSON.parse(v); }catch(_){ return fb; } }
  function currentPage(){ const p = String(location.pathname || '').split('/').pop() || 'index.html'; return p || 'index.html'; }
  function isExcludedPage(){ return EXCLUDED_PAGES.has(currentPage()) || (window.top && window.top !== window); }
  function isAuthed(){ try{ return !!localStorage.getItem('vsc_session_id'); }catch(_){ return false; } }
  function getSavedMeta(){ try{ return safeJsonParse(localStorage.getItem(META_KEY), {}) || {}; }catch(_){ return {}; } }
  function setSavedMeta(meta){ try{ localStorage.setItem(META_KEY, JSON.stringify(meta || {})); }catch(_){} }
  function normalizeDigits(v){ return String(v || '').replace(/\D+/g, ''); }

  function getTenantKey(){
    try{
      const empresa = safeJsonParse(localStorage.getItem('vsc_empresa_v1'), null) ||
                      safeJsonParse(localStorage.getItem('VSC_EMPRESA_V1'), null);
      const cnpj = normalizeDigits(empresa && (empresa.cnpj || empresa.CNPJ || empresa.documento || empresa.doc));
      if (cnpj) return `tenant-${cnpj}`;
      const nome = String((empresa && (empresa.razao || empresa.nome_fantasia || empresa.nome)) || '').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
      if (nome) return `tenant-${nome}`;
    } catch(_) {}
    try{
      const user = safeJsonParse(localStorage.getItem('vsc_user'), null);
      const uid = normalizeDigits(user && (user.id || user.user_id || user.uuid));
      if (uid) return `tenant-user-${uid}`;
    } catch(_) {}
    return 'tenant-default';
  }

  async function sha256HexFromString(str){
    const bytes = new TextEncoder().encode(String(str || ''));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b)=>b.toString(16).padStart(2,'0')).join('');
  }

  async function ensureCoreReady(){
    try{ if (window.__VSC_DB_READY && typeof window.__VSC_DB_READY.then === 'function') await window.__VSC_DB_READY; }catch(_){}
    try{ if (window.__VSC_AUTH_READY && typeof window.__VSC_AUTH_READY.then === 'function') await window.__VSC_AUTH_READY; }catch(_){}
    if (!(window.VSC_DB && typeof window.VSC_DB.exportDump === 'function' && typeof window.VSC_DB.importDump === 'function')) {
      throw new Error('VSC_DB indisponível para cloud sync.');
    }
  }

  async function apiJSON(path, init){
    const res = await fetch(path, Object.assign({ cache:'no-store', credentials:'same-origin' }, init || {}));
    const text = await res.text().catch(()=> '');
    let json = null;
    try{ json = text ? JSON.parse(text) : null; }catch(_){ json = null; }
    return { ok: res.ok, status: res.status, json, text };
  }

  function buildHeaders(){
    const headers = { 'Content-Type': 'application/json' };
    try{ headers['X-VSC-Tenant'] = getTenantKey(); }catch(_){ headers['X-VSC-Tenant'] = 'tenant-default'; }
    try{
      const user = safeJsonParse(localStorage.getItem('vsc_user'), null);
      const label = user && (user.username || user.nome || user.name || user.id) ? String(user.username || user.nome || user.name || user.id) : 'anonymous';
      headers['X-VSC-User'] = label.slice(0, 120);
    }catch(_){ headers['X-VSC-User'] = 'anonymous'; }
    return headers;
  }

  function emit(detail){
    try{ window.dispatchEvent(new CustomEvent('vsc:cloud-sync-progress', { detail })); }catch(_){ }
    try{ window.dispatchEvent(new CustomEvent('vsc:sync-progress', { detail })); }catch(_){ }
  }

  async function getCapabilities(){
    const r = await apiJSON(`${API}?action=capabilities`, { method:'GET' });
    state.available = !!(r.ok && r.json && r.json.available);
    emit({ running:false, remote_sync_allowed: state.available, local_static_mode:false, pending:0, error: state.lastError });
    return r;
  }

  async function exportSnapshot(){
    const snapshot = await window.VSC_DB.exportDump();
    const json = JSON.stringify(snapshot);
    const digest = await sha256HexFromString(json);
    return { snapshot, json, digest, bytes: new Blob([json]).size, exported_at: snapshot && snapshot.meta && snapshot.meta.exported_at ? snapshot.meta.exported_at : nowIso() };
  }

  async function pullLatest(metaOnly){
    const tenant = encodeURIComponent(getTenantKey());
    return await apiJSON(`${API}?action=pull&tenant=${tenant}${metaOnly ? '&meta_only=1' : ''}`, { method:'GET' });
  }

  async function importCloudSnapshot(payload){
    if (!payload || !payload.snapshot) return { ok:false, reason:'missing_snapshot' };
    const result = await window.VSC_DB.importDump(payload.snapshot, { mode:'replace_store' });
    const meta = Object.assign({}, getSavedMeta(), {
      tenant: payload.meta && payload.meta.tenant,
      revision: payload.meta && payload.meta.revision,
      sha256: payload.meta && payload.meta.sha256,
      saved_at: payload.meta && payload.meta.saved_at,
      last_imported_at: nowIso(),
    });
    setSavedMeta(meta);
    state.lastDigest = payload.meta && payload.meta.sha256 ? payload.meta.sha256 : state.lastDigest;
    return result;
  }

  async function pushSnapshot(reason){
    const exp = await exportSnapshot();
    const r = await apiJSON(`${API}?action=push`, {
      method:'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ snapshot: exp.snapshot, source: 'browser-manual-sync', reason: reason || 'manual' })
    });
    if (!r.ok || !r.json || !r.json.ok) throw new Error((r.json && r.json.error) || `cloud push falhou (${r.status})`);
    state.lastDigest = exp.digest;
    state.lastSyncAt = Date.now();
    setSavedMeta(Object.assign({}, getSavedMeta(), {
      tenant: r.json.meta && r.json.meta.tenant,
      revision: r.json.meta && r.json.meta.revision,
      sha256: r.json.meta && r.json.meta.sha256,
      bytes: r.json.meta && r.json.meta.bytes,
      saved_at: r.json.meta && r.json.meta.saved_at,
      exported_at: exp.exported_at,
      last_pushed_at: nowIso(),
      page: currentPage(),
    }));
    return r.json;
  }

  async function pullAndApply(){
    const r = await pullLatest(false);
    if (!r.ok || !r.json || !r.json.ok || !r.json.exists || !r.json.snapshot || !r.json.meta) {
      return { ok:true, skipped:true, reason:'no_cloud_state' };
    }
    await importCloudSnapshot(r.json);
    return { ok:true, pulled:true, meta:r.json.meta };
  }

  async function syncNow(){
    if (isExcludedPage()) return { ok:false, error:'page_excluded' };
    await ensureCoreReady();
    if (!isAuthed()) return { ok:false, error:'not_authenticated' };
    if (state.running) return { ok:false, skipped:true, reason:'in_flight' };

    state.running = true;
    state.mode = 'syncing';
    state.lastError = null;
    emit({ running:true, pending:0, error:null, remote_sync_allowed: state.available });

    try{
      const cap = await getCapabilities();
      if (!(cap.ok && cap.json && cap.json.available)) {
        const err = (cap && cap.json && cap.json.error) || 'storage_unavailable';
        throw new Error(err);
      }
      const push = await pushSnapshot('manual');
      const pull = await pullAndApply();
      state.mode = 'idle';
      state.lastResult = { ok:true, push, pull };
      emit({ running:false, pending:0, ok:true, synced:true, remote_sync_allowed:true, last_sync_at: nowIso() });
      return { ok:true, push, pull };
    }catch(e){
      state.lastError = String(e && (e.message || e));
      state.mode = 'idle';
      emit({ running:false, pending:0, ok:false, error:state.lastError, remote_sync_allowed: state.available });
      return { ok:false, error: state.lastError };
    }finally{
      state.running = false;
    }
  }

  window.VSC_CLOUD_SYNC = {
    status(){ return Object.assign({}, state, { tenant:getTenantKey(), meta:getSavedMeta() }); },
    async syncNow(){ return await syncNow(); },
    async pullNow(){ await ensureCoreReady(); return await pullAndApply(); },
    async backupLocalNow(){ await ensureCoreReady(); return await window.VSC_DB.downloadBackupFile(); },
    async refreshCapabilities(){ return await getCapabilities(); },
  };

  // Modo manual: sem boot com push/pull automático.
  try{
    if (!isExcludedPage()) {
      getCapabilities().catch(()=>{});
    }
  }catch(_){ }
})();
