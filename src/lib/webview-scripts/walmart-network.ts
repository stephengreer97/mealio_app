import type { NetworkRail } from './network-rail';
import { RETRY_FN } from './_retry';
/**
 * Walmart, over the network.
 *
 * The fourth rail, and the most defended. Everything here was MEASURED against
 * a signed-in session on 2026-09-03 (docs/network-rail-research/03-walmart.md).
 *
 * TRANSPORT
 *   POST /orchestra/<domain>/graphql/<OperationName>/<sha256>
 * The operation name AND its hash are in the URL PATH — Walmart's own scheme,
 * not Apollo's extensions.persistedQuery. Cookie-authenticated; no bearer.
 *
 * THE HEADERS ARE THE GATE. A request with only content-type is answered 418
 * "Access Denied"; a partial set gets 429 and a savings interstitial. The full
 * set below answers 200 in ~700ms. x-o-platform-version is required to be
 * PRESENT but not to be right — a deliberately bogus version still answered
 * 200 — so nothing has to be harvested from a page before the rail can talk.
 */


const ORIGIN = 'https://www.walmart.com';

/** MEASURED from the site's own calls. A pinned hash that stops working is a
 *  failure the run reports rather than works around — see the note on ops. */
const OPS = {
  /** cartxo. What the site itself calls on every page load. */
  MergeAndGetCart: '3ec6afb6cfeca435e690c537532ef47683874107384f76904e2327d4941979ef',
  /** home. The add — captured from a real Add-to-cart click. */
  updateItems: 'f7a7a5c72f31319f198a9097f111a1a5f121ed523e4400fcc215aa98152c5e4b',
  /**
   * snb. THE SEARCH THE SITE ITSELF USES for a client-side navigation.
   *
   * Captured by driving next.router.push('/search?q=...') and recording what
   * the app called. The page route uses getInitialProps, so there is no
   * /_next/data JSON route to fetch — every variant 404s — and this is the
   * fast path instead.
   */
  Search: '464cab4ac4aad772cd9b3cd6de458f56bb524d4b537612466028461ec5e05f58',
};

/**
 * The Search operation's variables, captured verbatim from the site.
 *
 * SEVENTY-TWO of them, and a persisted query answers 400 if the set does not
 * match — a hand-built subset was rejected outright. So the template is pinned
 * as the site sent it and only the query is swapped. When a deploy changes the
 * signature this stops working, which is exactly why the page fetch is still
 * there behind it: the rail falls back and the run carries on slower.
 */
