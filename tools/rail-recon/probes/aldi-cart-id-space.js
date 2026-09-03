// READ ONLY. Dumps every id-shaped field on each cart line.
//
// Why: the add looks up `before.held[productId]` using the SEARCH's
// `items_23898-...` form, while the cart read keys by `li.itemId`, which came
// back as a bare number (35303533299). If those are different id spaces the
// "already in the cart" refusal can never fire, and the after-write
// verification can never confirm a line either.
(async () => {
  const H = {
    ActiveCarts: '839c3658a57f86c543ba367a16d0eaa648f167a1eaf20f6d80aa14165f1ee10d',
    CartItems: '60fa63eb1afba0204993af2a7ea12e057f0ae2677e71753fc05d5a9c5b4adb6c',
  };
  const gql = async (name, variables) => {
    const r = await fetch('/graphql', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
      body: JSON.stringify({ operationName: name, variables: variables || {},
        extensions: { persistedQuery: { version: 1, sha256Hash: H[name] } } }),
    });
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return { parseError: t.slice(0, 300) }; }
  };
  const out = {};
  const carts = await gql('ActiveCarts', {});
  let cartId = null;
  try {
    const cs = (carts.data.userCarts && carts.data.userCarts.carts) || carts.data.activeCarts || carts.data.carts || [];
    for (const c of cs) if (c && c.id) { cartId = String(c.id); break; }
  } catch (e) {}
  out.cartId = cartId;
  if (!cartId) { out.why = 'no_cart_id'; out.peek = JSON.stringify(carts).slice(0, 400); return out; }

  const res = await gql('CartItems', { id: cartId, shopId: '8583', postalCode: '00000' });
  if (!res.data) { out.why = 'no_data'; out.peek = JSON.stringify(res).slice(0, 500); return out; }

  const lines = [];
  const walk = (node, depth) => {
    if (!node || depth > 7) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    if (typeof node !== 'object') return;
    if (node.quantity != null && (node.itemId != null || node.id != null || node.item != null)) {
      lines.push({
        quantity: node.quantity,
        itemId: node.itemId != null ? String(node.itemId) : null,
        id: node.id != null ? String(node.id) : null,
        legacyId: node.legacyId != null ? String(node.legacyId) : null,
        productId: node.productId != null ? String(node.productId) : null,
        item_id: node.item && node.item.id != null ? String(node.item.id) : null,
        item_legacyId: node.item && node.item.legacyId != null ? String(node.item.legacyId) : null,
        item_name: node.item && node.item.name ? String(node.item.name) : null,
        keys: Object.keys(node).slice(0, 22),
        basketProduct: node.basketProduct ? {
          keys: Object.keys(node.basketProduct).slice(0, 30),
          id: node.basketProduct.id != null ? String(node.basketProduct.id) : null,
          legacyId: node.basketProduct.legacyId != null ? String(node.basketProduct.legacyId) : null,
          productId: node.basketProduct.productId != null ? String(node.basketProduct.productId) : null,
          itemId: node.basketProduct.itemId != null ? String(node.basketProduct.itemId) : null,
          name: node.basketProduct.name ? String(node.basketProduct.name) : null,
          peek: JSON.stringify(node.basketProduct).slice(0, 600),
        } : null,
      });
    }
    for (const k of Object.keys(node)) walk(node[k], depth + 1);
  };
  walk(res.data, 0);
  out.lines = lines.slice(0, 10);
  return out;
})()
