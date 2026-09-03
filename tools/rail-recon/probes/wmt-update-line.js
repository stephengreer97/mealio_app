// Which field addresses an EXISTING Walmart cart line? Authorised: development.
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
    return { status: r.status, j, peek: t.slice(0, 120) };
  };
  const read = async () => {
    const r = await gql('cartxo', 'MergeAndGetCart', OPS.cart,
      { input: { cartId, strategy: 'MERGE', enableLiquorBox: true, enableCartSplitClarity: false, features: [] }, detailed: false });
    const lines = (r.j && r.j.data && r.j.data.mergeAndGetCart && r.j.data.mergeAndGetCart.lineItems) || [];
    return lines.map((li) => ({ offerId: li.product && li.product.offerId, lineId: li.id, qty: li.quantity,
      name: String((li.product && li.product.name) || '').slice(0, 26) }));
  };
  const TARGET = 'C9CD90D38EC24123AB6FBB669B830D0F';
  const before = await read();
  const line = before.find((l) => l.offerId === TARGET);
  if (!line) return { why: 'target not in cart', cart: before.map((l) => l.offerId + ':' + l.qty) };
  const out = { qtyBefore: line.qty, tries: [] };
  const variants = [
    ['id', { offerId: TARGET, quantity: line.qty + 1, usItemId: '', id: line.lineId }],
    ['cartLineId', { offerId: TARGET, quantity: line.qty + 1, usItemId: '', cartLineId: line.lineId }],
    ['lineItemId', { offerId: TARGET, quantity: line.qty + 1, usItemId: '', lineItemId: line.lineId }],
  ];
  for (const [label, item] of variants) {
    const r = await gql('home', 'updateItems', OPS.upd, {
      getDetailedAccesspoint: false,
      input: { cartId, items: [item], enableLiquorBox: true, skipPolicyCheck: false,
               enableCartSplitClarity: false, features: [] } });
    const now = await read();
    const l2 = now.find((l) => l.offerId === TARGET);
    out.tries.push({ label, status: r.status, qty: l2 ? l2.qty : 0,
      err: r.j && r.j.errors ? String(r.j.errors[0].message).slice(0, 70) : null });
    if (l2 && l2.qty !== line.qty) { out.worked = label; break; }
  }
  return out;
})()
