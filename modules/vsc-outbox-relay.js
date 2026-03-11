/*! 
 * VSC-OUTBOX-RELAY — Transactional Outbox Message Relay (Premium)
 * ============================================================
 */
(() => {
  'use strict';

  const DB_NAME      = (window.VSC_DB_NAME || 'vsc_db');
  const STORE_OUTBOX = 'sync_queue';
  const REMOTE_BASE  = 'https://app.vetsystemcontrol.com.br';

  const ACTIVE_TICK_MS = 500;
  const IDLE_TICK_MS   = 30000;
  const MAX_BATCH      = 100;

  let _enabled = true;
  let _running = false;
  let _stopRequested = false;
  let _inFlight = null;

  function _now() { return Date.now(); }
  function _getToken() { return localStorage.getItem('vsc_local_token') || sessionStorage.getItem('vsc_local_token') || ''; }

  function _apiBase() {
    const host = String(location.hostname || '').toLowerCase();
    if (location.protocol === 'file:' || host === '127.0.0.1' || host === 'localhost') return REMOTE_BASE;
    return '';
  }

  async function _openDB() {
    if (window.VSC_DB && typeof window.VSC_DB.openDB === 'function') {
      return await window.VSC_DB.openDB();
    }
    return await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }

  async function _pushBatch(batch) {
    const token = _getToken();
    const res = await fetch(`${_apiBase()}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VSC-Token': token,
        'X-VSC-Tenant': localStorage.getItem('vsc_tenant_id') || 'default',
      },
      body: JSON.stringify({ operations: batch }),
    });
    if (!res.ok) throw new Error(`Push failed: ${res.status}`);
    return await res.json();
  }

  async function _drainLoop() {
    if (_inFlight) return;
    _inFlight = (async () => {
      _running = true;
      try {
        while (_enabled && !_stopRequested) {
          const db = await _openDB();
          try {
            const tx = db.transaction([STORE_OUTBOX], 'readwrite');
            const store = tx.objectStore(STORE_OUTBOX);
            
            // Busca itens pendentes
            const pending = await new Promise(r => {
              const req = store.openCursor();
              const out = [];
              req.onsuccess = (e) => {
                const cursor = e.target.result;
                if(cursor && out.length < MAX_BATCH) {
                  if(cursor.value.status === 'PENDING') out.push(cursor.value);
                  cursor.continue();
                } else { r(out); }
              };
            });

            if (pending.length === 0) {
              db.close();
              await new Promise(r => setTimeout(r, IDLE_TICK_MS));
              continue;
            }

            // Envia para o servidor
            await _pushBatch(pending);

            // Marca como enviado
            for (const item of pending) {
              item.status = 'DONE';
              item.done_at = _now();
              store.put(item);
            }

            await new Promise(r => {
              tx.oncomplete = () => r();
              tx.onerror = () => r();
            });

          } finally { if(db && db.close) db.close(); }
          await new Promise(r => setTimeout(r, ACTIVE_TICK_MS));
        }
      } catch (err) {
        console.error("[VSC_RELAY] Erro na sincronização:", err);
        await new Promise(r => setTimeout(r, 5000));
      } finally { _running = false; _inFlight = null; }
    })();
  }

  window.VSC_RELAY = {
    start() { _enabled = true; _stopRequested = false; _drainLoop(); return true; },
    stop() { _stopRequested = true; _enabled = false; return true; },
    status() { return { enabled: _enabled, running: _running }; }
  };

  // Auto-start
  setTimeout(() => window.VSC_RELAY.start(), 2000);
})();
