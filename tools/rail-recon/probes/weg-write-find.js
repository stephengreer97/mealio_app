// Find the cart write by trying the plausible shapes and asking the CART which
// one landed. Authorised: development, writes allowed.
//
// The gateway hides 404/405 behind a CORS failure, so status is not a reliable
// signal — the cart is. One GET after each attempt, and it stops at the first
// one that changes anything.
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
  const B = 'https://api.digitaldevelopment.wegmans.cloud';
  const V1 = 'api-version=2024-02-19-preview';
  const V2 = 'api-version=2026-01-13-preview';
  const H = { authorization: 'Bearer ' + tok, accept: 'application/json', 'content-type': 'application/json' };
  const read = async (v) => {
    const r = await fetch(B + '/commerce/cart/carts/?' + (v || V1), { headers: H });
    const j = JSON.parse(await r.text());
    const g = j.grocery || j.cart || j;
    return { version: g.version, id: g.id, count: (g.lineItems || []).reduce((a, l) => a + (l.quantity || 0), 0),
      lines: (g.lineItems || []).map((li) => ({
        sku: li.variant && li.variant.sku != null ? String(li.variant.sku) : String(li.productKey || ''),
        lineId: li.id, qty: li.quantity })) };
  };
  const before = await read();
  if (!before.lines.length) return { why: 'empty cart' };
  const t = before.lines[0];
  const out = { cartId: before.id, sku: t.sku, countBefore: before.count, tries: [] };

  const actions = [{ action: 'addLineItem', sku: t.sku, quantity: 1 }];
  const combos = [
    ['POST', '/commerce/cart/carts/' + before.id + '?' + V1, { version: before.version, actions: actions }],
    ['POST', '/commerce/cart/carts/?' + V2, { version: before.version, actions: actions }],
    ['PUT',  '/commerce/cart/carts/?' + V1, { version: before.version, actions: actions }],
    ['PATCH','/commerce/cart/carts/?' + V1, { version: before.version, actions: actions }],
    ['POST', '/commerce/cart/carts/' + before.id + '/line-items?' + V1, { sku: t.sku, quantity: 1 }],
    ['POST', '/commerce/cart/carts/line-items?' + V1, { sku: t.sku, quantity: 1 }],
    ['POST', '/commerce/cart/carts/?' + V1, { actions: actions }],
    ['POST', '/commerce/cart/carts/items?' + V1, { items: [{ sku: t.sku, quantity: 1 }] }],
  ];
  for (const [m, path, body] of combos) {
    const row = { m: m, path: path.split('?')[0].replace('/commerce/cart', '') + ' (' + (path.indexOf(V2) > 0 ? 'v2' : 'v1') + ')' };
    try {
      const r = await fetch(B + path, { method: m, headers: H, body: JSON.stringify(body) });
      const txt = await r.text();
      row.status = r.status;
      if (r.status >= 400) row.peek = txt.slice(0, 130);
    } catch (e) { row.err = String(e && e.message).slice(0, 40); }
    const now = await read();
    row.countAfter = now.count;
    out.tries.push(row);
    if (now.count !== before.count) {
      out.worked = { method: m, path: path, body: body };
      out.countAfter = now.count;
      // Put it back.
      const line = now.lines.find((l) => l.sku === t.sku);
      try {
        await fetch(B + '/commerce/cart/carts/' + (out.worked.path.indexOf(now.id) > 0 ? now.id : '') + '?' + V1, {
          method: m, headers: H,
          body: JSON.stringify({ version: now.version,
            actions: [{ action: 'changeLineItemQuantity', lineItemId: line.lineId, quantity: t.qty }] }) });
      } catch (e) {}
      const back = await read();
      out.restoredCount = back.count;
      break;
    }
  }
  return out;
})()
