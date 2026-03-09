/* ============================================================
   VSC_CLOUD_SYNC — cloud-authoritative snapshot sync (R2-backed)
   - fonte primária na nuvem
   - cache local para operação local/offline
   - restore automático do snapshot mais novo
   - backup local opcional continua via VSC_DB.downloadBackupFile()
   ============================================================ */
(() => {
  'use strict';

  if (window.VSC_CLOUD_SYNC) return;

  const META_KEY = 'vsc_cloud_sync_meta_v1';
  const API = '/api/state';
  const TICK_MS = 60 * 1000;
  const MIN_PUSH_INTERVAL_MS = 45 * 1000;
  const PULL_COOLDOWN_MS = 2 * 60 * 1000;
  const EXCLUDED_PAGES = new Set(['login.html', 'topbar.html', '404.html']);

  const state = {
    available: false,
    mode: 'idle',
    running: false,
    syncing: false,
    lastError: null,
    lastDigest: null,
    lastPushAt: 0,
    lastPullAt: 0,
    timer: null,
  };

  function nowIso(){ return new Date().toISOString(); }
  function safeJsonParse(v, fb = null){ try{ return JSON.parse(v); }catch(_){ return fb; } }
  function sleep(ms){ return new Promise((resolve)=>setTimeout(resolve, ms)); }
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

  async function getCapabilities(){
    const r = await apiJSON(`${API}?action=capabilities`, { method:'GET' });
    state.available = !!(r.ok && r.json && r.json.available);
    return r;
  }

  async function exportSnapshot(){
    const snapshot = await window.VSC_DB.exportDump();
    const json = JSON.stringify(snapshot);
    const digest = await sha256HexFromString(json);
    return { snapshot, json, digest, bytes: new Blob([json]).size };
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
      exported_at: payload.meta && payload.meta.exported_at,
      last_imported_at: nowIso(),
    });
    setSavedMeta(meta);
    state.lastDigest = payload.meta && payload.meta.sha256 ? payload.meta.sha256 : state.lastDigest;
    return result;
  }

  async function maybePullNewerCloud(){
    const now = Date.now();
    if (now - state.lastPullAt < PULL_COOLDOWN_MS) return { ok:true, skipped:true, reason:'cooldown' };
    state.lastPullAt = now;
    const r = await pullLatest(false);
    if (!r.ok || !r.json || !r.json.exists || !r.json.snapshot || !r.json.meta) return { ok:true, skipped:true, reason:'no_cloud_state' };

    const saved = getSavedMeta();
    const cloudMeta = r.json.meta || {};
    const cloudRevision = String(cloudMeta.revision || '');
    const cloudSaved = Date.parse(cloudMeta.saved_at || cloudMeta.exported_at || '') || 0;
    const localSaved = Date.parse(saved.last_pushed_at || saved.last_imported_at || saved.exported_at || '') || 0;

    if (saved.revision && saved.revision === cloudRevision) {
      return { ok:true, skipped:true, reason:'already_current' };
    }

    if (cloudSaved > localSaved) {
      state.mode = 'pulling';
      await importCloudSnapshot(r.json);
      state.mode = 'idle';
      return { ok:true, pulled:true, revision: cloudRevision };
    }

    return { ok:true, skipped:true, reason:'local_is_newer_or_equal' };
  }

  async function pushSnapshot(reason){
    const now = Date.now();
    if (state.syncing) return { ok:false, skipped:true, reason:'in_flight' };
    if (now - state.lastPushAt < MIN_PUSH_INTERVAL_MS && reason !== 'manual') {
      return { ok:false, skipped:true, reason:'throttled' };
    }
    state.syncing = true;
    state.mode = 'pushing';
    state.lastError = null;
    try{
      const exp = await exportSnapshot();
      if (state.lastDigest && state.lastDigest === exp.digest && reason !== 'manual') {
        state.mode = 'idle';
        return { ok:true, skipped:true, reason:'unchanged' };
      }
      const r = await apiJSON(`${API}?action=push`, {
        method:'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ snapshot: exp.snapshot, source: 'browser-cloud-sync', reason: reason || 'auto' })
      });
      if (!r.ok || !r.json || !r.json.ok) throw new Error((r.json && r.json.error) || `cloud push falhou (${r.status})`);
      state.lastDigest = exp.digest;
      state.lastPushAt = Date.now();
      setSavedMeta(Object.assign({}, getSavedMeta(), {
        tenant: r.json.meta && r.json.meta.tenant,
        revision: r.json.meta && r.json.meta.revision,
        sha256: r.json.meta && r.json.meta.sha256,
        bytes: r.json.meta && r.json.meta.bytes,
        exported_at: exp.snapshot && exp.snapshot.meta && exp.snapshot.meta.exported_at,
        last_pushed_at: nowIso(),
        page: currentPage(),
      }));
      state.mode = 'idle';
      try{ window.dispatchEvent(new CustomEvent('vsc:cloud-sync', { detail:{ ok:true, mode:'push', revision:r.json.meta && r.json.meta.revision } })); }catch(_){}
      return { ok:true, pushed:true };
    }catch(e){
      state.lastError = String(e && (e.message || e));
      state.mode = 'idle';
      try{ window.dispatchEvent(new CustomEvent('vsc:cloud-sync', { detail:{ ok:false, mode:'push', error:state.lastError } })); }catch(_){}
      return { ok:false, error:state.lastError };
    }finally{
      state.syncing = false;
    }
  }

  async function tick(){
    if (!navigator.onLine || !document.hasFocus()) return;
    if (!isAuthed()) return;
    await maybePullNewerCloud();
    await pushSnapshot('auto');
  }

  async function boot(){
    if (isExcludedPage()) return;
    await ensureCoreReady();
    if (!isAuthed()) return;

    const cap = await getCapabilities();
    if (!(cap.ok && cap.json && cap.json.available)) {
      state.available = false;
      return;
    }

    state.available = true;

    await maybePullNewerCloud();
    await pushSnapshot('boot');

    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      tick().catch((e)=>{ state.lastError = String(e && (e.message || e)); });
    }, TICK_MS);

    window.addEventListener('online', () => { tick().catch(()=>{}); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        pushSnapshot('hidden').catch(()=>{});
      } else {
        tick().catch(()=>{});
      }
    });
    window.addEventListener('beforeunload', () => { pushSnapshot('manual').catch(()=>{}); });
  }

  window.VSC_CLOUD_SYNC = {
    status(){ return Object.assign({}, state, { tenant:getTenantKey(), meta:getSavedMeta() }); },
    async syncNow(){ await ensureCoreReady(); if (!state.available) await getCapabilities(); return await pushSnapshot('manual'); },
    async pullNow(){ await ensureCoreReady(); return await maybePullNewerCloud(); },
    async backupLocalNow(){ await ensureCoreReady(); return await window.VSC_DB.downloadBackupFile(); },
  };

  (async () => {
    try{
      await sleep(350);
      await boot();
    }catch(e){
      state.lastError = String(e && (e.message || e));
    }
  })();
})();
