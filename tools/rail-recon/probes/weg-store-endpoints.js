// READ ONLY — GETs only. Which commerce endpoint names the CURRENT store?
// Field paths only; values only for store-ish names (a shop, not a person).
(async () => {
  const b64 = (s) => { const t = String(s).split('-').join('+').split('_').join('/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const u = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; };
  const uuids = (k) => (String(k).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []);
  const c = document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('msal.cache.encryption'));
  if (!c) return { why: 'no cookie' };
  const meta = JSON.parse(decodeURIComponent(c.split('=').slice(1).join('=')));
  const base = await crypto.subtle.importKey('raw', b64(meta.key), 'HKDF', false, ['deriveKey']);
  let tok = null;
  for (let i = 0; i < localStorage.length && !tok; i++) {
    const k = localStorage.key(i); if (!k || k.indexOf('msal') < 0) continue;
    let j; try { j = JSON.parse(localStorage.getItem(k)||''); } catch(e){ continue; }
    if (!j || !j.data || !j.nonce) continue;
    for (const ctx of uuids(k).concat([''])) {
      try {
        const dk = await crypto.subtle.deriveKey({name:'HKDF',salt:b64(j.nonce),hash:'SHA-256',info:new TextEncoder().encode(ctx)}, base, {name:'AES-GCM',length:256}, false, ['decrypt']);
        const o = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)}, dk, b64(j.data))));
        if (o.credentialType === 'AccessToken' && String(o.target||'').indexOf('wegmans.cloud') >= 0
            && Number(o.expiresOn||0) - Date.now()/1000 > 60) { tok = o.secret; }
        break;
      } catch (e) {}
    }
  }
  if (!tok) return { why: 'no token on this page' };
  const B = 'https://api.digitaldevelopment.wegmans.cloud';
  const EP = [
    ['/commerce/my-items', '2024-01-26'],
    ['/commerce/order/orders/activeorders', '2024-03-04-preview'],
    ['/commerce/saved-list/savedlists', '2024-02-20-preview'],
    ['/commerce/account/addresses', '2024-03-06-preview'],
  ];
  const storeish = (obj) => {
    const found = [];
    const walk = (n, p, d) => {
      if (n == null || d > 7 || found.length > 14) return;
      if (Array.isArray(n)) { if (n[0]) walk(n[0], p + '[]', d + 1); return; }
      if (typeof n === 'object') { for (const k of Object.keys(n)) walk(n[k], p ? p + '.' + k : k, d + 1); return; }
      if (/store|site|fulfil|location|shop|pickup/i.test(p)) found.push(p + ' = ' + String(n).slice(0, 24));
    };
    walk(obj, '', 0); return found;
  };
  const out = [];
  for (const [path, v] of EP) {
    const t0 = Date.now();
    try {
      const r = await fetch(B + path + '?api-version=' + v, { headers: { authorization: 'Bearer ' + tok, accept: 'application/json' } });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      out.push({ path, status: r.status, ms: Date.now() - t0, bytes: txt.length,
                 topKeys: j && typeof j === 'object' ? Object.keys(j).slice(0, 10) : null,
                 storeFields: j ? storeish(j) : null });
    } catch (e) { out.push({ path, err: String(e && e.message).slice(0, 70) }); }
  }
  return { origin: location.origin, results: out };
})()
