/* ============================================================
   VSC_DB — IndexedDB Wrapper (Offline-First)
   ============================================================ */

(() => {
  "use strict";

  const DB_NAME = "vsc_db";
  const DB_VERSION = 41; // Incrementa a versão do DB para disparar onupgradeneeded

  // Store Names
  const STORE_ATENDIMENTOS = "atendimentos";
  const STORE_ANIMAIS = "animais";
  const STORE_CLIENTES = "clientes";
  const STORE_EMPRESAS = "empresas";
  const STORE_CONTAS_A_PAGAR = "contas_a_pagar";
  const STORE_CONTAS_A_RECEBER = "contas_a_receber";
  const STORE_FISCAL_NFES = "fiscal_nfes";
  const STORE_SYNC_QUEUE = "sync_queue";
  const STORE_AUTH_USERS = "auth_users";
  const STORE_AUTH_SESSIONS = "auth_sessions";
  const STORE_AUTH_AUDIT_LOG = "auth_audit_log";
  const STORE_AUTH_ROLES = "auth_roles";

  let _db = null;

  async function openDB() {
    if (_db) return _db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        console.log(`[VSC_DB] Upgrade necessário. Versão antiga: ${event.oldVersion}, Nova: ${event.newVersion}`);

        // Store: atendimentos
        if (!db.objectStoreNames.contains(STORE_ATENDIMENTOS)) {
          const store = db.createObjectStore(STORE_ATENDIMENTOS, { keyPath: "id" });
          store.createIndex("animal_id", "animal_id", { unique: false });
          store.createIndex("cliente_id", "cliente_id", { unique: false });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("created_at", "created_at", { unique: false });
          store.createIndex("updated_at", "updated_at", { unique: false });
          store.createIndex("deleted_at", "deleted_at", { unique: false });
        }

        // Store: animais
        if (!db.objectStoreNames.contains(STORE_ANIMAIS)) {
          const store = db.createObjectStore(STORE_ANIMAIS, { keyPath: "id" });
          store.createIndex("cliente_id", "cliente_id", { unique: false });
          store.createIndex("nome", "nome", { unique: false });
          store.createIndex("created_at", "created_at", { unique: false });
          store.createIndex("updated_at", "updated_at", { unique: false });
          store.createIndex("deleted_at", "deleted_at", { unique: false });
        }

        // Store: clientes
        if (!db.objectStoreNames.contains(STORE_CLIENTES)) {
          const store = db.createObjectStore(STORE_CLIENTES, { keyPath: "id" });
          store.createIndex("nome", "nome", { unique: false });
          store.createIndex("cpf_cnpj", "cpf_cnpj", { unique: true });
          store.createIndex("created_at", "created_at", { unique: false });
          store.createIndex("updated_at", "updated_at", { unique: false });
          store.createIndex("deleted_at", "deleted_at", { unique: false });
        }

        // Store: empresas
        if (!db.objectStoreNames.contains(STORE_EMPRESAS)) {
          const store = db.createObjectStore(STORE_EMPRESAS, { keyPath: "id" });
          store.createIndex("cnpj", "cnpj", { unique: true });
          store.createIndex("created_at", "created_at", { unique: false });
          store.createIndex("updated_at", "updated_at", { unique: false });
          store.createIndex("deleted_at", "deleted_at", { unique: false });
        }

        // Store: contas_a_pagar
        if (!db.objectStoreNames.contains(STORE_CONTAS_A_PAGAR)) {
          const store = db.createObjectStore(STORE_CONTAS_A_PAGAR, { keyPath: "id" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("vencimento", "vencimento", { unique: false });
          store.createIndex("created_at", "created_at", { unique: false });
          store.createIndex("updated_at", "updated_at", { unique: false });
          store.createIndex("deleted_at", "deleted_at", { unique: false });
        }

        // Store: contas_a_receber
        if (!db.objectStoreNames.contains(STORE_CONTAS_A_RECEBER)) {
          const store = db.createObjectStore(STORE_CONTAS_A_RECEBER, { keyPath: "id" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("vencimento", "vencimento", { unique: false });
          store.createIndex("created_at", "created_at", { unique: false });
          store.createIndex("updated_at", "updated_at", { unique: false });
          store.createIndex("deleted_at", "deleted_at", { unique: false });
        }

        // Store: fiscal_nfes
        if (!db.objectStoreNames.contains(STORE_FISCAL_NFES)) {
          const store = db.createObjectStore(STORE_FISCAL_NFES, { keyPath: "id" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("created_at", "created_at", { unique: false });
          store.createIndex("updated_at", "updated_at", { unique: false });
          store.createIndex("deleted_at", "deleted_at", { unique: false });
        }

        // Store: sync_queue (Transactional Outbox)
        if (!db.objectStoreNames.contains(STORE_SYNC_QUEUE)) {
          const store = db.createObjectStore(STORE_SYNC_QUEUE, { keyPath: "op_id" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("created_at", "created_at", { unique: false });
        }

        // Store: auth_users
        if (!db.objectStoreNames.contains(STORE_AUTH_USERS)) {
          const st = db.createObjectStore(STORE_AUTH_USERS, { keyPath: "id" });
          st.createIndex("username", "username", { unique: true });
          st.createIndex("role_id", "role_id", { unique: false }); // GARANTIDO AGORA
          st.createIndex("status", "status", { unique: false });
          st.createIndex("updated_at", "updated_at", { unique: false });
        } else if (event.oldVersion < DB_VERSION) { // Se a versão anterior for menor que a atual, garante o índice
          const st = request.transaction.objectStore(STORE_AUTH_USERS);
          if (!st.indexNames.contains("role_id")) {
            st.createIndex("role_id", "role_id", { unique: false });
            console.log("[VSC_DB] Índice 'role_id' criado em auth_users.");
          }
        }

        // Store: auth_sessions
        if (!db.objectStoreNames.contains(STORE_AUTH_SESSIONS)) {
          const st = db.createObjectStore(STORE_AUTH_SESSIONS, { keyPath: "id" });
          st.createIndex("user_id", "user_id", { unique: false });
          st.createIndex("status", "status", { unique: false });
          st.createIndex("expires_at", "expires_at", { unique: false });
        }

        // Store: auth_audit_log
        if (!db.objectStoreNames.contains(STORE_AUTH_AUDIT_LOG)) {
          const st = db.createObjectStore(STORE_AUTH_AUDIT_LOG, { keyPath: "id" });
          st.createIndex("user_id", "user_id", { unique: false });
          st.createIndex("event", "event", { unique: false });
          st.createIndex("when", "when", { unique: false });
        }

        // Store: auth_roles
        if (!db.objectStoreNames.contains(STORE_AUTH_ROLES)) {
          const st = db.createObjectStore(STORE_AUTH_ROLES, { keyPath: "id" });
          st.createIndex("name", "name", { unique: true });
        }

        console.log("[VSC_DB] Estrutura do banco de dados atualizada com sucesso.");
      };

      request.onsuccess = (event) => {
        _db = event.target.result;
        console.log(`[VSC_DB] ready {name: '${DB_NAME}', version: ${DB_VERSION}}`);
        resolve(_db);
        // Dispara evento global para sinalizar que o DB está pronto
        window.__VSC_DB_READY_FIRED = true;
        window.dispatchEvent(new Event("VSC_DB_READY"));
      };

      request.onerror = (event) => {
        console.error("[VSC_DB] Erro ao abrir IndexedDB:", event.target.error);
        reject(event.target.error);
      };
    });
  }

  /**
   * Adiciona ou atualiza um registro em uma store, com suporte a outbox.
   * @param {IDBDatabase} db - Instância do IndexedDB.
   * @param {string} storeName - Nome da store.
   * @param {object} record - Registro a ser salvo.
   * @param {string} [opType='UPSERT'] - Tipo de operação (UPSERT, DELETE).
   * @returns {Promise<object>} O registro salvo.
   */
  async function upsertWithOutbox(db, storeName, record, opType = "UPSERT") {
    const tx = db.transaction([storeName, STORE_SYNC_QUEUE], "readwrite");
    const store = tx.objectStore(storeName);
    const syncStore = tx.objectStore(STORE_SYNC_QUEUE);

    record.updated_at = new Date().toISOString();
    if (!record.created_at) record.created_at = record.updated_at;

    await store.put(record);

    // Adiciona à fila de sincronização
    await syncStore.add({
      op_id: window.VSC_UTILS ? window.VSC_UTILS.uuidv4() : Date.now().toString(),
      entity_type: storeName,
      entity_id: record.id,
      operation: opType,
      payload: record,
      status: "PENDING",
      created_at: new Date().toISOString(),
      retries: 0
    });

    await tx.oncomplete;
    return record;
  }

  /**
   * Deleta um registro de uma store, com suporte a outbox (soft-delete).
   * @param {IDBDatabase} db - Instância do IndexedDB.
   * @param {string} storeName - Nome da store.
   * @param {string} id - ID do registro a ser deletado.
   * @returns {Promise<void>}
   */
  async function deleteWithOutbox(db, storeName, id) {
    const tx = db.transaction([storeName, STORE_SYNC_QUEUE], "readwrite");
    const store = tx.objectStore(storeName);
    const syncStore = tx.objectStore(STORE_SYNC_QUEUE);

    const record = await store.get(id);
    if (record) {
      record.deleted_at = new Date().toISOString();
      record.status = "DELETED"; // Marca como deletado logicamente
      await store.put(record);

      // Adiciona à fila de sincronização como DELETE
      await syncStore.add({
        op_id: window.VSC_UTILS ? window.VSC_UTILS.uuidv4() : Date.now().toString(),
        entity_type: storeName,
        entity_id: record.id,
        operation: "DELETE",
        payload: { id: record.id, deleted_at: record.deleted_at }, // Envia apenas o essencial para o delete
        status: "PENDING",
        created_at: new Date().toISOString(),
        retries: 0
      });
    }

    await tx.oncomplete;
  }

  // Expõe a API VSC_DB globalmente
  window.VSC_DB = {
    openDB: openDB,
    upsertWithOutbox: upsertWithOutbox,
    deleteWithOutbox: deleteWithOutbox,
    // Expõe nomes das stores para uso externo
    STORES: {
      ATENDIMENTOS: STORE_ATENDIMENTOS,
      ANIMAIS: STORE_ANIMAIS,
      CLIENTES: STORE_CLIENTES,
      EMPRESAS: STORE_EMPRESAS,
      CONTAS_A_PAGAR: STORE_CONTAS_A_PAGAR,
      CONTAS_A_RECEBER: STORE_CONTAS_A_RECEBER,
      FISCAL_NFES: STORE_FISCAL_NFES,
      SYNC_QUEUE: STORE_SYNC_QUEUE,
      AUTH_USERS: STORE_AUTH_USERS,
      AUTH_SESSIONS: STORE_AUTH_SESSIONS,
      AUTH_AUDIT_LOG: STORE_AUTH_AUDIT_LOG,
      AUTH_ROLES: STORE_AUTH_ROLES,
    }
  };

  // Inicia a abertura do DB assim que o script é carregado
  // Isso garante que o DB esteja pronto o mais cedo possível.
  openDB().catch(e => console.error("[VSC_DB] Falha na inicialização automática do DB:", e));

  console.log("[VSC_DB] Módulo carregado.");
})();
