// READ ONLY. What a real Wegmans page holds that could yield a bearer.
// Reports SHAPES and key NAMES only — never a token value, never a full blob.
(async () => {
  const out = { url: location.href.slice(0, 80), msalKeys: [], other: [], cookies: [], encCookie: null };
  const redact = (v) => {
    if (v == null) return null;
    const s = String(v);
    return { len: s.length, head: s.slice(0, 12), looksJwt: /^ey[A-Za-z0-9_-]+\./.test(s) };
  };
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    const raw = localStorage.getItem(k) || '';
    let shape = null;
    try {
      const j = JSON.parse(raw);
      shape = j && typeof j === 'object' ? Object.keys(j).slice(0, 10) : typeof j;
    } catch (e) { shape = 'non-json'; }
    const row = { key: k.length > 90 ? k.slice(0, 90) + '…' : k, bytes: raw.length, shape };
    if (/msal|token|auth|b2c/i.test(k)) out.msalKeys.push(row); else out.other.push(row);
  }
  out.other = out.other.slice(0, 12);
  // Cookie NAMES only.
  out.cookies = document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean).slice(0, 40);
  const enc = document.cookie.split(';').map((c) => c.trim()).find((c) => /^msal\.cache\.encryption/.test(c));
  out.encCookie = enc ? redact(enc.split('=').slice(1).join('=')) : null;
  // Is MSAL itself reachable on the page?
  out.globals = Object.keys(window).filter((k) => /msal|Msal|MSAL/.test(k)).slice(0, 10);
  out.hasCrypto = !!(window.crypto && window.crypto.subtle);
  return out;
})()
