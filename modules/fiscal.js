(function(){
  "use strict";

  const DB_NAME = "vsc_fiscal_db";
  const DB_VERSION = 2;
  const STORE_DOCS = "nfe_docs";

  const $ = (id) => document.getElementById(id);

  function nowISO(){ return new Date().toISOString(); }

  function esc(s){
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function onlyDigits(v){ return String(v || "").replace(/\D+/g, ""); }

  function centsToBRL(c){
    const n = (Number(c || 0) / 100);
    return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function parseMoneyLike(v){
    const raw = String(v == null ? "" : v).trim();
    if(!raw) return 0;
    const clean = raw.replace(/\s+/g, "").replace(/\./g, "").replace(",", ".");
    const num = Number(clean);
    return Number.isFinite(num) ? num : 0;
  }

  function toCentsBRL(v){
    return Math.round(parseMoneyLike(v) * 100);
  }

  function fromDateTimeLocalToISO(v){
    const s = String(v || "").trim();
    if(!s) return "";
    const dt = new Date(s);
    return Number.isNaN(dt.getTime()) ? "" : dt.toISOString();
  }

  function toDateTimeLocalValue(v){
    const s = String(v || "").trim();
    if(!s) return "";
    const dt = new Date(s);
    if(Number.isNaN(dt.getTime())) return "";
    const pad = (n)=> String(n).padStart(2, "0");
    const yyyy = dt.getFullYear();
    const mm = pad(dt.getMonth() + 1);
    const dd = pad(dt.getDate());
    const hh = pad(dt.getHours());
    const mi = pad(dt.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }

  function fmtDateTime(v){
    const s = String(v || "").trim();
    if(!s) return "—";
    const dt = new Date(s);
    if(Number.isNaN(dt.getTime())) return esc(s);
    return dt.toLocaleString("pt-BR");
  }

  function snack(msg, kind){
    try{
      if(window.VSC && typeof window.VSC.toast === "function"){
        window.VSC.toast(msg, kind === "err" ? "error" : (kind || "info"));
        return;
      }
    }catch(_){}
    try{
      alert(msg);
    }catch(_){}
  }

  function setMsg(msg, kind){
    const el = $("msgArea");
    if(!el) return;
    el.textContent = msg || "—";
    el.style.color =
      kind === "err" ? "#b91c1c" :
      kind === "ok"  ? "#166534" :
      kind === "warn"? "#92400e" : "#64748b";
  }

  function setCertMsg(msg, kind){
    const el = $("certMsg");
    if(!el) return;
    el.textContent = msg || "—";
    el.style.color =
      kind === "err" ? "#b91c1c" :
      kind === "ok"  ? "#166534" :
      kind === "warn"? "#92400e" : "#64748b";
  }

  function badgeForStatus(status){
    const s = String(status || "DRAFT").toUpperCase();
    if(s === "AUTHORIZED") return { label:"AUTORIZADA", cls:"b-auth" };
    if(s === "REJECTED") return { label:"REJEITADA", cls:"b-rej" };
    if(s === "SENT") return { label:"ENVIADA", cls:"b-sent" };
    if(s === "SIGNED") return { label:"ASSINADA", cls:"b-signed" };
    return { label:"DRAFT", cls:"b-draft" };
  }

  function getDefaultItems(){
    return [{
      id: crypto.randomUUID(),
      codigo: "",
      descricao: "",
      ncm: "",
      cfop: "",
      unidade: "UN",
      quantidade: 1,
      valor_unit_cents: 0,
      valor_total_cents: 0
    }];
  }

  function normalizeItem(raw){
    const qty = Number(raw && raw.quantidade != null ? raw.quantidade : 0);
    const quantidade = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const vu = Number(raw && raw.valor_unit_cents != null ? raw.valor_unit_cents : 0);
    const valorUnit = Number.isFinite(vu) ? Math.max(0, Math.round(vu)) : 0;
    const vt = Number(raw && raw.valor_total_cents != null ? raw.valor_total_cents : Math.round(quantidade * valorUnit));
    const valorTotal = Number.isFinite(vt) ? Math.max(0, Math.round(vt)) : Math.round(quantidade * valorUnit);
    return {
      id: String(raw && raw.id || crypto.randomUUID()),
      codigo: String(raw && raw.codigo || "").trim(),
      descricao: String(raw && raw.descricao || "").trim(),
      ncm: String(raw && raw.ncm || "").trim(),
      cfop: String(raw && raw.cfop || "").trim(),
      unidade: String(raw && raw.unidade || "UN").trim().toUpperCase().slice(0, 6) || "UN",
      quantidade,
      valor_unit_cents: valorUnit,
      valor_total_cents: valorTotal
    };
  }

  function normalizeDoc(doc){
    const items = Array.isArray(doc && doc.items) && doc.items.length ? doc.items.map(normalizeItem) : getDefaultItems().map(normalizeItem);
    const totalItens = items.reduce((sum, it)=> sum + Number(it.valor_total_cents || 0), 0);
    const frete = Number(doc && doc.frete_cents || 0) || 0;
    const desconto = Number(doc && doc.desconto_cents || 0) || 0;
    const totalProvided = Number(doc && doc.total_cents || 0);
    const total = totalProvided > 0 ? totalProvided : Math.max(0, totalItens + frete - desconto);

    return {
      id: String(doc && doc.id || crypto.randomUUID()),
      model: 55,
      status: String(doc && doc.status || "DRAFT"),
      serie: String(doc && doc.serie || "1"),
      numero: String(doc && doc.numero || ""),
      ambiente: String(doc && doc.ambiente || "HOMOLOG"),
      natureza: String(doc && doc.natureza || "Venda / faturamento"),
      emissao_em: String(doc && doc.emissao_em || nowISO()),
      saida_em: String(doc && doc.saida_em || ""),
      dest_nome: String(doc && doc.dest_nome || ""),
      dest_doc: String(doc && doc.dest_doc || ""),
      dest_ie: String(doc && doc.dest_ie || ""),
      dest_fone: String(doc && doc.dest_fone || ""),
      dest_endereco: String(doc && doc.dest_endereco || ""),
      base_icms_cents: Number(doc && doc.base_icms_cents || 0) || 0,
      valor_icms_cents: Number(doc && doc.valor_icms_cents || 0) || 0,
      frete_cents: frete,
      desconto_cents: desconto,
      total_cents: total,
      obs: String(doc && doc.obs || ""),
      chave: String(doc && doc.chave || ""),
      protocolo: String(doc && doc.protocolo || ""),
      items,
      created_at: String(doc && doc.created_at || nowISO()),
      updated_at: String(doc && doc.updated_at || nowISO())
    };
  }

  function summarizeEmpresa(empresa){
    const nome = empresa.razao_social || empresa.nome_fantasia || "Empresa não configurada";
    const doc = empresa.cnpj ? `CNPJ ${maskCnpjCpf(empresa.cnpj)}` : "CNPJ não informado";
    const endereco = [empresa.logradouro, empresa.numero, empresa.bairro, empresa.cidade, empresa.uf].filter(Boolean).join(", ") || "Endereço não informado";
    const contato = [empresa.telefone || empresa.celular || "", empresa.email || ""].filter(Boolean).join(" · ") || "Contato não informado";
    $("emitenteResumo").textContent = nome;
    $("emitenteResumo2").textContent = `${doc} · ${endereco}`;
    $("sumEmpresaNome").textContent = nome;
    $("sumEmpresaDoc").textContent = doc;
    $("sumEmpresaEndereco").textContent = endereco;
    $("sumEmpresaContato").textContent = contato;
  }

  function readEmpresa(){
    try{
      const raw = localStorage.getItem("vsc_empresa_v1");
      if(!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === "object" ? obj : {};
    }catch(_){
      return {};
    }
  }

  function maskCnpjCpf(v){
    const d = onlyDigits(v);
    if(d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
    if(d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
    return d || "";
  }

  function buildAccessKeyPreview(doc, empresa){
    if(doc.chave && onlyDigits(doc.chave).length >= 44){
      return onlyDigits(doc.chave).slice(0,44);
    }
    const uf = "35";
    const d = new Date(doc.emissao_em || nowISO());
    const aamm = `${String(d.getFullYear()).slice(-2)}${String(d.getMonth()+1).padStart(2,"0")}`;
    const cnpj = onlyDigits(empresa.cnpj || "").padStart(14, "0").slice(0, 14);
    const mod = "55";
    const serie = onlyDigits(doc.serie || "").padStart(3, "0").slice(-3);
    const numero = onlyDigits(doc.numero || "").padStart(9, "0").slice(-9);
    const tpEmis = doc.ambiente === "PROD" ? "1" : "2";
    const codigo = String(Math.abs(hashCode(`${cnpj}${numero}${doc.id}`))).padStart(8, "0").slice(0, 8);
    const dv = String((Number(codigo.slice(-1)) + Number(numero.slice(-1)) + Number(serie.slice(-1))) % 9);
    return `${uf}${aamm}${cnpj}${mod}${serie}${numero}${tpEmis}${codigo}${dv}`.slice(0,44);
  }

  function hashCode(str){
    let h = 0;
    for(let i=0;i<str.length;i++) h = ((h << 5) - h) + str.charCodeAt(i), h |= 0;
    return h;
  }

  function groupKey(key){
    const d = onlyDigits(key);
    return d.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
  }

  function docResumo(doc){
    if(!doc){
      $("docResumo").textContent = "Nenhum documento selecionado";
      $("docResumo2").textContent = "Abra um rascunho ou crie uma nova NF-e.";
      return;
    }
    const label = `${doc.serie || "1"}/${doc.numero || "—"} · ${badgeForStatus(doc.status).label}`;
    const txt = `${doc.dest_nome || "Sem destinatário"} · R$ ${centsToBRL(doc.total_cents || 0)}`;
    $("docResumo").textContent = label;
    $("docResumo2").textContent = txt;
  }

  function updateStatusPill(doc){
    const el = $("docStatusPill");
    if(!doc){
      el.className = "pill";
      el.textContent = "Status: —";
      return;
    }
    const b = badgeForStatus(doc.status);
    el.className = "pill " + (b.cls === "b-auth" ? "ok" : (b.cls === "b-rej" ? "err" : ""));
    el.textContent = `Status: ${b.label}`;
  }

  function setButtons(doc){
    const has = !!(doc && doc.id);
    $("btnExcluir").disabled = !has;
    $("btnVisualizar").disabled = !has;
    $("btnImprimir").disabled = !has;
    $("btnAssinar").disabled = true;
    $("btnEnviar").disabled = true;
  }

  function openDB(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        let st;
        if(!db.objectStoreNames.contains(STORE_DOCS)){
          st = db.createObjectStore(STORE_DOCS, { keyPath:"id" });
        }else{
          st = req.transaction.objectStore(STORE_DOCS);
        }
        if(st && !st.indexNames.contains("by_updated")){
          st.createIndex("by_updated", "updated_at", { unique:false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPutDoc(doc){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DOCS], "readwrite");
      tx.objectStore(STORE_DOCS).put(normalizeDoc(doc));
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { const err = tx.error; try{ db.close(); }catch(_){} reject(err); };
    });
  }

  async function dbDeleteDoc(id){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DOCS], "readwrite");
      tx.objectStore(STORE_DOCS).delete(id);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { const err = tx.error; try{ db.close(); }catch(_){} reject(err); };
    });
  }

  async function dbGetAllDocs(){
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DOCS], "readonly");
      const st = tx.objectStore(STORE_DOCS);
      const idx = st.index("by_updated");
      const out = [];
      idx.openCursor(null, "prev").onsuccess = (e) => {
        const cur = e.target.result;
        if(cur){ out.push(normalizeDoc(cur.value)); cur.continue(); }
        else resolve(out);
      };
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => db.close();
    });
  }

  let currentId = null;
  let cache = [];
  let currentItems = getDefaultItems().map(normalizeItem);
  let previewUrl = "";

  function getForm(){
    return {
      serie: String($("fSerie").value || "").trim() || "1",
      numero: String($("fNumero").value || "").trim(),
      ambiente: String($("fAmbiente").value || "HOMOLOG").trim(),
      natureza: String($("fNatureza").value || "").trim(),
      emissao_em: fromDateTimeLocalToISO($("fEmissao").value),
      saida_em: fromDateTimeLocalToISO($("fSaida").value),
      dest_nome: String($("fDestNome").value || "").trim(),
      dest_doc: String($("fDestDoc").value || "").trim(),
      dest_ie: String($("fDestIE").value || "").trim(),
      dest_fone: String($("fDestFone").value || "").trim(),
      dest_endereco: String($("fDestEndereco").value || "").trim(),
      base_icms_cents: toCentsBRL($("fBaseICMS").value),
      valor_icms_cents: toCentsBRL($("fValorICMS").value),
      frete_cents: toCentsBRL($("fFrete").value),
      desconto_cents: toCentsBRL($("fDesconto").value),
      total_cents: toCentsBRL($("fTotal").value),
      obs: String($("fObs").value || "").trim(),
      chave: String($("fChave").value || "").trim(),
      protocolo: String($("fProtocolo").value || "").trim(),
      items: currentItems.map(normalizeItem)
    };
  }

  function setForm(doc){
    const d = normalizeDoc(doc || {});
    $("fSerie").value = d.serie || "1";
    $("fNumero").value = d.numero || "";
    $("fAmbiente").value = d.ambiente || "HOMOLOG";
    $("fNatureza").value = d.natureza || "";
    $("fEmissao").value = toDateTimeLocalValue(d.emissao_em);
    $("fSaida").value = toDateTimeLocalValue(d.saida_em);
    $("fDestNome").value = d.dest_nome || "";
    $("fDestDoc").value = d.dest_doc || "";
    $("fDestIE").value = d.dest_ie || "";
    $("fDestFone").value = d.dest_fone || "";
    $("fDestEndereco").value = d.dest_endereco || "";
    $("fBaseICMS").value = centsToBRL(d.base_icms_cents || 0);
    $("fValorICMS").value = centsToBRL(d.valor_icms_cents || 0);
    $("fFrete").value = centsToBRL(d.frete_cents || 0);
    $("fDesconto").value = centsToBRL(d.desconto_cents || 0);
    $("fTotal").value = centsToBRL(d.total_cents || 0);
    $("fObs").value = d.obs || "";
    $("fChave").value = d.chave || "";
    $("fProtocolo").value = d.protocolo || "";
    currentItems = d.items.map(normalizeItem);
    renderItems();
  }

  function renderItems(){
    const tb = $("itemsBody");
    if(!tb) return;
    tb.innerHTML = "";

    currentItems.forEach((item, index) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input class="item-input" data-k="codigo" data-i="${index}" value="${esc(item.codigo)}" /></td>
        <td><input data-k="descricao" data-i="${index}" value="${esc(item.descricao)}" placeholder="Produto / serviço" /></td>
        <td><input class="item-input" data-k="ncm" data-i="${index}" value="${esc(item.ncm)}" placeholder="0000.00.00" /></td>
        <td><input class="item-input" data-k="cfop" data-i="${index}" value="${esc(item.cfop)}" placeholder="5102" /></td>
        <td><input class="item-input" data-k="unidade" data-i="${index}" value="${esc(item.unidade)}" placeholder="UN" /></td>
        <td><input class="item-input num-right" data-k="quantidade" data-i="${index}" value="${String(item.quantidade).replace(".", ",")}" inputmode="decimal" /></td>
        <td><input class="item-input num-right" data-k="valor_unit_cents" data-i="${index}" value="${centsToBRL(item.valor_unit_cents)}" inputmode="decimal" /></td>
        <td class="num-right" data-total="${index}">R$ ${centsToBRL(item.valor_total_cents)}</td>
        <td><div class="item-row-actions"><button class="linkbtn" data-remove="${index}" type="button">Remover</button></div></td>
      `;
      tb.appendChild(tr);
    });

    tb.querySelectorAll("input[data-k]").forEach((input) => {
      input.addEventListener("input", onItemInputChange);
      input.addEventListener("change", onItemInputChange);
    });
    tb.querySelectorAll("button[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-remove"));
        if(currentItems.length === 1){
          currentItems = getDefaultItems().map(normalizeItem);
        }else{
          currentItems.splice(idx, 1);
        }
        renderItems();
        recalcTotalsFromItems();
      });
    });

    recalcTotalsFromItems({ silent:true });
  }

  function onItemInputChange(e
(Content truncated due to size limit. Use line ranges to read remaining content)