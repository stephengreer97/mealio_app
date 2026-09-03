// Read-only. Wegmans commerce API, authenticated with the MSAL access token the
// site itself keeps in localStorage. The token is never printed.
//
// MSAL keeps an INDEX (`msal.<n>.token.keys.<clientId>`) whose `accessToken`
// array names the localStorage keys the credentials live under. Reading it that
// way is what MSAL does and is more robust than pattern-matching key names.
(async () => {
  const out = { indexKeys: [], tokenFound: false };
  let tok = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!/^msal\.\d+\.token\.keys\./.test(k)) continue;
      out.indexKeys.push(k);
      const idx = JSON.parse(localStorage.getItem(k) || '{}');
      for (const name of (idx.accessToken || [])) {
        const raw = localStorage.getItem(name);
        if (!raw) continue;
        const j = JSON.parse(raw);
        if (j && j.secret) { tok = j; break; }
      }
      if (tok) break;
    }
  } catch (e) { out.err = String(e).slice(0, 120); }
  if (!tok) return out;
  out.tokenFound = true;
  out.expiresOn = tok.expiresOn;
  out.expiresInSec = Number(tok.expiresOn) - Math.floor(Date.now() / 1000);
  out.target = (tok.target || '').slice(0, 120);
  const BASE = 'https://api.digitaldevelopment.wegmans.cloud';
  const H = { authorization: 'Bearer ' + tok.secret, accept: 'application/json' };
  const get = async (p) => {
    const t0 = Date.now();
    try {
      const r = await fetch(BASE + p, { headers: H });
      const t = await r.text();
      return { status: r.status, ms: Date.now() - t0, bytes: t.length, peek: t.slice(0, 800) };
    } catch (e) { return { err: String(e).slice(0, 120) }; }
  };
  out.carts = await get('/commerce/cart/carts/');
  return out;
})()
