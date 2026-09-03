// READ ONLY, and VALUE-BLIND: key names, field names, byte lengths only.
// Never a token, never key material, never a decrypted payload.
(async () => {
  const out = { entries: [], cookieFields: null, cookieShape: null };
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !/msal/i.test(k)) continue;
    const raw = localStorage.getItem(k) || '';
    let fields = null, kind = 'raw';
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') { fields = Object.keys(j).slice(0, 12); kind = 'json'; }
    } catch (e) { /* raw */ }
    out.entries.push({
      key: k.length > 100 ? k.slice(0, 100) + '…' : k,
      bytes: raw.length, kind, fields,
    });
  }
  const c = document.cookie.split(';').map((x) => x.trim()).find((x) => x.startsWith('msal.cache.encryption'));
  if (c) {
    const val = decodeURIComponent(c.split('=').slice(1).join('='));
    out.cookieShape = { bytes: val.length, startsWith: val.slice(0, 1) };
    try {
      const j = JSON.parse(val);
      out.cookieFields = Object.keys(j).map((k) => ({ field: k, bytes: String(j[k]).length }));
    } catch (e) { out.cookieFields = 'unparseable'; }
  }
  return out;
})()
