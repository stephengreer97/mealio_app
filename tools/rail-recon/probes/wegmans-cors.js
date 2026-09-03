(async () => {
  const out = { href: location.href };
  const t = async (label, url, init) => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, init);
      out[label] = { status: r.status, ms: Date.now() - t0, type: r.type, peek: (await r.text()).slice(0, 160) };
    } catch (e) { out[label] = { err: String(e).slice(0, 160), ms: Date.now() - t0 }; }
  };
  // Control: same-origin, known to work.
  await t('sameOrigin', '/api/stores', { headers: { accept: 'application/json' } });
  // The API host, simplest possible request (no custom headers, no creds).
  await t('apiPlain', 'https://api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/');
  // no-cors tells us whether the request LEAVES at all: opaque means it did and
  // only the READ was blocked, an error means it never went.
  await t('apiNoCors', 'https://api.digitaldevelopment.wegmans.cloud/commerce/cart/carts/', { mode: 'no-cors' });
  return out;
})()
