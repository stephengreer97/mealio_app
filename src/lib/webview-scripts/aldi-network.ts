// ALDI over the network -- and every other Instacart Storefront tenant.
//
// ALDI runs on Instacart Storefront, so nothing here is about ALDI: it is about
// the PLATFORM, the same way railConfigKey treats the fifteen Albertsons banners
// as one. A tenant added to INSTACART_TENANTS gets this rail for free.
//
// Researched 2026-09-02 against a live signed-in session on the device; every
// operation below was executed and timed. See docs/network-rail-research/02-aldi.md
// for the measurements and for how the hashes were found.
//
// THE ONE CONSTRAINT THAT SHAPES EVERYTHING. Instacart accepts ALLOW-LISTED
// persisted queries only:
//
//   POST /graphql {"query":"query Ping { __typename }"}
//     -> 400 PersistedQueryNotSupported
//
// Introspection gets the same answer. So this rail cannot write a query; it can
// only name one and give the sha256 the store already knows. Those hashes live
// in the storefront's own JavaScript -- 1,552 of them, in the plain shape
// "OperationName":"<64 hex>" -- and they change when Instacart deploys. That is
// the same problem the Albertsons APIM key has, and it takes the same answer:
// harvest, cache, and forget the cache the moment the store says a hash is
// unknown.
import { INSTACART_TENANTS } from './instacart';
import type { NetworkRail } from './network-rail';
import { RETRY_FN } from './_retry';

/** Where the harvested operation map is cached, and for how long. */
const OPS_CACHE_KEY = '__mealio_ic_ops_v1';
const OPS_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** Where the discovered shop id is cached. Same lifetime as the hashes. */
const SHOP_CACHE_KEY = '__mealio_ic_shop_v1';
/** The fulfilment zone, discovered from the ids a search returns. */
const ZONE_CACHE_KEY = '__mealio_ic_zone_v1';

/**
 * The operations this rail needs, with the hashes observed on 2026-09-02.
 *
 * These are a SEED, not a source of truth. They are what lets a run work on the
 * first launch after an install, before anything has been harvested; the cache
 * and the harvest are what keep it working after Instacart's next deploy.
 */
export const ALDI_SEED_OPS: Record<string, string> = {
  // No arguments at all, and it returns the cart id -- session probe and cart
  // identity in one call. MEASURED 176ms.
  ActiveCarts: '839c3658a57f86c543ba367a16d0eaa648f167a1eaf20f6d80aa14165f1ee10d',
  // ($query, $shopId, $zoneId, $postalCode) -> items WITH names, sizes, brands
  // and product ids. One call, MEASURED 1.3s for 20 items.
  Search: '6d77b6fd5b62f6d88999f5a022af16fafcb00de911da6b942990f61a478ed8c1',
  // ($query, $shopId, $postalCode, $searchSource) -> item IDS only. MEASURED
  // 117ms. Kept because it needs no zoneId, and the ids it returns CONTAIN the
  // zone -- which is how the zone is discovered in the first place.
  AsyncItemSearch: '19889f981af1f9c5c70543f3d7555bf0d435e026fc96329984fc3414e3b56d8e',
  // ItemDetailsRetailerProduct WAS here, to hydrate the ids AsyncItemSearch
  // returns. It is gone: MEASURED on the device, it answers
  // {"retailerProducts":[]} for ids the search had just handed back, under
  // every combination of full/bare ids and zone/shop as zoneId. It addresses a
  // different id space. `Search` above returns the names directly, which is one
  // call rather than two anyway.
  // ($id, $shopId, $postalCode) -> the cart lines. MEASURED 306ms.
  CartItems: '60fa63eb1afba0204993af2a7ea12e057f0ae2677e71753fc05d5a9c5b4adb6c',
  // ($cartItemUpdates: [CartsCartItemUpdate!]!) where the input is
  // { itemId: ID!, quantity: Float! }. A LIST -- bulk add is one call.
  UpdateCartItemsMutation: 'a88cb16f9d30ef225e487baf6eda6851786440e74ffe73d66908ac2ab8b227a7',
};

/**
 * postalCode is required by three of the operations and is NOT validated --
 * "00000" was accepted, MEASURED. So the rail never needs the user's real
 * postcode, which is a small privacy win and one less thing to discover.
 */
const PLACEHOLDER_POSTAL = '00000';

function tenantOrigin(storeId: string): string {
  const t = INSTACART_TENANTS[storeId];
  return t ? t.origin : 'https://www.aldi.us';
}

/**
 * Everything the injected scripts share: the message bridge, the operation
 * cache, the GraphQL caller, and the context discovery.
 *
 * No backticks and no backslashes anywhere in here. A backtick ends the
 * template literal that carries this to the WebView, and a single backslash is
 * eaten before it ever arrives -- both have broken this build before, three
 * times each.
 */
