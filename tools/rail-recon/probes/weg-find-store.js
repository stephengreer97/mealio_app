// Which Wegmans store is this user shopping? The site knows — it called
// /api/stores/store-number/140 — so the number is somewhere on the origin.
// Look for the VALUE rather than guessing at the key.
(async () => {
  const out = { cookies: [], hits: [], api: {} };
  const NEEDLE = '140';
  const note = (from, ctx) => { if (out.hits.length < 16) out.hits.push({ from, ctx: String(ctx).slice(0, 160) }); };
  try {
    out.cookies = document.cookie.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean);
    for (const c of document.cookie.split(';')) {
      const eq = c.indexOf('=');
      const k = c.slice(0, eq).trim();
      const v = c.slice(eq + 1).trim();
      if (v === NEEDLE || (/store|shop|fulfil|location/i.test(k))) note('cookie:' + k, v.slice(0, 120));
    }
  } catch (e) {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k) || '';
      if (/store|shop|fulfil|location/i.test(k) && v.length < 3000) note('ls:' + k.slice(0, 50), v.slice(0, 150));
    }
  } catch (e) {}
  // The site's own APIs, same-origin and cheap. One of them may name the user's
  // store without needing the bearer.
  for (const path of ['/api/stores/preferred', '/api/user/store', '/api/stores/mine', '/api/customer/store']) {
    try {
      const r = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } });
      const t = await r.text();
      out.api[path] = { status: r.status, peek: t.slice(0, 120) };
    } catch (e) { out.api[path] = { err: String(e).slice(0, 60) }; }
  }
  return out;
})()
