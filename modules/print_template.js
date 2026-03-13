// SGQT-Version: 13.1
// Module-Version: 1.0.0
// Shared institutional print template engine
(function(global){
  "use strict";

  function fallbackEsc(s){
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function create(ctx){
    ctx = ctx || {};
    const esc = typeof ctx.esc === 'function' ? ctx.esc : fallbackEsc;

    function baseCss(){
      return `
:root{--text:#0f172a;--muted:#64748b;--bd:#d6e2ef;--soft:#f8fbfd;--brand:#0f7b74;--brand2:#0ea5e9;}
*{box-sizing:border-box;}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--text);margin:0;background:#fff;}
.page{max-width:920px;margin:0 auto;padding:22px 26px 34px;}
.sheet{position:relative;}
.sheet + .sheet{margin-top:14px;}
.sheet--attachments{padding-top:4px;}
.hdr{border:1px solid #cbd5e1;border-radius:20px;padding:10px 16px 0;background:#fff;overflow:hidden;margin-bottom:10px;}
.hdr-top{display:grid;grid-template-columns:minmax(470px,1fr) 170px;gap:22px;align-items:start;}
.system-logo-wrap{display:flex;align-items:flex-start;min-height:140px;}
.system-logo{width:420px;max-width:100%;height:auto;display:block;margin:0;border:none !important;border-radius:0 !important;}
.company-logo-wrap{display:flex;justify-content:flex-end;align-items:flex-start;}
.company-logo{width:152px;max-width:100%;height:152px;object-fit:contain;display:block;margin:0;border:none !important;border-radius:0 !important;}
.hdr-bottom{display:grid;grid-template-columns:minmax(470px,1fr) minmax(280px,.92fr);gap:22px;align-items:start;margin-top:-2px;padding-bottom:10px;}
.company-box{display:grid;gap:6px;align-content:start;}
.emp-nome{font-size:27px;line-height:1.02;font-weight:900;letter-spacing:-.04em;margin:0;color:#0f172a;text-transform:uppercase;}
.emp-dados{font-size:11px;line-height:1.5;color:#334155;display:grid;gap:2px;}
.doc-box{padding-top:10px;}
.doc-title{font-size:15px;line-height:1.12;font-weight:900;letter-spacing:.09em;text-transform:uppercase;margin:0 0 10px;color:#0f172a;}
.doc-meta{display:grid;gap:8px;font-size:12px;line-height:1.45;color:#334155;}
.doc-meta b{font-size:13px;color:#0f172a;}
.hdr-accent{height:10px;border-radius:0 0 20px 20px;margin:0 -16px;background:linear-gradient(90deg,#16a34a 0%, #14b8a6 44%, #0ea5e9 100%);}
.kado-block{display:grid;gap:8px;margin-top:8px;}
.kado-label{font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#64748b;line-height:1.2;}
.kado-label.brand{color:var(--brand);}
.kado-value{font-size:16px;font-weight:900;line-height:1.25;color:#0f172a;}
.kado-text{font-size:12px;line-height:1.55;color:#0f172a;font-weight:800;}
.kado-summary{display:grid;grid-template-columns:minmax(0,1fr) 210px;gap:18px;align-items:start;margin-top:18px;}
.kado-summary-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px 32px;align-items:start;}
.kado-field{display:grid;gap:6px;}
.kado-field .kado-label{font-size:10px;letter-spacing:.17em;}
.kado-date{text-align:right;padding-top:20px;}
.kado-date .kado-label{font-size:10px;letter-spacing:.16em;}
.kado-date .kado-value{font-size:18px;}
.small{font-size:11px;color:var(--muted);line-height:1.45;}
.page-break{height:0;break-before:page;page-break-before:always;}
@media print{
  @page{ size:A4; margin:10mm 10mm 22mm 10mm; }
  body{margin:0;}
  .page{max-width:none;padding:0;}
  .sheet{padding:0;}
  .sheet + .sheet{break-before:page;page-break-before:always;margin-top:0;}
}
      `;
    }

    function renderHeader(data){
      data = data || {};
      const systemLogoSrc = esc(data.systemLogoSrc || 'assets/brand/vsc-logo-horizontal.png');
      const systemLogoFallback = data.systemLogoFallback || '<div class="kado-text" style="font-size:22px;font-weight:900;">Vet System Control</div>';
      const companyName = esc(data.companyName || 'Empresa');
      const companyLines = Array.isArray(data.companyLines) ? data.companyLines.filter(Boolean) : [];
      const reportTitle = esc(data.reportTitle || 'RELATÓRIO');
      const reportLines = Array.isArray(data.reportLines) ? data.reportLines.filter(Boolean) : [];
      const companyLogoHtml = data.companyLogoHtml || '';
      return `
        <div class="hdr">
          <div class="hdr-top">
            <div class="system-logo-wrap">
              <img class="system-logo" src="${systemLogoSrc}" alt="Vet System Control" onerror="this.outerHTML='${systemLogoFallback.replace(/'/g, '&#39;')}'" />
            </div>
            <div class="company-logo-wrap">${companyLogoHtml}</div>
          </div>
          <div class="hdr-bottom">
            <div class="company-box">
              <div class="emp-nome">${companyName}</div>
              <div class="emp-dados">${companyLines.map(v => `<div>${esc(v)}</div>`).join('')}</div>
            </div>
            <div class="doc-box">
              <div class="doc-title">${reportTitle}</div>
              <div class="doc-meta">${reportLines.map(v => `<div>${v}</div>`).join('')}</div>
            </div>
          </div>
          <div class="hdr-accent"></div>
        </div>
      `;
    }

    function renderInstitutionalCover(data){
      data = data || {};
      const summaryTitle = esc(data.summaryTitle || 'Resumo institucional');
      const fields = Array.isArray(data.fields) ? data.fields : [];
      const rightTitle = esc(data.rightTitle || 'Data');
      const rightValue = esc(data.rightValue || '—');
      return `
        <div class="kado-block" style="margin-top:2px;">
          <div class="kado-label">Especificação</div>
          <div class="kado-value">${esc(data.spec || '—')}</div>
        </div>

        <div class="kado-block" style="margin-top:26px;">
          <div class="kado-label brand">Controle do documento</div>
        </div>

        <div class="kado-block" style="margin-top:18px;">
          <div class="kado-label">Origem</div>
          <div class="kado-text">${esc(data.origin || '—')}</div>
          <div class="kado-label" style="margin-top:10px;">Finalidade</div>
          <div class="kado-text">${esc(data.purpose || '—')}</div>
        </div>

        <div class="kado-summary">
          <div>
            <div class="kado-label brand">${summaryTitle}</div>
            <div class="kado-summary-grid">
              ${fields.map(function(field){
                const extra = field.extra ? `<div class="small" style="font-size:12px;color:#334155;line-height:1.45;font-weight:700;">${esc(field.extra)}</div>` : '';
                return `<div class="kado-field"><div class="kado-label">${esc(field.label || '')}</div><div class="kado-value">${esc(field.value || '—')}</div>${extra}</div>`;
              }).join('')}
            </div>
          </div>
          <div class="kado-date">
            <div class="kado-label">${rightTitle}</div>
            <div class="kado-value">${rightValue}</div>
          </div>
        </div>
      `;
    }

    return { baseCss, renderHeader, renderInstitutionalCover };
  }

  global.VSC_PRINT_TEMPLATE = { create };
})(window);
