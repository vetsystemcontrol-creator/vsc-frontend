
/*
  Vet System Control – Cloud Sync (patched)
  Fluxo:
  1) push pendências locais via VSC_RELAY.syncNow()
  2) pull snapshot canônico do Cloudflare
*/

async function pullCanonicalSnapshot() {
  const r = await fetch("https://app.vetsystemcontrol.com.br/api/sync/pull", {
    method: "GET",
    headers: { "X-VSC-Tenant": "tenant-default" }
  });
  const j = await r.json();

  if (!j || !j.snapshot || !j.snapshot.data) return;

  const db = await window.VSC_DB.openDB();
  const localStores = Array.from(db.objectStoreNames);

  const filtered = {};
  for (const [store, rows] of Object.entries(j.snapshot.data)) {
    if (localStores.includes(store)) filtered[store] = rows;
  }

  await window.VSC_DB.importDump({
    meta: j.snapshot.meta || {},
    data: filtered
  }, { mode: "replace_store" });
}

async function manualSync() {
  if (window.VSC_RELAY && typeof window.VSC_RELAY.syncNow === "function") {
    await window.VSC_RELAY.syncNow();
  }
  await pullCanonicalSnapshot();
}

window.VSC_CLOUD_SYNC = {
  manualSync
};
