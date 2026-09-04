import type { NetworkRail } from './network-rail';
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

/**
 * Shared cart read: the CartLines query, the call, and the rows it becomes.
 *
 * Lifted out of the add batch so the cart can be read ON ITS OWN. It was only
 * ever reachable as a side effect of writing, which is why the sheet loaded
 * www.heb.com/cart to take its before / reconcile / after snapshots instead --
 * a page load measured at 2.0s, flat, on every run, and the single largest fixed
 * cost in a rail run. It is also what made the cart breakdown wrong when that
 * navigation landed on the homepage.
 */
const CART_READ_FN = `
  var CART = 'query CartLines { cartV2 { __typename'
    + ' ... on Cart { id items { id quantity estimatedWeight product { id fullDisplayName }'
    + '   sku { id customerFriendlySize } } }'
    + ' ... on CartError { code title message } } }';

  var readCart = async function () {
    var r = await __hebGql('CartLines', CART, {}, 8000);
    if (!r.ok) return null;
    try {
      var c = r.data.cartV2;
      if (!c || c.__typename !== 'Cart') return null;
      return c.items || [];
    } catch (e) { return null; }
  };

  var rowsOf = function (lines) {
    if (!lines) return null;
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var nm = l && l.product && l.product.fullDisplayName;
      if (!nm) continue;
      nm = String(nm);
      // THE SIZE GOES ON, because the page reader puts it on.
      //
      // These rows are diffed against the cart-page probe's rows by NAME, and
      // the probe reads the card, which says "..., 10 ct". Without the size
      // nothing matched, so every line looked new: the done screen opened with
      // 17 all-green rows and then reshuffled into green-and-grey the moment
      // the probe answered. Same product, two spellings, one of them ours.
      var size = l.sku && l.sku.customerFriendlySize;
      if (typeof size === 'string' && size && nm.indexOf(size) === -1) nm = nm + ', ' + size;
      var w = (l.estimatedWeight != null) ? Number(l.estimatedWeight) : null;
      var row = { name: nm, qty: Number(l.quantity) || 0 };
      // A weight line is reconciled by presence, not by count — same rule the
      // page reader follows, so both paths produce identical rows.
      if (w != null && !isNaN(w)) { row.isWeight = true; row.weight = w; }
      out.push(row);
    }
    return out;
  };
`;

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
 * Turning the gateway's products into candidates.
 *
 * ONE copy, shared by the single-term and batch scripts. Two copies of this is
 * exactly how a candidate ends up meaning something slightly different depending
 * on which path produced it — and the add path matches names EXACTLY, so
 * "slightly different" is "matches nothing".
 */