const IC_PRELUDE = `
${RETRY_FN}
  var IC = window.__mealioIC = window.__mealioIC || {};
  IC.post = function (o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };

  // ---- the operation map -------------------------------------------------
  IC.cachedOps = function () {
    try {
      var raw = localStorage.getItem('${OPS_CACHE_KEY}');
      if (!raw) return null;
      var j = JSON.parse(raw);
      if (!j || !j.at || !j.ops) return null;
      if (Date.now() - j.at > ${OPS_CACHE_MAX_AGE_MS}) return null;
      return j.ops;
    } catch (e) { return null; }
  };
  IC.cacheOps = function (ops) {
    try { localStorage.setItem('${OPS_CACHE_KEY}', JSON.stringify({ at: Date.now(), ops: ops })); } catch (e) {}
  };
  IC.forgetOps = function () {
    try { localStorage.removeItem('${OPS_CACHE_KEY}'); } catch (e) {}
    IC.ops = null;
  };

  // Harvest the operation map out of the storefront's own scripts.
  //
  // MEASURED: 1,552 pairs across 80 files and 6.2MB, in the shape
  // "OperationName":"<64 hex>". Only the operations this rail names are kept --
  // storing all 1,552 would be a quarter of a megabyte in localStorage for no
  // reason.
  IC.harvestOps = async function (wanted, budgetMs) {
    var deadline = Date.now() + (budgetMs || 20000);
    var found = {};
    var urls = [];
    try {
      var res = performance.getEntriesByType('resource');
      for (var i = 0; i < res.length; i++) {
        var n = res[i].name || '';
        if (n.indexOf('.js') > 0) urls.push(n);
      }
    } catch (e) {}
    for (var u = 0; u < urls.length; u++) {
      if (Date.now() > deadline) break;
      var need = false;
      for (var w = 0; w < wanted.length; w++) if (!found[wanted[w]]) need = true;
      if (!need) break;
      var txt = '';
      try { var r = await fetch(urls[u]); txt = await r.text(); } catch (e) { continue; }
      for (var k = 0; k < wanted.length; k++) {
        var name = wanted[k];
        if (found[name]) continue;
        var at = txt.indexOf('"' + name + '":"');
        if (at < 0) continue;
        var from = at + name.length + 4;
        var hash = txt.substr(from, 64);
        if (hash.length === 64) found[name] = hash;
      }
    }
    return found;
  };

  // The hashes to use: cache, else harvest onto the seed, else the seed alone.
  IC.ensureOps = async function (seed, budgetMs) {
    if (IC.ops) return IC.ops;
    var cached = IC.cachedOps();
    if (cached) { IC.ops = cached; return IC.ops; }
    var wanted = Object.keys(seed);
    var got = {};
    try { got = await IC.harvestOps(wanted, budgetMs); } catch (e) { got = {}; }
    var merged = {};
    for (var i = 0; i < wanted.length; i++) merged[wanted[i]] = got[wanted[i]] || seed[wanted[i]];
    var harvested = 0;
    for (var j = 0; j < wanted.length; j++) if (got[wanted[j]]) harvested++;
    IC.harvested = harvested;
    // Only worth caching if the harvest actually found something; caching the
    // bare seed would hide a broken harvest for twelve hours.
    if (harvested > 0) IC.cacheOps(merged);
    IC.ops = merged;
    return IC.ops;
  };

  // ---- one GraphQL call --------------------------------------------------
  // ONE ATTEMPT. The retrying wrapper below is the thing everything calls; see
  // _retry.ts for which failures earn a second ask and why a timeout does not.
  // PHASE IS AN ARGUMENT, for the same reason it is on the other rails: a
  // name -> phase map belongs to no single script, so putting one here would
  // copy every operation name into all of them.
  IC.gql = function (name, variables, budgetMs, phase) {
    return __mealioRetry(
      function () { return IC.gqlAttempt(name, variables, budgetMs); },
      { phase: phase || 'session', op: name });
  };
  IC.gqlAttempt = async function (name, variables, budgetMs) {
    var hash = (IC.ops && IC.ops[name]) || null;
    if (!hash) return { ok: false, why: 'no_hash', op: name };
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, budgetMs || 15000);
    var t0 = Date.now();
    var r, txt;
    try {
      r = await fetch('/graphql', {
        method: 'POST', credentials: 'include', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
        body: JSON.stringify({
          operationName: name, variables: variables || {},
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
        }),
      });
      clearTimeout(to);
      txt = await r.text();
    } catch (e) {
      clearTimeout(to);
      return { ok: false, why: 'no_response', aborted: !!(e && e.name === 'AbortError'), op: name, ms: Date.now() - t0 };
    }
    var ms = Date.now() - t0;
    if (r.status !== 200) return { ok: false, why: 'http', status: r.status, op: name, ms: ms,
                                   detail: String(txt || '').slice(0, 160) };
    var j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    if (!j) return { ok: false, why: 'unparseable', op: name, ms: ms };
    if (j.errors && j.errors.length) {
      var first = j.errors[0] || {};
      var code = (first.extensions && first.extensions.code) || '';
      // The store no longer knows this hash -- Instacart deployed. Drop the
      // cache so the next call harvests again, exactly as __albForgetKeys does
      // when every Albertsons cart key 401s.
      if (code === 'PERSISTED_QUERY_NOT_FOUND') IC.forgetOps();
      // ERRORS AND DATA ARE NOT EXCLUSIVE. GraphQL returns both: a resolver that
      // fails puts an entry in errors and null at that path, and everything
      // else still arrives.
      //
      // MEASURED on the device: Search answers with twenty "Not Found" errors,
      // one per item, ALL of them on the price field -- and twenty complete
      // items alongside them. Treating that as a failure threw away a working
      // search over a field the matcher does not read. Only a response with no
      // data at all is a failure.
      if (!j.data) {
        return { ok: false, why: 'gql_error', op: name, ms: ms, code: code,
                 detail: String(first.message || '').slice(0, 160) };
      }
      return { ok: true, data: j.data, ms: ms, bytes: txt.length,
               partialErrors: j.errors.length,
               partialFirst: String(first.message || '').slice(0, 80) };
    }
    return { ok: true, data: j.data, ms: ms, bytes: txt.length };
  };

  // ---- the shop this user is shopping ------------------------------------
  //
  // shopId is not in the cart response, so it is looked for in the places the
  // storefront keeps it, in order, and which one answered is REPORTED. A store
  // fact discovered by guessing is one nobody can debug later.
  IC.cachedShop = function () {
    try {
      var raw = localStorage.getItem('${SHOP_CACHE_KEY}');
      if (!raw) return null;
      var j = JSON.parse(raw);
      if (!j || !j.v || !j.at) return null;
      if (Date.now() - j.at > ${OPS_CACHE_MAX_AGE_MS}) return null;
      return j;
    } catch (e) { return null; }
  };

  // Pull the first run of digits after a marker.
  IC.digitsAfter = function (hay, needle, max) {
    var at = hay.indexOf(needle);
    if (at < 0) return null;
    var from = at + needle.length;
    var v = '';
    for (var i = from; i < from + (max || 8); i++) {
      var ch = hay.charAt(i);
      if (ch < '0' || ch > '9') break;
      v += ch;
    }
    return v || null;
  };

  // FETCH THE STOREFRONT AS TEXT. Not load it -- fetch it.
  //
  // MEASURED 2026-09-03: the shop id is nowhere a page can be asked for it from
  // robots.txt. Not a cookie, not localStorage, not sessionStorage, and no
  // operation returns it -- ContinueShoppingUserCarts and AssociatedCarts both
  // answer with an empty cart list, and everything else that mentions a shop
  // takes one as an argument.
  //
  // It IS in the storefront's server payload, URL-ENCODED, which is why looking
  // for the plain string found nothing. A same-origin GET brings that back as
  // text in about 3 seconds without loading a page, rendering anything, or
  // running a line of the store's own JavaScript -- and it is cached for twelve
  // hours, so it is once a day rather than once a run.
  IC.fetchShopId = async function (slug, budgetMs) {
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, budgetMs || 20000);
    var t0 = Date.now();
    var html = '';
    try {
      var r = await fetch('/store/' + slug + '/storefront', { credentials: 'include', signal: ctl.signal });
      clearTimeout(to);
      html = await r.text();
    } catch (e) { clearTimeout(to); return { v: null, why: 'no_response', ms: Date.now() - t0 }; }
    // Two independent markers, because one of them will change before both do.
    var v = IC.digitsAfter(html, '%5C%22shopId%5C%22%3A%5C%22', 8)
         || IC.digitsAfter(html, '%22shops%22%3A%5B%7B%22id%22%3A%22', 8)
         || IC.digitsAfter(html, '%22shopId%22%3A%22', 8)
         || IC.digitsAfter(html, '"shopId":"', 8);
    return { v: v, ms: Date.now() - t0, bytes: html.length };
  };

  IC.findShopId = async function (slug, budgetMs) {
    var tries = [];
    var cached = IC.cachedShop();
    if (cached) { tries.push({ from: 'cache', v: String(cached.v) }); return tries; }
    // The page, when we happen to be on one that has it.
    try {
      var s = document.documentElement.innerHTML;
      var here = IC.digitsAfter(s, '%5C%22shopId%5C%22%3A%5C%22', 8) || IC.digitsAfter(s, '"shopId":"', 8);
      if (here) tries.push({ from: 'page', v: here });
    } catch (e) {}
    if (!tries.length) {
      var got = await IC.fetchShopId(slug, budgetMs);
      if (got.v) tries.push({ from: 'storefront-fetch', v: got.v, ms: got.ms, bytes: got.bytes });
      else tries.push({ from: 'storefront-fetch', v: null, why: got.why || 'not_found', ms: got.ms });
    }
    var first = null;
    for (var i = 0; i < tries.length; i++) if (tries[i].v) { first = tries[i].v; break; }
    if (first) {
      try { localStorage.setItem('${SHOP_CACHE_KEY}', JSON.stringify({ v: first, at: Date.now() })); } catch (e) {}
    }
    return tries;
  };
`;

