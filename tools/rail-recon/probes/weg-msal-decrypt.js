// Can the MSAL cache be read in-page, with no network and no page of our own?
//
// VALUE-BLIND BY CONSTRUCTION. It reports whether decryption worked, which
// fields the plaintext has, and a token's expiry. It never returns a token, a
// key, a nonce, or any plaintext value — only field NAMES and lengths.
(async () => {
  const out = { tried: 0, ok: 0, samples: [] };
  const b64 = (s) => {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const pad = t + '==='.slice((t.length + 3) % 4);
    const bin = atob(pad);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  const c = document.cookie.split(';').map((x) => x.trim()).find((x) => x.startsWith('msal.cache.encryption'));
  if (!c) return { why: 'no encryption cookie' };
  const meta = JSON.parse(decodeURIComponent(c.split('=').slice(1).join('=')));
  out.cookieId = meta.id ? meta.id.slice(0, 8) + '…' : null;

  let key;
  try {
    key = await crypto.subtle.importKey('raw', b64(meta.key), { name: 'AES-GCM' }, false, ['decrypt']);
  } catch (e) { return { why: 'importKey failed', detail: String(e && e.message).slice(0, 140) }; }

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !/msal/i.test(k)) continue;
    let j;
    try { j = JSON.parse(localStorage.getItem(k) || ''); } catch (e) { continue; }
    if (!j || !j.data || !j.nonce) continue;
    out.tried += 1;
    const row = { key: k.slice(0, 70), idMatches: j.id === meta.id };
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64(j.nonce) }, key, b64(j.data));
      const txt = new TextDecoder().decode(pt);
      out.ok += 1;
      row.decrypted = true;
      row.bytes = txt.length;
      try {
        const o = JSON.parse(txt);
        row.fields = Object.keys(o).slice(0, 14);
        // A token's SHAPE, never its value.
        if (o.secret) {
          row.secretLen = String(o.secret).length;
          row.looksJwt = /^ey[A-Za-z0-9_-]+\./.test(String(o.secret));
          if (row.looksJwt) {
            try {
              const claims = JSON.parse(new TextDecoder().decode(b64(String(o.secret).split('.')[1])));
              row.exp = claims.exp || null;
              row.secondsLeft = claims.exp ? Math.round(claims.exp - Date.now() / 1000) : null;
              row.claimNames = Object.keys(claims).slice(0, 14);
            } catch (e) { row.claimErr = 'undecodable'; }
          }
        }
        if (o.credentialType) row.credentialType = o.credentialType;
        if (o.tokenType) row.tokenType = o.tokenType;
        if (o.target) row.targetLen = String(o.target).length;
      } catch (e) { row.plaintextKind = 'non-json'; }
    } catch (e) {
      row.decrypted = false;
      row.err = String(e && e.message || e).slice(0, 80);
    }
    out.samples.push(row);
    if (out.samples.length >= 8) break;
  }
  return out;
})()
