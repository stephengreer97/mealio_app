// READ ONLY. Cart shape + whether a search can be fetched and parsed as JSON.
(async () => {
  const CART_HASH = '3ec6afb6cfeca435e690c537532ef47683874107384f76904e2327d4941979ef';
  const uuid = () => 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
  });
  const out = {};
  // Does the version have to be RIGHT, or merely present? That decides whether
  // the rail must harvest it from a page before it can talk to the cart.
  const FAKE_PV = 'usweb-1.0.0-0000000000000000000000000000000000000000-0000000';
  let cartId = null, isGuest = null;
  try { const m = JSON.parse(localStorage.getItem('glassCartIdMap') || 'null');
    if (m) { cartId = m.crt || m.id; isGuest = m.isGuest; } } catch (e) {}
  out.cartId = cartId ? cartId.slice(0, 8) + '…' : null;
  out.isGuest = isGuest;

  // The search: one GET of the HTML, one JSON.parse of the SSR payload.
  const t0 = Date.now();
  let pv = null;
  const sr = await fetch('/search?q=' + encodeURIComponent('sour cream'), { credentials: 'include' });
  const html = await sr.text();
  out.search = { status: sr.status, ms: Date.now() - t0, bytes: html.length };
  const pvm = html.match(/usweb-[0-9.]+-[0-9a-f]{40}-[0-9]+/);
  if (pvm) pv = pvm[0];
  out.platformVersion = pv;
  try {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const j = JSON.parse(m[1]);
    const stacks = j.props.pageProps.initialData.searchResult.itemStacks || [];
    const items = (stacks[0] && stacks[0].items) || [];
    out.search.items = items.length;
    out.search.first = items.slice(0, 2).map((it) => ({
      usItemId: it.usItemId, offerId: it.offerId, name: String(it.name || '').slice(0, 40),
      avail: it.availabilityStatusDisplayValue, canAdd: it.canAddToCart,
      price: it.priceInfo ? JSON.stringify(it.priceInfo).slice(0, 90) : null,
      weight: { avg: it.averageWeight, inc: it.weightIncrement, sold: it.salesUnitType || it.orderMinLimit },
    }));
    out.search.signedIn = m[1].indexOf('"customerId":"') >= 0;
  } catch (e) { out.search.parse = String(e && e.message).slice(0, 70); }

  // The cart, with the header set that worked.
  const hdrs = (op, kind) => ({
    'content-type': 'application/json', accept: 'application/json',
    'X-APOLLO-OPERATION-NAME': op, 'x-o-gql-query': kind + ' ' + op,
    'tenant-id': 'elh9ie', 'x-o-mart': 'B2C', 'x-o-bu': 'WALMART-US',
    'x-o-segment': 'oaoh', 'x-o-platform': 'rweb', 'WM_MP': 'true',
    'x-o-ccm': 'server', 'x-latency-trace': '1', 'x-enable-server-timing': '1',
    'accept-language': 'en-US', 'WM_PAGE_URL': location.href,
    baggage: 'trafficType=customer,deviceType=mobile,renderScope=SSR,webRequestSource=Browser',
    'wm-client-traceid': uuid(), 'x-o-correlation-id': uuid(), 'wm_qos.correlation_id': uuid(),
    traceparent: '00-' + uuid() + uuid().slice(0, 4) + '-' + uuid().slice(0, 16) + '-00',
    'x-o-platform-version': FAKE_PV || pv,
  });
  const t1 = Date.now();
  const cr = await fetch('/orchestra/cartxo/graphql/MergeAndGetCart/' + CART_HASH, {
    method: 'POST', credentials: 'include', headers: hdrs('MergeAndGetCart', 'mutation'),
    body: JSON.stringify({ variables: { input: { cartId, strategy: 'MERGE', enableLiquorBox: true,
      enableCartSplitClarity: false, features: [] }, detailed: false } }) });
  const ctxt = await cr.text();
  out.cart = { status: cr.status, ms: Date.now() - t1, bytes: ctxt.length };
  try {
    const j = JSON.parse(ctxt);
    out.cart.dataKeys = j.data ? Object.keys(j.data).slice(0, 8) : null;
    // find the item list
    const found = [];
    const walk = (n, p, d) => {
      if (n == null || d > 6 || found.length > 4) return;
      if (Array.isArray(n)) {
        if (n[0] && typeof n[0] === 'object' && (n[0].quantity != null || n[0].usItemId || n[0].offerId)) {
          found.push({ path: p, n: n.length, keys: Object.keys(n[0]).slice(0, 16) });
        }
        if (n[0]) walk(n[0], p + '[]', d + 1);
        return;
      }
      if (typeof n === 'object') { for (const k of Object.keys(n)) walk(n[k], p ? p + '.' + k : k, d + 1); }
    };
    walk(j.data, '', 0);
    out.cart.itemPaths = found;
    try {
      const li = j.data.mergeAndGetCart.lineItems[0];
      const ids = [];
      const idwalk = (n, p, d) => {
        if (n == null || d > 4 || ids.length > 14) return;
        if (Array.isArray(n)) { if (n[0]) idwalk(n[0], p + '[]', d + 1); return; }
        if (typeof n === 'object') { for (const k of Object.keys(n)) idwalk(n[k], p ? p + '.' + k : k, d + 1); return; }
        if (/offerid|usitemid|productid|\bid$|sku|name/i.test(p)) ids.push(p + ' = ' + String(n).slice(0, 34));
      };
      idwalk(li, '', 0);
      out.cart.lineIds = ids.slice(0, 14);
      out.cart.lineTopKeys = Object.keys(li).slice(0, 30);
    } catch (e) {}
  } catch (e) { out.cart.parse = ctxt.slice(0, 90); }
  return out;
})()
