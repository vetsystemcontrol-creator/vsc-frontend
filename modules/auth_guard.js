/* ============================================================
   VSC_AUTH_GUARD — Confiabilidade Máxima (SGQT 12.6)
   Objetivo:
   - Bloquear acesso ao dashboard sem sessão válida
   - Evitar loop infinito (login <-> dashboard)
   - Evitar tela branca (prehide)
   Compatibilidade:
   - auth.js expondo: window.VSC_AUTH (bootstrap/getCurrentUser)
   - opcional: window.__VSC_AUTH_READY (Promise) ou evento "VSC_AUTH_READY"
   ============================================================ */

// SGQT-Version: 12.6
// Module-Version: 1.0.1
// Change-Request: CR-2026-002
// Date: 2026-03-04T09:00:00-03:00
// Author: VSC (AI proposal)

(() => {
  "use strict";

  const BUILD = "SGQT12.6|auth_guard.js|MAX-RELIABILITY|2026-03-04";

  // Chave usada pelo auth.js / app para indicar sessão local
  const LS_SESSION_ID = "vsc_session_id";

  // Rotas canônicas (Cloudflare Pages com pretty URLs + fallback .html)
  const LOGIN_PATH = "/login";
  const DASH_PATH  = "/dashboard";
  const LOGIN_FILE = "/login.html";
  const DASH_FILE  = "/dashboard.html";

  // Anti-loop: impede redirecionar repetidamente em milissegundos
  const SS_GUARD_LOCK = "vsc_auth_guard_lock";
  const LOCK_MS = 1500;

  function path() {
    try { return String(location.pathname || ""); } catch (_) { return ""; }
  }

  function isLoginPage() {
    const p = path().toLowerCase();
    return p === "/login" || p.endsWith("/login/") || p.endsWith("/login.html");
  }

  function isDashboardPage() {
    const p = path().toLowerCase();
    return p === "/dashboard" || p.endsWith("/dashboard/") || p.endsWith("/dashboard.html");
  }

  function reveal() {
    try { document.documentElement.style.visibility = "visible"; } catch (_) {}
  }

  function setLock() {
    try { sessionStorage.setItem(SS_GUARD_LOCK, String(Date.now())); } catch (_) {}
  }

  function isLocked() {
    try {
      const v = Number(sessionStorage.getItem(SS_GUARD_LOCK) || "0");
      return v > 0 && (Date.now() - v) < LOCK_MS;
    } catch (_) {
      return false;
    }
  }

  function safeReplace(url) {
    setLock();
    try { location.replace(url); }
    catch (_) {
      try { location.href = url; } catch (__){ /* noop */ }
    }
  }

  function canonicalLoginUrl(nextHref) {
    const base = LOGIN_PATH || LOGIN_FILE;
    const next = nextHref || String(location.href || "");
    return base + "?next=" + encodeURIComponent(next);
  }

  function readNextParam() {
    try {
      const u = new URL(location.href);
      const raw = u.searchParams.get("next");
      if (!raw) return null;

      // Decodifica apenas uma vez (evita double-decode)
      let decoded = raw;
      try { decoded = decodeURIComponent(raw); } catch (_) {}

      // Aceita somente same-origin (ou relativo). Bloqueia apontar para /login.
      const nextUrl = new URL(decoded, location.origin);
      if (nextUrl.origin !== location.origin) return null;

      const np = String(nextUrl.pathname || "").toLowerCase();
      if (np === "/login" || np.endsWith("/login/") || np.endsWith("/login.html")) return null;

      return nextUrl.href;
    } catch (_) {
      return null;
    }
  }

  function waitFor(conditionFn, timeoutMs) {
    const timeout = Number(timeoutMs || 12000);
    const step = 50;
    const start = Date.now();

    return new Promise((resolve, reject) => {
      const tick = () => {
        let ok = false;
        try { ok = !!conditionFn(); } catch (_) { ok = false; }

        if (ok) return resolve(true);
        if (Date.now() - start >= timeout) return reject(new Error("timeout"));
        setTimeout(tick, step);
      };
      tick();
    });
  }

  async function waitForAuthReady() {
    // Preferência: Promise global criada pelo auth.js
    try {
      if (window.__VSC_AUTH_READY && typeof window.__VSC_AUTH_READY.then === "function") {
        await Promise.race([
          window.__VSC_AUTH_READY,
          new Promise((_, rej) => setTimeout(() => rej(new Error("__VSC_AUTH_READY timeout")), 15000)),
        ]);
        return true;
      }
    } catch (_) {}

    // Fallback: evento
    let signaled = false;
    const onReady = () => { signaled = true; };

    try { window.addEventListener("VSC_AUTH_READY", onReady, { once: true }); } catch (_) {}

    try {
      await waitFor(() => signaled || !!window.VSC_AUTH, 15000);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function ensureBootstrap() {
    if (!window.VSC_AUTH) return false;
    if (typeof window.VSC_AUTH.bootstrap !== "function") return true; // builds antigos
    await Promise.race([
      window.VSC_AUTH.bootstrap(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("bootstrap timeout")), 20000)),
    ]);
    return true;
  }

  async function getCurrentUserSafe() {
    if (!window.VSC_AUTH || typeof window.VSC_AUTH.getCurrentUser !== "function") return null;
    try {
      return await Promise.race([
        window.VSC_AUTH.getCurrentUser(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("getCurrentUser timeout")), 10000)),
      ]);
    } catch (_) {
      return null;
    }
  }

  function hasSessionId() {
    try { return !!localStorage.getItem(LS_SESSION_ID); } catch (_) { return false; }
  }

  async function runGuard() {
    const onLogin = isLoginPage();
    const onDash  = isDashboardPage();

    // REGRA SEGURA: nunca executar guard na página /login.
    // Evita loop (login <-> dashboard) quando há vsc_session_id local mas sessão expirou.
    if (onLogin) {
      reveal();
      return;
    }

    // Se não é login nem dashboard, não interfere.
    if (!onLogin && !onDash) {
      reveal();
      return;
    }

    if (isLocked()) {
      console.warn("[VSC_AUTH_GUARD] lock ativo (anti-loop).", { build: BUILD });
      reveal();
      return;
    }

    // Fail-closed rápido: dashboard sem session_id => login
    if (onDash && !hasSessionId()) {
      console.warn("[VSC_AUTH_GUARD] Sem sessão (LS vazio). Indo para login.");
      safeReplace(canonicalLoginUrl());
      return;
    }

    const ready = await waitForAuthReady();
    if (!ready) {
      console.error("[VSC_AUTH_GUARD] AUTH não ficou pronto (timeout).", { build: BUILD });
      // Fail-open visual (não trava UI); autenticação real deve ser garantida pelo backend/rotas
      reveal();
      return;
    }

    try {
      await ensureBootstrap();
    } catch (e) {
      console.error("[VSC_AUTH_GUARD] bootstrap falhou:", e);
      if (onDash) {
        console.warn("[VSC_AUTH_GUARD] Fail-closed no dashboard: indo para login.");
        safeReplace(canonicalLoginUrl());
        return;
      }
      reveal();
      return;
    }

    const user = await getCurrentUserSafe();

    if (onDash && !user) {
      console.warn("[VSC_AUTH_GUARD] Não autenticado. Indo para login.");
      safeReplace(canonicalLoginUrl());
      return;
    }

    if (onLogin && user) {
      const next = readNextParam();
      console.warn("[VSC_AUTH_GUARD] Já autenticado. Indo para destino.");
      safeReplace(next || (DASH_PATH || DASH_FILE));
      return;
    }

    reveal();
  }

  // Executa o guard cedo, mas depois que o DOM existir para revelar.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { runGuard(); }, { once: true });
  } else {
    runGuard();
  }
})();
