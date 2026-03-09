/* ==========================================================
   Vet System Control - Equine
   Topbar host integration (canônica)
   - padroniza iframe da topbar oficial
   - aplica Logo A somente a partir do módulo Empresa
   ========================================================== */
(function(){
  "use strict";
  var TOPBAR_FRAME_ID = "vscTopbarFrame";
  var TOPBAR_HEIGHT = 94;
  var TOPBAR_SRC = "topbar.html?v=20260307f";
  var EMPRESA_KEY = "vsc_empresa_v1";

  function getFrame(){ return document.getElementById(TOPBAR_FRAME_ID); }

  function ensureFrame(){
    var frame = getFrame();
    if(!frame) return null;
    frame.style.width = "100%";
    frame.style.height = TOPBAR_HEIGHT + "px";
    frame.style.border = "0";
    frame.style.display = "block";
    frame.style.background = "#fff";
    var src = String(frame.getAttribute("src") || "");
    if(src !== TOPBAR_SRC) frame.setAttribute("src", TOPBAR_SRC);
    return frame;
  }

  function post(type, extra){
    var frame = getFrame();
    if(!frame || !frame.contentWindow) return;
    try{
      var payload = Object.assign({ type:type, path:location.pathname }, extra || {});
      frame.contentWindow.postMessage(payload, "*");
    }catch(_){ }
  }

  function notifyNav(){ post("VSC_NAV_UPDATE"); }
  function notifyBranding(){ post("VSC_BRANDING_UPDATE"); }
  function notifySession(){ post("VSC_SESSION_UPDATE"); }

  function hookHistory(){
    ["pushState","replaceState"].forEach(function(name){
      var original = history[name];
      if(typeof original !== "function") return;
      history[name] = function(){
        var result = original.apply(this, arguments);
        setTimeout(notifyNav, 0);
        return result;
      };
    });
    window.addEventListener("popstate", notifyNav);
    window.addEventListener("hashchange", notifyNav);
  }

  function onStorage(ev){
    if(!ev) return;
    if(ev.key === EMPRESA_KEY) notifyBranding();
    if(ev.key === "vsc_user" || ev.key === "vsc_session_id") notifySession();
  }

  function boot(){
    ensureFrame();
    hookHistory();
    notifyNav();
    notifyBranding();
    notifySession();
    window.addEventListener("storage", onStorage);
  }

  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, {once:true});
  else boot();

  window.VSC_APPLY_BRANDING_TOPBAR = notifyBranding;
})();
