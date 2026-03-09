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

  async function runManualSync() {
    if (window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === 'function') {
      const push = await window.VSC_RELAY.syncNow();
      if (window.VSC_CLOUD_SYNC && typeof window.VSC_CLOUD_SYNC.pullNow === 'function') await window.VSC_CLOUD_SYNC.pullNow();
      return push;
    }
    if (window.VSC_CLOUD_SYNC && typeof window.VSC_CLOUD_SYNC.manualSync === 'function') {
      return await window.VSC_CLOUD_SYNC.manualSync();
    }
    if (window.VSC_CLOUD_SYNC && typeof window.VSC_CLOUD_SYNC.syncNow === 'function') {
      return await window.VSC_CLOUD_SYNC.syncNow();
    }
    throw new Error('manual_sync_unavailable');
  }

  const UI = {
    _els: null,
    _last: { pending: 0, running: false, rate: 0, batch: 0, local_static_mode: false, remote_sync_allowed: true, error: null },

    init() {
      this._els = _findEls();
      this._bind();
      this._render();
    },

    _bind() {
      const { btn } = this._els;
      if (btn && btn.dataset.vscSyncBound !== '1') {
        btn.dataset.vscSyncBound = '1';
        btn.addEventListener('click', async (ev) => {
          try {
            ev.preventDefault();
            ev.stopPropagation();
            await runManualSync();
          } catch (e) {
            this.onProgress({ running:false, error:String(e && (e.message || e)) });
          }
        });
      }
      window.addEventListener('online', () => this._render());
      window.addEventListener('offline', () => this._render());
      window.addEventListener('vsc:sync-progress', (e) => {
        if (e && e.detail) this.onProgress(e.detail);
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
      let msg = 'Pronto para sincronizar';
      if (!online) {
        msg = 'Offline';
      } else if (this._last.running) {
        msg = this._last.rate > 0 ? `Sincronizando… ${this._last.rate} ops/s` : 'Sincronizando...';
      } else if (this._last.error) {
        msg = 'Falha ao sincronizar';
      } else if (this._last.local_static_mode && this._last.remote_sync_allowed !== false) {
        msg = 'Modo local → nuvem';
      } else if (this._last.remote_sync_allowed === false) {
        msg = 'API de sync indisponível';
      }
      if (note) note.textContent = msg;
      if (btn) btn.title = msg;
    }
  };

  window.VSC_SYNC_UI = UI;
  if (document.readyState === 'complete' || document.readyState === 'interactive') UI.init();
  else window.addEventListener('DOMContentLoaded', () => UI.init(), { once: true });
})();
