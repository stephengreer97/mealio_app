/**
 * H-E-B search over the network, instead of loading a results page (MEAL-202).
 *
 * The page reader — DOM or embedded JSON — needs a rendered results page, which
 * costs about 1.8 s per ingredient and is the single biggest cost in a run. The
 * store's own gateway answers the same question in about 280 ms, from inside the
 * WebView we are already holding.
 *
 * WHAT THIS BUYS BEYOND SPEED, and it is the better half:
 *
 *   - `excludeSponsoredContent` — sponsored and "perfect pairings" tiles stop
 *     being something the extractor has to recognise and discard. We do not ask
 *     for them, so they cannot be mistaken for results.
 *   - `includeOutOfStock` — stock stops being read off button text (MEAL-172).
 *   - `pageSize` — the result count is stated rather than however many tiles the
 *     page happened to render.
 *   - Product id and sku arrive with every candidate, which is what the network
 *     ADD needs (MEAL-139, MEAL-200) and what the DOM card cannot supply.
 *
 * NOTHING HERE IS HARDCODED TO A STORE. `storeId` and `shoppingContext` are read
 * from the session on every run — see buildHebSessionScript, and read its note
 * about which identifier is the right one, because there are two and they differ.
 *
 * Every failure returns null rather than throwing, because the caller's answer to
 * "the network could not tell me" is always the same: load the page and read it.
 */

/** Shared transport. Same endpoint, headers and credentials as the cart rail. */
const GQL_FN = `
  function __hebGql(op, query, variables, timeoutMs) {
    var ctl = null;
    try { ctl = new AbortController(); } catch (e) { ctl = null; }
    var timer = null;
    return (async function () {
      try {
        var init = {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'accept': '*/*',
            'apollographql-client-name': 'WebPlatform-Solar (Production)'
          },
          body: JSON.stringify({ operationName: op, variables: variables || {}, query: query })
        };
        if (ctl) init.signal = ctl.signal;
        var p = fetch('/graphql', init);
        if (ctl) timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, timeoutMs || 8000);
        var res = await p;
        var text = '';
        try { text = await res.text(); } catch (e) { text = ''; }
        if (timer) { clearTimeout(timer); timer = null; }
        // The wall answers 403 with an HTML incident page. Named on its own
        // because it is transient and self-healing (MEAL-16 measured 71-84 s):
        // it means try again, not "this store has no such product".
        if (res.status === 403) return { ok: false, why: 'blocked', status: 403 };
        if (!res.ok) return { ok: false, why: 'http', status: res.status };
        var json = null;
        try { json = JSON.parse(text); } catch (e) { return { ok: false, why: 'unparseable', status: res.status }; }
        if (json && json.errors && json.errors.length) {
          var e0 = json.errors[0];
          return { ok: false, why: 'graphql_error', status: res.status,
                   detail: (e0 && typeof e0.message === 'string') ? e0.message.slice(0, 200) : null };
        }
        return { ok: true, status: res.status, data: json && json.data };
      } catch (e) {
        if (timer) clearTimeout(timer);
        var isAbort = !!(e && e.name === 'AbortError');
        return { ok: false, why: isAbort ? 'timeout' : 'network', detail: String(e).slice(0, 120) };
      }
    })();
  }
`;

/**
 * Reads the session: is the user signed in, which store, and pickup or delivery.
 *
 * This is the login gate as well. A signed-out session has no `me`, so one
 * request answers what the login script needed a page load and a DOM check for.
 *
 * THE STORE IDENTIFIER IS THE SUBTLE PART. `me.preferredStore.storeNumber` and
 * `cartV2.fulfillment.store.id` are BOTH store identifiers and they are NOT the
 * same number — measured 243 and 476 for one shop. Search wants the fulfillment
 * store's id; sending the preferred store's number searches a different
 * catalogue and returns results that look entirely reasonable. So the
 * fulfillment store is what this returns, and the preferred store number is
 * carried only as a diagnostic.
 */
