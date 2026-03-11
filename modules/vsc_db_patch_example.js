
/*
Patch: adiciona store fornecedores_master
Incrementar versão do IndexedDB para 35
*/

// trecho representativo da migração
case 35:
  if (!db.objectStoreNames.contains("fornecedores_master")) {
    const s = db.createObjectStore("fornecedores_master", { keyPath: "id" });
    s.createIndex("cnpj_digits", "cnpj_digits", { unique: false });
    s.createIndex("nome_norm", "nome_norm", { unique: false });
    s.createIndex("status", "status", { unique: false });
    s.createIndex("updated_at", "updated_at", { unique: false });
  }
  break;
