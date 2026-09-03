// Can the lineitems endpoint change an EXISTING line? Try the other methods
// with the same envelope. Authorised: development, writes allowed.
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
  const V = 'api-version=2024-02-19-preview';
  const H = { authorization: 'Bearer ' + tok, accept: 'application/json', 'content-type': 'application/json' };
  const read = async () => {
    const r = await fetch(B + '/commerce/cart/carts/?' + V, { headers: H });
    const g = (JSON.parse(await r.text()).grocery) || {};
    let sn = null;
    for (const f of (g.custom && g.custom.customFieldsRaw) || []) if (f.name === 'storeNumber') sn = f.value;
    return { id: g.id, version: g.version, storeNumber: sn,
      lines: (g.lineItems || []).map((li) => ({
        sku: li.variant && li.variant.sku ? String(li.variant.sku) : String(li.productKey || ''),
        lineId: li.id, qty: li.quantity })) };
  };
  const SKU = '71489';
  const before = await read();
  const line = before.lines.find((l) => l.sku === SKU);
  if (!line) return { why: 'sku not in cart' };
  const out = { qtyBefore: line.qty, tries: [] };

  const envelope = (qty, withLineId) => ({
    StoreKey: '140-CHAPEL-HILL',
    cartData: [{
      cartID: before.id, cartVersion: before.version,
      custom: [{ name: 'orderLevelAdjustments', value: '[]' },
               { name: 'storeNumber', value: String(before.storeNumber) },
               { name: 'fulfillmentType', value: 'pickup' }],
      isAlcoholic: false,
      lineItems: [Object.assign({
        custom: [{ name: 'itemLevelAdjustments', value: '[]' }],
        distributionChannelKey: '140-Delivery', isAlcoholic: false, isSoldByWeight: false,
        onlineApproxUnitWeight: 0, onlineSellByUnit: 'ea', quantity: qty,
        sku: SKU, standalonePrice: 199,
      }, withLineId ? { id: line.lineId, lineItemId: line.lineId } : {})],
    }],
    customerEmail: 'x', customerID: 'x',
  });

  // WHICH FIELD carries the line? Both were sent together the first time, which
  // proves only that one of them works. Try them one at a time.
  const only = (qty, field) => {
    const e = envelope(qty, false);
    e.cartData[0].lineItems[0][field] = line.lineId;
    return e;
  };
  const target = out.qtyBefore + 1;
  const attempts = [
    ['POST  lineitems, id only', 'POST', '/commerce/cart/carts/lineitems?' + V, only(target, 'id')],
    ['POST  lineitems, lineItemId only', 'POST', '/commerce/cart/carts/lineitems?' + V, only(target, 'lineItemId')],
  ];
  for (const [label, m, path, body] of attempts) {
    const row = { label };
    try {
      const r = await fetch(B + path, { method: m, headers: H, body: JSON.stringify(body) });
      const txt = await r.text();
      row.status = r.status;
      if (r.status >= 400) row.peek = txt.slice(0, 120);
    } catch (e) { row.err = String(e && e.message).slice(0, 40); }
    const now = await read();
    const l2 = now.lines.find((l) => l.sku === SKU);
    row.qtyNow = l2 ? l2.qty : 0;
    out.tries.push(row);
    if (row.qtyNow !== out.qtyBefore) { out.worked = label; break; }
  }
  return out;
})()
