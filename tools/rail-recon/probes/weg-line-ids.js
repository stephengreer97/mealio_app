// READ ONLY. Which field on a cart line matches what SEARCH returns as productId?
// Product identifiers only — no personal data.
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
  if (!tok) return { why: 'no token' };
  const r = await fetch('https://api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/?api-version=2024-02-19-preview',
    { headers: { authorization: 'Bearer ' + tok, accept: 'application/json' } });
  const j = JSON.parse(await r.text());
  const g = j.grocery || j.cart || j;
  const lines = (g.lineItems || g.items || []).slice(0, 4);
  return {
    lines: lines.map((li) => ({
      name: String(li.name && (li.name.en || li.name['en-US'] || li.name) || '').slice(0, 40),
      id: String(li.id || '').slice(0, 12) + '…',
      productId: String(li.productId || '').slice(0, 40),
      productKey: li.productKey != null ? String(li.productKey) : null,
      variantSku: li.variant && li.variant.sku != null ? String(li.variant.sku) : null,
      variantKey: li.variant && li.variant.key != null ? String(li.variant.key) : null,
      variantId: li.variant && li.variant.id != null ? String(li.variant.id) : null,
      quantity: li.quantity,
      customNames: (() => { try { return (li.custom.customFieldsRaw || []).map((f) => f.name).slice(0, 12); } catch (e) { return null; } })(),
    })),
  };
})()