/** The session probe: who is signed in, and which cart is theirs. */
export function buildAldiSessionScript(storeId = 'aldi'): string {
  const seed = JSON.stringify(ALDI_SEED_OPS);
  return `(async function () {
${IC_PRELUDE}
  var post = function (o) { o.type = 'ALDI_SESSION'; IC.post(o); };
  try {
    await IC.ensureOps(${seed}, 15000);
    var carts = await IC.gql('ActiveCarts', {}, 12000, 'cart_read');
    if (!carts.ok) {
      // Cannot answer. NOT a signed-out user -- saying so would wall one, which
      // is the mistake this project has made three times.
      post({ ok: false, why: carts.why, code: carts.code || null, detail: carts.detail || null,
             harvested: IC.harvested || 0 });
      return;
    }
    var uc = (carts.data && carts.data.userCarts) || null;
    var list = (uc && uc.carts) || [];
    if (!uc) { post({ ok: true, loggedIn: false, source: 'activeCarts' }); return; }
    var mine = null;
    for (var i = 0; i < list.length; i++) {
      var rt = list[i].retailer || {};
      if (String(rt.slug || '') === '${(INSTACART_TENANTS[storeId] || { slug: 'aldi' }).slug}') { mine = list[i]; break; }
    }
    if (!mine && list.length) mine = list[0];
    var shopTries = await IC.findShopId('${(INSTACART_TENANTS[storeId] || { slug: 'aldi' }).slug}', 20000);
    // THE SHOP ID IS NOT THE RETAILER ID, and confusing them searches the wrong
    // catalogue. The retailer is ALDI-the-chain (12). The shop is the branch the
    // user is shopping (8583 on this device), and it is what every search and
    // cart operation takes. ActiveCarts gives us the first and not the second,
    // so it is looked for -- and when it is not found, storeId is NULL and the
    // rail refuses to build a search rather than send the wrong number.
    // The first try that actually FOUND something. findShopId records its
    // attempts whether or not they worked, so taking tries[0] blindly and
    // String()-ing it turns a miss into the four-character string "null" --
    // which is truthy, sails past the no-shop guard in searchBatch, and gets
    // sent to the store as the shop to search. Caught by the fixture test that
    // asserts a bare document reports NO shop.
    var shopId = null;
    for (var si = 0; si < shopTries.length; si++) {
      if (shopTries[si] && shopTries[si].v) { shopId = String(shopTries[si].v); break; }
    }
    post({
      ok: true,
      loggedIn: !!mine,
      cartId: mine ? String(mine.id) : null,
      itemCount: mine ? mine.itemCount : null,
      retailerId: mine && mine.retailer ? String(mine.retailer.id) : null,
      // The engine's NetworkSession wants these two names. storeId is the SHOP.
      storeId: shopId,
      shoppingContext: 'delivery',
      shopTries: shopTries,
      shopFrom: shopTries.length ? shopTries[0].from : null,
      ms: carts.ms,
      harvested: IC.harvested || 0,
      source: 'activeCarts',
    });
  } catch (e) {
    post({ ok: false, why: 'threw', detail: String(e).slice(0, 160) });
  }
})(); true;`;
}