export function buildHebSessionScript(): string {
  return `(async function () {
${GQL_FN}
  var post = function (o) {
    o.type = 'HEB_SESSION';
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };

  var who = await __hebGql('myPreferredStore',
    'query myPreferredStore { me { id preferredStore { storeNumber } } }', {}, 8000);
  if (!who.ok) { post({ ok: false, why: who.why, status: who.status || null, detail: who.detail || null }); return; }
  var me = null, prefNumber = null;
  try { me = who.data.me && who.data.me.id; } catch (e) {}
  try { prefNumber = who.data.me.preferredStore.storeNumber; } catch (e) {}
  if (!me) { post({ ok: true, loggedIn: false }); return; }

  var sess = await __hebGql('SessionContext',
    'query SessionContext { cartV2 { __typename'
    + ' ... on Cart { id fulfillment { selectionState curbsideFulfillmentMode store { id name } } }'
    + ' ... on CartError { code title message } } }', {}, 8000);
  var storeId = null, storeName = null, mode = null;
  if (sess.ok) {
    try {
      var f = sess.data.cartV2.fulfillment;
      storeId = f.store && f.store.id;
      storeName = f.store && f.store.name;
      mode = f.curbsideFulfillmentMode;
    } catch (e) {}
  }
  post({
    ok: true,
    loggedIn: true,
    storeId: storeId != null ? String(storeId) : null,
    storeName: storeName || null,
    // Pickup and delivery price and stock differently, so this is not cosmetic.
    shoppingContext: (mode && String(mode).toUpperCase().indexOf('PICKUP') >= 0)
      ? 'CURBSIDE_PICKUP' : 'CURBSIDE_DELIVERY',
    fulfillmentMode: mode || null,
    preferredStoreNumber: prefNumber != null ? String(prefNumber) : null,
  });
})(); true;`;
}

/** The search document, written out so the nesting can be read. */
const SEARCH_QUERY = [
  'query productSearchPageV2($params: SearchPageParamsV2!) {',
  '  productSearchPageV2(params: $params) {',
  '    __typename',
  '    ... on SearchPage {',
  '      layout {',
  '        ... on VerticalStackLayout {',
  '          visualComponents {',
  '            ... on SearchGridV2 {',
  '              items {',
  '                __typename',
  '                ... on Product {',
  '                  id',
  '                  displayName',
  '                  decodedDisplayName',
  '                  fullDisplayName',
  '                  pricedByWeight',
  '                  shoppingContext',
  '                  minimumOrderQuantity',
  '                  maximumOrderQuantity',
  '                  inventory { inventoryState }',
  '                  productImageUrls { url size }',
  '                  purchasePreferenceList { label purchasePreferences { preferenceId text } }',
  '                  SKUs {',
  '                    id',
  '                    customerFriendlySize',
  '                    weightSelectionIncrements',
  '                    contextPrices { context salePrice { formattedAmount } listPrice { formattedAmount } }',
  '                  }',
  '                }',
  '              }',
  '            }',
  '          }',
  '        }',
  '      }',
  '    }',
  '    ... on SearchPageError { code message }',
  '  }',
  '}',
].join('\n');

/**
 * Search for one term and post SEARCH_RESULT, or post a failure the caller can
 * fall back on.
 *
 * The candidate shape is deliberately IDENTICAL to what the page readers emit,
 * name-for-name, so nothing downstream knows or cares where a candidate came
 * from. `source: 'network'` rides along only so the two can be compared in
 * telemetry before the page path is retired.
 */
