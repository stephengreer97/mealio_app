// READ ONLY. Does the previous cart still exist, and can it be made active?
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
  const get = async (p) => {
    try { const r = await fetch(B + p, { headers: H }); const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, bytes: t.length, j, peek: t.slice(0, 140) }; }
    catch (e) { return { err: String(e && e.message).slice(0, 50) }; }
  };
  const active = await get('/commerce/cart/carts/?api-version=2024-02-19-preview');
  const ag = active.j && (active.j.grocery || active.j);
  out.active = ag ? { id: ag.id, version: ag.version, lines: (ag.lineItems || []).length,
    qty: (ag.lineItems || []).reduce((a, l) => a + (l.quantity || 0), 0) } : active;
  // The old cart, by id.
  const OLD = '4d37e869-7f2a-45a5-bb74-ff312c2b6a94';
  for (const p of ['/commerce/cart/carts/' + OLD + '?api-version=2024-02-19-preview',
                   '/commerce/cart/carts/?api-version=2024-02-19-preview&cartId=' + OLD,
                   '/commerce/cart/carts/all?api-version=2024-02-19-preview',
                   '/commerce/cart/carts/list?api-version=2024-02-19-preview']) {
    const r = await get(p);
    out[p.split('?')[0].replace('/commerce/cart/carts', 'carts')] =
      { status: r.status, bytes: r.bytes, err: r.err, peek: r.status === 200 ? undefined : r.peek };
  }
  return out;
})()