const SEARCH_VARS_TEMPLATE = '{"id":"","dealsId":"","query":"__TERM__","nudgeContext":"","page":1,"prg":"mWeb","catId":"","facet":"","sort":"best_match","rawFacet":"","seoPath":"","ps":40,"limit":40,"ptss":"","trsp":"","beShelfId":"","recall_set":"","module_search":"","min_price":"","max_price":"","storeSlotBooked":"","additionalQueryParams":{"hidden_facet":null,"translation":null,"isMoreOptionsTileEnabled":true,"isGenAiEnabled":true,"rootDimension":"","altQuery":"","selectedFilter":"","neuralSearchSeeAll":false,"isModuleArrayReq":false,"enableGenericItemTileOptions":true,"isLMPBrowsePage":false},"searchArgs":{"query":"__TERM__","cat_id":"","prg":"mWeb","facet":""},"enableDesktopHighlights":false,"enableVolumePricing":false,"enableCopyBlock":true,"enableVariantCount":false,"enableSlaBadgeV2":true,"enableUnifiedProductFragment":true,"enableESSCarousel":false,"enableSearchBenefitsBanner":false,"enableSparkyPLPModule":false,"fitmentFieldParams":{"powerSportEnabled":true,"dynamicFitmentEnabled":true,"extendedAttributesEnabled":true,"extendedAttributesV2Enabled":true,"fuelTypeEnabled":true},"fitmentSearchParams":{"id":"","dealsId":"","query":"__TERM__","nudgeContext":"","page":1,"prg":"mWeb","catId":"","facet":"","sort":"best_match","rawFacet":"","seoPath":"","ps":40,"limit":40,"ptss":"","trsp":"","beShelfId":"","recall_set":"","module_search":"","min_price":"","max_price":"","storeSlotBooked":"","additionalQueryParams":{"hidden_facet":null,"translation":null,"isMoreOptionsTileEnabled":true,"isGenAiEnabled":true,"rootDimension":"","altQuery":"","selectedFilter":"","neuralSearchSeeAll":false,"isModuleArrayReq":false,"enableGenericItemTileOptions":true,"isLMPBrowsePage":false},"searchArgs":{"query":"sour cream","cat_id":"","prg":"mWeb","facet":""},"enableDesktopHighlights":false,"enableVolumePricing":false,"enableCopyBlock":true,"enableVariantCount":false,"enableSlaBadgeV2":true,"enableUnifiedProductFragment":true,"enableESSCarousel":false,"enableSearchBenefitsBanner":false,"enableSparkyPLPModule":false,"cat_id":"","_be_shelf_id":""},"searchParams":{"id":"","dealsId":"","query":"__TERM__","nudgeContext":"","page":1,"prg":"mWeb","catId":"","facet":"","sort":"best_match","rawFacet":"","seoPath":"","ps":40,"limit":40,"ptss":"","trsp":"","beShelfId":"","recall_set":"","module_search":"","min_price":"","max_price":"","storeSlotBooked":"","additionalQueryParams":{"hidden_facet":null,"translation":null,"isMoreOptionsTileEnabled":true,"isGenAiEnabled":true,"rootDimension":"","altQuery":"","selectedFilter":"","neuralSearchSeeAll":false,"isModuleArrayReq":false,"enableGenericItemTileOptions":true,"isLMPBrowsePage":false},"searchArgs":{"query":"sour cream","cat_id":"","prg":"mWeb","facet":""},"enableDesktopHighlights":false,"enableVolumePricing":false,"enableCopyBlock":true,"enableVariantCount":false,"enableSlaBadgeV2":true,"enableUnifiedProductFragment":true,"enableESSCarousel":false,"enableSearchBenefitsBanner":false,"enableSparkyPLPModule":false,"cat_id":"","_be_shelf_id":""},"fetchBadSplit":true,"enableFashionTopNav":false,"enableUnifiedSchema":true,"postProcessingVersion":2,"version":"v2","enableRelatedSearches":true,"enablePortableFacets":true,"enableFacetCount":true,"fetchMarquee":true,"fetchSkyline":true,"fetchGallery":false,"fetchSbaTop":true,"fetchDataV1":true,"fetchDataV2":false,"fungibilityEnabled":false,"enableAdsPromoData":false,"fetchDac":true,"tenant":"WM_GLASS","enableMultiSave":false,"enableInStoreShelfMessage":false,"enableSellerType":false,"enableItemRank":false,"enableOptimisticWeightUpdate":false,"enableAdditionalSearchDepartmentAnalytics":true,"enableFulfillmentTagsEnhacements":false,"enableRxDrugScheduleModal":false,"enablePromoData":true,"enableSignInToSeePrice":false,"enablePromotionMessages":false,"enableDebugAnalyticsTags":false,"enableItemLimits":false,"enableCanAddToList":false,"enableIsFreeWarranty":false,"enableShopSimilarBottomSheet":false,"adsParams":{"fungibilityEnabled":false},"pageType":"SearchPage","enableAdsUnifiedProductTile":false}';

/** Cart identity and login state, both in one localStorage key. */
const CART_MAP_KEY = 'glassCartIdMap';

