// MSAL's real scheme, read out of their own bundle:
//   salt = base64(entry.nonce)            (16 bytes, stored as "nonce")
//   info = clientId when the storage key contains it, else ""
//   key  = HKDF-SHA256(cookie.key, salt, info) -> AES-GCM 256
//   iv   = TWELVE ZERO BYTES              (not the stored nonce)
//
// VALUE-BLIND: reports field names, lengths and a token's expiry. Never a
// token, never key material, never a plaintext value.
(async () => {
  const out = { tried: 0, ok: 0, samples: [] };
  const b64 = (s) => {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  const c = document.cookie.split(';').map((x) => x.trim())
    .find((x) => x.startsWith('msal.cache.encryption'));
  if (!c) return { why: 'no encryption cookie' };
  const meta = JSON.parse(decodeURIComponent(c.split('=').slice(1).join('=')));

  const clientIds = [];
  try {
    const m = window.msal && window.msal.clientIds;
    if (Array.isArray(m)) clientIds.push(...m);
    else if (m && typeof m === 'object') clientIds.push(...Object.values(m).map(String));
    else if (typeof m === 'string') clientIds.push(m);
  } catch (e) { /* none */ }
  out.clientIdCount = clientIds.length;

  const base = await crypto.subtle.importKey('raw', b64(meta.key), 'HKDF', false, ['deriveKey']);
  const derive = async (salt, info) => crypto.subtle.deriveKey(
    { name: 'HKDF', salt, hash: 'SHA-256', info: new TextEncoder().encode(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !/msal/i.test(k)) continue;
    let j;
    try { j = JSON.parse(localStorage.getItem(k) || ''); } catch (e) { continue; }
    if (!j || !j.data || !j.nonce) continue;
    out.tried += 1;
    // getContext: the clientId only when the key carries it.
    const hit = clientIds.find((id) => id && k.includes(id));
    const contexts = [hit || '', ''];
    const row = { key: k.slice(0, 64), usedContext: null };
    for (const ctx of Array.from(new Set(contexts))) {
      try {
        const dk = await derive(b64(j.nonce), ctx);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, dk, b64(j.data));
        const txt = new TextDecoder().decode(pt);
        out.ok += 1;
        row.usedContext = ctx ? 'clientId' : '(empty)';
        row.bytes = txt.length;
        try {
          const o = JSON.parse(txt);
          row.fields = Object.keys(o).slice(0, 12);
          row.credentialType = o.credentialType || null;
          if (o.secret) {
            row.secretLen = String(o.secret).length;
            row.looksJwt = /^ey[A-Za-z0-9_-]+\./.test(String(o.secret));
            if (row.looksJwt) {
              const cl = JSON.parse(new TextDecoder().decode(b64(String(o.secret).split('.')[1])));
              row.secondsLeft = cl.exp ? Math.round(cl.exp - Date.now() / 1000) : null;
              row.aud = cl.aud ? 'present' : null;
              row.scopeNames = cl.scp ? String(cl.scp).split(' ').slice(0, 6) : null;
            }
          }
          if (o.target) row.target = String(o.target).slice(0, 80);
        } catch (e) { row.plaintextKind = 'non-json'; }
        break;
      } catch (e) { row.lastErr = String(e && e.message || e).slice(0, 60); }
    }
    out.samples.push(row);
    if (out.samples.length >= 8) break;
  }
  return out;
})()
