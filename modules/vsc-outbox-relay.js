// vsc-outbox-relay.js — CORRIGIDO
// Linha ~266: substituir o fetch direto por versão com credentials e headers

const VSC_OUTBOX_RELAY = (() => {

  const API_BASE = 'https://app.vetsystemcontrol.com.br/api/sync';

  // ✅ Função de fetch corrigida com headers CORS adequados
  async function fetchWithAuth(url, options = {}) {
    const token = VSC_AUTH?.getToken?.() || localStorage.getItem('vsc_token');

    const defaultOptions = {
      mode: 'cors',                          // ✅ modo CORS explícito
      credentials: 'include',               // ✅ envia cookies/session
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...options.headers
      },
      ...options
    };

    try {
      const response = await fetch(url, defaultOptions);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return await response.json();

    } catch (err) {
      console.error('[VSC_OUTBOX_RELAY] Fetch error:', err.message);
      throw err;
    }
  }

  // ✅ Push: envia registros locais para o servidor
  async function pushToServer(records) {
    if (!records || records.length === 0) return { pushed: 0 };

    console.log(`[VSC_OUTBOX_RELAY] Enviando ${records.length} registros...`);

    const result = await fetchWithAuth(`${API_BASE}/push`, {
      method: 'POST',
      body: JSON.stringify({
        records,
        client_id: getClientId(),
        timestamp: new Date().toISOString()
      })
    });

    console.log('[VSC_OUTBOX_RELAY] Push OK:', result);
    return result;
  }

  // ✅ Pull: busca atualizações do servidor
  async function pullFromServer(lastSync) {
    console.log('[VSC_OUTBOX_RELAY] Buscando atualizações desde:', lastSync);

    const params = new URLSearchParams({
      since: lastSync || '1970-01-01T00:00:00Z',
      client_id: getClientId()
    });

    const result = await fetchWithAuth(`${API_BASE}/pull?${params}`, {
      method: 'GET'
    });

    console.log('[VSC_OUTBOX_RELAY] Pull OK:', result);
    return result;
  }

  function getClientId() {
    let id = localStorage.getItem('vsc_client_id');
    if (!id) {
      id = 'vsc_' + crypto.randomUUID();
      localStorage.setItem('vsc_client_id', id);
    }
    return id;
  }

  return { pushToServer, pullFromServer };
})();