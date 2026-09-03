// Which POST shape does the gateway accept from this origin?
// A real write either way; the cart is read back and restored.
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
  const URL_ = 'https://api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/?api-version=2024-02-19-preview';
  const read = async () => {
    const r = await fetch(URL_, { headers: { authorization: 'Bearer ' + tok, accept: 'application/json' } });
    const j = JSON.parse(await r.text());
    const g = j.grocery || j.cart || j;
    return { version: g.version, lines: (g.lineItems || []).map((li) => ({
      sku: li.variant && li.variant.sku != null ? String(li.variant.sku) : String(li.productKey || ''),
      lineId: li.id, qty: li.quantity })) };
  };
  const before = await read();
  if (!before.lines.length) return { why: 'empty cart' };
  const t = before.lines[0];
  const body = JSON.stringify({ version: before.version,
    actions: [{ action: 'addLineItem', sku: t.sku, quantity: 1 }] });

  const out = { sku: t.sku, qtyBefore: t.qty, tries: [] };
  const attempts = [
    ['json content-type', { method: 'POST', headers: { authorization: 'Bearer ' + tok, accept: 'application/json', 'content-type': 'application/json' }, body }],
    ['text/plain (no preflight)', { method: 'POST', headers: { authorization: 'Bearer ' + tok, 'content-type': 'text/plain' }, body }],
    ['no content-type', { method: 'POST', headers: { authorization: 'Bearer ' + tok }, body }],
  ];
  for (const [label, init] of attempts) {
    const t0 = Date.now();
    try {
      const r = await fetch(URL_, init);
      const txt = await r.text();
      out.tries.push({ label, status: r.status, ms: Date.now() - t0, peek: r.status >= 400 ? txt.slice(0, 160) : 'ok' });
      if (r.status >= 200 && r.status < 300) { out.worked = label; break; }
    } catch (e) {
      out.tries.push({ label, err: String(e && e.message).slice(0, 60), ms: Date.now() - t0 });
    }
  }
  const after = await read();
  const now = (after.lines.find((l) => l.sku === t.sku) || {}).qty;
  out.qtyAfter = now == null ? null : now;
  if (now != null && now !== t.qty) {
    out.verdict = now === t.qty + 1 ? 'ADDITIVE' : (now === 1 ? 'SET' : 'UNEXPECTED');
    const line = after.lines.find((l) => l.sku === t.sku);
    try {
      const rr = await fetch(URL_, { method: 'POST',
        headers: { authorization: 'Bearer ' + tok, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ version: after.version,
          actions: [{ action: 'changeLineItemQuantity', lineItemId: line.lineId, quantity: t.qty }] }) });
      out.restoreStatus = rr.status;
    } catch (e) { out.restoreErr = String(e && e.message).slice(0, 60); }
    const back = await read();
    out.restoredTo = (back.lines.find((l) => l.sku === t.sku) || {}).qty ?? null;
  }
  return out;
})()