/**
 * Search every term, then hydrate every id from every term in ONE more call.
 *
 * The search returns ids and nothing else -- MEASURED, 28 of them for "sour
 * cream" in 556ms, shaped items_23898-18647633. Names and prices come from
 * ItemDetailsRetailerProduct, which takes an ARRAY, so a nine-term batch is nine
 * search calls and one hydration rather than nine of each.
 *
 * zoneId is the 23898 in that id. It was never observed being sent, so rather
 * than hard-code a number nobody can explain, it is READ BACK OUT of the search
 * results -- the ids carry it, so the search itself tells us what to ask with.
 */
export function buildAldiNetworkSearchBatchScript(
  terms: string[],
  opts: { shopId?: string | null; requestMs?: number } = {},
): string | null {
  if (!terms.length) return null;
  // NO SHOP, NO SEARCH.
  //
  // Every operation on this platform takes the shop the user is actually
  // shopping, and it is not the retailer id ActiveCarts hands back -- ALDI the
  // chain is 12, the branch is 8583. Sending the wrong one searches a catalogue
  // the user cannot buy from, which is the over-add rule wearing a different
  // hat: every candidate would be a product that is not there.
  if (!opts.shopId) return null;
  const seed = JSON.stringify(ALDI_SEED_OPS);
  return `(async function () {
${IC_PRELUDE}
  var TERMS = ${JSON.stringify(terms)};
  var SHOP = ${JSON.stringify(opts.shopId)};
  var REQ_MS = ${opts.requestMs ?? 15000};
  var post = IC.post;

  // ONE CALL PER TERM. The first design here used AsyncItemSearch for ids and
  // then a bulk hydration for the names, which looked better -- N + 1 requests
  // rather than N. It did not work: MEASURED on the device,
  // ItemDetailsRetailerProduct answers with an empty list for ids the search had
  // just returned, under every combination of full and bare ids and of zone and
  // shop as the zoneId. It addresses a different id space.
  //
  // Search returns the names itself, so this is N requests and no hydration.
  var toCandidate = function (it) {
    var vs = it.viewSection || {};
    var img = null;
    try { img = (vs.itemImage && (vs.itemImage.url || vs.itemImage.templateUrl)) || null; } catch (e) {}
    var price = null;
    try { price = vs.priceString || (it.price && it.price.viewSection && it.price.viewSection.priceString) || null; } catch (e) {}
    var name = it.name || vs.titleString || null;
    if (name && it.size) name = name + ', ' + it.size;
    return {
      productName: String(name || ''),
      imageUrl: img,
      // The search does not report stock, so nothing here may claim it is out.
      // The write is what finds out, and it verifies against the cart.
      outOfStock: false,
      preferences: null,
      // MEASURED: price resolves to "Not Found" on every item, under the real
      // postcode and the placeholder alike, and with the zone or the shop as
      // zoneId. Cosmetic -- the matcher scores on the name and the write uses
      // the id -- so it is left null rather than faked.
      price: price,
      productId: it.id != null ? String(it.id) : null,
      skuId: null,
      isWeightItem: false,
      maxOrderQuantity: null,
    };
  };

  try {
    await IC.ensureOps(${seed}, 15000);

    // THE ZONE, discovered rather than guessed. Search needs a zoneId and
    // nothing hands one over -- but AsyncItemSearch does NOT need one, and the
    // ids it returns carry it (items_23898-18647633). So one cheap call
    // (MEASURED 117ms) buys the zone, and it is cached for twelve hours with
    // the shop id.
    var zone = null;
    var cachedZone = null;
    try {
      var rawZ = localStorage.getItem('${ZONE_CACHE_KEY}');
      if (rawZ) {
        var jz = JSON.parse(rawZ);
        if (jz && jz.v && Date.now() - jz.at < ${OPS_CACHE_MAX_AGE_MS}) cachedZone = String(jz.v);
      }
    } catch (e) {}
    zone = cachedZone;
    if (!zone) {
      var probe = await IC.gql('AsyncItemSearch', {
        query: TERMS[0], shopId: SHOP, postalCode: '${PLACEHOLDER_POSTAL}', searchSource: 'search',
      }, REQ_MS, 'search');
      var pids = [];
      try { pids = probe.data.itemSearch.itemResultList.itemIds || []; } catch (e) {}
      if (pids.length) {
        var f = String(pids[0]);
        var us = f.indexOf('_');
        var dash = f.indexOf('-');
        if (us >= 0 && dash > us) zone = f.slice(us + 1, dash);
      }
      if (zone) { try { localStorage.setItem('${ZONE_CACHE_KEY}', JSON.stringify({ v: zone, at: Date.now() })); } catch (e) {} }
    }
    post({ type: 'IC_SEARCH_SHAPE', source: 'network', zone: zone, zoneFrom: cachedZone ? 'cache' : 'probe' });
    if (!zone) {
      for (var z = 0; z < TERMS.length; z++) {
        post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: TERMS[z], why: 'no_zone' });
      }
      post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length });
      return;
    }

    for (var t = 0; t < TERMS.length; t++) {
      var term = TERMS[t];
      var r = await IC.gql('Search', {
        query: term, shopId: SHOP, zoneId: zone, postalCode: '${PLACEHOLDER_POSTAL}',
      }, REQ_MS, 'search');
      if (!r.ok) {
        post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: term, why: r.why,
               status: r.status || null, ms: r.ms || null, code: r.code || null, detail: r.detail || null });
        continue;
      }
      var items = [];
      try { items = r.data.searchResults.primaryItemResultList.items || []; } catch (e) { items = []; }
      var cands = [];
      for (var i = 0; i < items.length && i < 30; i++) {
        var c = toCandidate(items[i]);
        if (c.productName && c.productId) cands.push(c);
      }
      post({ type: 'SEARCH_RESULT', source: 'network', term: term, candidates: cands,
             ms: r.ms, n: cands.length });
    }
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length });
  } catch (e) {
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length, threw: String(e).slice(0, 140) });
  }
})(); true;`;
}

