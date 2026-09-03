// READ ONLY. Decrypt the MSAL access token, then use it for ONE GET.
// Never prints the token. Reports HTTP status and the store number only.
(async () => {
  const b64 = (s) => {
    const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  const c = document.cookie.split(';').map((x) => x.trim())
    .find((x) => x.startsWith('msal.cache.encryption'));
  if (!c) return { why: 'no cookie' };
  const meta = JSON.parse(decodeURIComponent(c.split('=').slice(1).join('=')));
  const ids = [];
  try {
    const m = window.msal && window.msal.clientIds;
    if (Array.isArray(m)) ids.push(...m);
    else if (m && typeof m === 'object') ids.push(...Object.values(m).map(String));
  } catch (e) {}
  const base = await crypto.subtle.importKey('raw', b64(meta.key), 'HKDF', false, ['deriveKey']);

  let best = null;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !/msal/i.test(k)) continue;
    let j; try { j = JSON.parse(localStorage.getItem(k) || ''); } catch (e) { continue; }
    if (!j || !j.data || !j.nonce) continue;
    const ctx = ids.find((id) => id && k.includes(id)) || '';
    try {
      const dk = await crypto.subtle.deriveKey(
        { name: 'HKDF', salt: b64(j.nonce), hash: 'SHA-256', info: new TextEncoder().encode(ctx) },
        base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const txt = new TextDecoder().decode(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, dk, b64(j.data)));
      const o = JSON.parse(txt);
      if (o.credentialType !== 'AccessToken' || !o.secret) continue;
      const left = Number(o.expiresOn || 0) - Math.floor(Date.now() / 1000);
      if (left < 60) continue;
      if (/wegmans\.cloud/.test(String(o.target || '')) && (!best || left > best.left)) {
        best = { secret: o.secret, left, target: String(o.target).slice(0, 60) };
      }
    } catch (e) { /* wrong context, skip */ }
  }
  if (!best) return { why: 'no usable access token' };

  const out = { tokenSecondsLeft: best.left, target: best.target };
  const call = async (path) => {
    const t0 = Date.now();
    try {
      const r = await fetch('https://api.digitaldevelopment.wegmans.cloud' + path, {
        headers: { authorization: 'Bearer ' + best.secret, accept: 'application/json' },
      });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      return { status: r.status, ms: Date.now() - t0, keys: j && typeof j === 'object' ? Object.keys(j).slice(0, 18) : null, bytes: txt.length, body: j };
    } catch (e) { return { err: String(e && e.message).slice(0, 120) }; }
  };
  // The api-version query is REQUIRED: without it the gateway rejects before it
  // adds CORS headers, so the browser reports a bare "Failed to fetch".
  const res = await call('/commerce/account/customer?api-version=2024-03-06-preview');
  out.customer = { status: res.status, ms: res.ms, keys: res.keys, bytes: res.bytes, err: res.err || null };
  out.origin = location.origin;
  // FIELD NAMES ONLY from the customer payload — it is personal data. The one
  // value reported is a store number, which identifies a shop, not a person.
  const paths = [];
  const names = (n, path, d) => {
    if (!n || d > 5 || paths.length > 60) return;
    if (Array.isArray(n)) { if (n[0]) names(n[0], path + '[]', d + 1); return; }
    if (typeof n === 'object') { for (const k of Object.keys(n)) names(n[k], path ? path + '.' + k : k, d + 1); return; }
    paths.push(path + ' :' + typeof n + (/store|shop|site/i.test(path) ? ' = ' + String(n).slice(0, 12) : ''));
  };
  names(res.body, '', 0);
  out.customerFields = paths.slice(0, 60);
  // The custom fields are a name/value list. Report every NAME, and the value
  // only where the name is about a store.
  try {
    const cf = res.body.customer.custom.customFieldsRaw || [];
    out.customFields = cf.map((f) => ({
      name: f.name,
      value: /store|shop|site|location/i.test(String(f.name)) ? String(f.value).slice(0, 20) : '(withheld)',
    })).slice(0, 40);
  } catch (e) { out.customFieldsErr = String(e && e.message).slice(0, 80); }
  // And the top-level shape of customer.
  try { out.customerTopKeys = Object.keys(res.body.customer).slice(0, 20); } catch (e) {}
  const hits = [];
  const walk = (n, path, d) => {
    if (!n || d > 5 || hits.length > 12) return;
    if (Array.isArray(n)) { n.forEach((v, i) => walk(v, path + '[' + i + ']', d + 1)); return; }
    if (typeof n === 'object') {
      for (const k of Object.keys(n)) walk(n[k], path ? path + '.' + k : k, d + 1);
      return;
    }
    if (/store|shop|site|location/i.test(path) && /^\d{1,4}$/.test(String(n))) hits.push({ path, value: String(n) });
  };
  walk(res.body, '', 0);
  out.storeNumberCandidates = hits;
  return out;
})()
