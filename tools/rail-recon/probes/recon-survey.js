// READ ONLY. What this store's page holds and what it has called.
// Names and shapes only — never a token value, never personal data.
(async () => {
  const out = { url: location.href.slice(0, 70), cookies: [], storage: [], api: [], globals: [] };
  out.cookies = document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean).slice(0, 45);
  for (let i = 0; i < localStorage.length && out.storage.length < 40; i++) {
    const k = localStorage.key(i); if (!k) continue;
    const v = localStorage.getItem(k) || '';
    out.storage.push({ key: k.slice(0, 60), bytes: v.length });
  }
  const seen = new Set();
  for (const e of performance.getEntriesByType('resource')) {
    let u; try { u = new URL(e.name); } catch (err) { continue; }
    if (/\.(png|jpg|jpeg|svg|webp|woff2?|css|gif|mp4)(\?|$)/.test(u.pathname)) continue;
    if (!/walmart|amazon|primenow|whole/i.test(u.host)) continue;
    if (!/api|graphql|orchestra|cart|search|account|ident|session/i.test(u.pathname)) continue;
    const key = u.host + u.pathname.slice(0, 70);
    if (!seen.has(key)) { seen.add(key); out.api.push({ path: key, type: e.initiatorType }); }
    if (out.api.length > 25) break;
  }
  out.globals = Object.keys(window).filter((k) => /^__|APOLLO|NEXT|INITIAL|BOOTSTRAP|WML|config/i.test(k)).slice(0, 20);
  out.hasSW = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  return out;
})()
