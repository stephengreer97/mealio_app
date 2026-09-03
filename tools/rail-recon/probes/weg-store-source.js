// READ ONLY. Where did the page learn the CURRENT store number?
(async () => {
  const out = { globals: [], inHtml: [], nextData: null, storeApis: [] };
  // Globals whose serialised form mentions a store number field.
  for (const k of Object.keys(window).slice(0, 400)) {
    let v; try { v = window[k]; } catch (e) { continue; }
    if (!v || typeof v !== 'object') continue;
    let s; try { s = JSON.stringify(v); } catch (e) { continue; }
    if (!s || s.length > 400000) continue;
    if (/"storeNumber"|"currentStore"|"selectedStore"/i.test(s)) {
      const m = s.match(/"(storeNumber|currentStore|selectedStore)"\s*:\s*"?(\d{1,4})"?/i);
      out.globals.push({ global: k, bytes: s.length, hit: m ? m[0].slice(0, 60) : null });
      if (out.globals.length > 6) break;
    }
  }
  // The server-rendered payload, if there is one.
  const nd = document.getElementById('__NEXT_DATA__');
  if (nd) {
    const s = nd.textContent || '';
    const m = s.match(/"(storeNumber|currentStore|selectedStore)"\s*:\s*"?(\d{1,4})"?/i);
    out.nextData = { bytes: s.length, hit: m ? m[0].slice(0, 60) : null };
  }
  // Any inline script that carries it.
  for (const sc of Array.from(document.scripts).slice(0, 60)) {
    const t = sc.textContent || '';
    if (!t || t.length > 300000) continue;
    const m = t.match(/"(storeNumber|currentStore|selectedStore)"\s*:\s*"?(\d{1,4})"?/i);
    if (m) out.inHtml.push({ bytes: t.length, hit: m[0].slice(0, 60) });
    if (out.inHtml.length > 4) break;
  }
  // Same-origin endpoints that might name the user's store without a bearer.
  for (const p of ['/api/user/store', '/api/stores/current', '/api/user', '/api/session', '/api/stores/selected']) {
    try {
      const r = await fetch(p, { headers: { accept: 'application/json' } });
      const txt = await r.text();
      out.storeApis.push({ path: p, status: r.status, bytes: txt.length, peek: txt.slice(0, 120) });
    } catch (e) { out.storeApis.push({ path: p, err: String(e && e.message).slice(0, 60) }); }
  }
  return out;
})()
