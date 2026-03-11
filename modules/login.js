/* ============================================================
   VSC_LOGIN — Módulo de Login (Offline-First)
   ============================================================ */

(async () => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  async function init() {
    console.log("[VSC_LOGIN] Inicializando módulo de login...");

    if (!window.VSC_AUTH || !window.__VSC_AUTH_READY_FIRED) {
      await new Promise(resolve => window.addEventListener("VSC_AUTH_READY", resolve));
    }

    if (!window.VSC_DB || !window.__VSC_DB_READY_FIRED) {
      await new Promise(resolve => window.addEventListener("VSC_DB_READY", resolve));
    }

    // Auto-seed para garantir acesso
    if (window.VSC_AUTH && typeof window.VSC_AUTH.devResetBootstrapUsers === "function") {
      try {
        await window.VSC_AUTH.devResetBootstrapUsers();
      } catch (e) {
        console.error("[VSC_LOGIN] Erro ao executar devResetBootstrapUsers:", e);
      }
    }

    await loadUsersForDropdown();

    $("loginForm").addEventListener("submit", handleLogin);
    $("usernameSelect").addEventListener("change", () => {
      $("passwordInput").value = "";
      displayError("");
    });

    console.log("[VSC_LOGIN] Módulo de login pronto.");
  }

  async function loadUsersForDropdown() {
    if (!window.VSC_AUTH || typeof window.VSC_AUTH.listLoginUsers !== "function") return;

    try {
      const users = await window.VSC_AUTH.listLoginUsers();
      const select = $("usernameSelect");
      select.innerHTML = "<option value=\"\">Selecione...</option>";
      users.forEach(user => {
        const option = document.createElement("option");
        option.value = user.username;
        option.textContent = `${user.username} (${user.role})`;
        select.appendChild(option);
      });
    } catch (e) {
      console.error("[VSC_LOGIN] Erro ao carregar usuários:", e);
      displayError("Falha ao carregar usuários.");
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    const username = $("usernameSelect").value;
    const password = $("passwordInput").value;

    if (!username || !password) {
      displayError("Por favor, preencha usuário e senha.");
      return;
    }

    try {
      const { ok, error } = await window.VSC_AUTH.login(username, password);
      if (ok) {
        const nextUrl = new URLSearchParams(window.location.search).get("next") || "/dashboard.html";
        window.location.href = nextUrl;
      } else {
        displayError(error || "Falha no login.");
      }
    } catch (e) {
      console.error("[VSC_LOGIN] Erro no login:", e);
      displayError("Erro interno no login.");
    }
  }

  function displayError(message) {
    const errorDiv = $("loginError");
    if (errorDiv) {
      errorDiv.textContent = message;
      errorDiv.style.display = message ? "block" : "none";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
