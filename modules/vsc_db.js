  if (!entity) throw new Error("listChangeDocuments: entity obrigatório");
  if (!entity_id) throw new Error("listChangeDocuments: entity_id obrigatório");

  const db = await openDB();
  try{
    return await new Promise((resolve, reject) => {
      const out = [];
      const tx0 = db.transaction([STORE_BUSINESS_AUDIT], "readonly");
      const st0 = tx0.objectStore(STORE_BUSINESS_AUDIT);
      const ix = st0.index("entity_when");

      const range = IDBKeyRange.bound([String(entity), ""], [String(entity), "\uffff"]);
      const rq = ix.openCursor(range, "prev"); // mais recentes primeiro

      rq.onsuccess = () => {
        const cur = rq.result;
        if(!cur) return resolve(out);
        const v = cur.value;
        if(v && String(v.entity_id) === String(entity_id)){
          out.push(v);
          if(out.length >= limit) return resolve(out);
        }
        cur.continue();
      };
      rq.onerror = () => reject(rq.error || new Error("listChangeDocuments: cursor error"));
    });
  } finally { try{ db.close(); }catch(_){ } }
}

async function listRecentChanges(entity, opts){
  opts = opts || {};
  const limit = (opts.limit && Number(opts.limit) > 0) ? Number(opts.limit) : 50;
  if (!entity) throw new Error("listRecentChanges: entity obrigatório");

  const db = await openDB();
  try{
    return await new Promise((resolve, reject) => {
      const out = [];
      const tx0 = db.transaction([STORE_BUSINESS_AUDIT], "readonly");
      const st0 = tx0.objectStore(STORE_BUSINESS_AUDIT);
      const ix = st0.index("entity_when");

      const range = IDBKeyRange.bound([String(entity), ""], [String(entity), "\uffff"]);
      const rq = ix.openCursor(range, "prev");

      rq.onsuccess = () => {
        const cur = rq.result;
        if(!cur) return resolve(out);
        out.push(cur.value);
        if(out.length >= limit) return resolve(out);
        cur.continue();
      };
      rq.onerror = () => reject(rq.error || new Error("listRecentChanges: cursor error"));
    });
  } finally { try{ db.close(); }catch(_){ } }
}


  // ============================================================
  // BACKUP/RESTORE (Dump canônico do IndexedDB)
  // - exportDump(): retorna { meta, schema, data }
  // - importDump(): restaura dados (default: merge_newer)
  // ============================================================

  function _safeIso(v){
    try{ return new Date(v).toISOString(); }catch(_){ return null; }
  }

  function _asArray(x){
    return Array.isArray(x) ? x : [];
  }

  async function _getAllFromStore(db, storeName){
    return await new Promise((resolve, reject) => {
      const tx0 = db.transaction([storeName], "readonly");
      const st0 = tx0.objectStore(storeName);
      const out = [];
      const rq = st0.openCursor();
      rq.onsuccess = () => {
        const cur = rq.result;
        if(cur){
          out.push(cur.value);
          cur.continue();
        } else {
          resolve(out);
        }
      };
      rq.onerror = () => reject(rq.error);
    });
  }

  function _describeStore(db, storeName){
    const tx0 = db.transaction([storeName], "readonly");
    const st0 = tx0.objectStore(storeName);

    const idx = [];
    for (const ixName of st0.indexNames){
      const ix = st0.index(ixName);
      idx.push({
        name: ix.name,
        keyPath: ix.keyPath,
        unique: !!ix.unique,
        multiEntry: !!ix.multiEntry
      });
    }

    return {
      name: st0.name,
      keyPath: st0.keyPath,
      autoIncrement: !!st0.autoIncrement,
      indexes: idx
    };
  }

  async function exportDump(){
    const db = await openDB();
    try{
      const storeNames = Array.from(db.objectStoreNames);

      const schema = {
        db_name: DB_NAME,
        db_version: db.version,
        exported_at: _safeIso(Date.now()),
        stores: storeNames.map(s => _describeStore(db, s))
      };

      const data = {};
      for(const s of storeNames){
        data[s] = await _getAllFromStore(db, s);
      }

      const meta = {
        app: "Vet System Control – Equine",
        db_name: DB_NAME,
        db_version: db.version,
        exported_at: schema.exported_at,
        counts: storeNames.reduce((acc, s) => { acc[s] = _asArray(data[s]).length; return acc; }, {})
      };

      return { meta, schema, data };
    } finally {
      try{ db.close(); }catch(_){}
    }
  }

  function _pickUpdatedAt(o){
    if(!o) return null;
    return o.updated_at || o.updatedAt || o.last_update || null;
  }
