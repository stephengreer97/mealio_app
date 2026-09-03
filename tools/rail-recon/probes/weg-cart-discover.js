// READ ONLY — GETs only, no writes. Find the cart endpoint and the store it is
// bound to. Reports status, timing and FIELD NAMES; values only for store-ish
// fields, which name a shop and not a person.
(async () => {
  const b64 = (s) => { const t = String(s).replace(/-/g,'+').replace(/_/g,'/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const u = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; };
  const c = document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('msal.cache.encryption'));
  const meta = JSON.parse(decodeURIComponent(c.split('=').slice(1).join('=')));
  const ids = []; try { const m = window.msal && window.msal.clientIds;
    if (Array.isArray(m)) ids.push(...m); else if (m && typeof m==='object') ids.push(...Object.values(m).map(String)); } catch(e){}
  const base = await crypto.subtle.importKey('raw', b64(meta.key), 'HKDF', false, ['deriveKey']);
  let tok = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i); if (!k || !/msal/i.test(k)) continue;
    let j; try { j = JSON.parse(localStorage.getItem(k)||''); } catch(e){ continue; }
    if (!j || !j.data || !j.nonce) continue;
    const ctx = ids.find(id => id && k.includes(id)) || '';
    try {
      const dk = await crypto.subtle.deriveKey({name:'HKDF',salt:b64(j.nonce),hash:'SHA-256',info:new TextEncoder().encode(ctx)}, base, {name:'AES-GCM',length:256}, false, ['decrypt']);
      const o = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)}, dk, b64(j.data))));
      if (o.credentialType === 'AccessToken' && /wegmans\.cloud/.test(String(o.target||''))
          && Number(o.expiresOn||0) - Date.now()/1000 > 60) { tok = o.secret; break; }
    } catch(e){}
  }
  if (!tok) return { why: 'no token' };
  const B = 'https://api.digitaldevelopment.wegmans.cloud';
  const V = ['2024-03-06-preview', '2024-01-26', '2024-03-04-preview', '2024-02-20-preview'];
  const out = { tried: [] };
  const storeish = (obj) => {
    const found = [];
    const walk = (n, p, d) => {
      if (!n || d > 6 || found.length > 8) return;
      if (Array.isArray(n)) { if (n[0]) walk(n[0], p + '[]', d + 1); return; }
      if (typeof n === 'object') { for (const k of Object.keys(n)) walk(n[k], p ? p + '.' + k : k, d + 1); return; }
      if (/store|site|fulfil|location|shop/i.test(p)) found.push(p + '=' + String(n).slice(0, 24));
    };
    walk(obj, '', 0); return found;
  };
  for (const path of ['/commerce/cart/carts/active', '/commerce/cart/carts', '/commerce/cart/active',
                      '/commerce/carts/active', '/commerce/order/carts/active', '/commerce/cart']) {
    for (const v of V.slice(0, 2)) {
      const url = B + path + '?api-version=' + v;
      const t0 = Date.now();
      try {
        const r = await fetch(url, { headers: { authorization: 'Bearer ' + tok, accept: 'application/json' } });
        const txt = await r.text();
        let j = null; try { j = JSON.parse(txt); } catch (e) {}
        const row = { path, v, status: r.status, ms: Date.now() - t0, bytes: txt.length };
        if (r.status === 200 && j) { row.keys = Object.keys(j).slice(0, 14); row.storeFields = storeish(j); }
        else if (txt) row.peek = txt.slice(0, 90);
        out.tried.push(row);
        if (r.status === 200) return out;
      } catch (e) { out.tried.push({ path, v, err: String(e && e.message).slice(0, 60) }); }
    }
  }
  return out;
})()
