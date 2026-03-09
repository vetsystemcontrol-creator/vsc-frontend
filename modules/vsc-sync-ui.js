/*
 * VSC-SYNC-UI — Botão único de sincronização manual
 * ------------------------------------------------
 * Mostra:
 *  - Online/Offline (dot)
 *  - Pendências locais (quando informadas)
 *  - Progresso/erro da sincronização manual
 *
 * Não dispara sincronização automática.
 */
(() => {
  'use strict';

  function $(sel) { return document.querySelector(sel); }

  function _findEls() {
    const btn = $('#vscSyncBtn') || document.querySelector('[data-vsc-sync-btn]') || null;
    const dot = $('#vscNetDot') || $('#vscSyncDot') || document.querySelector('[data-vsc-sync-dot]') || null;
    const count = $('#vscSyncPending') || $('#vscSyncCount') || $('#vscMobilePending') || document.querySelector('[data-vsc-sync-count]') || null;
    const note = $('#vscSyncNote') || document.querySelector('[data-vsc-sync-note]') || null;
    return { btn, dot, count, note };
  }

  const UI = {
    _els: null,
    _last: { pending: 0, running: false, rate: 0, batch: 0, error: null, local_static_mode: false, remote_sync_allowed: true, synced: false },

    init() {
      this._els = _findEls();
      this._bind();
      this._render();
    },

    _bind() {
      window.addEventListener('online', () => this._render());
      window.addEventListener('offline', () => this._render());
      window.addEventListener('vsc:sync-progress', (e) => {
        if (!e || !e.detail) return;
        this.onProgress(e.detail);
      });
      window.addEventListener('vsc:cloud-sync-progress', (e) => {
        if (!e || !e.detail) return;
        this.onProgress(e.detail);
      });
    },

    onProgress(detail) {
      this._last.pending = Number(detail.pending ?? this._last.pending) || 0;
      this._last.running = !!detail.running;
      this._last.rate = Number(detail.lastRateOps ?? 0) || 0;
      this._last.batch = Number(detail.lastBatchSize ?? 0) || 0;
      this._last.error = detail.error || null;
      this._last.local_static_mode = !!detail.local_static_mode;
      this._last.remote_sync_allowed = typeof detail.remote_sync_allowed === 'boolean' ? detail.remote_sync_allowed : this._last.remote_sync_allowed;
      this._last.synced = !!detail.synced;
      this._render();
    },

    _render() {
      if (!this._els) this._els = _findEls();
      const { dot, count, note, btn } = this._els;
      const online = navigator.onLine;

      if (dot) {
        dot.style.opacity = online ? '1' : '0.35';
        dot.title = online ? 'Online' : 'Offline';
      }

      if (count) count.textContent = String(this._last.pending || 0);

      let msg = '';
      if (!online) {
        msg = 'Offline';
      } else if (this._last.running) {
        msg = 'Sincronizando...';
      } else if (this._last.error) {
        msg = 'Falha ao sincronizar (veja console)';
      } else if (this._last.local_static_mode || this._last.remote_sync_allowed === false) {
        msg = 'Aguardando API de sync';
      } else if (this._last.synced) {
        msg = 'Sincronização concluída';
      } else {
        msg = 'Pronto para sincronizar';
      }

      if (note) note.textContent = msg;
      if (btn) btn.title = msg || (online ? 'Sincronizar agora' : 'Offline');
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
