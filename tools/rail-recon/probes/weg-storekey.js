// READ ONLY. Where do StoreKey and the customer id come from?
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
  // the cart's own custom fields, all of them
  const rc = await fetch(B + '/commerce/cart/carts/?api-version=2024-02-19-preview', { headers: H });
  const jc = JSON.parse(await rc.text());
  const g = jc.grocery || jc.cart || jc;
  out.cartCustom = (g.custom && g.custom.customFieldsRaw || []).map((f) => ({
    name: f.name, value: /store|fulfil|adjust/i.test(f.name) ? String(f.value).slice(0, 30) : '(withheld)' }));
  out.cartTopKeys = Object.keys(g).slice(0, 22);
  out.storeKeyish = [];
  const walk = (n, p, d) => {
    if (n == null || d > 4 || out.storeKeyish.length > 6) return;
    if (Array.isArray(n)) { if (n[0]) walk(n[0], p + '[]', d + 1); return; }
    if (typeof n === 'object') { for (const k of Object.keys(n)) walk(n[k], p ? p + '.' + k : k, d + 1); return; }
    if (typeof n === 'string' && /^\d{2,4}-[A-Z]/.test(n)) out.storeKeyish.push(p + ' = ' + n);
  };
  walk(g, '', 0);
  // customer id + email presence
  const rp = await fetch(B + '/commerce/account/customer?api-version=2024-03-06-preview', { headers: H });
  const jp = JSON.parse(await rp.text());
  out.customer = { hasId: !!(jp.customer && jp.customer.id), hasEmail: !!(jp.customer && jp.customer.email) };
  // /api/stores entry for 140
  const rs = await fetch('/api/stores', { headers: { accept: 'application/json' } });
  const js = JSON.parse(await rs.text());
  const s140 = (Array.isArray(js) ? js : []).find((s) => String(s.storeNumber) === '140');
  out.store140 = s140 ? { keys: Object.keys(s140).slice(0, 20), name: s140.name, iwsName: s140.iwsName,
    storeKeyish: Object.keys(s140).filter((k) => /key/i.test(k)).map((k) => k + '=' + String(s140[k]).slice(0, 24)) } : null;
  return out;
})()
