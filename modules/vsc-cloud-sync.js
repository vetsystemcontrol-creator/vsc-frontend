// vsc-cloud-sync.js — CORRIGIDO
// Corrige: TypeError: Failed to fetch (topbar:321)
// Corrige: pullCanonicalSnapshot e pullNow

const VSC_CLOUD_SYNC = (() => {

  const SYNC_KEY    = 'vsc_last_sync';
  const RETRY_LIMIT = 3;
  const RETRY_DELAY = 2000; // ms

  let isSyncing = false;

  // ✅ Utilitário: aguarda N milissegundos
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ✅ Utilitário: retry com backoff exponencial
  async function withRetry(fn, label = 'operation') {
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
      try {
        return await fn();
      } catch (err) {
        console.warn(`[VSC_CLOUD_SYNC] ${label} tentativa ${attempt}/${RETRY_LIMIT} falhou:`, err.message);
        if (attempt < RETRY_LIMIT) {
          await sleep(RETRY_DELAY * attempt); // backoff: 2s, 4s, 6s
        } else {
          throw err;
        }
      }
    }
  }

  // ✅ Busca snapshot completo do servidor (pull canônico)
  async function pullCanonicalSnapshot() {
    return withRetry(async () => {
      const lastSync = localStorage.getItem(SYNC_KEY) || null;
      const data = await VSC_OUTBOX_RELAY.pullFromServer(lastSync);

      if (data?.records?.length > 0) {
        await applyRemoteRecords(data.records);
        console.log(`[VSC_CLOUD_SYNC] ${data.records.length} registros aplicados do servidor.`);
      }

      // Atualiza timestamp do último sync
      const now = new Date().toISOString();
      localStorage.setItem(SYNC_KEY, now);

      return data;
    }, 'pullCanonicalSnapshot');
  }

  // ✅ Executa sincronização completa (push + pull)
  async function pullNow() {
    if (isSyncing) {
      console.warn('[VSC_CLOUD_SYNC] Sincronização já em andamento, aguardando...');
      return;
    }

    if (!navigator.onLine) {
      console.warn('[VSC_CLOUD_SYNC] Sem conexão. Sync cancelado.');
      notifyUI('offline');
      return;
    }

    isSyncing = true;
    notifyUI('syncing');

    try {
      // 1. PUSH — envia dados locais pendentes
      const pendingRecords = await VSC_DB.getSyncQueue?.() || [];

      if (pendingRecords.length > 0) {
        console.log(`[VSC_CLOUD_SYNC] Enviando ${pendingRecords.length} itens pendentes...`);

        await withRetry(async () => {
          const result = await VSC_OUTBOX_RELAY.pushToServer(pendingRecords);
          if (result?.accepted) {
            await VSC_DB.clearSyncQueue?.(result.accepted);
          }
        }, 'push');
      }

      // 2. PULL — recebe dados do servidor
      await pullCanonicalSnapshot();

      notifyUI('success');
      console.log('[VSC_CLOUD_SYNC] ✅ Sincronização concluída com sucesso.');

    } catch (err) {
      console.error('[VSC_CLOUD_SYNC] ❌ Falha na sincronização:', err.message);
      notifyUI('error', err.message);
    } finally {
      isSyncing = false;
    }
  }

  // ✅ Aplica registros recebidos do servidor no banco local
  async function applyRemoteRecords(records) {
    for (const record of records) {
      try {
        const { module, type, payload } = record;

        if (type === 'DELETE') {
          await VSC_DB.delete?.(module, payload.id);
        } else {
          await VSC_DB.upsert?.(module, payload);
        }
      } catch (err) {
        console.error('[VSC_CLOUD_SYNC] Erro ao aplicar registro:', record, err);
      }
    }
  }

  // ✅ Notifica a UI sobre o estado do sync
  function notifyUI(status, message = '') {
    const event = new CustomEvent('vsc:sync:status', {
      detail: { status, message, timestamp: new Date().toISOString() }
    });
    window.dispatchEvent(event);
  }

  // ✅ Listener de reconexão automática
  window.addEventListener('online', () => {
    console.log('[VSC_CLOUD_SYNC] 🌐 Conexão restaurada. Iniciando sync automático...');
    setTimeout(pullNow, 1000); // pequeno delay para estabilizar conexão
  });

  return {
    pullNow,
    pullCanonicalSnapshot,
    getLastSync: () => localStorage.getItem(SYNC_KEY)
  };
})();