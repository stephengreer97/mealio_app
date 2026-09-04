(async () => {
  const HASH = '464cab4ac4aad772cd9b3cd6de458f56bb524d4b537612466028461ec5e05f58';
  const TEMPLATE = {"id":"","dealsId":"","query":"__TERM__","nudgeContext":"","page":1,"prg":"mWeb","catId":"","facet":"","sort":"best_match","rawFacet":"","seoPath":"","ps":40,"limit":40,"ptss":"","trsp":"","beShelfId":"","recall_set":"","module_search":"","min_price":"","max_price":"","storeSlotBooked":"","additionalQueryParams":{"hidden_facet":null,"translation":null,"isMoreOptionsTileEnabled":true,"isGenAiEnabled":true,"rootDimension":"","altQuery":"","selectedFilter":"","neuralSearchSeeAll":false,"isModuleArrayReq":false,"enableGenericItemTileOptions":true,"isLMPBrowsePage":false},"searchArgs":{"query":"__TERM__","cat_id":"","prg":"mWeb","facet":""},"enableDesktopHighlights":false,"enableVolumePricing":false,"enableCopyBlock":true,"enableVariantCount":false,"enableSlaBadgeV2":true,"enableUnifiedProductFragment":true,"enableESSCarousel":false,"enableSearchBenefitsBanner":false,"enableSparkyPLPModule":false,"fitmentFieldParams":{"powerSportEnabled":true,"dynamicFitmentEnabled":true,"extendedAttributesEnabled":true,"extendedAttributesV2Enabled":true,"fuelTypeEnabled":true},"fitmentSearchParams":{"id":"","dealsId":"","query":"__TERM__","nudgeContext":"","page":1,"prg":"mWeb","catId":"","facet":"","sort":"best_match","rawFacet":"","seoPath":"","ps":40,"limit":40,"ptss":"","trsp":"","beShelfId":"","recall_set":"","module_search":"","min_price":"","max_price":"","storeSlotBooked":"","additionalQueryParams":{"hidden_facet":null,"translation":null,"isMoreOptionsTileEnabled":true,"isGenAiEnabled":true,"rootDimension":"","altQuery":"","selectedFilter":"","neuralSearchSeeAll":false,"isModuleArrayReq":false,"enableGenericItemTileOptions":true,"isLMPBrowsePage":false},"searchArgs":{"query":"sour cream","cat_id":"","prg":"mWeb","facet":""},"enableDesktopHighlights":false,"enableVolumePricing":false,"enableCopyBlock":true,"enableVariantCount":false,"enableSlaBadgeV2":true,"enableUnifiedProductFragment":true,"enableESSCarousel":false,"enableSearchBenefitsBanner":false,"enableSparkyPLPModule":false,"cat_id":"","_be_shelf_id":""},"searchParams":{"id":"","dealsId":"","query":"__TERM__","nudgeContext":"","page":1,"prg":"mWeb","catId":"","facet":"","sort":"best_match","rawFacet":"","seoPath":"","ps":40,"limit":40,"ptss":"","trsp":"","beShelfId":"","recall_set":"","module_search":"","min_price":"","max_price":"","storeSlotBooked":"","additionalQueryParams":{"hidden_facet":null,"translation":null,"isMoreOptionsTileEnabled":true,"isGenAiEnabled":true,"rootDimension":"","altQuery":"","selectedFilter":"","neuralSearchSeeAll":false,"isModuleArrayReq":false,"enableGenericItemTileOptions":true,"isLMPBrowsePage":false},"searchArgs":{"query":"sour cream","cat_id":"","prg":"mWeb","facet":""},"enableDesktopHighlights":false,"enableVolumePricing":false,"enableCopyBlock":true,"enableVariantCount":false,"enableSlaBadgeV2":true,"enableUnifiedProductFragment":true,"enableESSCarousel":false,"enableSearchBenefitsBanner":false,"enableSparkyPLPModule":false,"cat_id":"","_be_shelf_id":""},"fetchBadSplit":true,"enableFashionTopNav":false,"enableUnifiedSchema":true,"postProcessingVersion":2,"version":"v2","enableRelatedSearches":true,"enablePortableFacets":true,"enableFacetCount":true,"fetchMarquee":true,"fetchSkyline":true,"fetchGallery":false,"fetchSbaTop":true,"fetchDataV1":true,"fetchDataV2":false,"fungibilityEnabled":false,"enableAdsPromoData":false,"fetchDac":true,"tenant":"WM_GLASS","enableMultiSave":false,"enableInStoreShelfMessage":false,"enableSellerType":false,"enableItemRank":false,"enableOptimisticWeightUpdate":false,"enableAdditionalSearchDepartmentAnalytics":true,"enableFulfillmentTagsEnhacements":false,"enableRxDrugScheduleModal":false,"enablePromoData":true,"enableSignInToSeePrice":false,"enablePromotionMessages":false,"enableDebugAnalyticsTags":false,"enableItemLimits":false,"enableCanAddToList":false,"enableIsFreeWarranty":false,"enableShopSimilarBottomSheet":false,"adsParams":{"fungibilityEnabled":false},"pageType":"SearchPage","enableAdsUnifiedProductTile":false};
  const uuid = () => { let s = ''; for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16); return s; };
  const hdrs = () => ({
    accept: 'application/json', 'accept-language': 'en-US',
    'X-APOLLO-OPERATION-NAME': 'Search', 'x-o-gql-query': 'query Search',
    'tenant-id': 'elh9ie', 'x-o-mart': 'B2C', 'x-o-bu': 'WALMART-US', 'x-o-segment': 'oaoh',
    'x-o-platform': 'rweb', 'x-o-ccm': 'server', 'WM_MP': 'true',
    'x-latency-trace': '1', 'x-enable-server-timing': '1', 'WM_PAGE_URL': location.href,
    baggage: 'trafficType=customer,deviceType=mobile,renderScope=SSR,webRequestSource=Browser',
    'wm-client-traceid': uuid(), 'x-o-correlation-id': uuid(), 'wm_qos.correlation_id': uuid(),
    traceparent: '00-' + uuid() + '-' + uuid().slice(0, 16) + '-00',
    'x-o-platform-version': 'usweb-1.302.0',
  });
  const call = async (term) => {
    const vars = JSON.parse(JSON.stringify(TEMPLATE).split('__TERM__').join(term));
    const t0 = Date.now();
    const r = await fetch('/orchestra/snb/graphql/Search/' + HASH + '/search?variables='
      + encodeURIComponent(JSON.stringify(vars)), { credentials: 'include', headers: hdrs() });
    const txt = await r.text();
    const row = { term, status: r.status, ms: Date.now() - t0, bytes: txt.length };
    try {
      const j = JSON.parse(txt);
      if (j.errors) row.err = String(j.errors[0].message).slice(0, 90);
      const sr = j.data && j.data.search && j.data.search.searchResult;
      const stacks = (sr && sr.itemStacks) || [];
      const items = (stacks[0] && stacks[0].items) || [];
      row.items = items.length;
      const it = items[0] || {};
      row.first = { name: String(it.name || '').slice(0, 30), offerId: it.offerId,
        usItemId: it.usItemId, canAdd: it.canAddToCart,
        price: it.priceInfo && it.priceInfo.currentPrice ? it.priceInfo.currentPrice.priceString : null };
      // Where are the items really?
      const found = [];
      const walk = (n, path, d) => {
        if (n == null || d > 6 || found.length > 3) return;
        if (Object.prototype.toString.call(n) === '[object Array]') {
          if (n[0] && typeof n[0] === 'object' && (n[0].usItemId || n[0].offerId)) {
            found.push({ path, n: n.length, keys: Object.keys(n[0]).slice(0, 10) });
          }
          if (n[0]) walk(n[0], path + '[]', d + 1);
          return;
        }
        if (typeof n === 'object') for (const k of Object.keys(n)) walk(n[k], path ? path + '.' + k : k, d + 1);
      };
      walk(j.data, '', 0);
      row.itemPaths = found;
      try {
        const st = j.data.search.searchResult.itemStacks || [];
        const list = (st[0] && (st[0].itemsV2 || st[0].items)) || [];
        const it2 = list.find((x) => x && x.priceInfo) || list[0] || {};
        row.priceShape = it2.priceInfo ? JSON.stringify(it2.priceInfo).slice(0, 300) : null;
        row.priceKeys = it2.priceInfo ? Object.keys(it2.priceInfo) : null;
        row.name2 = String(it2.name || '').slice(0, 30);
      } catch (e) {}
      row.dataKeys = j.data ? Object.keys(j.data) : null;
      try { row.searchKeys = Object.keys(j.data.search).slice(0, 12); } catch (e) {}
    } catch (e) { row.peek = txt.slice(0, 90); }
    return row;
  };
  return { a: await call('sour cream') };
})()
