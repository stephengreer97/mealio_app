// READ ONLY, value-blind. What credentials are in the cache and how long do
// they have left?
(async () => {
  const b64 = (s) => { const t = String(s).split('-').join('+').split('_').join('/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const u = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; };
  const uuids = (k) => (String(k).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []);
  const c = document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('msal.cache.encryption'));
  if (!c) return { why: 'no cookie' };
  const meta = JSON.parse(decodeURIComponent(c.split('=').slice(1).join('=')));
  const base = await crypto.subtle.importKey('raw', b64(meta.key), 'HKDF', false, ['deriveKey']);
  const out = { now: Math.floor(Date.now() / 1000), creds: [], cachedTok: null };
  try {
    const t = JSON.parse(localStorage.getItem('__mealio_weg_tok_v1') || 'null');
    out.cachedTok = t ? { hasV: !!t.v, at: t.at } : null;
  } catch (e) {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i); if (!k || k.indexOf('msal') < 0) continue;
    let j; try { j = JSON.parse(localStorage.getItem(k)||''); } catch(e){ continue; }
    if (!j || !j.data || !j.nonce) continue;
    for (const ctx of uuids(k).concat([''])) {
      try {
        const dk = await crypto.subtle.deriveKey({name:'HKDF',salt:b64(j.nonce),hash:'SHA-256',info:new TextEncoder().encode(ctx)}, base, {name:'AES-GCM',length:256}, false, ['decrypt']);
        const o = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)}, dk, b64(j.data))));
        out.creds.push({
          type: o.credentialType,
          target: String(o.target || '').slice(0, 46),
          secondsLeft: o.expiresOn ? Number(o.expiresOn) - Math.floor(Date.now() / 1000) : null,
          hasSecret: !!o.secret,
          clientId: o.clientId ? String(o.clientId).slice(0, 8) + '…' : null,
          realm: o.realm ? String(o.realm).slice(0, 24) : null,
          env: o.environment ? String(o.environment).slice(0, 40) : null,
        });
        break;
      } catch (e) {}
    }
  }
  return out;
})()
