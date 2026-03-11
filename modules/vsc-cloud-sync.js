// vsc-cloud-sync.js — CORRIGIDO
// Fluxo correto do sync manual:
// 1) push local -> cloud via window.VSC_RELAY.syncNow()
// 2) pull snapshot canônico do Cloudflare
// 3) aplicar apenas stores compatíveis com o IndexedDB local

const VSC_CLOUD_SYNC = (() => {
  const SYNC_KEY = 'vsc_last_sync';
  const TENANT = 'tenant-default';
  let isSyncing = false;

  function nowIso(){ return new Date().toISOString(); }

  function notifyUI(status, message = '') {
    try {
      window.dispatchEvent(new CustomEvent('vsc:sync:status', {
        detail: { status, message, tenant: TENANT, timestamp: nowIso() }
      }));
    } catch (_) {}
  }

  function status(){
    return {
      tenant: TENANT,
      syncing: !!isSyncing,
      last_sync: localStorage.getItem(SYNC_KEY) || null
    };
  }

  async function fetchSnapshot() {
    const urls = [
      'https://app.vetsystemcontrol.com.br/api/sync/pull',
      'https://app.vetsystemcontrol.com.br/api/state?action=pull'
    ];

    let lastErr = null;
    for (const url of urls) {
      try {
        const r = await fetch(url, {
          method: 'GET',
          headers: { 'X-VSC-Tenant': TENANT }
        });
        if (!r.ok) throw new Error(`pull_http_${r.status}`);
        const j = await r.json();
        if (j && j.ok && j.snapshot && j.snapshot.data) return j;
        throw new Error('pull_invalid_payload');
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('pull_failed');
  }

  async function applySnapshot(snapshot) {
    if (!snapshot || !snapshot.data) return { ok: true, importedStores: [] };

    const db = await window.VSC_DB.openDB();
    try {
      const localStores = Array.from(db.objectStoreNames || []);
      // Stores protegidas: não sobrescrever dados locais de auth e sessão
      const PROTECTED = new Set([
        'auth_users', 'auth_sessions', 'auth_audit_log',
        'auth_role_permissions', 'auth_roles',
        'backup_events', 'db_backups', 'attachments_queue'
      ]);
      const filteredData = {};
      for (const [store, rows] of Object.entries(snapshot.data || {})) {
        if (localStores.includes(store) && !PROTECTED.has(store)) {
          filteredData[store] = Array.isArray(rows) ? rows : [];
        }
      }

      const filteredSchema = {
        ...(snapshot.schema || {}),
        db_name: (snapshot.schema && snapshot.schema.db_name) || 'vsc_db',
        stores: Object.keys(filteredData)
      };

      await window.VSC_DB.importDump({
        meta: snapshot.meta || {},
        schema: filteredSchema,
        data: filteredData
      }, { mode: 'replace_store' });

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

    // SGQT 8.1 - Proteção de Integridade Local
    // Não permite PULL (sobrescrever IDB) se houver itens PENDING na outbox
    // Evita que o snapshot da nuvem apague dados locais ainda não sincronizados.
    try {
      if (window.VSC_RELAY && typeof window.VSC_RELAY.status === 'function') {
        const s = window.VSC_RELAY.status();
        if (s && s.pending > 0) {
          notifyUI('error', 'Há dados locais pendentes de envio. Sincronize o push primeiro.');
          return { ok: false, error: 'pending_outbox_push_required' };
        }
      }
    } catch (_) {}

    isSyncing = true;
    notifyUI('syncing');
    try {
      const payload = await fetchSnapshot();
      const applied = await applySnapshot(payload.snapshot);
      localStorage.setItem(SYNC_KEY, nowIso());
      notifyUI('success');
      return { ok: true, pulled: true, applied };
    } catch (err) {
      notifyUI('error', String(err && (err.message || err) || 'pull_failed'));
      throw err;
    } finally {
      isSyncing = false;
    }
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
      let pushResult = null;
      if (window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === 'function') {
        pushResult = await window.VSC_RELAY.syncNow();
      }
      const payload = await fetchSnapshot();
      const applied = await applySnapshot(payload.snapshot);
      localStorage.setItem(SYNC_KEY, nowIso());
      notifyUI('success');
      return { ok: true, pushed: !!pushResult, pushResult, applied };
    } catch (err) {
      notifyUI('error', String(err && (err.message || err) || 'manual_sync_failed'));
      throw err;
    } finally {
      isSyncing = false;
    }
  }

  return {
    status,
    pullNow,
    manualSync,
    syncNow: manualSync,
    getLastSync: () => localStorage.getItem(SYNC_KEY) || null
  };
})();

window.VSC_CLOUD_SYNC = VSC_CLOUD_SYNC;
