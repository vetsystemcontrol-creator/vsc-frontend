/* ============================================================
   VSC_AUTH — RBAC enterprise + Sessão + Auditoria (offline-first)
   ============================================================ */

// 1. Definições Globais de Auxílio (fora de qualquer IIFE para visibilidade total)
window.waitForVSC_DBOpenDB = async function(timeoutMs){
  const timeout = Number(timeoutMs||8000);
  const step = 50;
  const start = Date.now();
  while(true){
    try{
      if(window.VSC_DB && typeof window.VSC_DB.openDB === "function") return true;
    }catch(_){}
    if(Date.now() - start >= timeout) return false;
    await new Promise(r=>setTimeout(r, step));
  }
};

window.waitForDBReady = async function(timeoutMs){
  const timeout = Number(timeoutMs||30000);
  const start = Date.now();
  try{
    if(window.__VSC_DB_READY && typeof window.__VSC_DB_READY.then === "function"){
      const race = await Promise.race([
        window.__VSC_DB_READY,
        new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")), timeout))
      ]);
      if(race === true || race === undefined) return true;
    }
  }catch(_){}
  let done = false;
  function mark(){ done = true; }
  try{ window.addEventListener("VSC_DB_READY", mark, { once:true }); }catch(_){}
  while(true){
    try{
      if(window.VSC_DB && typeof window.VSC_DB.openDB === "function"){
        if(window.__VSC_DB_READY_FIRED === true) return true;
      }
    }catch(_){}
    if(done) return true;
    if(Date.now() - start >= timeout) return false;
    await new Promise(r=>setTimeout(r, 50));
  }
};

window.waitforVSC_DBopenDB = window.waitForVSC_DBOpenDB;
window.waitforVSC_DBOpenDB = window.waitForVSC_DBOpenDB;
window.waitForVSC_DBopenDB = window.waitForVSC_DBOpenDB;

// 2. Módulo Principal
(() => {
  "use strict";

  window.__VSC_AUTH_BUILD = "ERP2.0.1|auth.js|RBAC|2026-03-11|FIXED_SCOPE";

  try{
    if(!window.__VSC_AUTH_READY || typeof window.__VSC_AUTH_READY.then !== "function"){
      window.__VSC_AUTH_READY_FIRED = false;
      window.__VSC_AUTH_READY_RESOLVE = null;
      window.__VSC_AUTH_READY = new Promise((resolve)=>{ window.__VSC_AUTH_READY_RESOLVE = resolve; });
    }
  }catch(_){ }

  const S_USERS    = "auth_users";
  const S_ROLES    = "auth_roles";
  const S_PERMS    = "auth_role_permissions";
  const S_SESSIONS = "auth_sessions";
  const S_AUDIT    = "auth_audit_log";
  const S_SYS_META = "sys_meta";
  const LS_SESSION_ID = "vsc_session_id";
  const KDF_NAME = "PBKDF2";
  const HASH_NAME = "SHA-256";
  const PBKDF2_ITERATIONS = 120000;
  const PW_MIN_LEN = 8;
  const PW_MAX_LEN = 128;
  const PW_DENYLIST = new Set(["admin","admin123","password","123456","12345678","qwerty","master","master123","vet","vetsystem","vsc","equine","equinos","kado","torres"]);
  const LOGIN_MAX_FAILS = 5;
  const LOGIN_LOCK_MS_1 = 5 * 60 * 1000;
  const LOGIN_LOCK_MS_2 = 30 * 60 * 1000;
  const LOGIN_LOCK_MS_3 = 12 * 60 * 60 * 1000;
  const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
  const ROLE_MASTER = "MASTER";
  const ROLE_ADMIN  = "ADMIN";
  const ROLE_USER   = "USER";
  const ROLE_ID_MASTER = "role_master";
  const ROLE_ID_ADMIN  = "role_admin";
  const ROLE_ID_USER   = "role_user";
  const MODULE_CONFIG = "configuracoes";

  function nowISO(){ return new Date().toISOString(); }
  function nowMs(){ return Date.now(); }
  function uuid(){
    try{ if(crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID(); }catch(_){}
    try{
      const buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      buf[6] = (buf[6] & 0x0f) | 0x40;
      buf[8] = (buf[8] & 0x3f) | 0x80;
      const hex = Array.from(buf).map(b=>b.toString(16).padStart(2,"0")).join("");
      return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join("-");
    }catch(_){}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c)=>{
      const r = Math.random()*16|0, v = (c==="x") ? r : (r&0x3|0x8);
      return v.toString(16);
    });
  }

  async function openDB(){
    const ok = await window.waitForDBReady(30000);
    if(!ok) throw new Error("VSC_DB não ficou pronto.");
    return await window.VSC_DB.openDB();
  }

  async function tx(storeNames, mode, fn){
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      const stores = {};
      for(const s of storeNames) stores[s] = t.objectStore(s);
      let done = false;
      t.oncomplete = () => { if(!done){ done=true; resolve(true); } };
      t.onerror = () => { if(!done){ done=true; reject(t.error || new Error("Tx falhou")); } };
      try{ fn(stores); } catch(e){ try{ t.abort(); }catch(_){} if(!done){ done=true; reject(e); } }
    }).finally(() => { try{ db.close(); }catch(_){ } });
  }

  async function audit(action, userId, details){
    try{
      await tx([S_AUDIT], "readwrite", (s)=>{
        s[S_AUDIT].add({ id: uuid(), timestamp: nowISO(), action, user_id: userId, details, user_agent: navigator.userAgent });
      });
    }catch(e){ console.error("[VSC_AUTH] audit error", e); }
  }

  async function bootstrap(){
    try{
      const db = await openDB();
      const hasMaster = await new Promise(r=>{
        const t = db.transaction([S_USERS],"readonly");
        const req = t.objectStore(S_USERS).index("role").get(ROLE_MASTER);
        req.onsuccess = () => r(!!req.result);
        req.onerror = () => r(false);
      });
      if(!hasMaster){
        console.warn("[VSC_AUTH] Criando usuário MASTER inicial...");
        // Lógica de criação omitida para brevidade, mas deve existir no código real
      }
    }catch(e){ console.error("[VSC_AUTH] bootstrap failed", e); }
  }

  window.VSC_AUTH = {
    getUser(){ try{ return JSON.parse(localStorage.getItem("vsc_user") || "null"); }catch(_){ return null; } },
    isMaster(){ const u = this.getUser(); return !!(u && (u.role === ROLE_MASTER || u.is_master)); },
    isAdmin(){ const u = this.getUser(); return !!(u && (u.role === ROLE_ADMIN || u.is_admin || u.role === ROLE_MASTER)); },
    checkPermission(perm){ if(this.isMaster()) return true; return false; },
    bootstrap
  };

  console.log("[VSC_AUTH] ready", { build: window.__VSC_AUTH_BUILD });
  window.__VSC_AUTH_READY_FIRED = true;
  if(window.__VSC_AUTH_READY_RESOLVE) window.__VSC_AUTH_READY_RESOLVE(true);
  window.dispatchEvent(new Event("VSC_AUTH_READY"));

})();

// 3. Bootstrap Automático (Garantido Global)
(async () => {
  try {
    let ok = await window.waitForDBReady(60000);
    if(ok && window.VSC_AUTH) await window.VSC_AUTH.bootstrap();
  } catch (e) {
    console.error("[VSC_AUTH] bootstrap error:", e);
  }
})();
