(()=>{
  function safe(v){ return v == null ? '' : String(v); }

  function getInstitutionalCss(){
    return `
.kado-hdr{border:1px solid #cfd9e5;border-radius:18px;padding:14px 16px 0;background:#fff;overflow:hidden;margin-bottom:12px;}
.kado-hdr::after{content:"";display:block;height:9px;border-radius:0 0 16px 16px;margin:12px -16px 0;background:linear-gradient(90deg,#1ea35a 0%, #14b8a6 56%, #1d9bf0 100%);}
.kado-hdr-top{display:grid;grid-template-columns:minmax(0,1fr) 158px;gap:20px;align-items:start;}
.kado-system-wrap{display:flex;align-items:flex-start;min-height:138px;}
.kado-system-logo{width:365px;max-width:100%;height:auto;display:block;margin:0;border:none !important;border-radius:0 !important;object-fit:contain;}
.kado-fallback-system{font-size:30px;font-weight:900;line-height:1.05;color:#0f172a;}
.kado-company-logo-wrap{display:flex;justify-content:flex-end;align-items:flex-start;}
.kado-company-logo{width:154px;max-width:100%;height:154px;object-fit:contain;display:block;margin:0;border:none !important;border-radius:0 !important;}
.kado-company-logo-fallback{width:154px;height:154px;display:flex;align-items:center;justify-content:center;margin:0;border:none !important;}
.kado-hdr-bottom{display:grid;grid-template-columns:minmax(0,1fr) minmax(305px,.92fr);gap:20px;align-items:start;margin-top:8px;}
.kado-company-box{display:grid;gap:6px;align-content:start;}
.kado-company-name{font-size:24px;line-height:1.04;font-weight:900;letter-spacing:-.03em;margin:0;color:#0f172a;text-transform:uppercase;}
.kado-company-meta{font-size:12px;line-height:1.42;color:#334155;display:grid;gap:2px;}
.kado-doc-box{padding-top:4px;}
.kado-doc-title{font-size:15px;line-height:1.1;font-weight:900;letter-spacing:.08em;text-transform:uppercase;margin:0 0 10px;color:#0f172a;}
.kado-doc-meta{display:grid;gap:8px;font-size:12px;line-height:1.45;color:#334155;}
.kado-doc-meta b{font-size:13px;color:#0f172a;}
.kado-cover{padding-top:6px;}
.kado-spec-label,.kado-muted-label,.kado-mini-label{font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#64748b;line-height:1.2;}
.kado-spec-value{font-size:18px;font-weight:900;line-height:1.18;color:#0f172a;margin-top:8px;}
.kado-origin{margin-top:24px;display:grid;gap:3px;}
.kado-origin-line{font-size:12px;line-height:1.56;color:#0f172a;font-weight:800;}
.kado-control-label{margin-top:28px;font-size:12px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#0f7b74;}
.kado-summary-grid{display:grid;grid-template-columns:minmax(0,1fr) 192px;gap:16px;align-items:start;margin-top:24px;}
.kado-summary-left{display:grid;gap:16px;}
.kado-summary-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.kado-summary-head .kado-summary-title{font-size:12px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#0f7b74;}
.kado-summary-head .kado-summary-inline{font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:#64748b;}
.kado-summary-field{display:grid;gap:5px;}
.kado-summary-value{font-size:16px;font-weight:900;line-height:1.26;color:#0f172a;}
.kado-summary-date{padding-top:22px;text-align:right;}
.kado-summary-date .kado-summary-value{font-size:18px;}
.kado-page-break{height:0;break-before:page;page-break-before:always;}
.hdr img,.wmLocal img{border:none !important;border-radius:0 !important;}
`;
  }

  function renderInstitutionalHeader(data){
    return `
      <div class="kado-hdr">
        <div class="kado-hdr-top">
          <div class="kado-system-wrap">
            <img class="kado-system-logo" src="${safe(data.systemLogoSrc)}" alt="Vet System Control" onerror="this.outerHTML='${safe(data.systemLogoFallback).replace(/'/g, '&#39;')}'" />
          </div>
          <div class="kado-company-logo-wrap">${safe(data.companyLogoHtml)}</div>
        </div>
        <div class="kado-hdr-bottom">
          <div class="kado-company-box">
            <div class="kado-company-name">${safe(data.companyName)}</div>
            <div class="kado-company-meta">${safe(data.companyMetaHtml)}</div>
          </div>
          <div class="kado-doc-box">
            <div class="kado-doc-title">${safe(data.documentTitle)}</div>
            <div class="kado-doc-meta">${safe(data.documentMetaHtml)}</div>
          </div>
        </div>
      </div>`;
  }

  function renderClinicalInstitutionalCover(data){
    return `
      <div class="kado-cover">
        <div class="kado-spec-label">Especificação</div>
        <div class="kado-spec-value">${safe(data.spec)}</div>

        <div class="kado-origin">
          <div class="kado-origin-line">${safe(data.originLine1)}</div>
          <div class="kado-origin-line">${safe(data.originLine2)}</div>
        </div>

        <div class="kado-control-label">Controle do documento</div>

        <div class="kado-summary-grid">
          <div class="kado-summary-left">
            <div class="kado-summary-head">
              <div class="kado-summary-title">Resumo institucional</div>
              <div class="kado-summary-inline">${safe(data.clientLabel)}</div>
            </div>
            <div class="kado-summary-field">
              <div class="kado-summary-value">${safe(data.clientValue)}</div>
            </div>
            <div class="kado-summary-field">
              <div class="kado-mini-label">${safe(data.patientLabel)}</div>
              <div class="kado-summary-value">${safe(data.patientValue)}</div>
            </div>
            <div class="kado-summary-field">
              <div class="kado-mini-label">${safe(data.vetLabel)}</div>
              <div class="kado-summary-value">${safe(data.vetValue)}</div>
            </div>
            <div class="kado-summary-field">
              <div class="kado-mini-label">${safe(data.attachmentsLabel)}</div>
              <div class="kado-summary-value">${safe(data.attachmentsValue)}</div>
            </div>
          </div>
          <div class="kado-summary-date">
            <div class="kado-mini-label">${safe(data.dateLabel)}</div>
            <div class="kado-summary-value">${safe(data.dateValue)}</div>
          </div>
        </div>
      </div>
      <div class="kado-page-break"></div>`;
  }

  window.VSCPrintTemplate = Object.assign({}, window.VSCPrintTemplate || {}, {
    getInstitutionalCss,
    renderInstitutionalHeader,
    renderClinicalInstitutionalCover
  });
})();
