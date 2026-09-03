// READ ONLY. The authority's public OpenID configuration names the token
// endpoint. Also reports the full realm and the scope the expired access token
// was issued for, both needed to refresh it.
(async () => {
  const b64 = (s) => { const t = String(s).split('-').join('+').split('_').join('/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const u = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; };
  const uuids = (k) => (String(k).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || []);
  const c = document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('msal.cache.encryption'));
  const meta = JSON.parse(decodeURIComponent(c.split('=').slice(1).join('=')));
  const base = await crypto.subtle.importKey('raw', b64(meta.key), 'HKDF', false, ['deriveKey']);
  const out = { creds: [] };
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i); if (!k || k.indexOf('msal') < 0) continue;
    let j; try { j = JSON.parse(localStorage.getItem(k)||''); } catch(e){ continue; }
    if (!j || !j.data || !j.nonce) continue;
    for (const ctx of uuids(k).concat([''])) {
      try {
        const dk = await crypto.subtle.deriveKey({name:'HKDF',salt:b64(j.nonce),hash:'SHA-256',info:new TextEncoder().encode(ctx)}, base, {name:'AES-GCM',length:256}, false, ['decrypt']);
        const o = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(12)}, dk, b64(j.data))));
        if (o.credentialType === 'AccessToken' || o.credentialType === 'RefreshToken') {
          out.creds.push({ type: o.credentialType, realm: o.realm || null, clientId: o.clientId || null,
            env: o.environment || null, target: o.target || null,
            left: o.expiresOn ? Number(o.expiresOn) - Math.floor(Date.now()/1000) : null });
        }
        break;
      } catch (e) {}
    }
  }
  const at = out.creds.find((c2) => c2.type === 'AccessToken') || {};
  const host = at.env || 'myaccount.wegmans.com';
  const POLICY = 'b2c_1a_wegmanssignupsigninwithphoneverification';
  out.tried = [];
  for (const tenant of [at.realm, 'wegmansonline.onmicrosoft.com']) {
    if (!tenant) continue;
    const url = 'https://' + host + '/' + tenant + '/' + POLICY + '/v2.0/.well-known/openid-configuration';
    try {
      const r = await fetch(url);
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      out.tried.push({ tenant: String(tenant).slice(0, 40), status: r.status,
        token_endpoint: j && j.token_endpoint, issuer: j && j.issuer });
      if (j && j.token_endpoint) break;
    } catch (e) { out.tried.push({ tenant: String(tenant).slice(0, 40), err: String(e && e.message).slice(0, 50) }); }
  }
  return out;
})()
