
// UI binding for Sync button
(function(){

  function updateButton(btn,state){
    if(!btn) return;
    if(state.running){
      btn.textContent="Sincronizando...";
      btn.disabled=true;
    }else{
      btn.textContent="Sincronizar Agora";
      btn.disabled=false;
    }
  }

  function init(){
    const btn=document.querySelector("#btn-sync-now");
    if(!btn) return;

    setInterval(()=>{
      const s=window.VSC_RELAY?.status?.();
      updateButton(btn,s||{});
    },1000);

    btn.addEventListener("click",async ()=>{
      try{
        btn.textContent="Sincronizando...";
        btn.disabled=true;
        const r=await window.VSC_CLOUD_SYNC.manualSync();
        console.log("SYNC RESULT",r);
      }catch(e){
        console.error("SYNC ERROR",e);
      }finally{
        btn.textContent="Sincronizar Agora";
        btn.disabled=false;
      }
    });
  }

  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded",init);
  }else{
    init();
  }

})();
