/* ============================================================
   VSC_AUTH — RBAC enterprise + Sessão + Auditoria (offline-first)
   ============================================================ */

// 1. Definições Globais de Auxílio (Garantia de Escopo)
window.waitForDBReady = async function(timeoutMs){
  const timeout = Number(timeoutMs||30000);
  const start = Date.now();
  while(true){
    try{
      if(window.VSC_DB && window.__VSC_DB_READY_FIRED === true) return true;
    }catch(_){}
    if(Date.now() - start >= timeout) return false;
    await new Promise(r=>setTimeout(r, 50));
  }
};

(() => {
  "use strict";

  const S_USERS    = "auth_users";
  const S_SESSIONS = "auth_sessions";
  const S_AUDIT    = "auth_audit_log";
  const ROLE_MASTER = "MASTER";
  const ROLE_ADMIN  = "ADMIN";

  let _currentUser = null;

  async function openDB(){
    if(!window.VSC_DB) throw new Error("VSC_DB não carregado.");
    return await window.VSC_DB.openDB();
  }

  // Helper para garantir que o índice 'role' existe (Patch dinâmico se vsc_db falhou)
  async function ensureIndexes(db){
    // Nota: Em IndexedDB, índices só podem ser criados em onupgradeneeded.
    // Se o índice 'role' ou 'role_id' faltar, o bootstrap falhará com NotFoundError.
    // Esta função apenas valida a presença para logar erro claro.
    const tx = db.transaction([S_USERS], "readonly");
    const st = tx.objectStore(S_USERS);
    if(!st.indexNames.contains("role") && !st.indexNames.contains("role_id")){
      console.error("[VSC_AUTH] ERRO CRÍTICO: Índice 'role' não encontrado em 'auth_users'. O banco precisa de upgrade.");
    }
  }

  async function audit(action, userId, details){
    try{
      const db = await openDB();
      const t = db.transaction([S_AUDIT], "readwrite");
      t.objectStore(S_AUDIT).add({
        id: window.VSC_UTILS ? window.VSC_UTILS.uuidv4() : Date.now().toString(),
        when: new Date().toISOString(),
        event: action,
        user_id: userId,
        details: details
      });
    }catch(e){ console.error("[VSC_AUTH] audit error", e); }
  }

  const VSC_AUTH = {
    async bootstrap(){
      console.log("[VSC_AUTH] Iniciando bootstrap...");
      try{
        const db = await openDB();
        await ensureIndexes(db);
        
        // Tenta recuperar sessão ativa do localStorage
        const sid = localStorage.getItem("vsc_session_id");
        if(sid){
          const tx = db.transaction([S_SESSIONS, S_USERS], "readonly");
          const sess = await new Promise(r => {
            const req = tx.objectStore(S_SESSIONS).get(sid);
            req.onsuccess = () => r(req.result);
            req.onerror = () => r(null);
          });

          if(sess && sess.status === "ACTIVE"){
            const user = await new Promise(r => {
              const req = tx.objectStore(S_USERS).get(sess.user_id);
              req.onsuccess = () => r(req.result);
              req.onerror = () => r(null);
            });
            if(user){
              _currentUser = user;
              localStorage.setItem("vsc_user", JSON.stringify(user));
            }
          }
        }
      }catch(e){
        console.error("[VSC_AUTH] Erro no bootstrap:", e);
      }
    },

    async login(username, password){
      // Implementação simplificada para restaurar acesso
      const db = await openDB();
      const tx = db.transaction([S_USERS, S_SESSIONS], "readwrite");
      const store = tx.objectStore(S_USERS);
      
      const user = await new Promise((resolve) => {
        const req = store.index("username").get(username);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });

      if(!user || user.password !== password){
        return { ok: false, error: "Usuário ou senha inválidos." };
      }

      const sid = window.VSC_UTILS ? window.VSC_UTILS.uuidv4() : Date.now().toString();
      await tx.objectStore(S_SESSIONS).add({
        id: sid,
        user_id: user.id,
        status: "ACTIVE",
        created_at: new Date().toISOString()
      });

      _currentUser = user;
      localStorage.setItem("vsc_session_id", sid);
      localStorage.setItem("vsc_user", JSON.stringify(user));
      
      return { ok: true, user };
    },

    async logout(){
      const sid = localStorage.getItem("vsc_session_id");
      if(sid){
        const db = await openDB();
        const tx = db.transaction([S_SESSIONS], "readwrite");
        const sess = await new Promise(r => {
          const req = tx.objectStore(S_SESSIONS).get(sid);
          req.onsuccess = () => r(req.result);
          req.onerror = () => r(null);
        });
        if(sess){
          sess.status = "REVOKED";
          tx.objectStore(S_SESSIONS).put(sess);
        }
      }
      _currentUser = null;
      localStorage.removeItem("vsc_session_id");
      localStorage.removeItem("vsc_user");
      location.href = "/login.html";
    },

    async getCurrentUser(){
      if(_currentUser) return _currentUser;
      const u = localStorage.getItem("vsc_user");
      return u ? JSON.parse(u) : null;
    },

    getUser(){ return _currentUser || JSON.parse(localStorage.getItem("vsc_user") || "null"); },
    
    async listUsers(){
      const db = await openDB();
      return await new Promise(r => {
        const tx = db.transaction([S_USERS], "readonly");
        const req = tx.objectStore(S_USERS).getAll();
        req.onsuccess = () => r(req.result || []);
        req.onerror = () => r([]);
      });
    },

    isMaster(){ 
      const u = this.getUser(); 
      return !!(u && (u.role === ROLE_MASTER || u.role_id === "role_master" || u.is_master)); 
    },
    
    isAdmin(){ 
      const u = this.getUser(); 
      return !!(u && (u.role === ROLE_ADMIN || u.role === ROLE_MASTER || u.role_id === "role_admin" || u.role_id === "role_master")); 
    }
  };

  window.VSC_AUTH = VSC_AUTH;
  window.__VSC_AUTH_READY_FIRED = true;
  window.dispatchEvent(new Event("VSC_AUTH_READY"));
  console.log("[VSC_AUTH] Módulo carregado.");
})();
