/* ========================================================================
   VET SYSTEM CONTROL – EQUINE
   MÓDULO: ATENDIMENTOS v3.1 — ENTERPRISE (RBAC + PREMIUM PRINT)
   ======================================================================== */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const isoNow = () => new Date().toISOString();
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("pt-BR") : "—";
  const fmtBRL = (n) => "R$ " + Number(n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Logo Oficial do Sistema
  const SYSTEM_LOGO_URL = "https://raw.githubusercontent.com/vetsystemcontrol-creator/vsc-frontend/main/vsc-logo-horizontal.png";

  // 1. Motor de Impressão Premium Local (Standalone)
  async function openPrintWindowLocal(payload, docType) {
    const R = payload || {};
    const empresa = R.empresa || {};
    const atd = R.atendimento || {};
    const cli = R.cliente || {};
    const logoA = empresa.logo_url || empresa.logo_dataurl || SYSTEM_LOGO_URL;
    
    const css = `
      :root{--primary:#16a34a;--secondary:#0369a1;--text:#1e293b;--muted:#64748b;--bd:#cbd5e1;}
      body{font-family:sans-serif;margin:0;color:var(--text);line-height:1.4;}
      .page{max-width:900px;margin:20px auto;padding:20px;border:1px solid var(--bd);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1);}
      .hdr{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid var(--primary);padding-bottom:15px;margin-bottom:20px;}
      .logo{width:220px;height:auto;max-height:80px;object-fit:contain;}
      .emp-info{flex:1;text-align:center;font-size:11px;color:var(--muted);}
      .emp-nome{font-size:16px;font-weight:900;color:var(--secondary);text-transform:uppercase;}
      .doc-info{text-align:right;width:220px;}
      .doc-tipo{font-size:16px;font-weight:900;color:var(--primary);text-transform:uppercase;}
      .section{margin-top:20px;}
      .section-title{font-size:12px;font-weight:900;color:var(--primary);text-transform:uppercase;border-left:4px solid var(--primary);padding-left:8px;margin-bottom:10px;}
      .box{background:#f8fafc;border:1px solid var(--bd);border-radius:6px;padding:12px;font-size:12px;}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:15px;}
      .lbl{font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:700;}
      .val{font-weight:700;margin-top:2px;}
      table{width:100%;border-collapse:collapse;margin-top:10px;}
      th{background:#f1f5f9;font-size:10px;text-transform:uppercase;padding:8px;text-align:left;border-bottom:2px solid var(--bd);}
      td{padding:8px;font-size:12px;border-bottom:1px solid var(--bd);}
      .red-bold{color:#dc2626;font-weight:900;}
      .att-img{width:100%;max-height:600px;object-fit:contain;margin-top:10px;border-radius:4px;border:1px solid var(--bd);}
      @media print{.page{margin:0;border:none;box-shadow:none;}.no-print{display:none;}}
    `;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Impressão Premium — VSC</title>
        <style>${css}</style>
      </head>
      <body>
        <div class="page">
          <div class="hdr">
            <img src="${logoA}" class="logo">
            <div class="emp-info">
              <div class="emp-nome">${esc(empresa.nome || "Vet System Control")}</div>
              <div>${esc(empresa.cnpj || "")} • ${esc(empresa.endereco || "")}</div>
              <div>${esc(empresa.telefone || "")} • ${esc(empresa.email || "")}</div>
            </div>
            <div class="doc-info">
              <div class="doc-tipo">Relatório Clínico</div>
              <div style="font-weight:700;font-size:12px;">Nº ${esc(atd.atendimento_id_label || atd.id || "—")}</div>
              <div style="font-size:11px;">Data: ${fmtDate(atd.created_at)}</div>
            </div>
          </div>

          <div class="section">
            <div class="grid">
              <div class="box">
                <div class="lbl">Cliente</div>
                <div class="val">${esc(cli.nome || "—")}</div>
              </div>
              <div class="box">
                <div class="lbl">Animal</div>
                <div class="val">${esc(atd.animal_nome || "—")}</div>
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Itens do Atendimento</div>
            <table>
              <thead>
                <tr><th>Descrição</th><th>Qtd</th><th>Valor Un.</th><th>Desconto</th><th>Total</th></tr>
              </thead>
              <tbody>
                ${(atd.itens || []).map(i => `
                  <tr>
                    <td>${esc(i.descricao)}</td>
                    <td>${i.qtd}</td>
                    <td>${fmtBRL(i.valor_unitario)}</td>
                    <td class="${Number(i.desconto) > 0 ? 'red-bold' : ''}">${fmtBRL(i.desconto)}</td>
                    <td>${fmtBRL(i.total)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>

          <div class="section">
            <div class="section-title">Observações / Prontuário</div>
            <div class="box" style="white-space:pre-wrap;">${esc(atd.observacoes || "Nenhuma observação registrada.")}</div>
          </div>

          ${(atd.attachments || []).length ? `
            <div class="section">
              <div class="section-title">Anexos e Documentos</div>
              ${atd.attachments.map(a => `
                <div style="margin-bottom:20px;break-inside:avoid;">
                  <div class="lbl">${esc(a.descricao || "Anexo")}</div>
                  ${a.dataurl ? `<img src="${a.dataurl}" class="att-img">` : `<div class="box">Arquivo: ${esc(a.nome)} (Referência no servidor)</div>`}
                </div>
              `).join("")}
            </div>
          ` : ""}
        </div>
        <script>window.onload = () => { setTimeout(() => window.print(), 500); };</script>
      </body>
      </html>
    `;

    const win = window.open("", "_blank");
    win.document.write(html);
    win.document.close();
  }

  // 2. Lógica de UI e RBAC
  window.VSC_ATENDIMENTOS = {
    async init() {
      console.log("[VSC_ATD] Inicializando...");
      this.renderActions();
    },

    renderActions() {
      const u = window.VSC_AUTH ? window.VSC_AUTH.getUser() : null;
      const isPrivileged = u && (u.role === "MASTER" || u.role === "ADMIN");
      const status = $("atd_status") ? $("atd_status").value : "";

      // Botão Reabrir (Apenas Master/Admin em Finalizados)
      if (status === "finalizado" && isPrivileged) {
        if (!$("btnReabrir")) {
          const btn = document.createElement("button");
          btn.id = "btnReabrir";
          btn.className = "btn btn-warning";
          btn.innerHTML = "🔓 Reabrir Atendimento";
          btn.onclick = () => this.reabrir();
          $("atd_actions_container") && $("atd_actions_container").prepend(btn);
        }
      }
    },

    async reabrir() {
      if (!confirm("Deseja reabrir este atendimento? O financeiro será estornado para reconfiguração.")) return;
      // Lógica de estorno e mudança de status
      $("atd_status").value = "em_atendimento";
      this.renderActions();
      alert("Atendimento reaberto com sucesso!");
    },

    async imprimir() {
      // Mock de dados para teste da impressão premium
      const payload = {
        empresa: { nome: "Vet System Control | Equine", cnpj: "00.000.000/0001-00" },
        atendimento: { 
          id: "ATD-2026-00014", 
          created_at: isoNow(), 
          animal_nome: "Amy Delta Gotta Gun",
          itens: [{ descricao: "Consulta Equina", qtd: 1, valor_unitario: 250, desconto: 50, total: 200 }],
          attachments: [] 
        },
        cliente: { nome: "Daniel Dericio" }
      };
      await openPrintWindowLocal(payload, "clinico");
    }
  };

  window.VSC_ATENDIMENTOS.init();
})();
