/* ============================================================
   VSC_DB — Core de Persistência (IndexedDB)
   v43 — Enterprise Robustness (W3C Compliant)
   ============================================================ */

(function() {
  "use strict";

  const DB_NAME = "vsc_db";
  const DB_VERSION = 43;

  const VSC_DB = {
    _db: null,

    /**
     * Abre o banco de dados e retorna uma Promise que resolve com a instância IDBDatabase.
     */
    async openDB() {
      if (this._db) return this._db;
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          console.log(`[VSC_DB] Upgrade: v${event.oldVersion} -> v${DB_VERSION}`);

          // 1. Auth Stores
          if (!db.objectStoreNames.contains("auth_users")) {
            const s = db.createObjectStore("auth_users", { keyPath: "id" });
            s.createIndex("username", "username", { unique: true });
            s.createIndex("role_id", "role_id", { unique: false });
          } else {
            const s = request.transaction.objectStore("auth_users");
            if (!s.indexNames.contains("username")) s.createIndex("username", "username", { unique: true });
            if (!s.indexNames.contains("role_id")) s.createIndex("role_id", "role_id", { unique: false });
          }

          if (!db.objectStoreNames.contains("auth_roles")) {
            const s = db.createObjectStore("auth_roles", { keyPath: "id" });
            s.createIndex("name", "name", { unique: true });
          }

          if (!db.objectStoreNames.contains("auth_sessions")) db.createObjectStore("auth_sessions", { keyPath: "id" });
          if (!db.objectStoreNames.contains("auth_audit_log")) db.createObjectStore("auth_audit_log", { keyPath: "id" });

          // 2. Operational Stores
          const ops = ["atendimentos", "animais", "clientes", "empresas", "contas_a_pagar", "contas_a_receber", "sync_queue"];
          ops.forEach(name => {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
          });
        };

        request.onsuccess = (event) => {
          this._db = event.target.result;
          window.__VSC_DB_READY_FIRED = true;
          window.dispatchEvent(new Event("VSC_DB_READY"));
          console.log("[VSC_DB] Conexão estabelecida com sucesso.");
          resolve(this._db);
        };

        request.onerror = (e) => reject(e.target.error);
      });
    },

    /**
     * Wrapper genérico para operações de leitura/escrita que retorna uma Promise.
     * Resolve o problema de retornar IDBRequest em vez do dado real.
     */
    async exec(storeName, mode, callback) {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([storeName], mode);
        const store = tx.objectStore(storeName);
        const request = callback(store);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.onabort = () => reject(new Error("Transação abortada."));
      });
    },

    // Atalhos úteis
    async get(store, id) { return this.exec(store, "readonly", s => s.get(id)); },
    async getAll(store) { return this.exec(store, "readonly", s => s.getAll()); },
    async put(store, data) { return this.exec(store, "readwrite", s => s.put(data)); },
    async add(store, data) { return this.exec(store, "readwrite", s => s.add(data)); },
    async getByIndex(store, index, val) {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction([store], "readonly");
        const idx = tx.objectStore(store).index(index);
        const request = idx.get(val);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
  };

  window.VSC_DB = VSC_DB;
  VSC_DB.openDB().catch(e => console.error("[VSC_DB] Erro fatal:", e));
})();