const WM_PRELUDE = `
${RETRY_FN}
  var WM = window.__mealioWM = window.__mealioWM || {};
  WM.post = function (o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };

  WM.SEARCH_VARS = '${SEARCH_VARS_TEMPLATE}';

  WM.uuid = function () {
    var s = '';
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  };

  /**
   * WHO THE USER IS, WITH NO NETWORK AT ALL.
   *
   * glassCartIdMap is written by the storefront and holds both facts a session
   * needs: {"crt":"<cartId>","id":"<...>","isGuest":false}. isGuest is the login
   * signal and crt is the cart every cart call names. Same origin, so the quiet
   * page can read it.
   */
  WM.cartMap = function () {
    try {
      var raw = localStorage.getItem('${CART_MAP_KEY}');
      if (!raw) return null;
      var m = JSON.parse(raw);
      if (!m || typeof m !== 'object') return null;
      return { cartId: m.crt || m.id || null, isGuest: m.isGuest === true, raw: !!raw };
    } catch (e) { return null; }
  };

  /**
   * THE HEADER SET, which is what gets past the door.
   *
   * Every value here was on the site's own request. The random ones are
   * per-request ids and are generated rather than replayed; the constants are
   * genuinely constant across operations and sessions.
   */
  WM.headers = function (op, kind) {
    var cid = WM.uuid();
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-language': 'en-US',
      'X-APOLLO-OPERATION-NAME': op,
      'x-o-gql-query': kind + ' ' + op,
      'tenant-id': 'elh9ie',
      'x-o-mart': 'B2C',
      'x-o-bu': 'WALMART-US',
      'x-o-segment': 'oaoh',
      'x-o-platform': 'rweb',
      'x-o-ccm': 'server',
      'WM_MP': 'true',
      'x-latency-trace': '1',
      'x-enable-server-timing': '1',
      'WM_PAGE_URL': location.href,
      baggage: 'trafficType=customer,deviceType=mobile,renderScope=SSR,webRequestSource=Browser',
      'wm-client-traceid': WM.uuid(),
      'x-o-correlation-id': cid,
      'wm_qos.correlation_id': cid,
      traceparent: '00-' + WM.uuid() + '-' + WM.uuid().slice(0, 16) + '-00',
      // Present, not correct: a bogus version answered 200. Pinning a real one
      // would be a thing to keep up to date for no measured benefit.
      'x-o-platform-version': 'usweb-1.302.0'
    };
  };

  /** The statuses this store uses to say no-because-you-look-like-a-robot. */
  WM.blockedStatus = function (st) {
    return st === 418 || st === 429 || st === 403 || st === 412;
  };

  /**
   * A challenge page, which arrives with a 200.
   *
   * Cheap and specific: the interstitial is ~15KB and titled "Robot or human?",
   * where a real search document is ~780KB. Checking only the head of the body
   * keeps this off the hot path for a real page.
   */
  WM.isChallenge = function (html) {
    var head = String(html || '').slice(0, 4000);
    return head.indexOf('Robot or human') >= 0
      || head.indexOf('px-captcha') >= 0
      || head.indexOf('Access Denied') >= 0;
  };

  // ONE ATTEMPT. The retrying wrapper below is the thing everything calls; see
  // _retry.ts for which failures earn a second ask and why a timeout does not.
  // PHASE IS AN ARGUMENT. A name -> phase map here would put every operation
  // name into this prelude, and the prelude is in every script this rail emits
  // -- which is how a test counting H-E-B session probes by operation name went
  // from 0 to 1. The caller knows what it is asking for.
  WM.gql = function (domain, op, kind, hash, variables, budgetMs, phase) {
    return __mealioRetry(
      function () { return WM.gqlAttempt(domain, op, kind, hash, variables, budgetMs); },
      { phase: phase || 'session', op: op });
  };
  WM.gqlAttempt = async function (domain, op, kind, hash, variables, budgetMs) {
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, budgetMs || 20000);
    var t0 = Date.now();
    var r, txt;
    try {
      r = await fetch('${ORIGIN}/orchestra/' + domain + '/graphql/' + op + '/' + hash, {
        method: 'POST', credentials: 'include', signal: ctl.signal,
        headers: WM.headers(op, kind), body: JSON.stringify({ variables: variables })
      });
      clearTimeout(to);
      txt = await r.text();
    } catch (e) {
      clearTimeout(to);
      return { ok: false, why: 'no_response', aborted: !!(e && e.name === 'AbortError'), ms: Date.now() - t0 };
    }
    var ms = Date.now() - t0;
    // 418 and 429 are the anti-bot answers, and they are NOT the same as a
    // store that said no: they mean the request did not look like the site's.
    // THE ANTI-BOT ANSWERS, and 412 is one of them.
    //
    // MEASURED 2026-09-03: after a burst of searches this session started
    // getting 412 Precondition Failed on the cart and a challenge on search.
    // Blocked is not the same fact as a store that said no, and the two must
    // not be reported as one: a run that hands over because it was blocked can
    // still put the user in front of the store, where a run that thinks the
    // cart is empty writes nonsense.
    if (WM.blockedStatus(r.status)) {
      return { ok: false, why: 'blocked', status: r.status, ms: ms };
    }
    if (r.status < 200 || r.status >= 300) {
      return { ok: false, why: 'http', status: r.status, ms: ms, detail: String(txt || '').slice(0, 140) };
    }
    var j = null;
    try { j = JSON.parse(txt); } catch (e) {
      return { ok: false, why: 'unparseable', ms: ms, detail: String(txt || '').slice(0, 140) };
    }
    // A pinned hash that has been retired answers with an error and no data.
    if (!j.data) {
      var m = null;
      try { m = j.errors && j.errors[0] && String(j.errors[0].message).slice(0, 140); } catch (e) {}
      return { ok: false, why: 'gql_error', ms: ms, detail: m };
    }
    return { ok: true, data: j.data, ms: ms, bytes: txt.length };
  };

  /**
   * THE SEARCH IS THE PAGE, and the page is JSON.
   *
   * /search?q= is server-rendered Next.js, and the whole result set is in the
   * __NEXT_DATA__ script tag. So a search is one GET and one JSON.parse: no
   * rendering, no selectors, nothing to drift. It is a different shape from the
   * other three rails, which call an API, but it has the same properties.
   */
  /**
   * THE FAST SEARCH: the site's own Search operation.
   *
   * Returns null when it cannot be used, so the caller falls back to the page
   * rather than failing the term. Items live at itemStacks[].itemsV2 here,
   * where the server-rendered page calls the same list .items.
   */
  WM.searchOp = async function (term, budgetMs) {
    var out = await __mealioRetry(function () { return WM.searchOpAttempt(term, budgetMs); },
      { phase: 'search', op: 'Search' });
    // THE CONTRACT IS UNCHANGED: null still means "cannot be used, fall back to
    // the page", and blocked is still the one failure the caller reads. The
    // attempt below now names its transient failures so the policy can see
    // them, and this folds everything else back to null.
    if (!out || out.ok || out.why === 'blocked') return out || null;
    return null;
  };
  // ONE ATTEMPT. Walmart's search does NOT go through WM.gql -- it builds its
  // own URL -- so wrapping the transport left the search one-shot.
  WM.searchOpAttempt = async function (term, budgetMs) {
    var vars;
    try {
      vars = JSON.parse(String(WM.SEARCH_VARS).split('__TERM__').join(
        String(term).split('"').join(' ').split(String.fromCharCode(92)).join(' ')));
    } catch (e) { return null; }
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, budgetMs || 20000);
    var t0 = Date.now();
    var r, txt;
    try {
      r = await fetch('${ORIGIN}/orchestra/snb/graphql/Search/${OPS.Search}/search?variables='
        + encodeURIComponent(JSON.stringify(vars)),
        { credentials: 'include', signal: ctl.signal, headers: WM.headers('Search', 'query') });
      clearTimeout(to);
      txt = await r.text();
    } catch (e) {
      clearTimeout(to);
      return { ok: false, why: 'no_response', aborted: !!(e && e.name === 'AbortError') };
    }
    var ms = Date.now() - t0;
    if (WM.blockedStatus(r.status)) return { ok: false, why: 'blocked', status: r.status, ms: ms };
    if (r.status < 200 || r.status >= 300) return { ok: false, why: 'http', status: r.status, ms: ms };
    var j;
    try { j = JSON.parse(txt); } catch (e) { return null; }
    var stacks = null;
    try { stacks = j.data.search.searchResult.itemStacks; } catch (e) {}
    if (!stacks) return null;
    var items = [];
    for (var s2 = 0; s2 < stacks.length; s2++) {
      var list = stacks[s2].itemsV2 || stacks[s2].items || [];
      for (var i = 0; i < list.length; i++) items.push(list[i]);
    }
    if (!items.length) return null;
    return { ok: true, items: items, ms: ms, bytes: txt.length, via: 'op' };
  };

  WM.searchPage = function (term, budgetMs) {
    return __mealioRetry(function () { return WM.searchPageAttempt(term, budgetMs); },
      { phase: 'search', op: 'search-html' });
  };
  // ONE ATTEMPT. The HTML fallback is the LAST thing standing between a term
  // and the review screen, so a 5xx here costs the item outright.
  WM.searchPageAttempt = async function (term, budgetMs) {
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, budgetMs || 20000);
    var t0 = Date.now();
    var r, html;
    try {
      r = await fetch('${ORIGIN}/search?q=' + encodeURIComponent(term), {
        credentials: 'include', signal: ctl.signal
      });
      clearTimeout(to);
      html = await r.text();
    } catch (e) {
      clearTimeout(to);
      return { ok: false, why: 'no_response', aborted: !!(e && e.name === 'AbortError'), ms: Date.now() - t0 };
    }
    var ms = Date.now() - t0;
    if (WM.blockedStatus(r.status)) return { ok: false, why: 'blocked', status: r.status, ms: ms };
    if (r.status < 200 || r.status >= 300) return { ok: false, why: 'http', status: r.status, ms: ms };
    // A CHALLENGE IS SERVED AS A 200.
    //
    // MEASURED: /search?q= answered 200, 15KB, titled "Robot or human?" — a
    // PerimeterX interstitial wearing a success status. Reading that as
    // "no payload" reports an empty shelf for a store that never looked, and
    // sends the user to review holding nothing.
    if (WM.isChallenge(html)) return { ok: false, why: 'blocked', status: 200, ms: ms, challenge: true };
    // THE TAG, not the first mention of it.
    //
    // An inline script near the top of the document READS
    // document.getElementById("__NEXT_DATA__"), so a plain indexOf for the id
    // lands 900 bytes short of the payload and parses a slice of minified
    // JavaScript. Anchor on the opening tag instead.
    //
    // No regex: this whole script is a template literal, and a backslash class
    // like the s-and-S one does not survive into the emitted string.
    var start = html.indexOf('<script id="__NEXT_DATA__"');
    if (start < 0) return { ok: false, why: 'no_payload', ms: ms };
    var open = html.indexOf('>', start);
    var close = html.indexOf('</script>', open);
    if (open < 0 || close < 0) return { ok: false, why: 'no_payload', ms: ms };
    var j;
    try { j = JSON.parse(html.slice(open + 1, close)); } catch (e) {
      return { ok: false, why: 'unparseable', ms: ms };
    }
    var items = [];
    try {
      var stacks = j.props.pageProps.initialData.searchResult.itemStacks || [];
      for (var s = 0; s < stacks.length; s++) {
        var list = stacks[s].items || [];
        for (var i = 0; i < list.length; i++) items.push(list[i]);
      }
    } catch (e) {}
    var signedIn = null;
    try { signedIn = html.indexOf('"customerId":"') >= 0; } catch (e) {}
    return { ok: true, items: items, ms: ms, signedIn: signedIn, bytes: html.length, via: 'page' };
  };

  /**
   * The operation first, the page behind it.
   *
   * MEASURED 2026-09-03: the operation answers in ~0.9s against ~1.2-1.5s for
   * the 610-780KB document, and it is the request the site itself makes for a
   * client-side search — which matters as much as the speed on a store that
   * challenges anything that looks like page scraping.
   */
  WM.searchOnce = async function (term, budgetMs) {
    var op = await WM.searchOp(term, budgetMs);
    if (op && op.ok) return op;
    // A block is a block: do not spend a 700KB page fetch proving it twice.
    if (op && op.why === 'blocked') return op;
    return WM.searchPage(term, budgetMs);
  };

  /** Sold by the pound, rather than merely priced that way. */
  WM.soldByWeight = function (it) {
    var u = String(it.salesUnitType == null ? '' : it.salesUnitType).toUpperCase();
    if (u) return u === 'WEIGHT' || u === 'LB' || u === 'POUND';
    return false;
  };

  WM.candidate = function (it) {
    // THE PRICE, which only the OPERATION carries.
    //
    // The server-rendered page ships priceInfo with every field empty and
    // price: 0 on every item — Walmart strips it there — which is why this rail
    // reached the Choose Products screen without prices at all. The Search
    // operation returns priceDetails.priceLines instead, and DISCOUNTED_PRICE
    // is the one the shopper pays.
    var price = null;
    try {
      var lines = it.priceInfo && it.priceInfo.priceDetails && it.priceInfo.priceDetails.priceLines;
      if (lines) {
        for (var li = 0; li < lines.length && !price; li++) {
          if (String(lines[li].lineType) !== 'DISCOUNTED_PRICE') continue;
          var vals = lines[li].values || [];
          for (var vi = 0; vi < vals.length && !price; vi++) {
            if (String(vals[vi].key) === 'PRICE' && vals[vi].value != null) {
              price = '$' + String(vals[vi].value);
            }
          }
        }
      }
    } catch (e) {}
    // The page's shape, for the fallback path.
    if (!price) {
      try {
        var p = it.priceInfo && it.priceInfo.currentPrice;
        if (p && p.priceString) price = String(p.priceString);
        else if (p && p.price) price = '$' + Number(p.price).toFixed(2);
      } catch (e) {}
    }
    var img = null;
    try { img = it.imageInfo && (it.imageInfo.thumbnailUrl || it.imageInfo.size200Url) || it.image || null; } catch (e) {}
    var avail = String(it.availabilityStatusDisplayValue || it.availabilityStatus || '');
    return {
      productName: String(it.name || ''),
      imageUrl: img,
      // canAddToCart is the store's own word for it and is the one that
      // matters: an item can be "In stock" and still not be addable here.
      outOfStock: it.canAddToCart === false || /out of stock|unavailable/i.test(avail),
      preferences: null,
      price: price,
      // THE OFFER IS THE IDENTIFIER, and it is not a choice.
      //
      // usItemId is the stable PRODUCT and offerId is a seller-and-price OFFER,
      // so the product id looks like the better thing to save. The write will
      // not take it: MEASURED 2026-09-03, updateItems answers "offerId is
      // invalid" for a payload carrying usItemId and a real lineItemId, and the
      // same for an empty offerId. The site itself sends usItemId EMPTY.
      //
      // Both are saved on a chosen product all the same. If an offer ever
      // retires, the write fails, the cart disagrees and the row reaches review
      // — and the saved usItemId is what a re-resolve would start from.
      productId: it.offerId != null ? String(it.offerId) : null,
      skuId: it.usItemId != null ? String(it.usItemId) : null,
      isWeightItem: WM.soldByWeight(it),
      maxOrderQuantity: it.orderLimit != null ? Number(it.orderLimit) : null,
      upc: null,
      storeNumber: null
    };
  };
`;

