/* =====================================================================
VSC — clientes.js (Módulo Clientes) — ERP 2.0.1
Offline-first • IndexedDB (clientes_master) • Outbox (sync_queue)
Conforme PATCH CANÔNICO ÚNICO (AA — Automações Premium)
===================================================================== */

(function(){
  "use strict";

  // -----------------------------
  // Constantes / Config
  // -----------------------------
  var STORE_CLIENTES = "clientes_master";
  var STORE_OUTBOX  = "sync_queue";

  var STATUS = {
    SYNC: "SYNC",
    SALVANDO: "SALVANDO",
    SALVO: "SALVO",
    ERRO: "ERRO"
  };


  // -----------------------------
  // Utilitários base (do legado)
  // -----------------------------
  function uuidv4(){
    // UUID v4 determinístico o suficiente (crypto) com fallback
    if(window.crypto && crypto.getRandomValues){
      var a = new Uint8Array(16);
      crypto.getRandomValues(a);
      a[6] = (a[6] & 0x0f) | 0x40;
      a[8] = (a[8] & 0x3f) | 0x80;
      var s = Array.from(a).map(function(b){ return ("0"+b.toString(16)).slice(-2); }).join("");
      return s.slice(0,8)+"-"+s.slice(8,12)+"-"+s.slice(12,16)+"-"+s.slice(16,20)+"-"+s.slice(20);
    }
    // fallback (menos ideal)
    var d = Date.now();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){
      var r = (d + Math.random()*16)%16|0;
      d = Math.floor(d/16);
      return (c==="x" ? r : (r&0x3|0x8)).toString(16);
    });
  }

  function onlyDigits(s){ return String(s||"").replace(/\D+/g,""); }

  function clampStr(s, max){
    s = String(s||"").trim();
    if(max && s.length>max) s = s.slice(0,max);
    return s;
  }

  function setText(id, txt){
    var el = document.getElementById(id);
    if(el) el.textContent = txt;
  }

  function showEl(id, on){
    var el = document.getElementById(id);
    if(!el) return;
    el.style.display = on ? "" : "none";
  }

  // -----------------------------
  // Enterprise Floorplan: List Report (lista) + Object Page (detalhe)
  // - Detalhe fica oculto até seleção ou NOVO
  // -----------------------------
  function setDetailVisible(on){
    // on=true  => mostra DETALHE e oculta LISTA
    // on=false => mostra LISTA e oculta DETALHE
    var lv = document.getElementById("clientesListView");
    var dv = document.getElementById("clientesDetailView");
    if(lv) lv.style.display = on ? "none" : "";
    if(dv) dv.style.display = on ? "" : "none";

    // Compat: mantém blocos internos do detalhe (empty vs content)
    var empty = document.getElementById("detailEmpty");
    var cont  = document.getElementById("detailContent");
    if(on){
      // Se não há registro carregado e não está em NOVO, mostra mensagem
      var showEmpty = (!state || (!state.editingId && state.uiMode !== "NOVO"));
      if(empty) empty.style.display = showEmpty ? "" : "none";
      if(cont)  cont.style.display  = showEmpty ? "none" : "";
    }else{
      if(empty) empty.style.display = "";
      if(cont)  cont.style.display  = "none";
    }
  }


  // Toast determinístico (AA-4)
// Toast/snackbar + Modal de confirmação forte (premium)
var toastTimer = null;
var modalTimer = null;

  function ensureMsgModal(){
    var m = document.getElementById("msgModal");
    if(m) return m;

    // cria modal (somente via JS, mínimo diff no HTML)
    m = document.createElement("div");
    m.id = "msgModal";
    m.style.cssText = "display:none; position:fixed; inset:0; z-index:10000;";
    m.innerHTML = ''
      + '<div id="msgBackdrop" style="position:absolute; inset:0; background:rgba(0,0,0,.35);"></div>'
      + '<div style="position:relative; max-width:520px; margin:22vh auto 0; background:#fff; border:1px solid #e5e7eb; border-radius:14px; padding:16px; box-shadow:0 18px 60px rgba(0,0,0,.18);">'
      + '  <div id="msgTitle" style="font-weight:900; font-size:16px;">OK</div>'
      + '  <div id="msgText" style="margin-top:8px; font-size:14px; color:#111827;"></div>'
      + '</div>';

    document.body.appendChild(m);

    // fechar ao clicar no backdrop
    var bd = document.getElementById("msgBackdrop");
    if(bd){
      bd.addEventListener("click", function(){
        hideMsgModal();
      });
    }
    return m;
  }
