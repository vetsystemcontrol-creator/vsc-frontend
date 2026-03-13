
// VSC Outbox Relay (lock‑safe version)
(function(){
  const state = {
    enabled: true,
    running: false,
    last_error: null,
    last_progress_at: null,
    started_at: null
  };

  const STALE_LOCK_MS = 30000;

  function status(){
    return {
      enabled: state.enabled,
      running: state.running,
      last_error: state.last_error,
      last_progress_at: state.last_progress_at,
      stale_lock: state.running && Date.now() - state.started_at > STALE_LOCK_MS
    };
  }

  async function pushPending(){
    const dbReq = indexedDB.open("vsc_db");
    const db = await new Promise((res,rej)=>{
      dbReq.onsuccess=e=>res(e.target.result);
      dbReq.onerror=e=>rej(e);
    });

    if(!db.objectStoreNames.contains("sync_queue")) return;

    const tx = db.transaction("sync_queue","readonly");
    const store = tx.objectStore("sync_queue");

    const rows = await new Promise((res)=>{
      const r = store.getAll();
      r.onsuccess=()=>res(r.result||[]);
    });

    if(!rows.length) return;

    await fetch("/api/sync/push",{
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({items:rows})
    });

    state.last_progress_at = Date.now();
  }

  async function syncNow(){
    if(state.running){
      if(Date.now() - state.started_at > STALE_LOCK_MS){
        state.running=false;
      }else{
        return;
      }
    }

    state.running=true;
    state.started_at=Date.now();

    try{
      await pushPending();
    }catch(e){
      state.last_error=e;
      console.error("SYNC ERROR",e);
    }finally{
      state.running=false;
    }
  }

  window.VSC_RELAY={status,syncNow};

  window.addEventListener("online",syncNow);
  document.addEventListener("visibilitychange",()=>{
    if(!document.hidden) syncNow();
  });

})();
