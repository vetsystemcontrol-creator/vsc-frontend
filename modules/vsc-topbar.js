// topbar.js — CORRIGIDO
// Corrige: [VSC_TOPBAR] falha no sync manual TypeError: Failed to fetch (linha ~309-321)

const VSC_TOPBAR = (() => {

  let syncButton = null;
  let statusDot  = null;

  function init() {
    syncButton = document.querySelector('[data-action="sync"], .btn-sincronizar, #btn-sync');
    statusDot  = document.querySelector('.sync-status-dot, .status-indicator');

    if (syncButton) {
      // ✅ Remove listeners antigos antes de adicionar novo
      const newBtn = syncButton.cloneNode(true);
      syncButton.parentNode.replaceChild(newBtn, syncButton);
      syncButton = newBtn;

      syncButton.addEventListener('click', handleManualSync);
      console.log('[VSC_TOPBAR] Botão de sync inicializado.');
    }

    // ✅ Escuta eventos de status do sync
    window.addEventListener('vsc:sync:status', handleSyncStatus);

    // ✅ Monitora conectividade
    window.addEventListener('online',  () => updateOnlineIndicator(true));
    window.addEventListener('offline', () => updateOnlineIndicator(false));

    // Estado inicial
    updateOnlineIndicator(navigator.onLine);
  }

  // ✅ Handler do clique manual no botão SINCRONIZAR
  async function handleManualSync(event) {
    event.preventDefault();

    if (!navigator.onLine) {
      showToast('⚠️ Sem conexão com a internet.', 'warning');
      return;
    }

    setButtonState('loading');

    try {
      // ✅ Chama o motor de sync com tratamento de erro adequado
      await VSC_CLOUD_SYNC.pullNow();

    } catch (err) {
      console.error('[VSC_TOPBAR] falha no sync manual:', err.message);
      showToast('❌ Falha ao sincronizar: ' + err.message, 'error');
      setButtonState('error');
    }
  }

  // ✅ Reage aos eventos de status do sync
  function handleSyncStatus(event) {
    const { status, message } = event.detail;

    switch (status) {
      case 'syncing':
        setButtonState('loading');
        break;
      case 'success':
        setButtonState('success');
        showToast('✅ Sincronizado com sucesso!', 'success');
        setTimeout(() => setButtonState('idle'), 3000);
        break;
      case 'error':
        setButtonState('error');
        showToast('❌ Erro: ' + message, 'error');
        setTimeout(() => setButtonState('idle'), 5000);
        break;
      case 'offline':
        updateOnlineIndicator(false);
        break;
    }
  }

  function setButtonState(state) {
    if (!syncButton) return;

    const states = {
      idle:    { text: 'SINCRONIZAR', disabled: false, class: '' },
      loading: { text: '⏳ Sincronizando...', disabled: true,  class: 'btn-loading' },
      success: { text: '✅ Sincronizado',    disabled: false, class: 'btn-success' },
      error:   { text: '❌ Erro no Sync',    disabled: false, class: 'btn-error'   }
    };

    const s = states[state] || states.idle;
    syncButton.textContent = s.text;
    syncButton.disabled    = s.disabled;
    syncButton.className   = syncButton.className
      .replace(/btn-(loading|success|error)/g, '')
      .trim() + (s.class ? ' ' + s.class : '');
  }

  function updateOnlineIndicator(isOnline) {
    const badge = document.querySelector('.online-badge, [data-online-status]');
    if (badge) {
      badge.textContent = isOnline ? 'ONLINE' : 'OFFLINE';
      badge.className   = badge.className
        .replace(/(online|offline)/gi, '')
        .trim() + (isOnline ? ' online' : ' offline');
    }

    // Atualiza o dot vermelho/verde
    if (statusDot) {
      statusDot.style.background = isOnline ? '#22c55e' : '#ef4444';
    }
  }

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `vsc-toast vsc-toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; bottom: 20px; right: 20px;
      padding: 12px 20px; border-radius: 8px; z-index: 9999;
      font-weight: bold; color: white; min-width: 250px;
      background: ${{ success: '#22c55e', error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' }[type]};
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      animation: slideIn 0.3s ease;
    `;

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // Inicializa quando DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { init, handleManualSync };
})();