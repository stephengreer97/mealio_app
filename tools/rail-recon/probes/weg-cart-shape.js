// READ ONLY — one GET. The cart endpoint the shop app actually uses.
// Field NAMES and structure only; the one value reported is the store number.
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
            && Number(o.expiresOn||0) - Date.now()/1000 > 60) tok = o.secret;
        break;
      } catch (e) {}
    }
  }
  if (!tok) return { why: 'no token' };
  const t0 = Date.now();
  const r = await fetch('https://api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/?api-version=2024-02-19-preview',
    { headers: { authorization: 'Bearer ' + tok, accept: 'application/json' } });
  const txt = await r.text();
  const out = { status: r.status, ms: Date.now() - t0, bytes: txt.length };
  let j = null; try { j = JSON.parse(txt); } catch (e) { out.why = 'non-json'; return out; }
  out.topKeys = Object.keys(j).slice(0, 12);
  const g = j.grocery || j;
  out.groceryKeys = g && typeof g === 'object' ? Object.keys(g).slice(0, 24) : null;
  try {
    out.customFields = (g.custom.customFieldsRaw || []).map((f, i) => ({
      i, name: f.name,
      value: /store|site|shop|location|fulfil/i.test(String(f.name)) ? String(f.value).slice(0, 24) : '(withheld)',
    })).slice(0, 24);
  } catch (e) { out.customFieldsErr = String(e && e.message).slice(0, 60); }
  // Line-item shape — what an add would have to speak.
  try {
    const li = g.lineItems || g.items || [];
    out.lineCount = li.length;
    out.lineKeys = li[0] ? Object.keys(li[0]).slice(0, 20) : null;
    out.cartId = g.id ? String(g.id).slice(0, 8) + '…' : null;
    out.version = g.version != null ? g.version : null;
  } catch (e) {}
  return out;
})()