export interface WalmartAddItem {
  idx: number;
  productId: string;
  skuId?: string | null;
  quantity: number;
  name: string;
}

/** Who is signed in, and which cart. No network at all. */
export function buildWalmartSessionScript(): string {
  return `(async function () {
${WM_PRELUDE}
  try {
    var m = WM.cartMap();
    if (!m || !m.cartId) {
      // No cart map at all means the storefront has never run in this WebView,
      // which is not the same as being signed out — say so rather than guess.
      WM.post({ type: 'WMT_SESSION', ok: true, loggedIn: false, why: 'no_cart_map' });
      return;
    }
    WM.post({
      type: 'WMT_SESSION', ok: true, loggedIn: !m.isGuest, cartId: m.cartId,
      shoppingContext: 'delivery', source: 'cartmap'
    });
  } catch (e) {
    WM.post({ type: 'WMT_SESSION', ok: false, why: 'threw', detail: String(e).slice(0, 160) });
  }
})(); true;`;
}

/** Read the cart. One call, no page load. */
export function buildWalmartCartReadScript(): string {
  return `(async function () {
${WM_PRELUDE}
  try {
    var m = WM.cartMap();
    if (!m || !m.cartId) {
      WM.post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_failed',
                why: 'no_cart_map' });
      return;
    }
    var r = await WM.gql('cartxo', 'MergeAndGetCart', 'mutation', '${OPS.MergeAndGetCart}', {
      input: { cartId: m.cartId, strategy: 'MERGE', enableLiquorBox: true,
               enableCartSplitClarity: false, features: [] },
      detailed: false
    }, 20000, 'cart_read');
    if (!r.ok) {
      WM.post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_failed',
                why: r.why, status: r.status || null });
      return;
    }
    var lines = [];
    try { lines = r.data.mergeAndGetCart.lineItems || []; } catch (e) {}
    var rows = [];
    var count = 0;
    for (var i = 0; i < lines.length; i++) {
      var li = lines[i] || {};
      var p = li.product || {};
      var q = Number(li.quantity != null ? li.quantity : 1);
      if (!(q > 0)) q = 1;
      // THE OFFER, not the line and not the usItemId: it is what search returns
      // and what the write names. Two of the three ids on a line are traps, the
      // same way they were on Wegmans and ALDI.
      var id = p.offerId != null ? String(p.offerId) : null;
      rows.push({ name: String(p.name || id || 'item'), qty: q, itemId: id,
                  lineId: li.id != null ? String(li.id) : null, available: true });
      count += q;
    }
    WM.post({ type: 'CART_COUNT', count: count, items: rows, source: 'network', ms: r.ms,
              cartId: m.cartId });
  } catch (e) {
    WM.post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_threw',
              detail: String(e).slice(0, 140) });
  }
})(); true;`;
}