export function buildHebNetworkSearchScript(
  term: string,
  opts: { storeId: string; shoppingContext: string; pageSize?: number },
): string | null {
  // The store id is coerced HERE, not in the injected script, and a bad one
  // returns null so the caller loads the page instead.
  //
  // `"476" | 0` would have worked and `"abc" | 0` would have searched store ZERO
  // — a real store id somewhere, answering with a real catalogue for a shop the
  // user has never been to. There is no error to notice in that; the results
  // just quietly belong to someone else.
  const storeId = Number(opts.storeId);
  if (!Number.isInteger(storeId) || storeId <= 0) return null;
  if (!opts.shoppingContext) return null;
  const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.min(opts.pageSize, 60) : 40;
  return `(async function () {
${GQL_FN}
  var TERM = ${JSON.stringify(term)};
  var post = function (o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };
  var fail = function (why, detail) {
    post({ type: 'SEARCH_RESULT_FAILED', source: 'network', why: why, detail: detail || null, term: TERM });
  };

  var res = await __hebGql('productSearchPageV2', ${JSON.stringify(SEARCH_QUERY)}, {
    params: {
      query: TERM,
      storeId: ${storeId},
      shoppingContext: ${JSON.stringify(opts.shoppingContext)},
      // Asked for, rather than filtered out afterwards. The page reader has to
      // recognise sponsored tiles and drop them; not requesting them means they
      // can never be mistaken for a result in the first place.
      excludeSponsoredContent: true,
      // Out of stock still comes back, flagged. The review screen needs to be
      // able to SAY an item is out of stock rather than silently finding nothing.
      includeOutOfStock: true,
      pageSize: ${pageSize},
    },
  }, 9000);
  if (!res.ok) { fail(res.why, res.detail || (res.status ? 'status ' + res.status : null)); return; }

  var page = null;
  try { page = res.data.productSearchPageV2; } catch (e) {}
  if (!page) { fail('unexpected_shape'); return; }
  if (page.__typename === 'SearchPageError') { fail('search_page_error', (page.message || page.code || '').slice(0, 160)); return; }

  var items = null;
  try {
    var vcs = page.layout.visualComponents;
    for (var i = 0; i < vcs.length; i++) {
      // Found by TYPE, not by having items in it. Requiring a non-empty list
      // made "the store has nothing matching this" indistinguishable from "the
      // grid was not where we expected" — and the two have opposite answers:
      // one is a real result the review screen should show, the other is a
      // reason to load the page and read it. Reporting no-results as a failure
      // would spend 1.8 s re-asking a question already answered.
      if (vcs[i] && vcs[i].__typename === 'SearchGridV2' && vcs[i].items) { items = vcs[i].items; break; }
    }
    // Fallback for a grid whose typename we did not get: any component that
    // actually carries items is still a grid for our purposes.
    if (items == null) {
      for (var j = 0; j < vcs.length; j++) {
        if (vcs[j] && vcs[j].items && vcs[j].items.length) { items = vcs[j].items; break; }
      }
    }
  } catch (e) {}
  // No grid at all is a shape we did not expect; an EMPTY grid is a real answer,
  // and the difference matters — one means fall back, the other means the store
  // genuinely has nothing.
  if (items == null) { fail('no_grid'); return; }

  var imageOf = function (p) {
    var urls = p.productImageUrls || [];
    var bySize = {};
    for (var i = 0; i < urls.length; i++) { if (urls[i] && urls[i].size) bySize[urls[i].size] = urls[i].url; }
    return bySize.MEDIUM || bySize.SMALL || bySize.LARGE || (urls[0] && urls[0].url) || null;
  };
  // Same rule the embedded-JSON reader uses, so a candidate's price does not
  // change depending on which path produced it.
  var priceOf = function (p, sku) {
    var cps = (sku && sku.contextPrices) || [];
    if (!cps.length) return null;
    var want = String(p.shoppingContext || '').split('_')[0];
    var pick = null;
    for (var i = 0; i < cps.length; i++) { if (cps[i] && cps[i].context === want) { pick = cps[i]; break; } }
    if (!pick) for (var j = 0; j < cps.length; j++) { if (cps[j] && cps[j].context === 'ONLINE') { pick = cps[j]; break; } }
    if (!pick) pick = cps[0];
    var amt = pick && (pick.salePrice || pick.listPrice);
    var f = amt && amt.formattedAmount;
    return (typeof f === 'string' && /[0-9]/.test(f)) ? f : null;
  };
  // The size is appended for the same reason the JSON reader appends it: the
  // card the user sees reads "Sour Cream, 16 oz", and the add path matches names
  // EXACTLY, so a name without the size matches nothing.
  var nameOf = function (p, sku) {
    var base = null;
    if (typeof p.decodedDisplayName === 'string' && p.decodedDisplayName) base = p.decodedDisplayName;
    else if (typeof p.fullDisplayName === 'string' && p.fullDisplayName) base = p.fullDisplayName;
    else if (typeof p.displayName === 'string' && p.displayName) base = p.displayName;
    if (!base) return null;
    var size = sku && sku.customerFriendlySize;
    if (typeof size === 'string' && size && base.indexOf(size) === -1) base = base + ', ' + size;
    return base;
  };
  var prefsOf = function (p) {
    var out = [];
    try {
      var list = p.purchasePreferenceList.purchasePreferences;
      for (var i = 0; i < list.length; i++) {
        var t = list[i] && list[i].text;
        if (t) out.push({ text: String(t).trim(), value: String(t).trim() });
      }
    } catch (e) {}
    return out.length ? out : null;
  };

  var candidates = [];
  for (var i = 0; i < items.length; i++) {
    var p = items[i];
    if (!p || p.__typename !== 'Product') continue;
    var sku = (p.SKUs && p.SKUs[0]) || null;
    var name = nameOf(p, sku);
    if (!name) continue;
    var incr = (sku && sku.weightSelectionIncrements) || [];
    candidates.push({
      productName: name,
      imageUrl: imageOf(p),
      outOfStock: !!(p.inventory && p.inventory.inventoryState !== 'IN_STOCK'),
      preferences: prefsOf(p),
      price: priceOf(p, sku),
      isWeightItem: !!p.pricedByWeight || incr.length > 0,
      weightOptions: incr.slice(),
      productId: p.id != null ? String(p.id) : null,
      skuId: (sku && sku.id != null) ? String(sku.id) : null,
    });
  }

  post({ type: 'SEARCH_RESULT', source: 'network', term: TERM, candidates: candidates });
})(); true;`;
}
