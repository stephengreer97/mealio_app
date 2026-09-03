// Does the Wegmans commerce API accept the COOKIE session, or does it insist on
// the bearer? This decides the whole shape of a Wegmans rail, because the bearer
// is in an ENCRYPTED MSAL cache ({id,nonce,data}) and is not readable.
(async () => {
  const BASE = 'https://api.digitaldevelopment.wegmans.cloud';
  const out = { encryptionCookiePresent: /msal\.cache\.encryption/.test(document.cookie) };
  const get = async (label, p, init) => {
    const t0 = Date.now();
    try {
      const r = await fetch(BASE + p, init);
      const t = await r.text();
      out[label] = { status: r.status, ms: Date.now() - t0, bytes: t.length, peek: t.slice(0, 260) };
    } catch (e) { out[label] = { err: String(e).slice(0, 140) }; }
  };
  await get('cookieOnly', '/commerce/cart/carts/', { credentials: 'include', headers: { accept: 'application/json' } });
  await get('noCreds', '/commerce/cart/carts/', { headers: { accept: 'application/json' } });
  await get('customerCookie', '/commerce/account/customer', { credentials: 'include', headers: { accept: 'application/json' } });
  return out;
})()