/** Search every term. One GET each, serial, no navigation. */
export function buildWalmartNetworkSearchBatchScript(terms: string[]): string | null {
  if (!terms.length) return null;
  return `(async function () {
${WM_PRELUDE}
  var TERMS = ${JSON.stringify(terms)};
  var post = WM.post;
  try {
    for (var t = 0; t < TERMS.length; t++) {
      var term = TERMS[t];
      // PACED. A burst of full-page searches from one session is what a scraper
      // looks like, and this store answers that with a challenge — measured
      // 2026-09-03, after which even the homepage came back "Robot or human?".
      // A short gap between terms costs a second across a meal and makes the
      // run look like someone typing.
      if (t > 0) await new Promise(function (res) { setTimeout(res, 400 + Math.floor(Math.random() * 400)); });
      var r = await WM.searchOnce(term, 20000);
      if (!r.ok) {
        post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: term, why: r.why,
               status: r.status || null, ms: r.ms });
        // BLOCKED STOPS THE BATCH. Fourteen more requests to a store that has
        // just refused one will not find a different answer, and each of them
        // digs the session in deeper. The run hands over to the user instead.
        if (r.why === 'blocked') {
          post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length,
                 blocked: true, at: t });
          return;
        }
        continue;
      }
      var cands = [];
      for (var i = 0; i < r.items.length && cands.length < 24; i++) {
        var c = WM.candidate(r.items[i]);
        if (c.productName && c.productId) cands.push(c);
      }
      post({ type: 'SEARCH_RESULT', source: 'network', term: term, candidates: cands,
             ms: r.ms, n: r.items.length });
    }
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length });
  } catch (e) {
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length,
           threw: String(e).slice(0, 140) });
  }
})(); true;`;
}

