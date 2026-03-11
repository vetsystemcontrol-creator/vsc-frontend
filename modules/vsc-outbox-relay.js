/* ============================================================
   VSC_OUTBOX_RELAY — Sincronização de Outbox (Offline-First)
   ============================================================ */

(() => {
  "use strict";

  const SYNC_INTERVAL_MS = 5000; // Tenta sincronizar a cada 5 segundos
  const MAX_RETRIES = 5;         // Número máximo de tentativas para um item da outbox
  const BATCH_SIZE = 10;         // Quantos itens enviar por vez

  let _isSyncing = false;
  let _syncTimer = null;

  async function openDB() {
    if (!window.VSC_DB || typeof window.VSC_DB.openDB !== "function") {
      console.error("[VSC_OUTBOX_RELAY] VSC_DB não carregado ou openDB não disponível.");
      throw new Error("VSC_DB não pronto para sincronização.");
    }
    return await window.VSC_DB.openDB();
  }

  async function processOutbox() {
    if (_isSyncing) return;
    _isSyncing = true;
    console.log("[VSC_OUTBOX_RELAY] Iniciando processamento da outbox...");

    try {
      const db = await openDB();
      const tx = db.transaction([window.VSC_DB.STORES.SYNC_QUEUE], "readwrite");
      const store = tx.objectStore(window.VSC_DB.STORES.SYNC_QUEUE);

      const pendingItems = await store.index("status").getAll("PENDING");
      const itemsToSend = pendingItems.slice(0, BATCH_SIZE);

      if (itemsToSend.length === 0) {
        console.log("[VSC_OUTBOX_RELAY] Outbox vazia. Nenhuma sincronização pendente.");
        _isSyncing = false;
        return;
      }

      console.log(`[VSC_OUTBOX_RELAY] Processando ${itemsToSend.length} itens da outbox.`);

      // Simula envio para o servidor (substituir por fetch real)
      const results = await Promise.all(itemsToSend.map(async (item) => {
        try {
          // Aqui você faria a chamada real para o seu backend
          // Ex: const response = await fetch(\'/api/sync\', { method: \'POST\', body: JSON.stringify(item) });
          // const data = await response.json();

          // Simulação de sucesso/falha
          const success = Math.random() > 0.1; // 90% de chance de sucesso
          if (success) {
            console.log(`[VSC_OUTBOX_RELAY] Item ${item.op_id} (${item.operation} ${item.entity_type}) enviado com sucesso.`);
            return { op_id: item.op_id, status: "SENT" };
          } else {
            throw new Error("Simulated network error");
          }
        } catch (error) {
          console.warn(`[VSC_OUTBOX_RELAY] Falha ao enviar item ${item.op_id}: ${error.message}`);
          return { op_id: item.op_id, status: "FAILED", error: error.message };
        }
      }));

      for (const result of results) {
        const item = itemsToSend.find(i => i.op_id === result.op_id);
        if (item) {
          if (result.status === "SENT") {
            await store.delete(item.op_id); // Remove da outbox se enviado com sucesso
          } else {
            item.retries = (item.retries || 0) + 1;
            if (item.retries >= MAX_RETRIES) {
              item.status = "PERMANENT_FAILURE";
              console.error(`[VSC_OUTBOX_RELAY] Item ${item.op_id} atingiu o limite de retries e falhou permanentemente.`);
            } else {
              item.status = "PENDING"; // Mantém como pendente para tentar novamente
            }
            await store.put(item);
          }
        }
      }
      await tx.oncomplete;

    } catch (error) {
      console.error("[VSC_OUTBOX_RELAY] Erro crítico no processamento da outbox:", error);
    } finally {
      _isSyncing = false;
      console.log("[VSC_OUTBOX_RELAY] Processamento da outbox finalizado.");
    }
  }

  function startSync() {
    if (_syncTimer) clearInterval(_syncTimer);
    _syncTimer = setInterval(processOutbox, SYNC_INTERVAL_MS);
    console.log("[VSC_OUTBOX_RELAY] Sincronização automática iniciada.");
    processOutbox(); // Executa uma vez imediatamente
  }

  function stopSync() {
    if (_syncTimer) clearInterval(_syncTimer);
    _syncTimer = null;
    console.log("[VSC_OUTBOX_RELAY] Sincronização automática parada.");
  }

  // Expõe a API VSC_OUTBOX_RELAY globalmente
  window.VSC_OUTBOX_RELAY = {
    start: startSync,
    stop: stopSync,
    process: processOutbox // Para forçar uma sincronização
  };

  // Inicia a sincronização quando o VSC_DB estiver pronto
  if (window.__VSC_DB_READY_FIRED) {
    startSync();
  } else {
    window.addEventListener("VSC_DB_READY", startSync);
  }

  console.log("[VSC_OUTBOX_RELAY] Módulo carregado.");
})();
