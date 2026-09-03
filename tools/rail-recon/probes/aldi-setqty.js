// Set one ALDI line to an exact quantity. Tidying after measurement.
(async () => {
  const H = {
    ActiveCarts: '839c3658a57f86c543ba367a16d0eaa648f167a1eaf20f6d80aa14165f1ee10d',
    CartItems: '60fa63eb1afba0204993af2a7ea12e057f0ae2677e71753fc05d5a9c5b4adb6c',
    UpdateCartItemsMutation: 'a88cb16f9d30ef225e487baf6eda6851786440e74ffe73d66908ac2ab8b227a7',
  };
  const gql = async (name, variables) => {
    const r = await fetch('/graphql', { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
      body: JSON.stringify({ operationName: name, variables: variables || {},
        extensions: { persistedQuery: { version: 1, sha256Hash: H[name] } } }) });
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return { parseError: t.slice(0, 200) }; }
  };
  // His shop, from the session probe's own answer. A tidy-up tool, not a rail.
  const shop = '8583';
  const carts = await gql('ActiveCarts', {});
  let cartId = null;
  try { cartId = String(carts.data.userCarts.carts[0].id); } catch (e) {}
  const read = async () => {
    const res = await gql('CartItems', { id: cartId, shopId: shop, postalCode: '00000' });
    let lines = [];
    try { lines = res.data.userCart.cartItemCollection.cartItems || []; } catch (e) {}
    return lines.map((li) => ({
      iid: String((li.basketProduct && (li.basketProduct.itemId || li.basketProduct.id)) || li.id),
      name: String((li.basketProduct && li.basketProduct.name) || '').slice(0, 34),
      qty: li.quantity }));
  };
  const TARGETS = { 'items_23898-18648732': 1 };
  const before = await read();
  const out = { shop, before: before.map((l) => l.iid + ':' + l.qty) };
  const updates = [];
  for (const k of Object.keys(TARGETS)) {
    const l = before.find((x) => x.iid === k);
    if (l && l.qty !== TARGETS[k]) updates.push({ itemId: k, quantity: TARGETS[k] });
  }
  if (!updates.length) { out.skipped = true; return out; }
  const w = await gql('UpdateCartItemsMutation', { cartItemUpdates: updates });
  out.wroteOk = !!w.data;
  out.after = (await read()).map((l) => l.iid + ':' + l.qty);
  return out;
})()