function confirmModal(title, text){
  return new Promise(function(resolve){
    ensureMsgModal();

    var m = document.getElementById("msgModal");
    var t = document.getElementById("msgTitle");
    var x = document.getElementById("msgText");

    if(t) t.textContent = String(title || "Confirmação");
    if(x) x.textContent = String(text || "");

    // remove timer automático do modal (confirmação não pode sumir sozinha)
    try{
      if(modalTimer){ clearTimeout(modalTimer); modalTimer = null; }
    }catch(_){}

    // cria footer com botões (se não existir)
    var footer = m.querySelector('[data-role="footer"]');
    if(!footer){
      footer = document.createElement("div");
      footer.setAttribute("data-role","footer");
      footer.style.cssText = "display:flex; justify-content:flex-end; gap:8px; margin-top:14px;";
      // card interno do modal (onde ficam título e texto)
      var card = m.querySelector("div[style*='max-width']");
      if(card) card.appendChild(footer);
      else m.appendChild(footer);
    }
    footer.innerHTML = "";

    var btnCancel = document.createElement("button");
    btnCancel.className = "btn";
    btnCancel.type = "button";
    btnCancel.textContent = "Cancelar";

    var btnOk = document.createElement("button");
    btnOk.className = "btn btnPrimary";
    btnOk.type = "button";
    btnOk.textContent = "Confirmar";

    footer.appendChild(btnCancel);
    footer.appendChild(btnOk);

    function done(v){
      try{ m.style.display = "none"; }catch(_){}
      resolve(!!v);
    }

    btnCancel.addEventListener("click", function(){ done(false); });
    btnOk.addEventListener("click", function(){ done(true); });

    // abre e foca no seguro
    m.style.display = "block";
    setTimeout(function(){ try{ btnCancel.focus(); }catch(_){ } }, 0);
  });
}

  function showMsgModal(title, text, ms){
    ensureMsgModal();
    var m = document.getElementById("msgModal");
    var t = document.getElementById("msgTitle");
    var x = document.getElementById("msgText");
    if(t) t.textContent = String(title || "OK");
    if(x) x.textContent = String(text || "");

    if(modalTimer){ clearTimeout(modalTimer); modalTimer = null; }
    m.style.display = "block";

    modalTimer = setTimeout(function(){
      hideMsgModal();
    }, (typeof ms === "number" ? ms : 2000));
  }

  function hideMsgModal(){
    var m = document.getElementById("msgModal");
    if(!m) return;
    m.style.display = "none";
    if(modalTimer){ clearTimeout(modalTimer); modalTimer = null; }
  }

  function toast(msg, kind, strong){
    // strong=true -> modal forte + snackbar
    var el = document.getElementById("toast");
    if(el){
      if(toastTimer) { clearTimeout(toastTimer); toastTimer=null; }
      el.style.display = "block";
      el.textContent = String(msg||"");
      el.setAttribute("data-kind", kind||"info");
      toastTimer = setTimeout(function(){
        el.style.display = "none";
        el.textContent = "";
        el.removeAttribute("data-kind");
      }, 2200);
    }

    if(strong){
      var title = (kind === "error") ? "Erro" :
                  (kind === "warn")  ? "Atenção" : "Sucesso";
      showMsgModal(title, String(msg||""), 2000);
    }
  }

  // Badge (AA-4)
  function setSyncBadge(label, cssClass){
    var b = document.getElementById("syncBadge");
    if(!b) return;
    b.textContent = label;
    // remove classes conhecidas
    b.classList.remove("b-off","b-on","b-warn","b-err","b-sync");
    if(cssClass) b.classList.add(cssClass);
  }
  
    // -----------------------------
  // IndexedDB — abertura CANÔNICA (VSC_DB)
  // Fonte única de versão/esquema: vsc_db.js
  // -----------------------------
  function openDb(){
    return new Promise(function(resolve, reject){
      try{
        if(!window.VSC_DB || typeof window.VSC_DB.openDB !== "function"){
          reject(new Error("VSC_DB ausente. Banco canônico não disponível."));
          return;
        }
        Promise.resolve()
          .then(function(){ return window.VSC_DB.openDB(); })
          .then(function(db){ resolve(db); })
          .catch(function(err){ reject(err || new Error("Falha ao abrir VSC_DB")); });
      }catch(e){
        reject(e);
      }
    });
  }

  // -----------------------------
  // IndexedDB — wrapper mínimo (TX / CRUD usando db já aberto)
  // -----------------------------
  function txp(db, storeName, mode, fn){
    return new Promise(function(resolve, reject){
      try{
        var tx = db.transaction(storeName, mode);
        var st = tx.objectStore(storeName);
        var out = fn(st, tx);
        tx.oncomplete = function(){ resolve(out); };
        tx.onerror = function(){ reject(tx.error || new Error("Falha TX")); };
        tx.onabort = function(){ reject(tx.error || new Error("TX abortada")); };
      }catch(e){ reject(e); }
    });
  }

  function getAll(db, storeName){
    return txp(db, storeName, "readonly", function(st){
      return new Promise(function(resolve, reject){
        var r = st.getAll();
        r.onsuccess = function(){ resolve(r.result || []); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  function getById(db, storeName, id){
    return txp(db, storeName, "readonly", function(st){
      return new Promise(function(resolve, reject){
        var r = st.get(id);
        r.onsuccess = function(){ resolve(r.result || null); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  function put(db, storeName, obj){
    return txp(db, storeName, "readwrite", function(st){
      return new Promise(function(resolve, reject){
        var r = st.put(obj);
        r.onsuccess = function(){ resolve(obj); };
        r.onerror = function(){ reject(r.error); };
      });
    });
  }

  // Outbox: registra evento determinístico (AA-6)
  
  function delById(db, storeName, id){
    return txp(db, storeName, "readwrite", function(st){
      return new Promise(function(resolve, reject){
        try{
          var r = st.delete(String(id));
          r.onsuccess = function(){ resolve(true); };
          r.onerror = function(){ reject(r.error || new Error("Falha ao excluir")); };
        }catch(e){ reject(e); }
      });
    });
  }

  // outboxEnqueue: usa VSC_DB.upsertWithOutbox para garantir op_id, ISO timestamp,
  // store correto e transação atômica — compatível com o relay e o backend D1.
  function outboxEnqueue(db, entity, entityId, action, payload){
    var vscDb = window.VSC_DB;
    // Caminho preferencial: VSC_DB.upsertWithOutbox (atômico, op_id, ISO timestamp)
    if(vscDb && typeof vscDb.upsertWithOutbox === "function"){
      var storeName = STORE_CLIENTES;
      // payload do outbox = objeto completo do cliente + metadado __origin
      // O backend (cloud-store.js) usa op.payload para montar o registro no D1
      var outboxMeta = { __origin: "CADASTRO_MANUAL" };
      // Para DELETE não há objeto para dar upsert — enfileira diretamente via outboxEnqueue interno
      if(String(action).toUpperCase() === "DELETE"){
        if(typeof vscDb.outboxEnqueue === "function"){
          return vscDb.outboxEnqueue("clientes", "delete", entityId, Object.assign({}, payload || {}, outboxMeta));
        }
        return _outboxEnqueueFallback(entityId, action, payload);
      }
      // UPSERT: obj é o cliente puro (sem campos de outbox)
      // payload do outbox = objeto completo do cliente (para o backend salvar no D1)
      var obj = Object.assign({}, payload || {});
      if(!obj.id) obj.id = entityId;
      // Garantir created_at ISO se ainda for número (registros legados)
      if(typeof obj.created_at === "number"){
        obj.created_at = new Date(obj.created_at).toISOString();
      }
      if(typeof obj.updated_at === "number"){
        obj.updated_at = new Date(obj.updated_at).toISOString();
      }
      // outboxPayload = objeto completo do cliente + __origin (backend usa isso para salvar no D1)
      var outboxPayload = Object.assign({}, obj, outboxMeta);
      return vscDb.upsertWithOutbox(storeName, obj, "clientes", String(entityId), outboxPayload);
    }
    // Fallback caso VSC_DB não esteja disponível
    return _outboxEnqueueFallback(entityId, action, payload);
  }

  // Fallback com formato correto (ISO timestamp, op_id, store)
  function _outboxEnqueueFallback(entityId, action, payload){
    var now = new Date().toISOString();
    var evt = {
      id: uuidv4(),
      op_id: uuidv4(),
      store: STORE_CLIENTES,
      entity: "clientes",
      entity_id: String(entityId),
      action: String(action).toLowerCase(),
      payload: payload || {},
      status: "PENDING",
      created_at: now,
      updated_at: now,
      device_id: (navigator && navigator.userAgent ? navigator.userAgent.slice(0,40) : "unknown"),
      base_revision: 0,
      entity_revision: 1,
      dedupe_key: ["clientes_master", String(entityId), String(action).toLowerCase(), "0", "1"].join(":")
    };
    return new Promise(function(resolve, reject){
      try{
        var req2 = indexedDB.open(window.VSC_DB_NAME || "vsc_db");
        req2.onsuccess = function(){
          var database = req2.result;
          var tx2 = database.transaction(STORE_OUTBOX, "readwrite");
          var st2 = tx2.objectStore(STORE_OUTBOX);
          var r2 = st2.put(evt);
          r2.onsuccess = function(){ database.close(); resolve(evt); };
          r2.onerror = function(){ database.close(); reject(r2.error); };
        };
        req2.onerror = function(){ reject(req2.error); };
      }catch(e){ reject(e); }
    });
  }

  function countPendingOutbox(db){
    return new Promise(function(resolve, reject){
      try{
        var tx = db.transaction(STORE_OUTBOX, "readonly");
        var st = tx.objectStore(STORE_OUTBOX);
        // OBS: o índice canônico em vsc_db.js chama "status"
        // (vamos ajustar no 2/4 para ficar 100% canônico)
        var idx = st.index("status");
        var range = IDBKeyRange.only("PENDING");
        var c = 0;
        var req = idx.openCursor(range);
        req.onsuccess = function(){
          var cur = req.result;
          if(cur){ c++; cur.continue(); return; }
          resolve(c);
        };
        req.onerror = function(){ reject(req.error); };
      }catch(e){ reject(e); }
    });
  }
  // -----------------------------
  // Normalização / Validação
  // -----------------------------
  function normNome(s){
    s = String(s||"").trim();
    s = s.normalize ? s.normalize("NFD").replace(/[\u0300-\u036f]/g,"") : s;
    return s.toLowerCase();
  }

  function validaCPF(cpf){
    cpf = onlyDigits(cpf);
    if(cpf.length !== 11) return false;
    if(/^(\d)\1+$/.test(cpf)) return false;
    var sum=0, i=0;
    for(i=0;i<9;i++) sum += parseInt(cpf.charAt(i),10)*(10-i);
    var d1 = 11 - (sum % 11); if(d1>=10) d1=0;
    if(d1 !== parseInt(cpf.charAt(9),10)) return false;
    sum=0;
    for(i=0;i<10;i++) sum += parseInt(cpf.charAt(i),10)*(11-i);
    var d2 = 11 - (sum % 11); if(d2>=10) d2=0;
    return d2 === parseInt(cpf.charAt(10),10);
  }

  function validaCNPJ(cnpj){
    cnpj = onlyDigits(cnpj);
    if(cnpj.length !== 14) return false;
    if(/^(\d)\1+$/.test(cnpj)) return false;
    var t = cnpj.length - 2;
    var d = cnpj.substring(t);
    var d1 = parseInt(d.charAt(0),10);
    var d2 = parseInt(d.charAt(1),10);
    var calc = function(x){
      var n = cnpj.substring(0, x);
      var y = x - 7;
      var sum = 0;
      var i = 0;
      for(i=x; i>=1; i--){
        sum += parseInt(n.charAt(x - i),10) * y--;
        if(y < 2) y = 9;
      }
      var r = 11 - (sum % 11);
      return (r > 9) ? 0 : r;
    };
    return calc(t) === d1 && calc(t+1) === d2;
  }

  function docValido(doc){
    var d = onlyDigits(doc);
    if(!d) return true; // doc é opcional
    if(d.length === 11) return validaCPF(d);
    if(d.length === 14) return validaCNPJ(d);
    return false;
  }

  function validaUF(uf){
    uf = String(uf||"").trim().toUpperCase();
    if(!uf) return true;
    return /^[A-Z]{2}$/.test(uf);
  }

  function showErr(errId, on){
  var e = document.getElementBy
(Content truncated due to size limit. Use line ranges to read remaining content)