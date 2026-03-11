/* ============================================================
   VSC_LOGIN — Módulo de Login (Offline-First)
   v2.1 — UI Integrity & Async Sincrony
   ============================================================ */

(async () => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  async function init() {
    console.log("[VSC_LOGIN] Inicializando módulo de login...");

    try {
      // 1. Aguarda Prontidão do Banco e Autenticação
      if (!window.VSC_DB || !window.__VSC_DB_READY_FIRED) {
        await new Promise(resolve => window.addEventListener("VSC_DB_READY", resolve));
      }
      if (!window.VSC_AUTH || !window.__VSC_AUTH_READY_FIRED) {
        await new Promise(resolve => window.addEventListener("VSC_AUTH_READY", resolve));
      }

      // 2. Carrega usuários para o dropdown
      await loadUsersForDropdown();

      // 3. Adiciona listeners de evento
      const btnLogin = $("btnLogin");
      if (btnLogin) {
        btnLogin.addEventListener("click", handleLogin);
      } else {
        console.error("[VSC_LOGIN] Botão 'btnLogin' não encontrado no DOM.");
      }

      const usernameSelect = $("username");
      if (usernameSelect) {
        usernameSelect.addEventListener("change", () => {
          const passwordInput = $("password");
          if (passwordInput) passwordInput.value = "";
          displayError("");
        });
      }

      console.log("[VSC_LOGIN] Módulo de login pronto.");
      
      // Mostra o card de login (se estiver escondido por JS)
      document.documentElement.style.visibility = "visible";
      displayError("");
    } catch (e) {
      console.error("[VSC_LOGIN] Erro fatal na inicialização:", e);
      displayError("Erro fatal na inicialização do sistema.");
    }
  }

  async function loadUsersForDropdown() {
    if (!window.VSC_AUTH || typeof window.VSC_AUTH.listLoginUsers !== "function") return;

    try {
      // GARANTIA: listLoginUsers retorna um Array real.
      const users = await window.VSC_AUTH.listLoginUsers();
      const select = $("username");
      if (select) {
        select.innerHTML = "<option value=\"\">Selecione...</option>";
        if (Array.isArray(users)) {
          users.forEach(user => {
            const option = document.createElement("option");
            option.value = user.username;
            option.textContent = `${user.username} (${user.role})`;
            select.appendChild(option);
          });
        }
      }
    } catch (e) {
      console.error("[VSC_LOGIN] Erro ao carregar usuários:", e);
      displayError("Falha ao carregar usuários.");
    }
  }

  async function handleLogin(event) {
    if (event) event.preventDefault();
    
    const usernameSelect = $("username");
    const passwordInput = $("password");
    
    if (!usernameSelect || !passwordInput) {
      displayError("Erro técnico: Elementos do formulário não encontrados.");
      return;
    }

    const username = usernameSelect.value;
    const password = passwordInput.value;

    if (!username || !password) {
      displayError("Por favor, preencha usuário e senha.");
      return;
    }

    try {
      displayError("Autenticando...");
      const result = await window.VSC_AUTH.login(username, password);
      if (result && result.ok) {
        const nextUrl = new URLSearchParams(window.location.search).get("next") || "/dashboard.html";
        window.location.href = nextUrl;
      } else {
        displayError(result ? result.error : "Falha no login.");
      }
    } catch (e) {
      console.error("[VSC_LOGIN] Erro no login:", e);
      displayError("Erro interno no login.");
    }
  }

  function displayError(message) {
    const errorDiv = $("loginStatus");
    if (errorDiv) {
      errorDiv.textContent = message || "Pronto.";
      errorDiv.className = message ? "status error" : "status info";
      errorDiv.style.display = "block";
    }
  }

  // Executa inicialização
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
