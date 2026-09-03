// Set one line to an exact quantity. Tidying after measurement.
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
  const V = 'api-version=2024-02-19-preview';
  const H = { authorization: 'Bearer ' + tok, accept: 'application/json', 'content-type': 'application/json' };
  const read = async () => {
    const r = await fetch(B + '/commerce/cart/carts/?' + V, { headers: H });
    const g = (JSON.parse(await r.text()).grocery) || {};
    let sn = null;
    for (const f of (g.custom && g.custom.customFieldsRaw) || []) if (f.name === 'storeNumber') sn = f.value;
    return { id: g.id, version: g.version, sn, lines: (g.lineItems || []).map((li) => ({
      sku: li.variant && li.variant.sku ? String(li.variant.sku) : String(li.productKey || ''),
      lineId: li.id, qty: li.quantity,
      sold: li.custom, price: li.price })) };
  };
  const TARGETS = { '71489': 1 };
  const out = [];
  for (const sku of Object.keys(TARGETS)) {
    const before = await read();
    const line = before.lines.find((l) => l.sku === sku);
    if (!line || line.qty === TARGETS[sku]) { out.push({ sku, skipped: true, qty: line ? line.qty : 0 }); continue; }
    const r = await fetch(B + '/commerce/cart/carts/lineitems?' + V, { method: 'POST', headers: H,
      body: JSON.stringify({ StoreKey: '140-CHAPEL-HILL',
        cartData: [{ cartID: before.id, cartVersion: before.version,
          custom: [{ name: 'orderLevelAdjustments', value: '[]' },
                   { name: 'storeNumber', value: String(before.sn) },
                   { name: 'fulfillmentType', value: 'pickup' }],
          isAlcoholic: false,
          lineItems: [{ id: line.lineId, custom: [{ name: 'itemLevelAdjustments', value: '[]' }],
            distributionChannelKey: '140-Delivery', isAlcoholic: false, isSoldByWeight: false,
            onlineApproxUnitWeight: 0, onlineSellByUnit: 'ea', quantity: TARGETS[sku],
            sku: sku, standalonePrice: 199 }] }],
        customerEmail: 'x', customerID: 'x' }) });
    const after = await read();
    const l2 = after.lines.find((l) => l.sku === sku);
    out.push({ sku, status: r.status, from: line.qty, to: l2 ? l2.qty : 0 });
  }
  return out;
})()
