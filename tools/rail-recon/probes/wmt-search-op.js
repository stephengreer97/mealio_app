// Call the SPA's own Search operation with hand-built headers, and compare it
// with the 780KB page the rail fetches today.
(async () => {
  const HASH = '464cab4ac4aad772cd9b3cd6de458f56bb524d4b537612466028461ec5e05f58';
  const uuid = () => { let s = ''; for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16); return s; };
  const hdrs = (op, kind) => ({
    'content-type': 'application/json', accept: 'application/json', 'accept-language': 'en-US',
    'X-APOLLO-OPERATION-NAME': op, 'x-o-gql-query': kind + ' ' + op,
    'tenant-id': 'elh9ie', 'x-o-mart': 'B2C', 'x-o-bu': 'WALMART-US', 'x-o-segment': 'oaoh',
    'x-o-platform': 'rweb', 'x-o-ccm': 'server', 'WM_MP': 'true',
    'x-latency-trace': '1', 'x-enable-server-timing': '1', 'WM_PAGE_URL': location.href,
    baggage: 'trafficType=customer,deviceType=mobile,renderScope=SSR,webRequestSource=Browser',
    'wm-client-traceid': uuid(), 'x-o-correlation-id': uuid(), 'wm_qos.correlation_id': uuid(),
    traceparent: '00-' + uuid() + '-' + uuid().slice(0, 16) + '-00',
    'x-o-platform-version': 'usweb-1.302.0',
  });
  const vars = (q) => ({
    id: '', dealsId: '', query: q, nudgeContext: '', page: 1, prg: 'mWeb', catId: '', facet: '',
    sort: 'best_match', rawFacet: '', seoPath: '', ps: 40, limit: 40, ptss: '', trsp: '',
    beShelfId: '', recall_set: '', module_search: '', min_price: '', max_price: '', storeSlotBooked: '',
    additionalQueryParams: { hidden_facet: null, translation: null, isMoreOptionsTileEnabled: true,
      isGenAiEnabled: true, rootDimension: '', altQuery: '', selectedFilter: '',
      neuralSearchSeeAll: false, isModuleArrayReq: false, enableGenericItemTileOptions: true,
      isLMPBrowsePage: false },
    searchArgs: { query: q, cat_id: '', prg: 'mWeb', facet: '' },
    enableDesktopHighlights: false, enableVolumePricing: false, enableCopyBlock: true,
    enableVariantCount: false, enableSlaBadgeV2: true, enableUnifiedProductFragment: true,
    enableESSCarousel: false, enableSearchBenefitsBanner: false, enableSparkyPLPModule: false,
    fitmentFieldParams: { powerSportEnabled: true, dynamicFitmentEnabled: true,
      extendedAttributesEnabled: true, extendedAttributesV2Enabled: true, fuelTypeEnabled: true },
    fitmentSearchParams: { id: '', dealsId: '', query: q, nudgeContext: '', page: 1, prg: 'mWeb',
      catId: '', facet: '', sort: 'best_match', rawFacet: '', seoPath: '', ps: 40, limit: 40 },
  });
  const out = {};
  const term = 'sour cream';
  let t0 = Date.now();
  const r = await fetch('/orchestra/snb/graphql/Search/' + HASH + '/search?variables='
    + encodeURIComponent(JSON.stringify(vars(term))), { credentials: 'include', headers: hdrs('Search', 'query') });
  const txt = await r.text();
  out.op = { status: r.status, ms: Date.now() - t0, bytes: txt.length };
  try {
    const j = JSON.parse(txt);
    out.op.dataKeys = j.data ? Object.keys(j.data) : null;
    const sr = j.data && j.data.search && j.data.search.searchResult;
    const stacks = (sr && sr.itemStacks) || [];
    const items = (stacks[0] && stacks[0].items) || [];
    out.op.items = items.length;
    const it = items[0] || {};
    out.op.sample = { name: String(it.name || '').slice(0, 34), offerId: it.offerId,
      usItemId: it.usItemId, canAdd: it.canAddToCart, avail: it.availabilityStatusDisplayValue,
      price: it.priceInfo && it.priceInfo.currentPrice ? it.priceInfo.currentPrice.priceString : null,
      salesUnit: it.salesUnitType };
  } catch (e) { out.op.peek = txt.slice(0, 100); }
  // The page, for comparison.
  t0 = Date.now();
  const p = await fetch('/search?q=' + encodeURIComponent(term), { credentials: 'include' });
  const ptxt = await p.text();
  out.page = { status: p.status, ms: Date.now() - t0, bytes: ptxt.length };
  if (out.op.bytes && out.page.bytes) out.smallerBy = Math.round((1 - out.op.bytes / out.page.bytes) * 100) + '%';
  return out;
})()