/**
 * Read the cart and post the CART_COUNT every other read posts.
 *
 * Two calls: ActiveCarts for the id (it takes no arguments), then CartItems for
 * the lines. A rail store must never load a page to learn what is in its own
 * cart.
 */
export function buildAldiCartReadScript(
  opts: { shopId?: string | null; storeId?: string } = {},
): string {
  const storeId = opts.storeId ?? 'aldi';
  const seed = JSON.stringify(ALDI_SEED_OPS);
  return `(async function () {
${IC_PRELUDE}
  var SHOP = ${JSON.stringify(opts.shopId ?? null)};
  try {
    await IC.ensureOps(${seed}, 15000);
    // cartRead() takes no session -- the rail interface does not hand it one --
    // so it finds the shop the same way the session probe does. After a session
    // has run this is a cache hit and costs nothing; cold, it is the one
    // storefront fetch. MEASURED before this: the read failed outright with
    // "Variable $shopId of type ID! was provided invalid value", because null
    // was passed straight through.
    if (!SHOP) {
      var tries = await IC.findShopId('${(INSTACART_TENANTS[storeId] || { slug: 'aldi' }).slug}', 20000);
      for (var ti = 0; ti < tries.length; ti++) if (tries[ti] && tries[ti].v) { SHOP = String(tries[ti].v); break; }
    }
    if (!SHOP) {
      IC.post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_failed',
                why: 'no_shop' });
      return;
    }
    var carts = await IC.gql('ActiveCarts', {}, 12000, 'cart_read');
    if (!carts.ok) {
      IC.post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_failed',
                why: carts.why, detail: carts.detail || null });
      return;
    }
    var list = [];
    try { list = carts.data.userCarts.carts || []; } catch (e) {}
    if (!list.length) { IC.post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' }); return; }
    var cartId = String(list[0].id);
    var items = await IC.gql('CartItems', { id: cartId, shopId: SHOP, postalCode: '${PLACEHOLDER_POSTAL}' }, 15000, 'cart_read');
    if (!items.ok) {
      IC.post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_failed',
                why: items.why, detail: items.detail || null });
      return;
    }
    var lines = [];
    try { lines = items.data.userCart.cartItemCollection.cartItems || []; } catch (e) { lines = []; }
    var rows = [];
    var count = 0;
    for (var i = 0; i < lines.length; i++) {
      var li = lines[i] || {};
      var qty = Number(li.quantity != null ? li.quantity : 1);
      if (!(qty > 0)) qty = 1;
      // basketProduct FIRST, and li.id LAST.
      //
      // A cart line carries two different ids and only one of them is the item.
      // MEASURED against the real cart on 2026-09-03:
      //   li.id                      = 35303533299            <- the CART LINE
      //   li.basketProduct.itemId    = items_23898-46580608   <- the ITEM
      // and the second is exactly what Search returns as productId.
      //
      // Reading li.id meant the held map was keyed by line ids that no search
      // result could ever match. Everything downstream that asks how many of this
      // the cart already holds got 0 for every item, always: the add's refusal of
      // an item the cart already holds could not fire, and its after-write check
      // -- which reads this same map to decide whether the write landed -- would
      // have called every successful write a failure.
      var bp = li.basketProduct || null;
      var iid = null;
      try { iid = String((bp && (bp.itemId || bp.id)) || li.itemId || (li.item && li.item.id) || li.id); } catch (e) {}
      // The NAME comes from the same place, so a cart row stops reading
      // "35303533299" on the review screen.
      var nm = li.name || null;
      if (!nm && bp && bp.name) nm = bp.name;
      if (!nm) { try { nm = li.item.name || (li.item.viewSection && li.item.viewSection.titleString); } catch (e) {} }
      rows.push({ name: String(nm || iid || 'item'), qty: qty, itemId: iid, available: true });
      count += qty;
    }
    IC.post({ type: 'CART_COUNT', count: count, items: rows, source: 'network',
              cartId: cartId, ms: items.ms });
  } catch (e) {
    IC.post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_threw',
              detail: String(e).slice(0, 140) });
  }
})(); true;`;
}

