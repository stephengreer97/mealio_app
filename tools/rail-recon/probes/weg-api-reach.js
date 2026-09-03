// READ ONLY. Is the commerce API reachable from this origin at all, and what
// does each variation do? No token is printed; auth variants send it but only
// the STATUS comes back.
(async () => {
  const b64 = (s) => { const t = String(s).replace(/-/g,'+').replace(/_/g,'/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const u = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; };
  const c = document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('msal.cache.encryption'));
  const meta = JSON.parse(decodeURIComponent(c.split('=').slice(1).join('=')));
  const ids = []; try { const m = window.msal && window.msal.clientIds;
    if (Array.isArray(m)) ids.push(...m); else if (m && typeof m==='object') ids.push(...Object.values(m).map(String)); } catch(e){}
  const base = await crypto.subtle.importKey('raw', b64(meta.key), 'HKDF', false, ['deriveKey']);
  let tok = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i); if (!k || !/msal/i.test(k)) continue;
    let j; try { j = JSON.parse(localStorage.getItem(k)||''); } catch(e){ continue; }
    if (!j || !j.data || !j.nonce) continue;
    const ctx = ids.find(id => id && k.includes(id)) || '';
    try {
      const dk = await crypto.subtle.deriveKey({name:'HKDF',salt:b64(j.nonce),hash:'SHA-256',info:new TextEncoder().encode(ctx)}, base, {name:'AES-GCM',length:256}, false, ['decrypt']);
      const o = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)}, dk, b64(j.data))));
      if (o.credentialType === 'AccessToken' && /wegmans\.cloud/.test(String(o.target||''))
          && Number(o.expiresOn||0) - Date.now()/1000 > 60) { tok = o.secret; break; }
    } catch(e){}
  }
  const out = { haveToken: !!tok, origin: location.origin, tries: [] };
  const B = 'https://api.digitaldevelopment.wegmans.cloud';
  const go = async (label, url, init) => {
    const t0 = Date.now();
    try { const r = await fetch(url, init);
      out.tries.push({ label, status: r.status, type: r.type, ms: Date.now()-t0 });
    } catch (e) { out.tries.push({ label, err: String(e && e.message).slice(0,90), ms: Date.now()-t0 }); }
  };
  await go('no auth, plain', B + '/commerce/account/customer', {});
  await go('no auth, accept', B + '/commerce/account/customer', { headers: { accept: 'application/json' } });
  if (tok) {
    await go('bearer only', B + '/commerce/account/customer', { headers: { authorization: 'Bearer ' + tok } });
    await go('bearer + accept', B + '/commerce/account/customer',
      { headers: { authorization: 'Bearer ' + tok, accept: 'application/json' } });
    await go('bearer, credentials omit', B + '/commerce/account/customer',
      { headers: { authorization: 'Bearer ' + tok }, credentials: 'omit' });
  }
  return out;
})()
