// Read-only. The cart's own line shape is what an add has to verify against.
(async () => {
  const out = {};
  const gql = async (name, hash, variables) => {
    const t0 = Date.now();
    const r = await fetch('/graphql', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
      body: JSON.stringify({ operationName: name, variables, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
    });
    const t = await r.text();
    return { status: r.status, ms: Date.now() - t0, bytes: t.length, json: t.slice(0, 1400) };
  };
  const carts = await gql('ActiveCarts', '839c3658a57f86c543ba367a16d0eaa648f167a1eaf20f6d80aa14165f1ee10d', {});
  out.carts = carts;
  let cartId = null, shopId = null;
  try { cartId = JSON.parse(carts.json.length < 1400 ? carts.json : '{}').data.userCarts.carts[0].id; } catch (e) {}
  // shopId came from the site's own VisitShop call.
  shopId = '8583';
  out.used = { cartId, shopId };
  if (cartId) {
    out.cartItems = await gql('CartItems', '60fa63eb1afba0204993af2a7ea12e057f0ae2677e71753fc05d5a9c5b4adb6c',
      { id: cartId, shopId, postalCode: '00000' });
  }
  out.search = await gql('AsyncItemSearch', '19889f981af1f9c5c70543f3d7555bf0d435e026fc96329984fc3414e3b56d8e',
    { query: 'sour cream', shopId });
  return out;
})()