export interface AldiAddItem {
  idx: number;
  productId: string;
  quantity: number;
  name: string;
}

/**
 * Write the cart. ONE call for every item -- MEASURED signature:
 *
 *   UpdateCartItemsMutation($cartItemUpdates: [CartsCartItemUpdate!]!)
 *   CartsCartItemUpdate { itemId: ID!, quantity: Float! }
 *
 * IS QUANTITY ABSOLUTE? NOBODY HAS MEASURED IT, AND THIS SCRIPT REFUSES TO GUESS.
 *
 * H-E-B and the Albertsons family both SET the line rather than adding to it, so
 * a write is held + wanted; the operation here being named Update rather than
 * Add points the same way. But "points the same way" is not a measurement, and
 * getting it backwards is the silent under-add MEAL-194 exists to prevent --
 * setting a line the user already had down to what this run alone asked for.
 *
 * So the rule until someone measures it:
 *
 *   held === 0  ->  the two readings AGREE (held + wanted === wanted). Write it.
 *   held > 0    ->  they disagree. Refuse the item, name the reason, and let it
 *                   reach the review screen.
 *
 * That ships a working add for the common case -- an ingredient the cart does
 * not already hold -- and cannot corrupt a cart in the case it is unsure about.
 * `absoluteQty: true` lifts the restriction once the answer is known.
 */