const CANDIDATE_HELPERS = `
  function __hebGridItems(page) {
    var items = null;
    try {
      var vcs = page.layout.visualComponents;
      for (var i = 0; i < vcs.length; i++) {
        // Found by TYPE, not by having items in it. Requiring a non-empty list
        // made "the store has nothing matching this" indistinguishable from "the
        // grid was not where we expected" — and the two have opposite answers:
        // one is a real result to show, the other is a reason to load the page.
        if (vcs[i] && vcs[i].__typename === 'SearchGridV2' && vcs[i].items) { items = vcs[i].items; break; }
      }
      if (items == null) {
        for (var j = 0; j < vcs.length; j++) {
          if (vcs[j] && vcs[j].items && vcs[j].items.length) { items = vcs[j].items; break; }
        }
      }
    } catch (e) {}
    return items;
  }

  function __hebImageOf(p) {
    var urls = p.productImageUrls || [];
    var bySize = {};
    for (var i = 0; i < urls.length; i++) { if (urls[i] && urls[i].size) bySize[urls[i].size] = urls[i].url; }
    return bySize.MEDIUM || bySize.SMALL || bySize.LARGE || (urls[0] && urls[0].url) || null;
  }

  // Same rule the embedded-JSON reader uses, so a candidate's price does not
  // change depending on which path produced it.
  function __hebPriceOf(p, sku) {
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
  }

  // The size is appended for the same reason the JSON reader appends it: the card
  // the user sees reads "Sour Cream, 16 oz", and the add path matches names
  // EXACTLY, so a name without the size matches nothing.
  function __hebNameOf(p, sku) {
    var base = null;
    if (typeof p.decodedDisplayName === 'string' && p.decodedDisplayName) base = p.decodedDisplayName;
    else if (typeof p.fullDisplayName === 'string' && p.fullDisplayName) base = p.fullDisplayName;
    else if (typeof p.displayName === 'string' && p.displayName) base = p.displayName;
    if (!base) return null;
    var size = sku && sku.customerFriendlySize;
    if (typeof size === 'string' && size && base.indexOf(size) === -1) base = base + ', ' + size;
    return base;
  }

  function __hebPrefsOf(p) {
    var out = [];
    try {
      var list = p.purchasePreferenceList.purchasePreferences;
      for (var i = 0; i < list.length; i++) {
        var t = list[i] && list[i].text;
        if (!t) continue;
        // text/value keep the shape the page path built from a modal ROW LABEL,
        // so a candidate stays interchangeable. preferenceId is additive and only
        // the network add reads it — the page path has no use for an id it cannot
        // click.
        var e = { text: String(t).trim(), value: String(t).trim() };
        var pid = list[i].preferenceId;
        if (pid != null) e.preferenceId = String(pid);
        out.push(e);
      }
    } catch (e) {}
    return out.length ? out : null;
  }

  function __hebCandidates(items) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var p = items[i];
      if (!p || p.__typename !== 'Product') continue;
      var sku = (p.SKUs && p.SKUs[0]) || null;
      var name = __hebNameOf(p, sku);
      if (!name) continue;
      var incr = (sku && sku.weightSelectionIncrements) || [];
      out.push({
        productName: name,
        imageUrl: __hebImageOf(p),
        outOfStock: !!(p.inventory && p.inventory.inventoryState !== 'IN_STOCK'),
        preferences: __hebPrefsOf(p),
        price: __hebPriceOf(p, sku),
        isWeightItem: !!p.pricedByWeight || incr.length > 0,
        weightOptions: incr.slice(),
        productId: p.id != null ? String(p.id) : null,
        skuId: (sku && sku.id != null) ? String(sku.id) : null,
        // The store's own per-item cap. Carried because the write sets an
        // ABSOLUTE quantity: cart-held + asked can exceed it, and the store then
        // refuses the whole write with "Quantity limit reached." — which is
        // exactly what happened to an avocado on the first full device run.
        maxOrderQuantity: (typeof p.maximumOrderQuantity === 'number' && p.maximumOrderQuantity > 0)
          ? p.maximumOrderQuantity : null,
      });
    }
    return out;
  }
`;

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
${CANDIDATE_HELPERS}
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

  var items = __hebGridItems(page);
  if (items == null) {
    // See the batch script: no grid on a well-formed page means the store has
    // nothing, which is an answer rather than a reason to load a page.
    post({ type: 'SEARCH_RESULT', source: 'network', term: TERM, candidates: [], noGrid: true });
    return;
  }

  post({ type: 'SEARCH_RESULT', source: 'network', term: TERM, candidates: __hebCandidates(items) });

})(); true;`;
}

/**
 * Search MANY terms from ONE page, with no navigation between them.
 *
 * This is where the time actually goes. The parallel worker pool exists to load
 * four results pages at once, because loading a page is what costs ~1.8 s per
 * ingredient. A network search needs no page at all: the WebView is already on
 * the store with a live session, so twelve ingredients are twelve requests from
 * where we already are.
 *
 * Measured single-search latency is ~280 ms, so a twelve-item run is a few
 * seconds of network against 22.5 s of navigation — and it needs no worker
 * WebViews, which is also where the memory goes (about 187 MB of the peak).
 *
 * CONCURRENCY IS DELIBERATELY SMALL. The bot defence did not react to 30 writes
 * at ~2/s (MEAL-115), and this is lighter than that, but a burst of twelve
 * simultaneous requests is a different shape from anything measured. Three at a
 * time stays inside what has been observed while still finishing quickly.
 *
 * Each term posts its own SEARCH_RESULT or SEARCH_RESULT_FAILED as it lands, so
 * the caller can fall back to loading a page for JUST the terms that failed
 * rather than abandoning the whole batch.
 */
export function buildHebNetworkSearchBatchScript(
  terms: string[],
  opts: { storeId: string; shoppingContext: string; pageSize?: number; concurrency?: number },
): string | null {
  const storeId = Number(opts.storeId);
  if (!Number.isInteger(storeId) || storeId <= 0) return null;
  if (!opts.shoppingContext) return null;
  if (!terms.length) return null;
  const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.min(opts.pageSize, 60) : 40;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 4));
  return `(async function () {
${GQL_FN}
  var TERMS = ${JSON.stringify(terms)};
  var post = function (o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };

${CANDIDATE_HELPERS}

  var searchOne = async function (term) {
    var res = await __hebGql('productSearchPageV2', ${JSON.stringify(SEARCH_QUERY)}, {
      params: {
        query: term,
        storeId: ${storeId},
        shoppingContext: ${JSON.stringify(opts.shoppingContext)},
        excludeSponsoredContent: true,
        includeOutOfStock: true,
        pageSize: ${pageSize},
      },
    }, 9000);
    if (!res.ok) {
      post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: term,
             why: res.why, detail: res.detail || (res.status ? 'status ' + res.status : null) });
      return;
    }
    var page = null;
    try { page = res.data.productSearchPageV2; } catch (e) {}
    if (!page) { post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: term, why: 'unexpected_shape' }); return; }
    if (page.__typename === 'SearchPageError') {
      post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: term, why: 'search_page_error',
             detail: String(page.message || page.code || '').slice(0, 160) });
      return;
    }
    var items = __hebGridItems(page);
    if (items == null) {
      // A well-formed SearchPage with no product grid is the store saying it has
      // NOTHING for this term — a no-results page renders a different set of
      // components (suggestions, promos) instead of an empty grid. That is a real
      // answer, not a transport failure, so it must not send the caller off to
      // load a page: the page would show the same nothing, 1.8 s later.
      //
      // The component names ride along so the day this assumption is wrong is a
      // day someone can see in the log rather than infer from bad matches.
      var seen = [];
      try {
        var vcs = page.layout.visualComponents;
        for (var v = 0; v < vcs.length; v++) if (vcs[v] && vcs[v].__typename) seen.push(vcs[v].__typename);
      } catch (e) {}
      post({ type: 'SEARCH_RESULT', source: 'network', term: term, candidates: [],
             noGrid: true, components: seen.join(',') });
      return;
    }
    post({ type: 'SEARCH_RESULT', source: 'network', term: term, candidates: __hebCandidates(items) });
  };

  // A fixed-size worker pool over the term list. Not Promise.all: twelve
  // simultaneous requests is a burst shape nothing has measured, and the point
  // of this rail is to stop guessing about what the store tolerates.
  var next = 0;
  var runner = async function () {
    while (true) {
      var i = next++;
      if (i >= TERMS.length) return;
      try { await searchOne(TERMS[i]); }
      catch (e) {
        post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: TERMS[i],
               why: 'threw', detail: String(e).slice(0, 120) });
      }
    }
  };
  var lanes = [];
  for (var L = 0; L < ${concurrency}; L++) lanes.push(runner());
  await Promise.all(lanes);
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length });
})(); true;`;
}

/**
 * Add many products by request, from one page, with no navigation.
 *
 * Each item arrives already MATCHED — product id, sku and quantity decided by the
 * caller from search results — so this script makes no product choices. It reads
 * the cart once for a baseline, issues one write per item, and reads once more.
 *
 * QUANTITY IS CART-ABSOLUTE. The store SETS a line rather than incrementing it,
 * so each write sends (what the cart already holds) + (what was asked for). The
 * card label cannot be used for that baseline here — there is no card — and it
 * could not be trusted anyway (MEAL-187). No usable cart read means no writes at
 * all, reported as such, because the alternative is setting lines to a number
 * derived from nothing.
 *
 * DECLINES weight-priced items, for the same reason the click-path rail does: a
 * count line can be set back to zero, a weight line cannot be undone at all
 * (MEAL-200). Those come back with a reason so the caller can route them to the
 * page path instead.
 */
/**
 * Read the cart, over the network, and answer as the cart PAGE would.
 *
 * Posts the same CART_COUNT the page posts -- same type, same {name, qty} rows,
 * same count (summed quantities) -- so every handler downstream is untouched and
 * cannot tell which read replied. That is the point: there is no second reader
 * left to disagree with, which is what made the done screen's green/grey
 * breakdown wrong when the two spelled a product differently.
 */
export function buildHebCartReadScript(): string {
  return `(async function () {
${GQL_FN}
${CART_READ_FN}
  var post = function (o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };
  try {
    var lines = await readCart();
    if (!lines) {
      // Null is UNKNOWN, never zero. A failed read reporting 0 would tell the
      // reconcile the cart is empty and invite it to re-add everything.
      post({ type: 'CART_COUNT', count: null, reason: 'rail_read_failed', source: 'network' });
      return;
    }
    var rows = rowsOf(lines) || [];
    var count = 0;
    for (var i = 0; i < rows.length; i++) count += (rows[i].qty || 0);
    post({ type: 'CART_COUNT', count: count, items: rows, source: 'network' });
  } catch (e) {
    post({ type: 'CART_COUNT', count: null, reason: 'rail_read_threw', source: 'network',
           detail: String(e).slice(0, 120) });
  }
})(); true;`;
}

export function buildHebNetworkAddBatchScript(
  items: Array<{
    idx: number; productId: string; skuId: string; quantity: number; name: string;
    isWeightItem?: boolean;
    /** The chosen purchase preference, for products that offer them (deli
     *  thickness, avocado ripeness). Absent means "no preference stated". */
    purchasePreferenceId?: string | null;
    /** The store's per-item cap, when known. */
    maxOrderQuantity?: number | null;
  }>,
  opts?: { concurrency?: number },
): string | null {
  const usable = items.filter(
    (i) => i && i.productId && i.skuId && Number.isInteger(i.quantity) && i.quantity > 0,
  );
  if (!usable.length) return null;
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 2, 3));
  return `(async function () {
${GQL_FN}
${CART_READ_FN}
  var ITEMS = ${JSON.stringify(usable)};
  var post = function (o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };
  // Named, not positional, and deliberately so: the taxonomy guard in
  // tests/unit/automationTelemetry.test.ts finds reasons by scanning for
  // single-quoted snake_case on a line mentioning "reason". Passed positionally,
  // every reason in this file was invisible to it — the guard was silently
  // disarmed for what is now the primary rail, which is the exact failure it was
  // written to catch.
  var report = function (it, ok, reason, detail) {
    post({ type: 'NET_ADD_RESULT', idx: it.idx, name: it.name, productId: it.productId,
           skuId: it.skuId, asked: it.quantity, success: !!ok, reason: reason || null,
           detail: detail || null });
  };
  // One per line, each carrying the word the scanner looks for. An uppercase
  // constant name did NOT work: the guard matches a lowercase word-boundary
  // "reason", so the first attempt at this list was invisible too and the test
  // went on passing.
  var reasonCatalog = [
    { reason: 'no_cart_baseline' },
    { reason: 'weight_item_declined' },
    { reason: 'multiple_cart_lines' },
    { reason: 'cart_line_is_weight' },
    { reason: 'preference_line_ambiguous' },
    { reason: 'quantity_limit_reached' },
    { reason: 'error_arm' },
    { reason: 'out_of_stock' },
    { reason: 'unexpected_shape' },
    { reason: 'threw' },
    { reason: 'blocked' },
    { reason: 'http' },
    { reason: 'unparseable' },
    { reason: 'graphql_error' },
    { reason: 'timeout' },
    { reason: 'network' },
  ];
  void reasonCatalog;

  var ADD = 'mutation cartItemV2($productId: String!, $skuId: String!, $quantity: Int,'
    + ' $purchasePreferenceId: String) {'
    + ' addItemToCartV2(productId: $productId, skuId: $skuId, quantity: $quantity,'
    + ' purchasePreferenceId: $purchasePreferenceId) {'
    + ' __typename'
    + ' ... on Cart { id }'
    + ' ... on AddOnsCart { id cart { id } }'
    + ' ... on AddItemToCartV2Error { message title code }'
    + ' ... on AddItemToCartV2TimeslotError { message title errorCode: code } } }';

  // ONE REQUEST FOR EVERY WRITE, the GraphQL way.
  //
  // addItemToCartV2 takes a single productId/skuId -- there is no list parameter
  // to fill, so H-E-B cannot be batched the way Albertsons was. GraphQL itself
  // provides the equivalent: several ALIASED root fields in one document. The
  // spec requires root mutation fields to execute SERIALLY, in order, which is
  // exactly what a shared cart needs -- one round trip, and no two writes in
  // flight against the same cart at once.
  //
  // Built rather than constant because the variable list depends on how many
  // items there are.
  function buildBatchDoc(n) {
    var params = [], fields = [];
    for (var i = 0; i < n; i++) {
      params.push('$p' + i + ': String!, $s' + i + ': String!, $q' + i + ': Int, $r' + i + ': String');
      fields.push(' a' + i + ': addItemToCartV2(productId: $p' + i + ', skuId: $s' + i
        + ', quantity: $q' + i + ', purchasePreferenceId: $r' + i + ') {'
        + ' __typename'
        + ' ... on Cart { id }'
        + ' ... on AddOnsCart { id cart { id } }'
        + ' ... on AddItemToCartV2Error { message title code }'
        + ' ... on AddItemToCartV2TimeslotError { message title errorCode: code } }');
    }
    return 'mutation cartItemsV2(' + params.join(', ') + ') {' + fields.join('') + ' }';
  }

  // Summed across every line for the product, because one product can hold
  // several lines keyed by preference — and reported with the COUNT, because the
  // write sets ONE line and cannot address a product that holds more than one.
  var held = function (lines, pid) {
    if (!lines) return null;
    var qty = 0, n = 0, weight = false;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var lp = l && l.product && l.product.id;
      if (lp == null || String(lp) !== String(pid)) continue;
      qty += (l.quantity || 0); n++;
      if (l.estimatedWeight != null) weight = true;
    }
    return { qty: qty, lines: n, weight: weight };
  };

  // The cart's own lines in the shape the done screen diffs (cart-count's
  // CartItem). The rail has always read the cart here — it just threw the rows
  // away and reported a count, which is why the breakdown had to come from a
  // page load. Same read, nothing extra on the wire.

  var before = await readCart();
  if (before == null) {
    // No baseline means no way to know what to SET. Guessing would drop whatever
    // the cart already held, silently.
    for (var i = 0; i < ITEMS.length; i++) report(ITEMS[i], false, 'no_cart_baseline');
    post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0 });
    return;
  }

  var wrote = 0;
  // Every write the store ACCEPTED, with the quantity it should then hold.
  var accepted = [];
  /** Items that passed every per-item check and are waiting for the one write. */
  var planned = [];
  var next = 0;
  var runner = async function () {
    while (true) {
      var k = next++;
      if (k >= ITEMS.length) return;
      var it = ITEMS[k];
      try {
        if (it.isWeightItem) { report(it, false, 'weight_item_declined'); continue; }
        var h = held(before, it.productId);
        if (h && h.weight) { report(it, false, 'cart_line_is_weight'); continue; }
        if (h && h.lines > 1) { report(it, false, 'multiple_cart_lines'); continue; }
        // A single existing line is not necessarily OUR line.
        //
        // held() sums across every line for the product, and lines are keyed by
        // preference. One existing line of 2 under "Ripe", plus a write for the
        // same product under "Firm", makes base 2 — so the new Firm line is set
        // to 2 + asked while the Ripe line keeps its 2, and the cart ends up
        // over by 2. The multi-line guard above does not catch it because there
        // is only one line so far.
        //
        // The cart read does not tell us which preference a line belongs to, so
        // there is nothing to reconcile against: decline and let the user add it
        // on the page, where the variants are visible.
        if (it.purchasePreferenceId && h && h.lines > 0) {
          report(it, false, 'preference_line_ambiguous', 'cart already holds ' + h.qty + ' of this product');
          continue;
        }
        var base = h ? h.qty : 0;
        // ADD ON TOP OF WHAT IS THERE. Stephen confirmed this on 2026-09-01,
        // after a run that started on the previous run's 19 items and ended at
        // 38. That is the cost of it and he chose it knowingly: an item already
        // in the cart is treated as the user's, so a meal needing 1 adds 1.
        // Re-running the same meals therefore doubles them. Not a bug -- do not
        // "fix" it into max(base, asked) without asking him again.
        var want = base + it.quantity;

        // The store's per-item cap, respected BEFORE asking.
        //
        // The write sets an absolute quantity, so cart-held + asked can exceed
        // the cap and the store refuses the whole write — "Quantity limit
        // reached." is what an avocado got on the first full device run, because
        // earlier test runs had already put several in the cart.
        //
        // Clamping is right where it still adds something, and wrong where it
        // does not: clamping to a number the cart ALREADY holds would write no
        // change and report success, which is an under-add dressed as a win. So
        // a cap already reached is reported as its own reason instead.
        var cap = (typeof it.maxOrderQuantity === 'number' && it.maxOrderQuantity > 0) ? it.maxOrderQuantity : null;
        if (cap != null && want > cap) {
          if (base >= cap) { report(it, false, 'quantity_limit_reached', 'cart already holds ' + base + ' of ' + cap); continue; }
          want = cap;
        }

        var vars = { productId: it.productId, skuId: it.skuId, quantity: want };
        // Only sent when there is one. A null preference on a product that
        // offers them is a different statement from an absent one, and the
        // store's own site omits the field rather than nulling it.
        if (it.purchasePreferenceId) vars.purchasePreferenceId = it.purchasePreferenceId;
        // PLANNED, NOT SENT. Every check above is per item and stays exactly
        // where it is; only the request moves.
        planned.push({ it: it, want: want, base: base, vars: vars });
      } catch (e) {
        report(it, false, 'threw', String(e).slice(0, 120));
      }
    }
  };
  /**
   * Turn one mutation's answer into this item's verdict.
   *
   * Lifted out of the lane so the batched and per-item paths cannot drift: the
   * arms they read, the wrote count and the message they post are the same code
   * whichever request carried them.
   */
  function applyOne(p, data, why, detail) {
    var it = p.it;
    if (why) { report(it, false, why, detail || null); return; }
    var arm = null, msg = null, code = null;
    try {
      var a = data.addItemToCartV2;
      arm = a && a.__typename;
      msg = a && a.message ? String(a.message).slice(0, 160) : null;
      // The mutation has ALWAYS selected this and nothing has ever read it.
      // AddItemToCartV2Error carries a code field; the timeslot arm aliases its
      // own code to errorCode, which is why both are checked. (No backticks in
      // this file: it is one template literal, and a backtick ends it.)
      code = a && (a.code || a.errorCode) ? String(a.code || a.errorCode) : null;
    } catch (e) {}
    // AddOnsCart wraps a cart -- the item went in. Reading it as a failure would
    // send the caller on to add the same product a second way.
    //
    // ACCEPTED, NOT LANDED. The mutation selects '... on Cart { id }' and
    // nothing else, so this says H-E-B took the write, not that the item is in
    // the cart. On 2026-09-01 a spinach write came back Cart and the cart read a
    // second later did not contain it. Verified below against the read we take
    // anyway.
    var ok = arm === 'Cart' || arm === 'AddOnsCart';
    if (ok) { wrote++; accepted.push({ it: it, want: p.want }); }
    // UNAVAILABLE IS OUT OF STOCK, and the difference is everything the user
    // can do about it.
    //
    // MEASURED, Stephen's H-E-B run, 2026-09-04 12:09:
    //   name 'Morton Salt, 26 oz'  reason 'error_arm'
    //   detail 'This item is out of stock. Try searching for a different item.'
    //
    // The store said so in its own words and we filed it as a generic error
    // arm. error_arm is not a definitive failure, so the reconcile sent the item
    // to RETRY; the retry hit the identical wall, and the run finished telling
    // him "could not add Morton Salt" with no review card, no alternatives and
    // nothing to do. out_of_stock routes to review, which is where the store's
    // own advice -- try a different item -- can actually be taken.
    //
    // On the CODE first, because it is the machine-readable field and the site's
    // own bundles carry the vocabulary: OUT_OF_STOCK, UNAVAILABLE,
    // UNAVAILABLE_FOR_STORE / _TIMESLOT / _DELIVERY / _PICKUP,
    // ITEM_UNAVAILABLE_DUE_TO_BLACKOUT, UNAVAILABLE_DUE_TO_OUTAGE. Every one of
    // them means the same thing to a shopper: not this product, today. The
    // message is the fallback, for an arm that carries no code.
    var unavailable = !ok && (
      (code && /OUT_OF_STOCK|UNAVAILABLE/i.test(code))
      || (!code && msg && /out of stock|unavailable|not available/i.test(msg)));
    // The sent quantity rides along so a clamped add is visible as a SHORT add
    // rather than passing for a full one -- the reconcile's own short-add
    // detection then reports it to the user.
    post({ type: 'NET_ADD_RESULT', idx: it.idx, name: it.name, productId: it.productId,
           skuId: it.skuId, asked: it.quantity, sent: p.want, base: p.base,
           preferenceId: it.purchasePreferenceId || null,
           success: ok,
           reason: ok ? null
             : unavailable ? 'out_of_stock'
             : arm ? 'error_arm' : 'unexpected_shape',
           // The store's own words reach the user through the review card, and
           // its code reaches the funnel — this was the one field that could
           // have told us which errors are worth routing and it was never
           // posted.
           detail: msg || null, code: code || null, arm: arm || null });
  }

  // One lane. The per-item checks only read the cart snapshot we already hold,
  // so there is nothing here to parallelise -- the request they used to make is
  // now made once, below, for all of them.
  await runner();

  // ONE DOCUMENT, root mutation fields executed SERIALLY by the spec, so no two
  // writes are ever in flight against the same cart. A document-level failure
  // falls back to the per-item path rather than failing every write: a gateway
  // that dislikes the shape must not be able to take a whole run with it.
  if (planned.length > 0) {
    var vmap = {};
    for (var bi = 0; bi < planned.length; bi++) {
      vmap['p' + bi] = planned[bi].vars.productId;
      vmap['s' + bi] = planned[bi].vars.skuId;
      vmap['q' + bi] = planned[bi].vars.quantity;
      // Left UNDEFINED when there is none. An unprovided variable leaves the
      // argument unprovided, which is the omission the single write relied on;
      // sending null would state a preference of "none".
      if (planned[bi].vars.purchasePreferenceId) {
        vmap['r' + bi] = planned[bi].vars.purchasePreferenceId;
      }
    }
    var bres = await __hebGql('cartItemsV2', buildBatchDoc(planned.length), vmap,
      9000 + planned.length * 1500);
    if (!bres.ok) {
      post({ type: 'NET_ADD_BATCH_FELL_BACK', count: planned.length, why: bres.why || null });
      for (var fb = 0; fb < planned.length; fb++) {
        var pf = planned[fb];
        var r1 = await __hebGql('cartItemV2', ADD, pf.vars, 9000);
        applyOne(pf, r1.ok ? r1.data : null, r1.ok ? null : (r1.why || 'network'), r1.detail || null);
      }
    } else {
      for (var bj = 0; bj < planned.length; bj++) {
        var pj = planned[bj], node = null;
        try { node = bres.data['a' + bj]; } catch (e) {}
        applyOne(pj, node ? { addItemToCartV2: node } : null, node ? null : 'unexpected_shape', null);
      }
    }
  }

  // One read after, so the caller has the cart's own account of what landed
  // rather than only the store's per-write answer.
  var after = await readCart();

  // VERIFY EVERY ACCEPTED WRITE AGAINST THAT READ, AND RETRY WHAT IS MISSING.
  //
  // The per-write answer is the mutation's return TYPE. It cannot say whether
  // the item is in the cart, and once it did not: eleven writes, all accepted,
  // and the cart came back without the spinach. The reconcile caught it a
  // second later and topped it up, which is what the reconcile is for -- but it
  // is a slow backstop for something this read already knew.
  //
  // So: anything accepted but absent (or short) is written ONCE more and the
  // cart re-read. The write sets an ABSOLUTE quantity, so a retry that races a
  // late-applying first write cannot double it. If it is still missing after
  // that, the item is reported failed and the reconcile does its job.
  if (after) {
    var missing = [];
    for (var v = 0; v < accepted.length; v++) {
      var h2 = held(after, accepted[v].it.productId);
      if (!h2 || h2.qty < accepted[v].want) missing.push(accepted[v]);
    }
    if (missing.length > 0) {
      post({ type: 'NET_ADD_UNLANDED', source: 'network', count: missing.length,
             names: missing.map(function (m) { return m.it.name; }) });
      for (var r2 = 0; r2 < missing.length; r2++) {
        var m2 = missing[r2];
        try {
          var vars2 = { productId: String(m2.it.productId), skuId: String(m2.it.skuId),
                        quantity: m2.want };
          if (m2.it.purchasePreferenceId) vars2.purchasePreferenceId = String(m2.it.purchasePreferenceId);
          await __hebGql('cartItemV2', ADD, vars2, 9000);
        } catch (e) {}
      }
      after = await readCart();
      // Re-report each one against the FINAL read, so the caller's per-item
      // record matches the cart rather than the mutation.
      for (var r3 = 0; r3 < missing.length; r3++) {
        var m3 = missing[r3];
        var h3 = held(after, m3.it.productId);
        var landed = !!(h3 && h3.qty >= m3.want);
        if (!landed) wrote--;
        post({ type: 'NET_ADD_RESULT', idx: m3.it.idx, name: m3.it.name,
               productId: m3.it.productId, skuId: m3.it.skuId,
               asked: m3.it.quantity, sent: m3.want, base: m3.want - m3.it.quantity,
               preferenceId: m3.it.purchasePreferenceId || null,
               success: landed, reason: landed ? null : 'cart_not_incremented',
               detail: landed ? 'landed on retry' : 'accepted but absent from the cart' });
      }
    }
  }
  post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: wrote,
         cartLines: after ? after.length : null,
         // Before and after, so the done screen can show what THIS run added in
         // green and what was already there in grey without loading the cart
         // page to find out.
         cartBefore: rowsOf(before), cartAfter: rowsOf(after) });
})(); true;`;
}

// ── The rail ─────────────────────────────────────────────────────────────────
//
// Moved here from network-rail.ts on 2026-09-04. A rail is a store's answer to
// the questions the engine asks, so it belongs in the store's own file: editing
// this one no longer means opening a file the other four are also in.

export const HEB_RAIL: NetworkRail = {
  sessionMessageType: 'HEB_SESSION',
  sessionScript: buildHebSessionScript,
  searchBatch: (terms, sess) => buildHebNetworkSearchBatchScript(terms, sess),
  cartRead: () => buildHebCartReadScript(),
  addBatch: (items, opts) =>
    buildHebNetworkAddBatchScript(
      // H-E-B addresses a cart line by sku, so an item without one is not
      // writable there; the filter is the store's constraint, not a shared rule.
      items.filter((i) => !!i.skuId).map((i) => ({ ...i, skuId: String(i.skuId) })),
      opts,
    ),
  writable: (c) => !!c.productId && !!c.skuId,
  // One session answer, and it is complete when it lands.
  sessionUsable: () => true,
  // THE STORE'S OWN PRECONDITION. cartSkuConfirm is what puts H-E-B's cart query
  // in front of the write; without it the add has no way to check that what it
  // reported actually landed, and an unverifiable write is the one thing this
  // store must not do. No other rail needs a second switch — each verifies from
  // its own write's response.
  addRequires: (cfg) => cfg.cartSkuConfirm === true,
  needsPreference: (c) => (c.preferences ?? []).some((p) => !!p.preferenceId),
  // MEASURED on the device 2026-09-02: eleven terms, all prewarmed, tap to done
  // in 6.9s; a search batch answers in about a second. Generous against that and
  // still a fraction of what Albertsons needs.
  budgets: {
    sessionMs: 15_000,
    searchMs: (terms) => Math.min(20_000 + terms * 2_000, 90_000),
    searchResumeMs: 20_000,
    addMs: (items) => Math.min(30_000 + items * 3_000, 120_000),
    // Measured at well under a second on this store.
    cartProbeMs: 12_000,
    searchRequestMs: 15_000,
    searchFirstRequestMs: 15_000,
  },
};
