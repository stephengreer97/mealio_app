// READ ONLY. Where does the page keep the current store number?
// Reports key names and where 140 appears — no token, no personal data.
(async () => {
  const out = { localStorage: [], sessionStorage: [], cookies: [], apiStores: null };
  const scan = (store, bag) => {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (!k) continue;
      const v = store.getItem(k) || '';
      if (/\b140\b/.test(v) && v.length < 4000) {
        bag.push({ key: k.slice(0, 70), bytes: v.length, peek: v.slice(0, 160) });
      }
    }
  };
  try { scan(localStorage, out.localStorage); } catch (e) {}
  try { scan(sessionStorage, out.sessionStorage); } catch (e) {}
  out.cookies = document.cookie.split(';').map((c) => c.trim())
    .filter((c) => /140/.test(c)).map((c) => c.slice(0, 90));
  // Same-origin, no auth: what does /api/stores say?
  try {
    const t0 = Date.now();
    const r = await fetch('/api/stores', { headers: { accept: 'application/json' } });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    out.apiStores = {
      status: r.status, ms: Date.now() - t0, bytes: txt.length,
      shape: Array.isArray(j) ? 'array(' + j.length + ')' : (j && Object.keys(j).slice(0, 12)),
      firstKeys: Array.isArray(j) && j[0] ? Object.keys(j[0]).slice(0, 14) : null,
    };
  } catch (e) { out.apiStores = { err: String(e && e.message).slice(0, 120) }; }
  return out;
})()
