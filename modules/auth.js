/* ============================================================
   VSC_AUTH — RBAC enterprise + Sessão + Auditoria (offline-first)
   Base (boas práticas):
   - RBAC (roles -> permissions) + fail-closed
   - Senha: PBKDF2 (WebCrypto) com salt e iterations
   - Sessão: token aleatório, expiração, multi-aba via localStorage
   - Auditoria: auth_audit_log (login ok/fail, logout, change pass etc.)
   ============================================================ */
(() => {
  "use strict";

  window.__VSC_AUTH_BUILD = "ERP2.0.1|auth.js|RBAC|2026-02-23|BOOTSTRAP_WAIT_DB";

  // ============================================================
  // ESOS 5.3 — AUTH READY (Promise + evento) — anti-race
  // - Consumidores (auth_guard/login/etc) podem aguardar window.__VSC_AUTH_READY
  // - READY só dispara após window.VSC_AUTH ser publicado.
  // ============================================================
  try{
    if(!window.__VSC_AUTH_READY || typeof window.__VSC_AUTH_READY.then !== "function"){
      window.__VSC_AUTH_READY_FIRED = false;
      window.__VSC_AUTH_READY_RESOLVE = null;
      window.__VSC_AUTH_READY = new Promise((resolve)=>{ window.__VSC_AUTH_READY_RESOLVE = resolve; });
    }
  }catch(_){ }

  // Stores (já criadas no vsc_db v23)
  const S_USERS    = "auth_users";
  const S_ROLES    = "auth_roles";
  const S_PERMS    = "auth_role_permissions";
  const S_SESSIONS = "auth_sessions";
  const S_AUDIT    = "auth_audit_log";

  // Sistema/meta (existente no vsc_db)
  const S_SYS_META = "sys_meta";

  // Sessão em multi-aba
  const LS_SESSION_ID = "vsc_session_id";

  // KDF: PBKDF2 (WebCrypto)
  const KDF_NAME = "PBKDF2";
  const HASH_NAME = "SHA-256";

  // Iterações: valor seguro e realista p/ browser (pode ajustar depois)
  const PBKDF2_ITERATIONS = 120000;


// ============================================================
// Password Policy (NIST 800-63B + OWASP) — offline-first
// - mínimo 8 chars, máximo 128 (suporte a passphrases)
// - sem regras de composição obrigatória
// - bloqueio de senhas comuns/esperadas (denylist local)
// - lockout/rate-limit por tentativas falhas (anti-bruteforce)
// ============================================================
const PW_MIN_LEN = 8;
const PW_MAX_LEN = 128;

// Denylist mínima local (pode expandir via Config futuramente)
// NOTE: "Master@1234" é permitida por ordem do dono do sistema (ambiente interno).
const PW_DENYLIST = new Set([
  "admin","admin123","password","123456","12345678","qwerty",
  "master","master123","vet","vetsystem","vsc",
  "equine","equinos","kado","torres"
]);

// Anti-bruteforce (OWASP): lock progressivo por usuário
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS_1 = 5 * 60 * 1000;   // 5 min
const LOGIN_LOCK_MS_2 = 30 * 60 * 1000;  // 30 min
const LOGIN_LOCK_MS_3 = 12 * 60 * 60 * 1000; // 12 h

function pwNormalize(pw){
  // NIST: permitir espaços e caracteres imprimíveis; aqui só normaliza whitespace externo
  return String(pw||"").trim();
}

function pwIsWeak(pw){
  const p = pwNormalize(pw);
  if(p.length < PW_MIN_LEN) return "Senha muito curta (mín. " + PW_MIN_LEN + ").";
  if(p.length > PW_MAX_LEN) return "Senha muito longa (máx. " + PW_MAX_LEN + ").";
  const low = p.toLowerCase();
  if(PW_DENYLIST.has(p) || PW_DENYLIST.has(low)) return "Senha fraca/banida (muito comum).";
  return null;
}

function calcLockMs(fails){
  const n = Number(fails||0) || 0;
  if(n < LOGIN_MAX_FAILS) return 0;
  if(n === LOGIN_MAX_FAILS) return LOGIN_LOCK_MS_1;
  if(n === LOGIN_MAX_FAILS + 1) return LOGIN_LOCK_MS_2;
  return LOGIN_LOCK_MS_3;
}

  // Expiração da sessão
  const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h

  // Roles canônicas
  const ROLE_MASTER = "MASTER";
  const ROLE_ADMIN  = "ADMIN";
  const ROLE_USER   = "USER";

  // IDs fixos (facilita bootstrap e perm lookup)
  const ROLE_ID_MASTER = "role_master";
  const ROLE_ID_ADMIN  = "role_admin";
  const ROLE_ID_USER   = "role_user";

  // Permissões por módulo (mínimo enterprise)
  // module: "configuracoes" -> { view/edit/admin }
  // MASTER ignora e sempre permite.
  const MODULE_CONFIG = "configuracoes";

  function nowISO(){ return new Date().toISOString(); }
  function nowMs(){ return Date.now(); }

  function uuid(){
    try{ if(crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID(); }catch(_){}
    // fallback não-cripto (último recurso). Ideal: crypto.randomUUID().
try{
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = Array.from(buf).map(b=>b.toString(16).padStart(2,"0")).join("");
  return [
    hex.slice(0,8),
    hex.slice(8,12),
    hex.slice(12,16),
    hex.slice(16,20),
    hex.slice(20)
  ].join("-");
}catch(_){}
return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c)=>{
  const r = Math.random()*16|0, v = (c==="x") ? r : (r&0x3|0x8);
  return v.toString(16);
});
  }

  function $(id){ return document.getElementById(id); }

  function b64Encode(bytes){
    let bin = "";
    const arr = new Uint8Array(bytes);
    for(let i=0;i<arr.length;i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  function b64Decode(b64){
    const bin = atob(String(b64||""));
    const out = new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function ctEqual(aBytes, bBytes){
    // constant-time-ish compare (JS best-effort)
    const a = (aBytes instanceof Uint8Array) ? aBytes : new Uint8Array(aBytes||[]);
    const b = (bBytes instanceof Uint8Array) ? bBytes : new Uint8Array(bBytes||[]);
    if(a.length !== b.length) return false;
    let diff = 0;
    for(let i=0;i<a.length;i++) diff |= (a[i] ^ b[i]);
    return diff === 0;
  }

  // ============================================================
// HARDENING — Ordem de carregamento determinística (anti-race)
// Problema observado: auth.js pode iniciar bootstrap antes de vsc_db.js
// expor window.VSC_DB.openDB (corrida em alguns loads/caches).
// Solução enterprise: aguardar dependência com timeout (fail-closed com log).
// ============================================================
async function waitForVSC_DBOpenDB(timeoutMs){
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
}

// ============================================================
// ESOS 5.2 — DB READY (event/promise) — anti-timeout
// Preferir aguardar o sinal de pronto do vsc_db.js:
// window.__VSC_DB_READY (Promise) ou evento "VSC_DB_READY".
// ============================================================
async function waitForDBReady(timeoutMs){
  const timeout = Number(timeoutMs||30000);
  const start = Date.now();

  // Se houver Promise global, aguarda (com timeout)
  try{
    if(window.__VSC_DB_READY && typeof window.__VSC_DB_READY.then === "function"){
      const race = await Promise.race([
        window.__VSC_DB_READY,
        new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")), timeout))
      ]);
      if(race === true || race === undefined) return true;
    }
  }catch(_){}

  // Fallback: polling + evento
  let done = false;
  function mark(){ done = true; }
  try{ window.addEventListener("VSC_DB_READY", mark, { once:true }); }catch(_){}

  while(true){
    try{
      if(window.VSC_DB && typeof window.VSC_DB.openDB === "function"){
        // openDB exposta -> considera OK (mas ainda pode estar abrindo internamente)
        // o evento/promise cobre o "pronto".
        if(window.__VSC_DB_READY_FIRED === true) return true;
      }
    }catch(_){}
    if(done) return true;
    if(Date.now() - start >= timeout) return false;
    await new Promise(r=>setTimeout(r, 50));
  }
}


// ============================================================
// COMPAT ALIASES (anti-regressão)
// JavaScript é case-sensitive; qualquer divergência de caixa no
// nome da função quebra o bootstrap (ReferenceError).
// Mantemos aliases para tolerar variações antigas/typos sem
// reintroduzir corrida/timeout.
// ============================================================
function waitforVSC_DBopenDB(timeoutMs){ return waitForVSC_DBOpenDB(timeoutMs); }
function waitforVSC_DBOpenDB(timeoutMs){ return waitForVSC_DBOpenDB(timeoutMs); }
function waitForVSC_DBopenDB(timeoutMs){ return waitForVSC_DBOpenDB(timeoutMs); }

async function openDB(){
  const ok = await waitForDBReady(30000);
  if(!ok){
    throw new Error("VSC_DB não ficou pronto após timeout (VSC_DB_READY).");
  }
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
      t.onabort = () => { if(!done){ done=true; reject(t.error || new Error("Tx abortada")); } };

      try{ fn(stores); }
      catch(e){
        try{ t.abort(); }catch(_){}
        if(!done){ done=true; reject(e); }
      }
    }).finally(() => { try{ db.close(); }catch(_){ } });
  }

  async function kdfPbkdf2(password, saltBytes, iterations){
    if(!crypto || !crypto.subtle) throw new Error("WebCrypto indisponível (crypto.subtle).");

    const enc = new TextEncoder();
    const pwKey = await crypto.subtle.importKey(
      "raw",
      enc.encode(String(password||"")),
      { name: KDF_NAME },
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: KDF_NAME,
        salt: saltBytes,
        iterations: iterations,
        hash: HASH_NAME
      },
      pwKey,
      256 // 32 bytes
    );
    return new Uint8Array(bits);
  }

  function randomBytes(n){
    const u = new Uint8Array(n);
    crypto.getRandomValues(u);
    return u;
  }

  async function audit(event, user_id, detail){
    const rec = {
      id: uuid(),
      when: nowISO(),
      event: String(event||""),
      user_id: user_id || null,
      detail: detail ? String(detail) : null
    };
    await tx([S_AUDIT], "readwrite", (s) => {
      s[S_AUDIT].add(rec);
    });
    return rec.id;
  }

  function roleRank(roleName){
    // ranking simples p/ check >= ADMIN etc.
    const r = String(roleName||"").toUpperCase();
    if(r === ROLE_MASTER) return 3;
    if(r === ROLE_ADMIN) return 2;
    if(r === ROLE_USER) return 1;
    return 0;
  }

  // [continua na PARTE 2/4]
  async function ensureRoles(){
    await tx([S_ROLES], "readwrite", (s) => {
      const st = s[S_ROLES];

      st.put({ id: ROLE_ID_MASTER, name: ROLE_MASTER, updated_at: nowISO() });
      st.put({ id: ROLE_ID_ADMIN,  name: ROLE_ADMIN,  updated_at: nowISO() });
      st.put({ id: ROLE_ID_USER,   name: ROLE_USER,   updated_at: nowISO() });
    });
  }

  async function ensureDefaultPermissions(){
    await tx([S_PERMS], "readwrite", (s) => {
      const st = s[S_PERMS];

      // MASTER → acesso total (não precisa perm específica)

      // ADMIN → pode acessar Configurações (edit)
      st.put({
        id: "perm_admin_config",
        role_id: ROLE_ID_ADMIN,
        module: MODULE_CONFIG,
        can_view: true,
        can_edit: true,
        updated_at: nowISO()
      });

      // USER → somente visualização
      st.put({
        id: "perm_user_config",
        role_id: ROLE_ID_USER,
        module: MODULE_CONFIG,
        can_view: true,
        can_edit: false,
        updated_at: nowISO()
      });
    });
  }

  async function countUsers(){
    const db = await openDB();
    try{
      return await new Promise((resolve, reject) => {
        const tx0 = db.transaction([S_USERS], "readonly");
        const rq = tx0.objectStore(S_USERS).count();
        rq.onsuccess = () => resolve(rq.result || 0);
        rq.onerror = () => reject(rq.error);
      });
    } finally { try{ db.close(); }catch(_){ } }
  }

  async function createUser(username, password, role_id, opts){
if(!username || !password) throw new Error("createUser: username/password obrigatórios");
opts = opts || {};
const forceChange = (opts.force_change_password === true);
const status = opts.status ? String(opts.status) : "ACTIVE";

const weakMsg = pwIsWeak(password);
if(weakMsg) throw new Error(weakMsg);

    const salt = randomBytes(16);
    const hash = await kdfPbkdf2(password, salt, PBKDF2_ITERATIONS);

    const rec = {
      id: uuid(),
      username: String(username).trim(),
      role_id: role_id,
      status: status,
      password_hash: b64Encode(hash),
      password_salt: b64Encode(salt),
      password_iter: PBKDF2_ITERATIONS,
      force_change_password: forceChange,
      failed_attempts: 0,
      lock_until: null,
      last_login_at: null,
      last_failed_at: null,
      created_at: nowISO(),      professional: {
        is_vet: false,
        full_name: "",
        crmv_uf: "",
        crmv_num: "",
        phone: "",
        email: "",
        signature_image_dataurl: null,
        icp_enabled: false,
        updated_at: nowISO()
      },

      updated_at: nowISO()
    };

    await tx([S_USERS], "readwrite", (s) => {
      s[S_USERS].add(rec);
    });

    await audit("USER_CREATE", rec.id, rec.username);

    return rec.id;
  }

  


async function reconcileLegacyUsers(){
  // Reconciliar usuários de stores antigas para auth_users.
  // Objetivo: migrar dados sem criar "usuários fantasmas".
  // Regra: só considera store legado se existir pelo menos 1 linha com campo de username.
  const META_KEY = "auth_legacy_reconciled_v3";

  const db = await openDB();
  try{
    const names = Array.from(db.objectStoreNames || []);

    // Nunca tratar stores CANÔNICAS como legado
    const CANONICAL_BLOCKLIST = new Set([
      String(S_USERS),
      String(S_ROLES),
      String(S_ROLE_PERMS),
      String(S_SESSIONS),
      String(S_AUDIT),
      String(S_SYS_META),
      // Perfil profissional (não é store de usuários)
      "user_profiles"
    ]);

    // Candidatos legados (ordem importa). Evite nomes genéricos que batem com stores modernas.
    const CANDIDATES = [
      "usuarios_master","usuarios_v1","usuarios_v2","usuarios",
      "vsc_users","vsc_user","users_master","users_v1","users_v2","users",
      "auth_users_legacy"
    ].filter((n) => !CANONICAL_BLOCKLIST.has(String(n)));

    function pickUsername(row){
      if(!row) return "";
      const cand = row.username || row.user || row.user_name || row.login || row.usuario || row.nome_usuario;
      return (cand == null) ? "" : String(cand);
    }

    async function sampleStoreHasUserRows(storeName){
      if(!storeName) return false;
      if(CANONICAL_BLOCKLIST.has(String(storeName))) return false;
      if(names.indexOf(storeName) === -1) return false;

      try{
        return await new Promise((resolve) => {
          const tx0 = db.transaction([storeName], "readonly");
          const st = tx0.objectStore(storeName);
          const rq = st.openCursor();
          let seen = 0;
          rq.onerror = () => resolve(false);
          rq.onsuccess = () => {
            const cur = rq.result;
            if(!cur) return resolve(false);
            const v = cur.value;
            const u = pickUsername(v);
            if(u && String(u).trim()) return resolve(true);
            seen++;
            if(seen >= 12) return resolve(false);
            cur.continue();
          };
        });
      }catch(_){
        return false;
      }
    }

    // 1) tenta achar store legado válido
    let legacyStore = null;
    for(const n of CANDIDATES){
      if(await sampleStoreHasUserRows(n)) { legacyStore = n; break; }
    }

    // 2) fallback: tenta adivinhar por regex (mas valida)
    if(!legacyStore){
      const guess = names.find((n) => /(^|_)(users?|usuarios?)(_|$)/i.test(String(n||"")));
      if(guess && !CANONICAL_BLOCKLIST.has(String(guess))){
        if(await sampleStoreHasUserRows(String(guess))) legacyStore = Stri
(Content truncated due to size limit. Use line ranges to read remaining content)