export function buildAldiNetworkAddBatchScript(
  items: AldiAddItem[],
  opts: {
    shopId?: string | null;
    knownLines?: Record<string, number> | null;
    absoluteQty?: boolean | null;
    /** The tenant whose storefront holds the shop id. ALDI is the only banner
     *  that has ever run through this rail; the option exists so the next one
     *  does not have to discover this the hard way. */
    slug?: string;
  } = {},
): string | null {
  const writable = items.filter((i) => !!i.productId);
  if (!writable.length) return null;
  const seed = JSON.stringify(ALDI_SEED_OPS);
  return `(async function () {
${IC_PRELUDE}
  var ITEMS = ${JSON.stringify(writable)};
  var SHOP = ${JSON.stringify(opts.shopId ?? null)};
  var KNOWN = ${JSON.stringify(opts.knownLines ?? null)};
  var ABSOLUTE = ${JSON.stringify(opts.absoluteQty ?? null)};
  var post = IC.post;

  // Named, not positional: the telemetry taxonomy guard scans for single-quoted
  // snake_case on a line mentioning "reason", and a positional argument is
  // invisible to it.
  var report = function (it, ok, reason, detail, asked) {
    post({ type: 'NET_ADD_RESULT', idx: it.idx, name: it.name, productId: it.productId,
           skuId: null, asked: asked != null ? asked : it.quantity, success: !!ok,
           reason: reason || null, detail: detail || null });
  };
  var reasonCatalog = [
    { reason: 'no_cart' },
    { reason: 'qty_semantics_unproven' },
    { reason: 'write_refused' },
    { reason: 'not_in_cart_after_write' },
  ];

  var readCart = async function () {
    // THE SHOP, FOUND HERE IF NOBODY HANDED IT OVER.
    //
    // CartItems needs a shopId, and the rail's addBatch is not given one -- it
    // gets items and knownLines and nothing else. So SHOP was null on every
    // run, CartItems answered with nothing usable, and the held map came back EMPTY
    // for a cart full of items.
    //
    // That is not a quiet degradation on this store, because its write is
    // ABSOLUTE: with have stuck at 0 the script writes the WANTED amount as the
    // line's whole total. An item the user already had three of, asked for once, would be
    // SET TO ONE. It could take things out of the cart. The after-write check
    // was blind for the same reason and could not have caught it.
    if (!SHOP) {
      // findShopId(slug, budgetMs) returns the TRIES it made, not an id — the
      // first one that found something is the answer. Same walk the cart read
      // does; calling it as if it returned the id put an ARRAY in SHOP, which
      // is falsy in none of the right ways and made this look fixed when it was
      // not.
      try {
        var tries2 = await IC.findShopId('${opts.slug ?? 'aldi'}', 15000);
        for (var t2 = 0; t2 < tries2.length; t2++) if (tries2[t2] && tries2[t2].v) { SHOP = String(tries2[t2].v); break; }
      } catch (e) {}
    }
    if (!SHOP) return null;
    var carts = await IC.gql('ActiveCarts', {}, 12000, 'cart_read');
    if (!carts.ok) return null;
    var list = [];
    try { list = carts.data.userCarts.carts || []; } catch (e) {}
    if (!list.length) return null;
    var cartId = String(list[0].id);
    var items = await IC.gql('CartItems', { id: cartId, shopId: SHOP, postalCode: '${PLACEHOLDER_POSTAL}' }, 15000, 'cart_read');
    // A CART THAT COULD NOT BE READ IS NOT AN EMPTY CART.
    //
    // This used to fall through and return an empty held map, which on a store
    // whose write is ABSOLUTE means every item looks unheld and every line gets
    // SET to the wanted amount. An unreadable cart would quietly overwrite the
    // user's quantities. Returning null makes the add report no_cart and touch
    // nothing.
    if (!items.ok) return null;
    var held = {};
    var rows = [];
    {
      var lines = [];
      try { lines = items.data.userCart.cartItemCollection.cartItems || []; } catch (e) {}
      for (var i = 0; i < lines.length; i++) {
        var li = lines[i] || {};
        // The item, not the cart line — see the note on the read above.
        var bp = li.basketProduct || null;
        var iid = null;
        try { iid = String((bp && (bp.itemId || bp.id)) || li.itemId || (li.item && li.item.id) || li.id); } catch (e) {}
        var q = Number(li.quantity != null ? li.quantity : 1);
        if (!(q > 0)) q = 1;
        if (iid) held[iid] = (held[iid] || 0) + q;
        var nm = li.name || null;
        if (!nm && bp && bp.name) nm = bp.name;
        if (!nm) { try { nm = li.item.name; } catch (e) {} }
        rows.push({ name: String(nm || iid || 'item'), qty: q, itemId: iid, available: true });
      }
    }
    return { cartId: cartId, held: held, rows: rows };
  };

  try {
    await IC.ensureOps(${seed}, 15000);

    // The baseline. Handed in when the sheet already read it, read here when it
    // did not -- the write needs one either way, because a line is SET.
    var before = null;
    if (KNOWN) { before = { cartId: null, held: KNOWN, rows: [] }; }
    if (!before) before = await readCart();
    if (!before) {
      for (var z = 0; z < ITEMS.length; z++) report(ITEMS[z], false, 'no_cart', 'could not read the cart to baseline against');
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0 });
      return;
    }

    var updates = [];
    var planned = [];
    for (var i2 = 0; i2 < ITEMS.length; i2++) {
      var it = ITEMS[i2];
      var have = Number(before.held[it.productId] || 0);
      var want = Math.max(1, Math.round(it.quantity || 1));
      if (have > 0 && ABSOLUTE !== true) {
        report(it, false, 'qty_semantics_unproven',
               'the cart already holds ' + have + ' of this and it is not yet measured whether this store SETS or ADDS the quantity');
        continue;
      }
      // held + wanted. With have === 0 that is also just the wanted amount,
      // which is why the branch above makes the two readings agree on
      // everything this actually writes.
      updates.push({ itemId: it.productId, quantity: have + want });
      planned.push({ it: it, want: want, have: have, sent: have + want });
    }

    if (!updates.length) { post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0 }); return; }

    var res = await IC.gql('UpdateCartItemsMutation', { cartItemUpdates: updates }, 25000, 'add');
    if (!res.ok) {
      for (var f = 0; f < planned.length; f++) report(planned[f].it, false, 'write_refused', res.why + (res.detail ? ': ' + res.detail : ''));
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, why: res.why });
      return;
    }

    // THE CART DECIDES. Never the write's own report -- that rule has caught a
    // silent under-add, an unhydrated zero and an over-adding retry.
    var after = await readCart();
    var wrote = 0;
    for (var p = 0; p < planned.length; p++) {
      var pl = planned[p];
      var now = after ? Number(after.held[pl.it.productId] || 0) : null;
      if (now == null) { report(pl.it, true, null, 'written, cart not re-read', pl.want); wrote++; continue; }
      if (now >= pl.sent) { report(pl.it, true, null, null, pl.want); wrote++; }
      else report(pl.it, false, 'not_in_cart_after_write', 'expected ' + pl.sent + ', cart holds ' + now, pl.want);
    }
    post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: wrote,
           cartBefore: before.rows, cartAfter: after ? after.rows : [],
           cartLines: after ? after.rows.length : null, ms: res.ms });
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
 * Instacart Storefront, which ALDI runs on.
 *
 * Registered against the PLATFORM rather than the banner: INSTACART_TENANTS is
 * the registry, so a tenant added there gets this rail without another entry
 * here. That is the same reasoning railConfigKey uses for the fifteen
 * Albertsons banners.
 */
export const INSTACART_RAIL: NetworkRail = {
  sessionMessageType: 'ALDI_SESSION',
  sessionScript: () => buildAldiSessionScript(),
  searchBatch: (terms, sess) =>
    buildAldiNetworkSearchBatchScript(terms, {
      shopId: sess.storeId,
      requestMs: INSTACART_RAIL.budgets.searchRequestMs,
    }),
  cartRead: () => buildAldiCartReadScript(),
  addBatch: (items, opts) =>
    buildAldiNetworkAddBatchScript(
      items.map((i) => ({ idx: i.idx, productId: i.productId, quantity: i.quantity, name: i.name })),
      {
        knownLines: opts?.knownLines ?? null,
        // MEASURED against the real store, 2026-09-03, on one authorised write.
        // The cart held 1 of items_23898-46580608; we wrote quantity 2 and read
        // it back as 2, not 3, then restored it to 1. The write SETS the line.
        //
        // The storefront's own bundle says the same thing independently: its
        // updateCartItems computes `finalQuantity: u` from the value you send
        // and derives the delta (u - d) only for analytics, and its bulk-add
        // path computes held + wanted ITSELF before sending. There is no
        // quantityDelta anywhere in it. The mutation variable is named
        // newQuantity.
        //
        // So held + wanted, which is what this script already writes, is right —
        // and the refusal of an item the cart already holds can lift.
        absoluteQty: true,
      },
    ),
  // The cart is addressed by the item id the search returns
  // (items_23898-18647633). There is no sku on this platform at all.
  writable: (c) => !!c.productId,
  // One session answer. ActiveCarts takes no arguments and returns everything
  // the run needs, so there is no early/refined split to wait out.
  sessionUsable: () => true,
  // No preference concept on this platform.
  needsPreference: () => false,
  // MEASURED 2026-09-02 against a live session: ActiveCarts 176ms, CartItems
  // 306ms, AsyncItemSearch 556ms for one term. Generous against that, and the
  // search budget carries the extra hydration call every batch makes.
  budgets: {
    sessionMs: 20_000,
    searchMs: (terms) => Math.min(20_000 + terms * 3_000, 90_000),
    searchResumeMs: 20_000,
    addMs: (items) => Math.min(30_000 + items * 1_500, 90_000),
    cartProbeMs: 20_000,
    searchRequestMs: 15_000,
    // No cold-start problem observed; the first call was as quick as the rest.
    searchFirstRequestMs: 15_000,
  },
};
