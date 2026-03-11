/* ============================================================
   VSC_AUTH — RBAC enterprise + Sessão + Auditoria (offline-first)
   ============================================================ */

// 1. Definições Globais de Auxílio (Garantia de Escopo e Sincronização Atômica)
window.waitForDBReady = async function(timeoutMs = 30000) {
  const start = Date.now();
  while (true) {
    if (window.VSC_DB && window.__VSC_DB_READY_FIRED === true) {
      return true;
    }
    if (Date.now() - start >= timeoutMs) {
      console.warn("[VSC_AUTH] waitForDBReady: Timeout atingido.");
      return false;
    }
    await new Promise(r => setTimeout(r, 50));
  }
};

(async () => {
  "use strict";

  const S_USERS    = "auth_users";
  const S_SESSIONS = "auth_sessions";
  const S_AUDIT    = "auth_audit_log";
  const S_ROLES    = "auth_roles";
  const ROLE_MASTER = "MASTER";
  const ROLE_ADMIN  = "ADMIN";

  let _currentUser = null;

  async function openDB() {
    if (!window.VSC_DB || typeof window.VSC_DB.openDB !== "function") {
      await window.waitForDBReady();
      if (!window.VSC_DB || typeof window.VSC_DB.openDB !== "function") {
        throw new Error("VSC_DB não pronto.");
      }
    }
    return await window.VSC_DB.openDB();
  }

  async function audit(action, userId, details) {
    try {
      const db = await openDB();
      const t = db.transaction([S_AUDIT], "readwrite");
      t.objectStore(S_AUDIT).add({
        id: window.VSC_UTILS ? window.VSC_UTILS.uuidv4() : Date.now().toString(),
        when: new Date().toISOString(),
        event: action,
        user_id: userId,
        details: details
      });
      await t.oncomplete;
    } catch (e) { console.error("[VSC_AUTH] audit error", e); }
  }

  const VSC_AUTH_API = {
    async bootstrap() {
      console.log("[VSC_AUTH] Iniciando bootstrap...");
      if (!await window.waitForDBReady()) {
        throw new Error("VSC_DB não pronto para autenticação.");
      }

      try {
        const db = await openDB();
        const tx = db.transaction([S_USERS, S_ROLES, S_SESSIONS], "readwrite");
        const userStore = tx.objectStore(S_USERS);
        const roleStore = tx.objectStore(S_ROLES);

        let masterRole = await roleStore.index("name").get(ROLE_MASTER);
        if (!masterRole) {
          masterRole = { id: "role_master", name: ROLE_MASTER, created_at: new Date().toISOString() };
          await roleStore.add(masterRole);
        }
        let adminRole = await roleStore.index("name").get(ROLE_ADMIN);
        if (!adminRole) {
          adminRole = { id: "role_admin", name: ROLE_ADMIN, created_at: new Date().toISOString() };
          await roleStore.add(adminRole);
        }

        const host = String(location.hostname||"").toLowerCase();
        const isLocal = (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.includes("127.0.0.1"));
        if (isLocal) {
          await VSC_AUTH_API.devResetBootstrapUsers();
        }

        const sid = localStorage.getItem("vsc_session_id");
        if (sid) {
          const sess = await tx.objectStore(S_SESSIONS).get(sid);
          if (sess && sess.status === "ACTIVE" && new Date(sess.expires_at) > new Date()) {
            const user = await tx.objectStore(S_USERS).get(sess.user_id);
            if (user) {
              _currentUser = user;
              localStorage.setItem("vsc_user", JSON.stringify(user));
            }
          }
        }
        await tx.oncomplete;
      } catch (e) {
        console.error("[VSC_AUTH] Erro no bootstrap:", e);
      }
    },

    async login(username, password) {
      const db = await openDB();
      const tx = db.transaction([S_USERS, S_SESSIONS], "readwrite");
      const userStore = tx.objectStore(S_USERS);
      
      const user = await userStore.index("username").get(username.toLowerCase());

      if (!user || user.password !== password) {
        await audit("LOGIN_FAIL", username, { reason: "Invalid credentials" });
        return { ok: false, error: "Usuário ou senha inválidos." };
      }

      const sid = window.VSC_UTILS ? window.VSC_UTILS.uuidv4() : Date.now().toString();
      const expiresAt = new Date(Date.now() + (1000 * 60 * 60 * 24)).toISOString();
      await tx.objectStore(S_SESSIONS).add({
        id: sid,
        user_id: user.id,
        status: "ACTIVE",
        created_at: new Date().toISOString(),
        expires_at: expiresAt
      });

      _currentUser = user;
      localStorage.setItem("vsc_session_id", sid);
      localStorage.setItem("vsc_user", JSON.stringify(user));
      await audit("LOGIN_SUCCESS", user.id, { username: user.username });
      await tx.oncomplete;
      
      return { ok: true, user };
    },

    async logout() {
      const sid = localStorage.getItem("vsc_session_id");
      if (sid) {
        const db = await openDB();
        const tx = db.transaction([S_SESSIONS], "readwrite");
        const sess = await tx.objectStore(S_SESSIONS).get(sid);
        if (sess) {
          sess.status = "REVOKED";
          sess.revoked_at = new Date().toISOString();
          await tx.objectStore(S_SESSIONS).put(sess);
        }
        await tx.oncomplete;
      }
      _currentUser = null;
      localStorage.removeItem("vsc_session_id");
      localStorage.removeItem("vsc_user");
      location.href = "/login.html";
    },

    getCurrentUser() {
      if (_currentUser) return _currentUser;
      const u = localStorage.getItem("vsc_user");
      return u ? JSON.parse(u) : null;
    },

    getUser() { return this.getCurrentUser(); },
    
    async listUsers() {
      const db = await openDB();
      const tx = db.transaction([S_USERS], "readonly");
      return await tx.objectStore(S_USERS).getAll();
    },

    async listLoginUsers() {
      const users = await this.listUsers();
      return users.map(u => ({ username: u.username, role: u.role }));
    },

    isMaster() {
      const u = this.getCurrentUser(); 
      return !!(u && (u.role === ROLE_MASTER || u.role_id === "role_master")); 
    },
    
    isAdmin() {
      const u = this.getCurrentUser(); 
      return !!(u && (u.role === ROLE_ADMIN || u.role === ROLE_MASTER || u.role_id === "role_admin" || u.role_id === "role_master")); 
    },

    async devResetBootstrapUsers() {
      const db = await openDB();
      const tx = db.transaction([S_USERS, S_ROLES], "readwrite");
      const userStore = tx.objectStore(S_USERS);
      const roleStore = tx.objectStore(S_ROLES);

      // Senhas fixas para facilitar o primeiro acesso em DEV
      const masterPass = "master123";
      const adminPass  = "admin123";

      let masterRole = await roleStore.index("name").get(ROLE_MASTER);
      if (!masterRole) {
        masterRole = { id: "role_master", name: ROLE_MASTER, created_at: new Date().toISOString() };
        await roleStore.add(masterRole);
      }
      let adminRole = await roleStore.index("name").get(ROLE_ADMIN);
      if (!adminRole) {
        adminRole = { id: "role_admin", name: ROLE_ADMIN, created_at: new Date().toISOString() };
        await roleStore.add(adminRole);
      }

      // Upsert Master
      let masterUser = await userStore.index("username").get("master");
      if (masterUser) {
        masterUser.password = masterPass;
        masterUser.role_id = masterRole.id;
        masterUser.role = ROLE_MASTER;
        await userStore.put(masterUser);
      } else {
        await userStore.add({
          id: "user_master",
          username: "master",
          password: masterPass,
          role_id: masterRole.id,
          role: ROLE_MASTER,
          status: "ACTIVE",
          created_at: new Date().toISOString()
        });
      }

      // Upsert Admin
      let adminUser = await userStore.index("username").get("admin");
      if (adminUser) {
        adminUser.password = adminPass;
        adminUser.role_id = adminRole.id;
        adminUser.role = ROLE_ADMIN;
        await userStore.put(adminUser);
      } else {
        await userStore.add({
          id: "user_admin",
          username: "admin",
          password: adminPass,
          role_id: adminRole.id,
          role: ROLE_ADMIN,
          status: "ACTIVE",
          created_at: new Date().toISOString()
        });
      }

      await tx.oncomplete;
      console.warn("[VSC_AUTH] (DEV) Usuários resetados: master / master123 | admin / admin123");
    }
  };

  window.VSC_AUTH = VSC_AUTH_API;
  window.__VSC_AUTH_READY_FIRED = true;
  window.dispatchEvent(new Event("VSC_AUTH_READY"));
  VSC_AUTH_API.bootstrap();
})();
