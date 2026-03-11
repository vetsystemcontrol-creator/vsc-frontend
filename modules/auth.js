/* ============================================================
   VSC_AUTH — RBAC Enterprise + Sessão (Offline-First)
   v3.2 — Data Integrity & Async Sincrony
   ============================================================ */

(function() {
  "use strict";

  const S_USERS    = "auth_users";
  const S_SESSIONS = "auth_sessions";
  const S_ROLES    = "auth_roles";
  const ROLE_MASTER = "MASTER";
  const ROLE_ADMIN  = "ADMIN";

  let _currentUser = null;

  const VSC_AUTH_API = {
    /**
     * Inicializa o módulo, aguardando o banco e configurando usuários DEV.
     */
    async bootstrap() {
      console.log("[VSC_AUTH] Iniciando bootstrap...");
      try {
        if (!window.VSC_DB || !window.__VSC_DB_READY_FIRED) {
          await new Promise(resolve => window.addEventListener("VSC_DB_READY", resolve));
        }

        // Auto-seed em ambiente local
        const host = String(location.hostname||"").toLowerCase();
        const isLocal = (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.includes("127.0.0.1"));
        if (isLocal) {
          await this.devResetBootstrapUsers();
        }

        // Tenta restaurar sessão
        const sid = localStorage.getItem("vsc_session_id");
        if (sid) {
          const sess = await window.VSC_DB.get(S_SESSIONS, sid);
          if (sess && sess.status === "ACTIVE" && new Date(sess.expires_at) > new Date()) {
            const user = await window.VSC_DB.get(S_USERS, sess.user_id);
            if (user) {
              _currentUser = user;
              localStorage.setItem("vsc_user", JSON.stringify(user));
            }
          }
        }
        console.log("[VSC_AUTH] Bootstrap concluído.");
      } catch (e) {
        console.error("[VSC_AUTH] Erro no bootstrap:", e);
      }
    },

    /**
     * Retorna a lista de usuários formatada para o login.
     * GARANTIA: Sempre retorna um Array real (não uma Promise pendente).
     */
    async listLoginUsers() {
      try {
        if (!window.VSC_DB || !window.__VSC_DB_READY_FIRED) {
          await new Promise(resolve => window.addEventListener("VSC_DB_READY", resolve));
        }
        const users = await window.VSC_DB.getAll(S_USERS);
        return (users || []).map(u => ({ username: u.username, role: u.role }));
      } catch (e) {
        console.error("[VSC_AUTH] Erro ao listar usuários:", e);
        return [];
      }
    },

    async login(username, password) {
      try {
        const user = await window.VSC_DB.getByIndex(S_USERS, "username", username.toLowerCase());

        if (!user || user.password !== password) {
          return { ok: false, error: "Usuário ou senha inválidos." };
        }

        const sid = "sess_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
        const expiresAt = new Date(Date.now() + (1000 * 60 * 60 * 24)).toISOString();
        
        await window.VSC_DB.add(S_SESSIONS, {
          id: sid,
          user_id: user.id,
          status: "ACTIVE",
          created_at: new Date().toISOString(),
          expires_at: expiresAt
        });

        _currentUser = user;
        localStorage.setItem("vsc_session_id", sid);
        localStorage.setItem("vsc_user", JSON.stringify(user));
        
        return { ok: true, user };
      } catch (e) {
        console.error("[VSC_AUTH] Erro no login:", e);
        return { ok: false, error: "Erro interno no sistema de autenticação." };
      }
    },

    getUser() {
      if (_currentUser) return _currentUser;
      const u = localStorage.getItem("vsc_user");
      return u ? JSON.parse(u) : null;
    },

    isMaster() {
      const u = this.getUser();
      return !!(u && (u.role === ROLE_MASTER || u.role_id === "role_master"));
    },

    async devResetBootstrapUsers() {
      try {
        const masterPass = "master123";
        const adminPass  = "admin123";

        // Upsert Roles
        await window.VSC_DB.put(S_ROLES, { id: "role_master", name: ROLE_MASTER, created_at: new Date().toISOString() });
        await window.VSC_DB.put(S_ROLES, { id: "role_admin", name: ROLE_ADMIN, created_at: new Date().toISOString() });

        // Upsert Users
        const masterUser = await window.VSC_DB.getByIndex(S_USERS, "username", "master");
        if (!masterUser) {
          await window.VSC_DB.add(S_USERS, {
            id: "user_master",
            username: "master",
            password: masterPass,
            role_id: "role_master",
            role: ROLE_MASTER,
            status: "ACTIVE",
            created_at: new Date().toISOString()
          });
        }

        const adminUser = await window.VSC_DB.getByIndex(S_USERS, "username", "admin");
        if (!adminUser) {
          await window.VSC_DB.add(S_USERS, {
            id: "user_admin",
            username: "admin",
            password: adminPass,
            role_id: "role_admin",
            role: ROLE_ADMIN,
            status: "ACTIVE",
            created_at: new Date().toISOString()
          });
        }
        console.warn("[VSC_AUTH] (DEV) master/master123 | admin/admin123");
      } catch (e) {
        console.error("[VSC_AUTH] Erro no devReset:", e);
      }
    }
  };

  window.VSC_AUTH = VSC_AUTH_API;
  window.__VSC_AUTH_READY_FIRED = true;
  window.dispatchEvent(new Event("VSC_AUTH_READY"));
  VSC_AUTH_API.bootstrap();
})();
