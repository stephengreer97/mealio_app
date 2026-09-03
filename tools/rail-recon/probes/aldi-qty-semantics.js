// THE ONE WRITE. Authorised by Stephen, 2026-09-03, on the item he added by
// hand for this purpose.
//
// Question: does UpdateCartItemsMutation SET a cart line or ADD to it?
// The cart holds 1 of items_23898-46580608. We send quantity 2.
//   cart reads 2  ->  SET   (quantity is absolute)
//   cart reads 3  ->  ADD   (quantity is a delta)
//
// Then it puts the cart back to 1 if and only if the answer was SET, where that
// restore is exact. Under ADD it stops and reports, because a restore would be
// another guess with his groceries.
(async () => {
  const H = {
    ActiveCarts: '839c3658a57f86c543ba367a16d0eaa648f167a1eaf20f6d80aa14165f1ee10d',
    CartItems: '60fa63eb1afba0204993af2a7ea12e057f0ae2677e71753fc05d5a9c5b4adb6c',
    UpdateCartItemsMutation: 'a88cb16f9d30ef225e487baf6eda6851786440e74ffe73d66908ac2ab8b227a7',
  };
  const ITEM = 'items_23898-46580608';
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
  const readQty = async () => {
    const carts = await gql('ActiveCarts', {});
    let cartId = null;
    try { cartId = String(carts.data.userCarts.carts[0].id); } catch (e) {}
    if (!cartId) return { err: 'no_cart' };
    const res = await gql('CartItems', { id: cartId, shopId: '8583', postalCode: '00000' });
    let lines = [];
    try { lines = res.data.userCart.cartItemCollection.cartItems || []; } catch (e) {}
    let qty = 0;
    const all = [];
    for (const li of lines) {
      const bp = li.basketProduct || {};
      const iid = String(bp.itemId || bp.id || li.id);
      const q = Number(li.quantity != null ? li.quantity : 0);
      all.push({ iid, name: bp.name || null, q });
      if (iid === ITEM) qty += q;
    }
    return { cartId, qty, all };
  };

  const out = {};
  out.before = await readQty();
  if (out.before.err || out.before.qty !== 1) {
    out.aborted = 'expected exactly 1 of the item before writing; found ' + JSON.stringify(out.before);
    return out;
  }
  const w = await gql('UpdateCartItemsMutation', { cartItemUpdates: [{ itemId: ITEM, quantity: 2 }] });
  out.writeOk = !!w.data;
  out.writeErr = w.errors ? String(w.errors[0] && w.errors[0].message).slice(0, 200) : null;
  out.after = await readQty();

  if (out.after.qty === 2) {
    out.verdict = 'SET — quantity is ABSOLUTE';
    const back = await gql('UpdateCartItemsMutation', { cartItemUpdates: [{ itemId: ITEM, quantity: 1 }] });
    out.restoreOk = !!back.data;
    out.restored = await readQty();
  } else if (out.after.qty === 3) {
    out.verdict = 'ADD — quantity is a DELTA';
    out.note = 'cart left at 3; a restore under these semantics would be another guess';
  } else {
    out.verdict = 'INCONCLUSIVE — cart reads ' + out.after.qty;
  }
  return out;
})()
