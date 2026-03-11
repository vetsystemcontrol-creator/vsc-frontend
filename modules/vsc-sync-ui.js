/*
 * VSC-SYNC-UI — Botão único de sincronização (Premium)
 * ---------------------------------------------------
 * Mostra:
 *  - Online/Offline (dot)
 *  - Pendências (count)
 *  - Progresso (enviando X ops/s)
 *
 * Integra com:
 *  - window.VSC_RELAY.syncNow()        (push)
 *  - window.VSC_CLOUD_SYNC.manualSync() (push + pull)
 *  - evento window 'vsc:sync-progress'
 *  - evento window 'vsc:sync:status'
 */
(() => {
  'use strict';

  const TOKEN_KEY = 'vsc_local_token';
  const FIXED_TOKEN = 'VSC@2026!SyncToken#Vet$Equine';

  // Garantir token e flag de sync remoto sempre presentes
  try {
    if (!localStorage.getItem(TOKEN_KEY)) {
      localStorage.setItem(TOKEN_KEY, FIXED_TOKEN);
    }
    // Habilitar sync remoto em localhost (necessário para 127.0.0.1)
    localStorage.setItem('vsc_allow_local_sync_api', '1');
  } catch(_) {}

  function $(sel) { return document.querySelector(sel); }

  function _findEls() {
    const btn   = $('#vscSyncBtn')     || document.querySelector('[data-vsc-sync-btn]')   || null;
    const dot   = $('#vscNetDot')      || $('#vscSyncDot') || document.querySelector('[data-vsc-sync-dot]') || null;
    const count = $('#vscSyncPending') || $('#vscSyncCount') || document.querySelector('[data-vsc-sync-count]') || null;
    const note  = $('#vscSyncNote')    || document.querySelector('[data-vsc-sync-note]')  || null;
    return { btn, dot, count, note };
  }

  const UI = {
    _els: null,
    _last: { pending: 0, running: false, rate: 0, batch: 0, error: null },
    _firstSyncDone: false,

    init() {
      this._els = _findEls();
      this._bind();
      this._render();

      // Mostrar nota de última sync se existir
      try {
        const last = localStorage.getItem('vsc_last_sync');
        if (last && this._els.note) {
          const d = new Date(last);
          this._els.note.textContent = 'Base sincronizada às ' +
            d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }
      } catch(_) {}
    },

    _bind() {
      const { btn } = this._els;
      if (btn) {
        btn.addEventListener('click', async (ev) => {
          ev.preventDefault();
          // Abrir painel na página pai se disponível
          try {
            const p = window.parent;
            if (p && p !== window) {
              if (p.VSC_SYNC_PANEL && typeof p.VSC_SYNC_PANEL.open === 'function') {
                p.VSC_SYNC_PANEL.open();
                return;
              }
              p.postMessage({ type: 'VSC_SYNC_PANEL_OPEN' }, '*');
              return;
            }
          } catch(_) {}
          // Fallback: sync direto
          await this._doSync();
        });
      }

      window.addEventListener('online',  () => this._render());
      window.addEventListener('offline', () => this._render());

      // Progresso do relay (push)
      window.addEventListener('vsc:sync-progress', (e) => {
        if (!e || !e.detail) return;
        this.onProgress(e.detail);
      });

      // Status do cloud sync (pull)
      window.addEventListener('vsc:sync:status', (e) => {
        if (!e || !e.detail) return;
        const { status, message } = e.detail;
        if (status === 'syncing') {
          this._last.running = true;
          this._render();
        } else if (status === 'success') {
          this._last.running = false;
          this._last.error = null;
          // Recarregar página pai após sync bem-sucedido
          try {
            const parentWin = window.parent;
            if (parentWin && parentWin !== window) {
              // Primeiro sync: recarrega para carregar dados
              if (!this._firstSyncDone) {
                this._firstSyncDone = true;
                setTimeout(() => {
                  try { parentWin.location.reload(); } catch(_) {}
                }, 800);
              }
            }
          } catch(_) {}
          this._render();
        } else if (status === 'error') {
          this._last.running = false;
          this._last.error = message || 'Falha ao sincronizar';
          this._render();
        } else if (status === 'offline') {
          this._last.running = false;
          this._render();
        }
      });
    },

    async _doSync() {
      if (this._last.running) return;
      this._last.running = true;
      this._last.error = null;
      this._render();

      try {
        // Usa manualSync se disponível (push + pull), senão só push
        if (window.VSC_CLOUD_SYNC && typeof window.VSC_CLOUD_SYNC.manualSync === 'function') {
          await window.VSC_CLOUD_SYNC.manualSync();
        } else if (window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === 'function') {
          await window.VSC_RELAY.syncNow();
        }
      } catch(e) {
        this._last.error = String(e && (e.message || e)) || 'Falha ao sincronizar';
      } finally {
        this._last.running = false;
        this._render();
      }
    },

    onProgress(detail) {
      this._last.pending = Number(detail.pending ?? this._last.pending) || 0;
      this._last.running = !!detail.running;
      this._last.rate    = Number(detail.lastRateOps ?? 0) || 0;
      this._last.batch   = Number(detail.lastBatchSize ?? 0) || 0;
      this._last.error   = detail.error || null;
      this._render();
    },

    _render() {
      if (!this._els) this._els = _findEls();
      const { dot, count, note, btn } = this._els;

      const online = navigator.onLine;
      if (dot) {
        dot.style.background = online
          ? (this._last.error ? 'var(--vsc-danger,#e53)' : 'var(--vsc-green,#2fb26a)')
          : '#aaa';
        dot.style.opacity = online ? '1' : '0.5';
        dot.title = online ? 'Online' : 'Offline';
      }

      if (count) {
        count.textContent = String(this._last.pending || 0);
      }

      const msg = this._last.running
        ? (this._last.rate > 0 ? `Enviando… ${this._last.rate} ops/s` : 'Sincronizando…')
        : (this._last.error
            ? 'Falha ao sincronizar'
            : (() => {
                try {
                  const last = localStorage.getItem('vsc_last_sync');
                  if (last) {
                    const d = new Date(last);
                    return 'Base sincronizada às ' +
                      d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  }
                } catch(_) {}
                return online ? 'Pronto para sincronizar' : 'Offline';
              })()
          );

      if (note) {
        note.textContent = msg;
      } else if (btn) {
        btn.title = msg;
      }

      if (btn) {
        btn.disabled = this._last.running;
      }
    }
  };

  window.VSC_SYNC_UI = UI;

  try {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      UI.init();
    } else {
      window.addEventListener('DOMContentLoaded', () => UI.init(), { once: true });
    }
  } catch (_) {}

})();
