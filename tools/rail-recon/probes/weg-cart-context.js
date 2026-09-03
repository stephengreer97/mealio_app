// READ ONLY. Is the old basket a DELIVERY cart that still exists beside the
// pickup one this session created?
(async () => {
  const b64 = (s) => { const t = String(s).split('-').join('+').split('_').join('/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const u = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; };
  const uuids = (k) => (String(k).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []);
  const c = document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('msal.cache.encryption'));
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
  const B = 'https://api.digitaldevelopment.wegmans.cloud';
  const H = { authorization: 'Bearer ' + tok, accept: 'application/json' };
  const out = {};
  const r = await fetch(B + '/commerce/cart/carts/?api-version=2024-02-19-preview', { headers: H });
  const j = JSON.parse(await r.text());
  out.topKeys = Object.keys(j);
  for (const k of Object.keys(j)) {
    const cart = j[k];
    if (!cart || typeof cart !== 'object') { out[k] = String(cart); continue; }
    let ft = null, sn = null;
    try {
      for (const f of (cart.custom && cart.custom.customFieldsRaw) || []) {
        if (f.name === 'fulfillmentType') ft = f.value;
        if (f.name === 'storeNumber') sn = f.value;
      }
    } catch (e) {}
    out[k] = { id: cart.id, version: cart.version, fulfillmentType: ft, storeNumber: sn,
      lines: (cart.lineItems || []).length,
      qty: (cart.lineItems || []).reduce((a, l) => a + (l.quantity || 0), 0),
      names: (cart.lineItems || []).slice(0, 12).map((li) => ({
        sku: li.variant && li.variant.sku, qty: li.quantity,
        name: String((li.name && (li.name['en-US'] || li.name.en)) || '').slice(0, 38) })) };
  }
  return out;
})()
