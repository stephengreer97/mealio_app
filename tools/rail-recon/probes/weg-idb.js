// READ ONLY. Does IndexedDB hold the selected store?
(async () => {
  const out = { databases: [], hits: [] };
  if (!indexedDB.databases) return { why: 'indexedDB.databases unsupported' };
  const dbs = await indexedDB.databases();
  out.databases = dbs.map((d) => ({ name: d.name, version: d.version }));
  for (const d of dbs) {
    if (!d.name) continue;
    const db = await new Promise((res) => {
      const rq = indexedDB.open(d.name);
      rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
      setTimeout(() => res(null), 2500);
    });
    if (!db) continue;
    for (const storeName of Array.from(db.objectStoreNames).slice(0, 8)) {
      try {
        const rows = await new Promise((res) => {
          const tx = db.transaction(storeName, 'readonly');
          const rq = tx.objectStore(storeName).getAll(undefined, 40);
          rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]);
          setTimeout(() => res([]), 2500);
        });
        for (const r of rows) {
          let s; try { s = JSON.stringify(r); } catch (e) { continue; }
          if (!s || s.length > 40000) continue;
          if (/\b140\b/.test(s)) {
            const m = s.match(/"([a-zA-Z]*[Ss]tore[a-zA-Z]*)"\s*:\s*"?140"?/);
            out.hits.push({ db: d.name, store: storeName, field: m ? m[1] : null, peek: s.slice(0, 200) });
            if (out.hits.length > 6) return out;
          }
        }
      } catch (e) { /* skip */ }
    }
    db.close();
  }
  return out;
})()
