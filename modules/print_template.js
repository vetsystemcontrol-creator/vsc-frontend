(()=>{
  function safe(v){ return v == null ? '' : String(v); }

  function getInstitutionalCss(){
    return `
.kado-hdr{border:1px solid #cfd9e5;border-radius:20px;padding:14px 16px 0;background:#fff;overflow:hidden;margin-bottom:12px;}
.kado-hdr::after{content:"";display:block;height:9px;border-radius:0 0 18px 18px;margin:12px -16px 0;background:linear-gradient(90deg,#1ea35a 0%, #14b8a6 56%, #1d9bf0 100%);}
.kado-hdr-grid{display:grid;grid-template-columns:minmax(470px,1fr) 288px;grid-template-areas:"system badge" "company doc";column-gap:26px;row-gap:10px;align-items:start;}
.kado-system-wrap{grid-area:system;display:flex;align-items:flex-start;justify-content:flex-start;min-height:144px;}
.kado-system-logo{width:392px;max-width:100%;height:auto;display:block;margin:0;border:none !important;border-radius:0 !important;object-fit:contain;object-position:left top;image-rendering:auto;}
.kado-fallback-system{font-size:30px;font-weight:900;line-height:1.05;color:#0f172a;}
.kado-company-logo-wrap{grid-area:badge;display:flex;justify-content:flex-end;align-items:flex-start;justify-self:end;width:168px;min-height:144px;}
.kado-company-logo{width:152px;max-width:152px;height:152px;object-fit:contain;object-position:center top;display:block;margin:0;border:none !important;border-radius:0 !important;image-rendering:auto;}
.kado-company-logo-fallback{width:152px;height:152px;display:flex;align-items:center;justify-content:center;margin:0;border:none !important;}
.kado-company-box{grid-area:company;display:grid;gap:6px;align-content:start;padding-top:0;}
.kado-company-name{font-size:27px;line-height:1.02;font-weight:900;letter-spacing:-.03em;margin:0;color:#0f172a;text-transform:uppercase;}
.kado-company-meta{font-size:12px;line-height:1.42;color:#334155;display:grid;gap:2px;}
.kado-doc-box{grid-area:doc;align-self:start;padding-top:8px;}
.kado-doc-title{font-size:14px;line-height:1.12;font-weight:900;letter-spacing:.12em;text-transform:uppercase;margin:0 0 12px;color:#0f172a;}
.kado-doc-meta{display:grid;gap:10px;font-size:12px;line-height:1.45;color:#334155;}
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
        <div class="kado-hdr-grid">
          <div class="kado-system-wrap">${safe(data.systemLogoHtml) || (safe(data.systemLogoSrc) ? `<img class="kado-system-logo" src="${safe(data.systemLogoSrc)}" alt="Vet System Control" />` : safe(data.systemLogoFallback))}</div>
          <div class="kado-company-logo-wrap">${safe(data.companyLogoHtml)}</div>
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
