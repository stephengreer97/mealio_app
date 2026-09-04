// Can updateItems address an item by usItemId instead of offerId?
// usItemId is the stable PRODUCT; offerId is a seller-and-price OFFER that can
// retire. If the write accepts the former, it is the better key to save.
// Kept to five requests: this store challenges a burst.
(async () => {
  const OPS = { cart: '3ec6afb6cfeca435e690c537532ef47683874107384f76904e2327d4941979ef',
                upd: 'f7a7a5c72f31319f198a9097f111a1a5f121ed523e4400fcc215aa98152c5e4b' };
  const uuid = () => { let s = ''; for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16); return s; };
  const hdrs = (op) => ({
    'content-type': 'application/json', accept: 'application/json', 'accept-language': 'en-US',
    'X-APOLLO-OPERATION-NAME': op, 'x-o-gql-query': 'mutation ' + op,
    'tenant-id': 'elh9ie', 'x-o-mart': 'B2C', 'x-o-bu': 'WALMART-US', 'x-o-segment': 'oaoh',
    'x-o-platform': 'rweb', 'x-o-ccm': 'server', 'WM_MP': 'true',
    'x-latency-trace': '1', 'x-enable-server-timing': '1', 'WM_PAGE_URL': location.href,
    baggage: 'trafficType=customer,deviceType=mobile,renderScope=SSR,webRequestSource=Browser',
    'wm-client-traceid': uuid(), 'x-o-correlation-id': uuid(), 'wm_qos.correlation_id': uuid(),
    traceparent: '00-' + uuid() + '-' + uuid().slice(0, 16) + '-00',
    'x-o-platform-version': 'usweb-1.302.0',
  });
  const m = JSON.parse(localStorage.getItem('glassCartIdMap') || '{}');
  const cartId = m.crt || m.id;
  const gql = async (domain, op, hash, variables) => {
    const r = await fetch('/orchestra/' + domain + '/graphql/' + op + '/' + hash,
      { method: 'POST', credentials: 'include', headers: hdrs(op), body: JSON.stringify({ variables }) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch (e) {}
    return { status: r.status, j, peek: t.slice(0, 110) };
  };
  const read = async () => {
    const r = await gql('cartxo', 'MergeAndGetCart', OPS.cart,
      { input: { cartId, strategy: 'MERGE', enableLiquorBox: true, enableCartSplitClarity: false, features: [] }, detailed: false });
    if (r.status !== 200) return { blocked: r.status, lines: [] };
    const lines = (r.j && r.j.data && r.j.data.mergeAndGetCart && r.j.data.mergeAndGetCart.lineItems) || [];
    return { lines: lines.map((li) => ({ offerId: li.product && li.product.offerId,
      usItemId: li.product && li.product.usItemId, lineId: li.id, qty: li.quantity })) };
  };
  const before = await read();
  if (before.blocked) return { why: 'blocked', status: before.blocked };
  const t = before.lines[0];
  if (!t) return { why: 'cart empty' };
  const out = { target: { usItemId: t.usItemId, qtyBefore: t.qty }, tries: [] };
  const attempt = async (label, item) => {
    const r = await gql('home', 'updateItems', OPS.upd, {
      getDetailedAccesspoint: false,
      input: { cartId, items: [item], enableLiquorBox: true, skipPolicyCheck: false,
               enableCartSplitClarity: false, features: [] } });
    const now = await read();
    const l = (now.lines || []).find((x) => x.usItemId === t.usItemId);
    return { label, status: r.status, qty: l ? l.qty : 0,
      err: r.j && r.j.errors ? String(r.j.errors[0].message).slice(0, 80) : null };
  };
  // usItemId ALONE, addressing the existing line.
  out.tries.push(await attempt('usItemId only, with lineItemId',
    { usItemId: t.usItemId, quantity: t.qty + 1, lineItemId: t.lineId }));
  if (out.tries[0].qty === t.qty) {
    out.tries.push(await attempt('usItemId + empty offerId',
      { usItemId: t.usItemId, offerId: '', quantity: t.qty + 1, lineItemId: t.lineId }));
  }
  return out;
})()
