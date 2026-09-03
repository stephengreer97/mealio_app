// Can the cart be read from a quiet page with hand-built headers?
// MergeAndGetCart is what the site itself calls on every page load.
(async () => {
  const CART_HASH = '3ec6afb6cfeca435e690c537532ef47683874107384f76904e2327d4941979ef';
  const uuid = () => 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
  });
  let cartId = null;
  try {
    const m = JSON.parse(localStorage.getItem('glassCartIdMap') || 'null');
    if (m) cartId = m.cartId || Object.values(m).find((v) => typeof v === 'string' && v.length > 20) || null;
    if (!cartId && m) { const k = Object.keys(m)[0]; cartId = m[k] && m[k].cartId ? m[k].cartId : null; }
  } catch (e) {}
  const out = { origin: location.origin, cartIdFound: !!cartId, cartIdMapRaw: (localStorage.getItem('glassCartIdMap') || '').slice(0, 120) };
  const call = async (label, headers) => {
    const t0 = Date.now();
    try {
      const r = await fetch('/orchestra/cartxo/graphql/MergeAndGetCart/' + CART_HASH, {
        method: 'POST', credentials: 'include', headers,
        body: JSON.stringify({ variables: { input: { cartId: cartId, strategy: 'MERGE',
          enableLiquorBox: true, enableCartSplitClarity: false, features: [] }, detailed: false } }),
      });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      const cart = j && j.data && (j.data.cart || j.data.mergeAndGetCart);
      return { label, status: r.status, ms: Date.now() - t0, bytes: txt.length,
        hasData: !!(j && j.data), errs: j && j.errors ? String(j.errors[0] && j.errors[0].message).slice(0, 80) : null,
        items: cart && cart.items ? cart.items.length : null,
        peek: r.status >= 400 ? txt.slice(0, 100) : null };
    } catch (e) { return { label, err: String(e && e.message).slice(0, 60), ms: Date.now() - t0 }; }
  };
  const base = {
    'content-type': 'application/json', accept: 'application/json',
    'X-APOLLO-OPERATION-NAME': 'MergeAndGetCart',
    'x-o-gql-query': 'mutation MergeAndGetCart',
    'tenant-id': 'elh9ie', 'x-o-mart': 'B2C', 'x-o-bu': 'WALMART-US',
    'x-o-segment': 'oaoh', 'x-o-platform': 'rweb', 'WM_MP': 'true',
    'wm-client-traceid': uuid(), 'x-o-correlation-id': uuid(),
  };
  // Everything the site's own call carried. The page-derived ones are read from
  // the page rather than invented.
  let platformVersion = null, deviceProfile = null;
  try {
    const html = document.documentElement.innerHTML;
    const pv = html.match(/usweb-[0-9.]+-[0-9a-f]{40}-[0-9]+/);
    if (pv) platformVersion = pv[0];
    const dp = html.match(/"deviceProfileRefId"\s*:\s*"([^"]+)"/) || html.match(/DEVICE_PROFILE_REF_ID[^a-z0-9]{1,6}([a-z0-9-]{20,})/i);
    if (dp) deviceProfile = dp[1];
  } catch (e) {}
  out.harvested = { platformVersion, deviceProfile: deviceProfile ? deviceProfile.slice(0, 10) + '…' : null };
  const trace = '00-' + uuid() + uuid().slice(0, 4) + '-' + uuid().slice(0, 16) + '-00';
  const full = Object.assign({}, base, {
    'x-o-ccm': 'server', 'x-latency-trace': '1', 'x-enable-server-timing': '1',
    'accept-language': 'en-US', traceparent: trace,
    'WM_PAGE_URL': location.href,
    baggage: 'trafficType=customer,deviceType=mobile,renderScope=SSR,webRequestSource=Browser',
    'wm_qos.correlation_id': base['x-o-correlation-id'],
  });
  if (platformVersion) full['x-o-platform-version'] = platformVersion;
  if (deviceProfile) full['DEVICE_PROFILE_REF_ID'] = deviceProfile;
  out.tries = [];
  out.tries.push(await call('everything observed', full));
  return out;
})()