/**
 * Write the cart.
 *
 * MEASURED: POST /orchestra/home/graphql/updateItems/<hash> with
 * {input:{cartId, items:[{offerId, quantity, usItemId:"", name}]}}. `items` is
 * a list, so a whole meal is one request.
 */
export function buildWalmartNetworkAddBatchScript(
  items: WalmartAddItem[],
  opts: { absoluteQty?: boolean | null } = {},
): string | null {
  const writable = items.filter((i) => !!i.productId);
  if (!writable.length) return null;
  return `(async function () {
${WM_PRELUDE}
  var ITEMS = ${JSON.stringify(writable)};
  var ABSOLUTE = ${JSON.stringify(opts.absoluteQty ?? null)};
  var post = WM.post;
  var report = function (it, ok, reason, detail, asked) {
    post({ type: 'NET_ADD_RESULT', idx: it.idx, name: it.name, productId: it.productId,
           skuId: it.skuId || null, asked: asked != null ? asked : it.quantity,
           success: !!ok, reason: reason || null, detail: detail || null });
  };
  // Named so the telemetry taxonomy guard can see them.
  var reasonCatalog = [
    { reason: 'no_cart' },
    { reason: 'blocked' },
    { reason: 'write_refused' },
    { reason: 'not_in_cart_after_write' }
  ];
  void reasonCatalog;

  var readCart = async function (cartId) {
    var r = await WM.gql('cartxo', 'MergeAndGetCart', 'mutation', '${OPS.MergeAndGetCart}', {
      input: { cartId: cartId, strategy: 'MERGE', enableLiquorBox: true,
               enableCartSplitClarity: false, features: [] },
      detailed: false
    }, 20000, 'cart_read');
    if (!r.ok) return null;
    var lines = [];
    try { lines = r.data.mergeAndGetCart.lineItems || []; } catch (e) { return null; }
    var held = {};
    var lineIds = {};
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var li = lines[i] || {};
      var p = li.product || {};
      var id = p.offerId != null ? String(p.offerId) : null;
      var q = Number(li.quantity != null ? li.quantity : 1);
      if (!(q > 0)) q = 1;
      if (id) {
        held[id] = (held[id] || 0) + q;
        // The LINE, which is what turns a write into a quantity change.
        if (li.id != null) lineIds[id] = String(li.id);
      }
      rows.push({ name: String(p.name || id || 'item'), qty: q, itemId: id, available: true });
    }
    return { held: held, rows: rows, lineIds: lineIds };
  };

  try {
    var m = WM.cartMap();
    if (!m || !m.cartId) {
      for (var n = 0; n < ITEMS.length; n++) report(ITEMS[n], false, 'no_cart', 'no cart id in this WebView');
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, why: 'no_cart' });
      return;
    }
    // A CART THAT COULD NOT BE READ IS NOT AN EMPTY CART. The same rule the
    // other rails learned the hard way: an empty baseline plus an absolute
    // write silently overwrites the user's own quantities.
    var before = await readCart(m.cartId);
    if (!before) {
      for (var z = 0; z < ITEMS.length; z++) report(ITEMS[z], false, 'no_cart', 'could not read the cart to baseline against');
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, why: 'no_cart' });
      return;
    }

    var list = [];
    var planned = [];
    for (var i2 = 0; i2 < ITEMS.length; i2++) {
      var it = ITEMS[i2];
      var have = Number(before.held[it.productId] || 0);
      var want = Math.max(1, Math.round(it.quantity || 1));
      // AN EXISTING LINE IS ADDRESSED BY lineItemId, and then quantity is
      // ABSOLUTE. MEASURED 2026-09-03:
      //
      //   no line id           creates a line. For an offer the cart already
      //                        holds, the write returns 200 and changes nothing.
      //   lineItemId           SETS that line. 1 -> 2 when 2 is sent.
      //
      // The field name is load-bearing: plain id and cartLineId both answered
      // "400: Bad Request" from ORCHESTRA-CARTXO-GQL. Only lineItemId works.
      //
      // So held + wanted for a line that exists, wanted for a new one — which
      // is add-on-top either way, the same as every other rail.
      var lineId = before.lineIds ? before.lineIds[it.productId] : null;
      var entry = { offerId: it.productId, usItemId: '', name: String(it.name || ''),
                    quantity: lineId ? have + want : want };
      if (lineId) entry.lineItemId = lineId;
      list.push(entry);
      planned.push({ it: it, want: want, have: have, sent: have + want });
    }
    if (!list.length) { post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0 }); return; }

    var res = await WM.gql('home', 'updateItems', 'mutation', '${OPS.updateItems}', {
      getDetailedAccesspoint: false,
      input: { cartId: m.cartId, items: list, enableLiquorBox: true,
               skipPolicyCheck: false, enableCartSplitClarity: false, features: [] }
    }, 25000, 'add');
    if (!res.ok) {
      for (var f = 0; f < planned.length; f++) report(planned[f].it, false,
        res.why === 'blocked' ? 'blocked' : 'write_refused',
        res.why + (res.status ? ' ' + res.status : '') + (res.detail ? ': ' + res.detail : ''));
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, why: res.why, status: res.status || null });
      return;
    }

    // THE CART DECIDES. Never the write's own report.
    var after = await readCart(m.cartId);
    var wrote = 0;
    for (var p2 = 0; p2 < planned.length; p2++) {
      var pl = planned[p2];
      var now = after ? Number(after.held[pl.it.productId] || 0) : null;
      if (now == null) { report(pl.it, true, null, 'written, cart not re-read', pl.want); wrote++; continue; }
      if (now >= pl.sent) { report(pl.it, true, null, null, pl.want); wrote++; }
      else report(pl.it, false, 'not_in_cart_after_write', 'expected ' + pl.sent + ', cart holds ' + now, pl.want);
    }
    post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: wrote, ms: res.ms,
           cartBefore: before.rows, cartAfter: after ? after.rows : [] });
  } catch (e) {
    post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, threw: String(e).slice(0, 140) });
  }
})(); true;`;
}

