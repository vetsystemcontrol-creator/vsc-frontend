
// VSC Cloud Sync controller
(function(){

  async function timeoutPromise(promise,ms){
    return Promise.race([
      promise,
      new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),ms))
    ]);
  }

  async function pullNow(){
    const res = await timeoutPromise(fetch("/api/sync/pull"),15000);
    if(res.status===304) return {ok:true,unchanged:true};
    if(!res.ok) throw new Error("pull failed");
    const data = await res.json();
    return {ok:true,data};
  }

  async function manualSync(){
    await timeoutPromise(window.VSC_RELAY.syncNow(),15000);
    const pull = await pullNow();
    return {ok:true,pull};
  }

  window.VSC_CLOUD_SYNC={manualSync,pullNow};

})();
