// A REAL WRITE. Stephen, 2026-09-03: "We are in development and you can write
// to my basket. You do not need my say so."
//
// Settles two things in one pass:
//   1. the envelope  — does POST {version, actions:[{action:'addLineItem'...}]}
//                      to the cart collection work, and what does it answer?
//   2. the semantics — commercetools addLineItem is ADDITIVE by definition, so
//                      writing quantity 1 against a line that already holds N
//                      should read back N+1, not 1. Measure it, do not assume.
//
// Then it PUTS THE QUANTITY BACK.
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

  const URL_ = 'https://api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/?api-version=2024-02-19-preview';
  const H = { authorization: 'Bearer ' + tok, accept: 'application/json', 'content-type': 'application/json' };
  const read = async () => {
    const r = await fetch(URL_, { headers: H });
    const j = JSON.parse(await r.text());
    const g = j.grocery || j.cart || j;
    const lines = (g.lineItems || []).map((li) => ({
      sku: li.variant && li.variant.sku != null ? String(li.variant.sku) : String(li.productKey || ''),
      lineId: li.id, qty: li.quantity,
      name: String((li.name && (li.name['en-US'] || li.name.en)) || '').slice(0, 34),
    }));
    return { version: g.version, id: g.id, lines };
  };

  const out = { steps: [] };
  const before = await read();
  if (!before.lines.length) return { why: 'cart is empty — nothing safe to measure against' };
  const target = before.lines[0];
  out.target = { sku: target.sku, name: target.name, qtyBefore: target.qty };

  const post = async (label, body) => {
    const t0 = Date.now();
    const r = await fetch(URL_, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    const row = { label, status: r.status, ms: Date.now() - t0 };
    if (r.status >= 400) row.error = txt.slice(0, 220);
    else if (j) row.answerKeys = Object.keys(j).slice(0, 10);
    out.steps.push(row);
    return { ok: r.status >= 200 && r.status < 300, json: j, status: r.status };
  };

  // The envelope, as commercetools defines it and their analytics implies.
  const add = await post('addLineItem qty 1', {
    version: before.version,
    actions: [{ action: 'addLineItem', sku: target.sku, quantity: 1 }],
  });
  const after = await read();
  const now = (after.lines.find((l) => l.sku === target.sku) || {}).qty;
  out.qtyAfter = now == null ? null : now;
  if (add.ok && now != null) {
    out.verdict = now === target.qty + 1 ? 'ADDITIVE — quantity is a delta'
      : now === 1 ? 'SET — quantity is absolute'
      : 'UNEXPECTED (' + now + ')';
  }

  // PUT IT BACK, whichever way it went.
  if (now != null && now !== target.qty) {
    const line = after.lines.find((l) => l.sku === target.sku);
    const restore = await post('restore', {
      version: after.version,
      actions: [{ action: 'changeLineItemQuantity', lineItemId: line.lineId, quantity: target.qty }],
    });
    const back = await read();
    const q = (back.lines.find((l) => l.sku === target.sku) || {}).qty;
    out.restoredTo = q == null ? null : q;
    out.restoreOk = restore.ok && q === target.qty;
  }
  return out;
})()