// ── The rail ─────────────────────────────────────────────────────────────────
//
// Moved here from network-rail.ts on 2026-09-04. A rail is a store's answer to
// the questions the engine asks, so it belongs in the store's own file: editing
// this one no longer means opening a file the other four are also in.

/**
 * Walmart.
 *
 * The odd one out in exactly one way: its SEARCH is a GET of a server-rendered
 * page whose whole result set is in a __NEXT_DATA__ script tag, rather than an
 * API call. One request, one JSON.parse, no rendering and no selectors — the
 * same properties the other three have, reached differently.
 *
 * Its cart is Walmart's own persisted-query scheme, with the operation name and
 * hash in the URL path. The headers are the gate: too few and the answer is 418
 * Access Denied.
 */
export const WALMART_RAIL: NetworkRail = {
  sessionMessageType: 'WMT_SESSION',
  sessionScript: buildWalmartSessionScript,
  searchBatch: (terms) => buildWalmartNetworkSearchBatchScript(terms),
  cartRead: () => buildWalmartCartReadScript(),
  addBatch: (items, opts) =>
    buildWalmartNetworkAddBatchScript(
      items.map((i) => ({ idx: i.idx, productId: i.productId, skuId: i.skuId ?? null,
                          quantity: i.quantity, name: i.name })),
      {
        // UNMEASURED: whether updateItems SETS a line or ADDS to it. ALDI and
        // Wegmans both surprised me on this question, and Wegmans turned out to
        // do BOTH depending on a line id — so it is null until a device says
        // otherwise, and null means the script sends held + wanted, which is
        // right for a SET and is checked against the cart afterwards either way.
        absoluteQty: opts?.absoluteQty ?? null,
      },
    ),
  // The OFFER is the identifier. usItemId rides along for display and is sent
  // empty on the write, which is measured rather than assumed.
  writable: (c) => !!c.productId,
  // One answer, from localStorage. Nothing to wait out.
  sessionUsable: () => true,
  // No store to resolve: national search, account cart.
  needsStoreId: false,
  needsPreference: () => false,
  // MEASURED: cart read ~700-800ms, search ~1.5-3s for a 500KB document. The
  // search is the slow half here because it is a whole page.
  budgets: {
    sessionMs: 10_000,
    // The BASE covers one cold request, which is allowed 25s below. It was
    // 15_000, so a one-term search had a 19s phase deadline over a request with
    // a 25s budget: the phase gave up while the request it was waiting for was
    // still legitimately running. Found by storeIsolation.test.ts on the day
    // that check was extended past the two stores it had been written for.
    searchMs: (terms) => Math.min(30_000 + terms * 4_000, 90_000),
    searchResumeMs: 20_000,
    addMs: (items) => Math.min(30_000 + items * 3_000, 120_000),
    cartProbeMs: 20_000,
    searchRequestMs: 20_000,
    searchFirstRequestMs: 25_000,
  },
};
