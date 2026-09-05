import type { NetworkRail } from './network-rail';
import { RETRY_FN } from './_retry';
// Wegmans over the network.
//
// Researched 2026-09-02/03 against a live signed-in session on the device; see
// docs/network-rail-research/01-wegmans.md for the measurements. Three parts,
// and they are NOT equally certain, which is why they are layered rather than
// written as one lump.
//
//   login   MEASURED, and free. Azure AD B2C via MSAL keeps a plaintext account
//           list in localStorage. Reading it costs no network at all -- the best
//           login signal of any store here.
//   search  MEASURED, and free. Algolia, with a search-only key that ships in
//           the page's own request URLs. 32,223 hits for "sour cream" in 26ms
//           from a plain curl with no cookies; storeNumber:140 narrows it to 282
//           in 13ms. No session, so it works signed-out and cannot be broken by
//           an expired token.
//   cart    Needs a BEARER, and MSAL keeps that encrypted ({id, nonce, data},
//           with a msal.cache.encryption cookie). The commerce API also refuses
//           the cookie session -- a no-cors request comes back opaque, so it is
//           answered and we are simply not allowed to read it.
//
// That last one is why the token has a PROVIDER with fallbacks rather than a
// single read. Search and login do not depend on it, so a Wegmans run still
// searches at full speed when the cart half cannot start.

/** Algolia. A search-only key, public by design, and in every URL the site sends. */
const ALGOLIA_APP = 'QGPPR19V8V';
const ALGOLIA_KEY = '9a10b1401634e9a6e55161c3a60c200d';
const ALGOLIA_HOST = 'https://qgppr19v8v-dsn.algolia.net';
const ALGOLIA_INDEX = 'products';
const ALGOLIA_URL = ALGOLIA_HOST + '/1/indexes/*/queries';
/** The store's "140-CHAPEL-HILL" key, cached a day beside its number. */
const STORE_KEY_CACHE = '__mealio_weg_storekey_v1';
/** Our own refresh token and token endpoint, so a stale hour costs one POST. */
const REFRESH_CACHE = '__mealio_weg_rt_v1';
const ENDPOINT_CACHE = '__mealio_weg_oidc_v1';

/** The commerce API. Named "development" and is what production calls. */
const COMMERCE_BASE = 'https://api.digitaldevelopment.wegmans.cloud';

/** Where a captured bearer is cached, and how long it is trusted without proof. */
const TOKEN_CACHE_KEY = '__mealio_weg_tok_v1';
/** The user's store number, once something has managed to learn it. */
const STORE_CACHE_KEY = '__mealio_weg_store_v1';
/**
 * The cart the shop app itself reads. A trailing slash and its own api-version,
 * both load-bearing: /commerce/cart/carts/active and every other shape guessed
 * for this came back as a bare "Failed to fetch", because the gateway rejects an
 * unknown route before it adds CORS headers.
 */
const CART_PATH = '/commerce/cart/carts/';
/**
 * The WRITE. "lineitems", one word, on the collection — captured from the shop
 * app's own add, because every guessed shape (/carts/{id}, /carts/{id}/line-items,
 * /carts/items, PUT, PATCH) came back as a bare "Failed to fetch": this gateway
 * rejects an unknown route before it adds CORS headers, so a wrong path and a
 * dead host are indistinguishable.
 */
const CART_WRITE_PATH = '/commerce/cart/carts/lineitems';
const STORE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Shared by every injected script: the bridge, the account read, the store
 * number, and the token provider.
 *
 * No backticks and no backslashes. A backtick ends the template literal that
 * carries this to the WebView; a single backslash is eaten before it arrives.
 * Both have broken this build before, three times each.
 */
const WEG_PRELUDE = `
${RETRY_FN}
  var WG = window.__mealioWeg = window.__mealioWeg || {};
  WG.post = function (o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };

  // ---- who is signed in: a localStorage read, and nothing else -----------
  //
  // MSAL keeps a PLAINTEXT list of signed-in accounts even when the credential
  // cache is encrypted. Non-empty means somebody is signed in. Zero network,
  // cannot be rate-limited, cannot be confused by markup -- which is what every
  // DOM login check in this project has eventually been.
  WG.accountCount = function () {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf('msal.') !== 0 || k.indexOf('.account.keys') < 0) continue;
        var arr = JSON.parse(localStorage.getItem(k) || '[]');
        if (Array.isArray(arr)) return arr.length;
      }
    } catch (e) {}
    return 0;
  };

  // ---- which store ------------------------------------------------------
  //
  // The search index is per store: the same product is 626485 at store 50 and
  // 608294 at store 140, and an unfiltered query returns every store's
  // catalogue at once (32,223 hits vs 282). So this is not optional, and where
  // it was found is REPORTED -- a store fact discovered by guessing is one
  // nobody can debug later.
  WG.cachedStore = function () {
    try {
      var raw = localStorage.getItem('${STORE_CACHE_KEY}');
      if (!raw) return null;
      var j = JSON.parse(raw);
      if (!j || !j.v || !j.at) return null;
      if (Date.now() - j.at > ${STORE_CACHE_MAX_AGE_MS}) return null;
      return String(j.v);
    } catch (e) { return null; }
  };

  // Pull a store number out of whatever the customer endpoint calls it. The
  // exact field has NOT been seen -- reading it needs the bearer, and the
  // bearer needs a page load -- so several plausible names are tried and the
  // one that answered is reported.
  WG.storeFromCustomer = function (data) {
    if (!data || typeof data !== 'object') return null;
    var keys = ['storeNumber', 'preferredStoreNumber', 'defaultStoreNumber',
                'shoppingStoreNumber', 'storeId', 'preferredStore'];
    var found = null;
    var walk = function (n, depth) {
      if (found || !n || depth > 5) return;
      if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) walk(n[i], depth + 1); return; }
      if (typeof n !== 'object') return;
      for (var k = 0; k < keys.length; k++) {
        var v = n[keys[k]];
        if (v == null) continue;
        if (typeof v === 'object') { walk(v, depth + 1); continue; }
        var sv = String(v);
        if (/^[0-9]{1,4}$/.test(sv)) { found = sv; return; }
      }
      for (var kk in n) { if (Object.prototype.hasOwnProperty.call(n, kk)) walk(n[kk], depth + 1); }
    };
    walk(data, 0);
    return found;
  };

  // WHICH STORE, and why this is not optional.
  //
  // The search index is per store: the SAME Daisy sour cream is 626485 at store
  // 50 and 608294 at store 140, and an unfiltered query returns every store's
  // catalogue at once (32,223 hits against 282). An unfiltered search therefore
  // offers real products under real names carrying ids that are NOT valid where
  // this user shops -- and saving one as their choice would add the wrong
  // product on the next run. That is the failure the cart rules exist to
  // prevent, so the rail refuses to search rather than risk it.
  //
  // WHERE IT ACTUALLY IS: the CART.
  //
  // It is nowhere a page can simply be asked. Not a cookie, not localStorage,
  // not sessionStorage, not IndexedDB, not the server-rendered HTML of / or
  // /shop, and every /api/user/store-shaped guess is a 404. It is NOT in the
  // customer profile either, which was this rail's original guess and carries
  // only hasInstacartAccountsForStores.
  //
  // Found 2026-09-03 by recording every response the shop app received during a
  // cold boot and asking which one first mentioned the number: the cart. It is
  // a commercetools cart, and the store rides in its custom fields:
  //
  //   GET /commerce/cart/carts/?api-version=2024-02-19-preview
  //     -> grocery.custom.customFieldsRaw[] where name === 'storeNumber'
  //
  // BY NAME, never by index. It sat at [6] on the run that found it, behind
  // loyalty and coupon fields that have no reason to keep their order.
  //
  // One call answers both halves: the same response carries grocery.lineItems,
  // which is the cart baseline. So a run that reads the cart already knows the
  // store, and the customer profile is only a fallback.
  /** The grocery cart out of the carts response, whatever it is wrapped in. */
  WG.groceryCart = function (data) {
    if (!data || typeof data !== 'object') return null;
    if (data.grocery && typeof data.grocery === 'object') return data.grocery;
    if (data.cart && typeof data.cart === 'object') return data.cart;
    return data;
  };

  /** A commercetools custom field, BY NAME. Index is not stable. */
  WG.customField = function (cart, name) {
    try {
      var raw = cart.custom.customFieldsRaw || [];
      for (var i = 0; i < raw.length; i++) {
        if (raw[i] && String(raw[i].name) === name) return raw[i].value;
      }
    } catch (e) {}
    return null;
  };

  /**
   * THE SKU, which is the only id on a cart line that SEARCH also speaks.
   *
   * A line carries three, and two of them are traps — MEASURED 2026-09-03:
   *   li.id           f2cc4dd6-...   the LINE
   *   li.productId    47b86662-...   the commercetools PRODUCT
   *   li.variant.sku  45407          the SKU  <- search returns this
   *
   * Reading either UUID keys the held-quantity map by ids no search result can
   * match, so every item looks like have = 0 and nothing downstream can tell
   * what the cart already holds. That exact bug shipped on the Instacart rail
   * and was caught only against a live cart.
   */
  WG.lineSku = function (li) {
    try {
      if (li.variant && li.variant.sku != null) return String(li.variant.sku);
    } catch (e) {}
    if (li.productKey != null) return String(li.productKey);
    if (li.skuId != null) return String(li.skuId);
    if (li.sku != null) return String(li.sku);
    return null;
  };

  /** commercetools names are localised objects as often as they are strings. */
  WG.lineName = function (li, fallback) {
    var n = li.name != null ? li.name : (li.productName != null ? li.productName : null);
    if (n && typeof n === 'object') {
      n = n.en || n['en-US'] || n['en-GB'] || n[Object.keys(n)[0]];
    }
    return String(n || li.description || fallback || 'item');
  };

  /**
   * The store's KEY, "140-CHAPEL-HILL", which the write names as StoreKey.
   * /api/stores is same-origin and needs no token; 115 stores, cached a day.
   */
  WG.storeKey = async function (storeNo) {
    if (!storeNo) return null;
    try {
      var c = JSON.parse(localStorage.getItem('${STORE_KEY_CACHE}') || 'null');
      if (c && c.n === String(storeNo) && Date.now() - c.at < 86400000) return c.v;
    } catch (e) {}
    try {
      var r = await fetch('/api/stores', { headers: { accept: 'application/json' } });
      if (r.status && (r.status < 200 || r.status >= 300)) return null;
      var list = JSON.parse(await r.text());
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].storeNumber) === String(storeNo) && list[i].key) {
          try { localStorage.setItem('${STORE_KEY_CACHE}', JSON.stringify({ n: String(storeNo), v: String(list[i].key), at: Date.now() })); } catch (e) {}
          return String(list[i].key);
        }
      }
    } catch (e) {}
    return null;
  };

  /** customerID and customerEmail, which the write also names. */
  WG.customerRef = async function (tok) {
    if (WG.who) return WG.who;
    var r = await WG.commerce('/commerce/account/customer', tok, { method: 'GET' }, 10000);
    if (!r.ok) return null;
    try {
      var cu = r.data.customer || r.data;
      if (cu && cu.id && cu.email) { WG.who = { id: String(cu.id), email: String(cu.email) }; return WG.who; }
    } catch (e) {}
    return null;
  };

  /**
   * The catalogue row per sku. Every line-item field the write carries comes
   * from here — category, planogram, upc, channel key, price in cents — so the
   * add re-reads the catalogue rather than having a dozen extra fields plumbed
   * through the app's candidate shape. One request for the whole batch.
   */
  WG.hitsBySku = async function (skus, storeNo) {
    var out = {};
    if (!skus.length) return out;
    var reqs = [];
    for (var i = 0; i < skus.length; i++) {
      // BY objectID, which is "<store>-<sku>". skuId is in the index but is not
      // a filterable facet — filtering on it returns 0 hits for a sku that
      // demonstrably exists, which reads as "this store does not carry it".
      reqs.push({ indexName: '${ALGOLIA_INDEX}', query: '',
        filters: 'objectID:"' + storeNo + '-' + skus[i] + '"', hitsPerPage: 1 });
    }
    try {
      var r = await fetch('${ALGOLIA_URL}', {
        method: 'POST',
        headers: { 'content-type': 'application/json',
          'x-algolia-application-id': '${ALGOLIA_APP}', 'x-algolia-api-key': '${ALGOLIA_KEY}' },
        body: JSON.stringify({ requests: reqs }),
      });
      // text() then parse, like every other call here: a response shim that
      // implements text() but not json() is the difference between a working
      // batch and an empty one, and this file already standardises on text().
      var j = JSON.parse(await r.text());
      // A multi-query answers { results: [ { hits }, ... ] }; a single-index one
      // answers { hits } directly. Accept both rather than assume the wrapper.
      var res = j.results || [{ hits: j.hits || [] }];
      for (var k = 0; k < res.length; k++) {
        var hs = (res[k] && res[k].hits) || [];
        for (var hh = 0; hh < hs.length; hh++) {
          var h = hs[hh];
          var key = String(h.skuId != null ? h.skuId : (h.productId != null ? h.productId : skus[k]));
          if (!out[key]) out[key] = h;
        }
      }
    } catch (e) {}
    return out;
  };

  /** One line item, shaped exactly as the site shapes it. */
  /**
   * Does the user have to choose a WEIGHT for this?
   *
   * Only when the unit of sale is itself a weight. "Each" is not, whatever the
   * price is quoted per, and whatever isSoldByWeight says.
   */
  WG.soldByWeight = function (h) {
    var u = String(h.onlineSellByUnit == null ? '' : h.onlineSellByUnit).toLowerCase().replace(/[. ]/g, '');
    if (u) return u === 'lb' || u === 'lbs' || u === 'pound' || u === 'pounds'
      || u === 'oz' || u === 'ounce' || u === 'ounces' || u === 'kg' || u === 'g';
    // No unit named at all: fall back to the flag, which is the only signal left.
    return !!h.isSoldByWeight;
  };

  WG.lineItemFor = function (h, qty) {
    var cats = h.category || [];
    var top = cats.length ? cats[cats.length - 1] : null;
    var price = h.price_pickup || h.price_delivery || {};
    var custom = [
      { name: 'category', value: top && top.name ? String(top.name) : 'Grocery' },
      { name: 'categoryId', value: top && top.key ? String(top.key) : '' },
      { name: 'itemLevelAdjustments', value: '[]' },
      { name: 'isSoldAtStore', value: h.isSoldAtStore !== false },
      { name: 'ebtEligible', value: !!h.ebtEligible },
      { name: 'isAvailable', value: h.isAvailable !== false },
      { name: 'planogram', value: typeof h.planogram === 'string' ? h.planogram : JSON.stringify(h.planogram || {}) },
      { name: 'note', value: '' },
      { name: 'bottleDeposit', value: h.bottleDeposit != null ? h.bottleDeposit : 0 },
      { name: 'upc', value: h.upc || [] },
      { name: 'fulfillmentTypes', value: h.fulfilmentType || h.fulfillmentTypes || ['pickup'] },
      { name: 'maxQuantity', value: String(h.maxQuantity != null ? h.maxQuantity : 99) },
    ];
    return {
      custom: custom,
      distributionChannelKey: price.channelKey || (h.storeNumber + '-Delivery'),
      isAlcoholic: !!h.isAlcoholic,
      // The STORE's own flag here, not our sold-by-weight reading: this field
      // is echoed back to their API and has to say what their index says.
      isSoldByWeight: !!h.isSoldByWeight,
      onlineApproxUnitWeight: h.onlineApproxUnitWeight != null ? h.onlineApproxUnitWeight : 0,
      onlineSellByUnit: h.onlineSellByUnit || 'ea',
      quantity: qty,
      sku: String(h.skuId != null ? h.skuId : h.sku),
      standalonePrice: Math.round(Number(price.amount || 0) * 100),
    };
  };

  WG.readCart = async function (tok, budgetMs) {
    return WG.commerce('${CART_PATH}', tok, { method: 'GET' }, budgetMs || 12000);
  };

  WG.findStoreNumber = async function (tok, budgetMs) {
    var tries = [];
    var cached = WG.cachedStore();
    if (cached) { tries.push({ from: 'cache', v: cached }); return tries; }
    if (!tok) { tries.push({ from: 'cart', v: null, why: 'no_token' }); return tries; }
    // The CART first: it is where the number actually lives, and the same
    // response is the cart baseline a run needs anyway.
    var rc = await WG.readCart(tok, budgetMs || 12000);
    // Kept for the session answer and the baseline: this response is the cart,
    // so nothing downstream has to fetch it a second time.
    WG.lastCart = rc;
    if (rc.ok) {
      var cart = WG.groceryCart(rc.data);
      var v = cart ? WG.customField(cart, 'storeNumber') : null;
      var sv = v == null ? null : String(v);
      if (sv && /^[0-9]{1,4}$/.test(sv)) {
        tries.push({ from: 'cart', v: sv, ms: rc.ms });
        try { localStorage.setItem('${STORE_CACHE_KEY}', JSON.stringify({ v: sv, at: Date.now() })); } catch (e) {}
        return tries;
      }
      tries.push({ from: 'cart', v: null, ms: rc.ms });
    } else {
      tries.push({ from: 'cart', v: null, why: rc.why });
    }
    // The profile is a fallback only. It did not carry the number on the
    // account this was measured against, but it costs one call to be sure.
    var r = await WG.commerce('/commerce/account/customer', tok, { method: 'GET' }, budgetMs || 10000);
    if (!r.ok) { tries.push({ from: 'customer', v: null, why: r.why }); return tries; }
    var n = WG.storeFromCustomer(r.data);
    tries.push({ from: 'customer', v: n, ms: r.ms });
    if (n) { try { localStorage.setItem('${STORE_CACHE_KEY}', JSON.stringify({ v: n, at: Date.now() })); } catch (e) {} }
    return tries;
  };

  // ---- the bearer -------------------------------------------------------
  //
  // Layered on purpose. MSAL's credential cache is ENCRYPTED, so there is no
  // single read that gets this, and each layer below is cheaper than the one
  // after it. A run that gets none of them still searches at full speed.
  WG.cachedToken = function () {
    try {
      var raw = localStorage.getItem('${TOKEN_CACHE_KEY}');
      if (!raw) return null;
      var j = JSON.parse(raw);
      if (!j || !j.t) return null;
      // The token's own expiry, read out of the JWT rather than trusted from
      // when we happened to store it. A minute of slack so a token about to
      // expire is not handed to a write that will outlive it.
      if (j.exp && Date.now() / 1000 > j.exp - 60) return null;
      return j.t;
    } catch (e) { return null; }
  };
  WG.cacheToken = function (tok) {
    var exp = null;
    try {
      var body = tok.split('.')[1];
      if (body) {
        var pad = body.replace(/-/g, '+').replace(/_/g, '/');
        while (pad.length % 4) pad += '=';
        exp = JSON.parse(atob(pad)).exp || null;
      }
    } catch (e) {}
    try { localStorage.setItem('${TOKEN_CACHE_KEY}', JSON.stringify({ t: tok, exp: exp, at: Date.now() })); } catch (e) {}
    return exp;
  };
  WG.forgetToken = function () {
    try { localStorage.removeItem('${TOKEN_CACHE_KEY}'); } catch (e) {}
  };

  // Watch for the site's own commerce call and take the header off it.
  //
  // This is what page-globals-are-someone-elses-fetch says to do, one step on:
  // do not poll for a value, find the request that already carries it. It only
  // catches anything on a page where the site's own code runs -- which is why
  // the session probe reports whether it worked rather than assuming.
  WG.watchForToken = function () {
    if (WG.watching) return;
    WG.watching = true;
    var real = window.fetch;
    window.fetch = function (url, init) {
      try {
        var h = (init && init.headers) || {};
        var a = h.authorization || h.Authorization ||
                (h.get ? h.get('authorization') : null);
        if (a && String(a).indexOf('Bearer ') === 0 && String(url).indexOf('wegmans.cloud') > 0) {
          WG.cacheToken(String(a).slice(7));
        }
      } catch (e) {}
      return real.apply(this, arguments);
    };
  };

  // THE BEARER, WITH NO NETWORK AND NO PAGE LOAD.
  //
  // MSAL keeps its token cache ENCRYPTED in localStorage. This was written off
  // as unreadable, and the rail waited for the site's own code to make a
  // request it could observe -- which never happens on robots.txt, because
  // nothing runs there. So the token was never obtained and Wegmans never had
  // a usable session.
  //
  // It is readable. The scheme is MSAL's own, read out of their bundle:
  //
  //   cookie msal.cache.encryption = { id, key }      key is base64, 32 bytes
  //   entry  msal.<...>            = { id, nonce, data }
  //
  //   salt = base64(entry.nonce)          16 bytes, called "nonce", IS THE SALT
  //   info = clientId, but ONLY when the entry key contains it (getContext)
  //   aes  = HKDF-SHA256(cookie.key, salt, info) -> AES-GCM 256
  //   iv   = TWELVE ZERO BYTES            not the stored nonce
  //
  // MEASURED on Stephen's phone 2026-09-03: decrypts his AccessToken with ~55
  // minutes left, and that token answered /commerce/account/customer in 302ms.
  //
  // Same origin is all it needs, so robots.txt can do it.
  WG.b64 = function (s) {
    var t = String(s).split('-').join('+').split('_').join('/');
    var bin = atob(t + '==='.slice((t.length + 3) % 4));
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };

  WG.clientIds = function () {
    var out = [];
    try {
      var m = window.msal && window.msal.clientIds;
      if (Object.prototype.toString.call(m) === '[object Array]') out = m.slice(0);
      else if (m && typeof m === 'object') { for (var k in m) if (m[k]) out.push(String(m[k])); }
      else if (typeof m === 'string') out = [m];
    } catch (e) {}
    return out;
  };

  /** Every UUID in a string, most-specific first. MSAL's context is one of these. */
  WG.uuidsIn = function (k) {
    var m = String(k).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
    return m ? m.slice(0) : [];
  };

  /**
   * THE token lookup. Cache first, then the MSAL store.
   *
   * Every script that needs a bearer goes through this. The session script had
   * the MSAL fallback and the cart read and the add did not, so the moment the
   * cached token aged out they reported no_token on a device that could read
   * one in 40ms — which is exactly what Stephen's run did: session fine, then
   * "wrote 0 of 5, why: no_token".
   */
  WG.token = async function () {
    var t = WG.cachedToken();
    if (t) return t;
    try { t = await WG.tokenFromCache(); } catch (e) { t = null; }
    if (t) return t;
    // EXPIRED IS NOT SIGNED OUT.
    //
    // The access token lasts an hour. MSAL renews it with the refresh token
    // beside it, but only when the site's own code runs — and the rail runs on
    // robots.txt, where it never does. So an hour after the user last opened
    // Wegmans, every script here reported no_token and the run failed at the
    // gate, on a device holding a refresh token good for another six hours.
    // Stephen, on exactly that: "just tested wegmans and it immedietly failed".
    try { return await WG.refresh(); } catch (e) { return null; }
  };

  /** The B2C token endpoint, from the authority's own public discovery doc. */
  WG.tokenEndpoint = async function (env, realm, policy) {
    try {
      var c = JSON.parse(localStorage.getItem('${ENDPOINT_CACHE}') || 'null');
      if (c && c.v && Date.now() - c.at < 604800000) return c.v;
    } catch (e) {}
    if (!env || !realm || !policy) return null;
    var url = 'https://' + env + '/' + realm + '/' + policy + '/v2.0/.well-known/openid-configuration';
    try {
      var r = await fetch(url);
      var j = JSON.parse(await r.text());
      if (j && j.token_endpoint) {
        try { localStorage.setItem('${ENDPOINT_CACHE}', JSON.stringify({ v: j.token_endpoint, at: Date.now() })); } catch (e) {}
        return j.token_endpoint;
      }
    } catch (e) {}
    return null;
  };

  /**
   * Trade the refresh token for a fresh access token, exactly as MSAL would.
   *
   * The new refresh token is kept in OUR storage rather than written back into
   * MSAL's encrypted cache: re-encrypting into a store the site owns is a good
   * way to corrupt someone's login, and the worst case here is that a rotated
   * token makes the next refresh fail and the user's next visit to the site
   * fixes it.
   */
  WG.refresh = async function () {
    var creds = WG.msalCreds ? WG.msalCreds : await WG.readMsalCreds();
    var rt = null;
    try {
      var mine = JSON.parse(localStorage.getItem('${REFRESH_CACHE}') || 'null');
      if (mine && mine.v && Date.now() - mine.at < 86400000) rt = mine.v;
    } catch (e) {}
    if (!rt) rt = creds.refresh;
    if (!rt || !creds.clientId) return null;
    var ep = await WG.tokenEndpoint(creds.env, creds.realm, creds.policy);
    if (!ep) return null;
    var form = 'grant_type=refresh_token'
      + '&client_id=' + encodeURIComponent(creds.clientId)
      + '&refresh_token=' + encodeURIComponent(rt)
      + (creds.scope ? '&scope=' + encodeURIComponent(creds.scope) : '');
    try {
      var r = await fetch(ep, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
      var j = JSON.parse(await r.text());
      if (!j || !j.access_token) return null;
      WG.cacheToken(j.access_token);
      if (j.refresh_token) {
        try { localStorage.setItem('${REFRESH_CACHE}', JSON.stringify({ v: j.refresh_token, at: Date.now() })); } catch (e) {}
      }
      return j.access_token;
    } catch (e) { return null; }
  };

  /**
   * One walk of MSAL's cache, yielding everything the rail needs from it: the
   * access token if it is still good, the refresh token, and the account
   * identifiers a refresh has to quote. The policy comes out of the storage KEY
   * — it is not a field on any credential.
   */
  WG.readMsalCreds = async function () {
    var out = { access: null, refresh: null, clientId: null, realm: null, env: null,
                scope: null, policy: null };
    if (!window.crypto || !window.crypto.subtle) return (WG.msalCreds = out);
    var raw = null;
    var parts = document.cookie.split(';');
    for (var p = 0; p < parts.length; p++) {
      var t0 = parts[p].replace(/^ +/, '');
      if (t0.indexOf('msal.cache.encryption') === 0) { raw = t0.slice(t0.indexOf('=') + 1); break; }
    }
    if (!raw) return (WG.msalCreds = out);
    var meta;
    try { meta = JSON.parse(decodeURIComponent(raw)); } catch (e) { return (WG.msalCreds = out); }
    if (!meta || !meta.key) return (WG.msalCreds = out);
    var base;
    try {
      base = await window.crypto.subtle.importKey('raw', WG.b64(meta.key), 'HKDF', false, ['deriveKey']);
    } catch (e) { return (WG.msalCreds = out); }
    var ids = WG.clientIds();
    var bestLeft = -1e9;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf('msal') < 0) continue;
      if (!out.policy) {
        var pm = k.match(/b2c_1a_[a-z0-9_]+/i);
        if (pm) out.policy = pm[0];
      }
      var j;
      try { j = JSON.parse(localStorage.getItem(k) || ''); } catch (e) { continue; }
      if (!j || !j.data || !j.nonce) continue;
      var ctxs = WG.uuidsIn(k);
      for (var q = 0; q < ids.length; q++) { if (ids[q] && k.indexOf(ids[q]) >= 0) ctxs.unshift(ids[q]); }
      ctxs.push('');
      for (var ci = 0; ci < ctxs.length; ci++) {
        try {
          var dk = await window.crypto.subtle.deriveKey(
            { name: 'HKDF', salt: WG.b64(j.nonce), hash: 'SHA-256', info: new TextEncoder().encode(ctxs[ci]) },
            base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
          var o = JSON.parse(new TextDecoder().decode(await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(12) }, dk, WG.b64(j.data))));
          if (o.clientId && !out.clientId) out.clientId = String(o.clientId);
          if (o.environment && !out.env) out.env = String(o.environment);
          if (o.realm && !out.realm) out.realm = String(o.realm);
          if (o.credentialType === 'RefreshToken' && o.secret) out.refresh = String(o.secret);
          if (o.credentialType === 'AccessToken' && o.secret
              && String(o.target || '').indexOf('wegmans.cloud') >= 0) {
            // The scope is kept even from an EXPIRED token: it is what a refresh
            // has to ask for, and the expired one is the only record of it.
            if (!out.scope) out.scope = String(o.target);
            var left = Number(o.expiresOn || 0) - Math.floor(Date.now() / 1000);
            if (left > 60 && left > bestLeft) { bestLeft = left; out.access = String(o.secret); }
          }
          break;
        } catch (e) { /* wrong context for this entry; try the next */ }
      }
    }
    WG.msalCreds = out;
    return out;
  };

  WG.tokenFromCache = async function () {
    var c = await WG.readMsalCreds();
    if (!c.access) return null;
    WG.cacheToken(c.access);
    return c.access;
  };

  WG.authHeaders = function (tok) {
    return { authorization: 'Bearer ' + tok, accept: 'application/json' };
  };

  // THE api-version QUERY IS NOT OPTIONAL.
  //
  // Without it the gateway rejects the request BEFORE it adds CORS headers, so
  // the browser reports a bare "Failed to fetch" with no status — which reads
  // exactly like an unreachable host. That is what made the commerce API look
  // unusable from the page: every call, with or without a token, failed the
  // same way. With the version, /commerce/account/customer answers 200 in
  // 302ms. Versions are per-path and were read off the site's own requests.
  WG.API_VERSION = {
    '/commerce/account/customer': '2024-03-06-preview',
    '/commerce/account/addresses': '2024-03-06-preview',
    '/commerce/order/orders/activeorders': '2024-03-04-preview',
    '/commerce/saved-list/savedlists': '2024-02-20-preview',
    '/commerce/my-items': '2024-01-26',
    '/commerce/cart/carts/': '2024-02-19-preview',
    '/commerce/cart/carts/lineitems': '2024-02-19-preview',
  };
  // Read off the site's own version table (TURBOPACK chunk 96047), which names
  // one per API: ACCOUNT 2024-03-06-preview, CART 2024-02-19-preview, CART_V2
  // 2026-01-13-preview, COUPONS 2024-11-05-preview, COMMERCE_BROWSE 2023-09-22.
  // The cart URL is built there from API_CART + "/carts/?" + API_CART_VERSION --
  // the collection, with the trailing slash, for the read AND the write.
  // (Written out rather than quoted: this whole script is a template literal,
  // so a dollar-brace in a comment is an interpolation and breaks the build.)
  WG.versioned = function (path) {
    if (path.indexOf('api-version=') >= 0) return path;
    var base = path.split('?')[0];
    var v = WG.API_VERSION[base] || '2024-03-06-preview';
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'api-version=' + v;
  };

  // ONE ATTEMPT. The retrying wrapper below is the thing everything calls; see
  // _retry.ts for which failures earn a second ask and why a timeout does not.
  WG.commerce = function (path, tok, init, budgetMs) {
    return __mealioRetry(function () { return WG.commerceAttempt(path, tok, init, budgetMs); });
  };
  WG.commerceAttempt = async function (path, tok, init, budgetMs) {
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, budgetMs || 15000);
    var t0 = Date.now();
    var opts = init || {};
    opts.signal = ctl.signal;
    opts.headers = WG.authHeaders(tok);
    if (opts.body) opts.headers['content-type'] = 'application/json';
    var r, txt;
    try {
      r = await fetch('${COMMERCE_BASE}' + WG.versioned(path), opts);
      clearTimeout(to);
      txt = await r.text();
    } catch (e) {
      clearTimeout(to);
      return { ok: false, why: 'no_response', aborted: !!(e && e.name === 'AbortError'), ms: Date.now() - t0 };
    }
    var ms = Date.now() - t0;
    // A 401 means the token we cached is spent. Drop it so the next run looks
    // again rather than failing the same way for an hour.
    if (r.status === 401 || r.status === 403) { WG.forgetToken(); return { ok: false, why: 'unauthorised', status: r.status, ms: ms }; }
    if (r.status < 200 || r.status >= 300) return { ok: false, why: 'http', status: r.status, ms: ms, detail: String(txt || '').slice(0, 160) };
    var j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    return { ok: true, data: j, ms: ms, bytes: (txt || '').length };
  };
`;

/**
 * The session probe. Answers the login question with no network at all, then
 * says whether the cart half can run.
 *
 * TWO ANSWERS, deliberately, and the Albertsons lesson is why: an account
 * existing and a token being usable are different facts, and a run built on the
 * first wrote nothing at all on that store. `early` settles the login gate;
 * `verified` is what lets the run write.
 */
export function buildWegmansSessionScript(): string {
  return `(async function () {
${WEG_PRELUDE}
  var post = function (o) { o.type = 'WEGMANS_SESSION'; WG.post(o); };
  try {
    WG.watchForToken();
    var accounts = WG.accountCount();
    // The cache FIRST. watchForToken only ever fires where the site's own code
    // runs, and the rail deliberately sits on a page where nothing runs.
    var tok0 = await WG.token();
    var stores = await WG.findStoreNumber(tok0, 10000);
    var storeNumber = null;
    for (var sx = 0; sx < stores.length; sx++) if (stores[sx] && stores[sx].v) { storeNumber = String(stores[sx].v); break; }

    if (!accounts) {
      // DEFINITIVE, and cheap: MSAL keeps this list whether or not the
      // credential cache is readable.
      post({ ok: true, loggedIn: false, source: 'msal', storeTries: stores });
      return;
    }

    // AN ACCOUNT IS NOT A TOKEN, and with neither token this cannot answer.
    //
    // The access token lasts an hour; the refresh token beside it about six.
    // MSAL renews both, but only where the site's own code runs -- and the rail
    // deliberately sits on robots.txt, where nothing runs. So a user who has not
    // opened Wegmans in a day holds two expired credentials and nothing to mint
    // with. WG.token() has already tried the cache, MSAL's own store and a
    // refresh by the time we get here.
    //
    // MEASURED 2026-09-04 on Stephen's device: the refresh token had expired
    // 6771 seconds earlier, and the session still answered "signed in". The run
    // then read no_token, wrote no_token, and told him nothing was added.
    //
    // ok:false is the honest report -- not "signed out", which walls a user
    // whose cookies are perfectly good, and not "signed in", which is the
    // failure above. It means COULD NOT ANSWER, and the engine's repair pass
    // takes it from there: one load of the real storefront runs MSAL, which
    // signs them back in from those cookies and mints a fresh pair, and the
    // probe is re-asked on that page. Nobody is shown a sign-in form unless the
    // site itself declines to sign them in.
    if (!tok0) {
      post({ ok: false, why: 'token_expired', source: 'msal',
             accounts: accounts, storeId: storeNumber, storeTries: stores });
      return;
    }

    // Signed in. Answer the LOGIN gate now -- no budget of ours may make a
    // signed-in user wait to be told they are signed in.
    post({
      ok: true, loggedIn: true, early: true, source: 'msal',
      storeId: storeNumber, shoppingContext: 'pickup',
      accounts: accounts, storeTries: stores,
    });

    // THE CART IS THE PROOF, and it is a cart we need anyway.
    //
    // This used to spend a second call on /commerce/account/customer purely to
    // see whether the token was accepted. A cart read answers the same question
    // and returns the baseline with it, so the run gets both for one request.
    var tok = tok0;
    var verified = false;
    var why = 'no_token';
    if (tok) {
      var rc2 = WG.lastCart;
      if (!rc2) rc2 = await WG.readCart(tok, 8000);
      verified = !!(rc2 && rc2.ok);
      if (rc2 && !rc2.ok) why = rc2.why;
    }
    post({
      ok: true, loggedIn: true, verified: verified,
      // Not usable for the RUN until the token proves out -- see sessionUsable.
      storeId: storeNumber, shoppingContext: 'pickup',
      cartCapable: verified, why: verified ? null : why,
      source: 'msal', accounts: accounts, storeTries: stores,
    });
  } catch (e) {
    post({ ok: false, why: 'threw', detail: String(e).slice(0, 160) });
  }
})(); true;`;
}

/**
 * Search, over Algolia, with no session at all.
 *
 * MEASURED: 26ms unfiltered, 13ms with the store filter, from a plain curl with
 * no cookies and no token. That has two consequences worth stating, because
 * neither is true of any other store here:
 *
 *   - it works for a SIGNED-OUT user, so the prewarm need not wait for the
 *     login check;
 *   - it cannot be broken by an expired token, so the cart half failing does
 *     not take search with it.
 *
 * The store filter is not optional. The same product is 626485 at store 50 and
 * 608294 at store 140, and unfiltered "sour cream" returns 32,223 hits -- every
 * store's catalogue at once.
 */
export function buildWegmansNetworkSearchBatchScript(
  terms: string[],
  opts: { storeNumber?: string | null; requestMs?: number; hitsPerPage?: number } = {},
): string | null {
  if (!terms.length) return null;
  // NO STORE, NO SEARCH -- see WG.findStoreNumber for why. An unfiltered query
  // returns every store's catalogue, and its ids are not valid where this user
  // shops, so a product chosen from one would add the wrong thing next run.
  if (!opts.storeNumber) return null;
  return `(async function () {
${WEG_PRELUDE}
  var TERMS = ${JSON.stringify(terms)};
  var STORE = ${JSON.stringify(opts.storeNumber)};
  var REQ_MS = ${opts.requestMs ?? 12000};
  var HITS = ${opts.hitsPerPage ?? 24};
  var post = WG.post;

  var search = async function (term) {
    var url = '${ALGOLIA_HOST}/1/indexes/${ALGOLIA_INDEX}/query'
      + '?x-algolia-api-key=${ALGOLIA_KEY}&x-algolia-application-id=${ALGOLIA_APP}';
    var body = { query: term, hitsPerPage: HITS };
    if (STORE) body.filters = 'storeNumber:' + STORE;
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, REQ_MS);
    var t0 = Date.now();
    var r, txt;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
                             body: JSON.stringify(body), signal: ctl.signal });
      clearTimeout(to);
      txt = await r.text();
    } catch (e) { clearTimeout(to); return { ok: false, why: 'no_response', ms: Date.now() - t0 }; }
    var ms = Date.now() - t0;
    if (r.status !== 200) return { ok: false, why: 'http', status: r.status, ms: ms,
                                   detail: String(txt || '').slice(0, 160) };
    var j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    if (!j || !j.hits) return { ok: false, why: 'unparseable', ms: ms };
    return { ok: true, hits: j.hits, nb: j.nbHits, ms: ms, algoliaMs: j.processingTimeMS };
  };

  // The record carries everything the matcher and the review screen need, so
  // nothing here is inferred from a name. maxQuantity especially: H-E-B's
  // per-item cap is only discovered when a write is refused, and this store
  // hands it over before we ask.
  var toCandidate = function (h) {
    var price = null;
    try {
      var p = h.price_inStore || h.price_delivery || null;
      if (p && p.amount != null) price = '$' + Number(p.amount).toFixed(2);
    } catch (e) {}
    var img = null;
    try { img = (h.images && h.images.length) ? h.images[0] : null; } catch (e) {}
    return {
      productName: String(h.productName || h.webProductDescription || ''),
      imageUrl: img,
      // isAvailable and isSoldAtStore are separate facts and either one being
      // false means we must not write it.
      outOfStock: (h.isAvailable === false) || (h.isSoldAtStore === false),
      preferences: null,
      price: price,
      productId: h.productId != null ? String(h.productId) : null,
      skuId: h.skuId != null ? String(h.skuId) : null,
      // SOLD by weight, not PRICED by weight. isSoldByWeight is true for both,
      // so it cannot be the discriminator -- MEASURED 2026-09-03:
      //
      //   Butter Boy French Butter  isSoldByWeight true, onlineSellByUnit "Each",
      //                             approxUnitWeight 0.25, $6.48 a unit
      //   Fresh Sea Scallops        isSoldByWeight true, onlineSellByUnit "lb",
      //                             approxUnitWeight 0,   $32.99 a pound
      //
      // Wegmans shows an average weight and a per-pound price on plenty of
      // things it sells BY THE UNIT. Reading isSoldByWeight sent the butter to
      // review asking Stephen to choose a weight for something you buy one of:
      // "That is not true. Wegmans gives an average weight, but it is sold by
      // the unit qty."
      isWeightItem: WG.soldByWeight(h),
      maxOrderQuantity: h.maxQuantity != null ? Number(h.maxQuantity) : null,
      // Kept so a saved product survives a store change: the id is per store,
      // the barcode is not. See the note on storeProductKey.
      upc: (h.upc && h.upc.length) ? String(h.upc[0]) : null,
      storeNumber: h.storeNumber != null ? String(h.storeNumber) : null,
    };
  };

  try {
    for (var t = 0; t < TERMS.length; t++) {
      var term = TERMS[t];
      var r = await search(term);
      if (!r.ok) {
        post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: term, why: r.why,
               status: r.status || null, ms: r.ms || null, detail: r.detail || null });
        continue;
      }
      var cands = [];
      for (var i = 0; i < r.hits.length; i++) {
        var c = toCandidate(r.hits[i]);
        if (c.productName) cands.push(c);
      }
      post({ type: 'SEARCH_RESULT', source: 'network', term: term, candidates: cands,
             ms: r.ms, algoliaMs: r.algoliaMs, nb: r.nb, filtered: !!STORE });
    }
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length });
  } catch (e) {
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length, threw: String(e).slice(0, 140) });
  }
})(); true;`;
}

/** Read the cart. Needs the bearer; says so plainly when it has none. */
export function buildWegmansCartReadScript(): string {
  return `(async function () {
${WEG_PRELUDE}
  try {
    WG.watchForToken();
    var tok = await WG.token();
    if (!tok) {
      // NOT an empty cart. "Nobody could read it" and "it holds nothing" are
      // different facts, and calling the first the second makes every item the
      // user already owned look like something this run just added.
      WG.post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_failed',
                why: 'no_token' });
      return;
    }
    var r = await WG.readCart(tok, 15000);
    if (!r.ok) {
      WG.post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_failed',
                why: r.why, status: r.status || null });
      return;
    }
    // THE MEASURED SHAPE, 2026-09-03, against a cart holding 13 items.
    // This used to WALK the response for anything array-shaped with a quantity,
    // because the envelope had never been seen with items in it. It has now.
    var cart = WG.groceryCart(r.data) || {};
    var lines = cart.lineItems || cart.items || [];
    if (!lines.length) {
      // Kept as a fallback, not as the plan: an envelope change should degrade
      // to a guess rather than to an empty cart, because "empty" is the reading
      // that makes everything the user already owns look newly added.
      var pick = function (n, depth) {
        if (!n || depth > 6 || lines.length) return;
        if (Object.prototype.toString.call(n) === '[object Array]') {
          if (n.length > 0 && n[0] && typeof n[0] === 'object' && n[0].quantity != null) { lines = n; return; }
          for (var i = 0; i < n.length; i++) pick(n[i], depth + 1);
          return;
        }
        if (typeof n !== 'object') return;
        for (var k in n) { if (Object.prototype.hasOwnProperty.call(n, k)) pick(n[k], depth + 1); }
      };
      pick(r.data, 0);
    }
    var rows = [];
    var count = 0;
    for (var i2 = 0; i2 < lines.length; i2++) {
      var li = lines[i2] || {};
      var qty = Number(li.quantity != null ? li.quantity : (li.qty != null ? li.qty : 1));
      if (!(qty > 0)) qty = 1;
      var id = WG.lineSku(li);
      rows.push({ name: WG.lineName(li, id), qty: qty, itemId: id, available: li.isAvailable !== false });
      count += qty;
    }
    // cartId and version travel with it: this is a commercetools cart, so any
    // write has to quote the version it was read at.
    WG.post({ type: 'CART_COUNT', count: count, items: rows, source: 'network', ms: r.ms,
              cartId: cart.id || null, version: cart.version != null ? cart.version : null,
              shape: rows.length ? null : JSON.stringify(r.data || {}).slice(0, 300) });
  } catch (e) {
    WG.post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_threw',
              detail: String(e).slice(0, 140) });
  }
})(); true;`;
}

export interface WegmansAddItem {
  idx: number;
  productId: string;
  skuId?: string | null;
  quantity: number;
  name: string;
}

/**
 * Write the cart.
 *
 * THE LEAST CERTAIN THING IN THIS FILE, and it is marked rather than dressed up.
 * The endpoint was never called: capturing it meant adding to a real basket,
 * and that is not a thing to do to a sleeping man's groceries. What is below is
 * read off the shape of the eight commerce endpoints that WERE observed --
 * /commerce/cart/carts/ is a REST collection, so its items live at
 * /commerce/cart/carts/{cartId}/items and conventionally take a list.
 *
 * So it ships behind `networkAdd: false`, and it refuses the same case the
 * Instacart rail refuses: an item the cart already holds, where SET and ADD
 * semantics disagree and nobody has measured which this store does.
 *
 * To finish it: run the cart read with one item added by hand, read the shape it
 * reports, then watch the site add one more (tools/rail-recon/watch.ts) -- that
 * request IS the answer, including whether the body holds one item or a list.
 */
export function buildWegmansNetworkAddBatchScript(
  items: WegmansAddItem[],
  opts: {
    knownLines?: Record<string, number> | null;
    absoluteQty?: boolean | null;
    itemsPath?: string;
  } = {},
): string | null {
  const writable = items.filter((i) => !!i.productId);
  if (!writable.length) return null;
  return `(async function () {
${WEG_PRELUDE}
  var ITEMS = ${JSON.stringify(writable)};
  var KNOWN = ${JSON.stringify(opts.knownLines ?? null)};
  var ABSOLUTE = ${JSON.stringify(opts.absoluteQty ?? null)};
  var post = WG.post;

  var report = function (it, ok, reason, detail, asked) {
    post({ type: 'NET_ADD_RESULT', idx: it.idx, name: it.name, productId: it.productId,
           skuId: it.skuId || null, asked: asked != null ? asked : it.quantity,
           success: !!ok, reason: reason || null, detail: detail || null });
  };
  var reasonCatalog = [
    { reason: 'no_token' },
    { reason: 'no_cart' },
    { reason: 'line_already_present' },
    { reason: 'write_refused' },
    { reason: 'not_in_cart_after_write' },
  ];

  var readCart = async function (tok) {
    var r = await WG.commerce('/commerce/cart/carts/', tok, { method: 'GET' }, 15000);
    if (!r.ok) return null;
    var lines = [];
    var pick = function (n, depth) {
      if (!n || depth > 6 || lines.length) return;
      if (Array.isArray(n)) {
        if (n.length && n[0] && typeof n[0] === 'object' && (n[0].quantity != null || n[0].qty != null)) { lines = n; return; }
        for (var i = 0; i < n.length; i++) pick(n[i], depth + 1);
        return;
      }
      if (typeof n !== 'object') return;
      for (var k in n) { if (Object.prototype.hasOwnProperty.call(n, k)) pick(n[k], depth + 1); }
    };
    // The measured envelope first; the walk above is the fallback. Same reading
    // as the cart read, and it has to be: this map is what decides whether an
    // item is already held, and the read and the write disagreeing about that
    // is how a cart gets double-added.
    var cart = WG.groceryCart(r.data) || {};
    if (cart.lineItems && cart.lineItems.length) lines = cart.lineItems;
    else if (!lines.length) pick(r.data, 0);
    var held = {};
    var lineIds = {};
    var rows = [];
    var cartId = cart.id || null;
    if (!cartId) { try { cartId = (r.data && (r.data.cartId || r.data.id)) || null; } catch (e) {} }
    for (var i2 = 0; i2 < lines.length; i2++) {
      var li = lines[i2] || {};
      // variant.sku — the ONLY id a cart line shares with a search result.
      var id = WG.lineSku(li);
      var q = Number(li.quantity != null ? li.quantity : (li.qty != null ? li.qty : 1));
      if (!(q > 0)) q = 1;
      if (id) {
        held[id] = (held[id] || 0) + q;
        // The LINE's own id, which is what turns a write into a quantity change.
        if (li.id != null) lineIds[id] = String(li.id);
      }
      rows.push({ name: WG.lineName(li, id), qty: q, itemId: id, available: true });
    }
    // The cart OBJECT travels with it: the write needs the store number and the
    // version out of the same response the baseline came from, and re-reading
    // would be a second call whose answer could already differ.
    return { cartId: cartId ? String(cartId) : null, held: held, rows: rows, lineIds: lineIds,
             version: cart.version != null ? cart.version : null, cart: cart };
  };

  try {
    WG.watchForToken();
    var tok = await WG.token();
    if (!tok) {
      for (var n = 0; n < ITEMS.length; n++) report(ITEMS[n], false, 'no_token', 'no bearer for the commerce API');
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, why: 'no_token' });
      return;
    }

    // ALWAYS READ THE CART. The prewarmed baseline can supply the held
    // quantities, but it cannot supply the cartID or the cartVersion, and this
    // write names both. Sent without them the API does not fail -- it CREATES A
    // NEW CART, and the user's existing basket stops being the active one.
    //
    // That happened once, on Stephen's real cart, 2026-09-03: an app run passed
    // knownLines, cartID went out as null, and a 20-item basket was replaced by
    // a one-item cart. A read costs ~600ms; that is not a trade worth making.
    var before = await readCart(tok);
    // KNOWN, the prewarm's baseline, is deliberately NOT used. The read above is
    // newer, and its held counts have to agree with the line ids that come from
    // the same response: a quantity computed from one snapshot and written
    // against a line id from another is how a cart gets the wrong total.
    if (!before) {
      for (var z = 0; z < ITEMS.length; z++) report(ITEMS[z], false, 'no_cart', 'could not read the cart to baseline against');
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0 });
      return;
    }

    // WHAT THE WRITE NEEDS BESIDES THE CART, all of it cacheable.
    //
    //   StoreKey    "140-CHAPEL-HILL"  — /api/stores, same-origin and unauthenticated
    //   customerID  + email            — /commerce/account/customer
    //
    var storeNo = null;
    try { storeNo = WG.customField(before.cart || {}, 'storeNumber'); } catch (e) {}
    if (!storeNo) storeNo = WG.cachedStore();
    if (!before.cartId || before.version == null) {
      // Refusing beats creating a second cart the user cannot see.
      for (var q3 = 0; q3 < ITEMS.length; q3++) report(ITEMS[q3], false, 'no_cart',
        'the cart has no id or version to write against');
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, why: 'no_cart_identity' });
      return;
    }
    var storeKey = await WG.storeKey(storeNo);
    var who = await WG.customerRef(tok);
    if (!storeKey || !who) {
      for (var q2 = 0; q2 < ITEMS.length; q2++) report(ITEMS[q2], false, 'write_refused',
        'missing ' + (!storeKey ? 'store key' : 'customer ref'));
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, why: 'write_prereq' });
      return;
    }

    // The catalogue row for each sku, which is where every line-item field
    // comes from. One Algolia request for the whole batch.
    var skus = [];
    for (var s1 = 0; s1 < ITEMS.length; s1++) if (ITEMS[s1].productId) skus.push(String(ITEMS[s1].productId));
    var rows = await WG.hitsBySku(skus, storeNo);

    var lineItems = [];
    var planned = [];
    for (var i = 0; i < ITEMS.length; i++) {
      var it = ITEMS[i];
      var have = Number(before.held[it.productId] || 0);
      var want = Math.max(1, Math.round(it.quantity || 1));
      // WANT, NOT held + want.
      //
      // This endpoint ADDS. Every other rail here writes an ABSOLUTE quantity,
      // so held + wanted is how they land on "add on top" -- Stephen's rule
      // since 2026-09-01, and the reason re-running a meal doubles the cart on
      // purpose. Sending held + wanted to an endpoint that adds would give
      // held + held + wanted, which is the over-add MEAL-194 was about.
      //
      // An item the cart already holds is NOT a special case and is not
      // refused. It briefly was, because this file copied the Instacart rail's
      // guard -- and that guard exists there only because that store's write
      // SETS a line and nobody had measured it. Stephen: "are preventing adding
      // things that are already in the cart? Where did you get that idea?? No
      // other store does that and that has never been the behavior."
      var hit = rows[String(it.productId)];
      if (!hit) { report(it, false, 'write_refused', 'no catalogue row for sku ' + it.productId); continue; }
      // AN EXISTING LINE IS ADDRESSED BY ITS ID, and then quantity is ABSOLUTE.
      //
      // Without the id this endpoint only CREATES lines: a write for a sku the
      // cart already holds returns 200, advances the cart version and changes
      // nothing at all. With the line's own id it SETS that line -- measured
      // 1 -> 2, then 2 -> 3, and the plain "id" field alone does it.
      //
      // So held + wanted, exactly like every other rail, and re-running a meal
      // adds on top the way Stephen chose on 2026-09-01.
      var lineId = before.lineIds ? before.lineIds[String(it.productId)] : null;
      var li2 = WG.lineItemFor(hit, lineId ? have + want : want);
      if (lineId) li2.id = lineId;
      lineItems.push(li2);
      planned.push({ it: it, want: want, sent: have + want, have: have });
    }
    if (!lineItems.length) { post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0 }); return; }

    // THE ENVELOPE, captured from the site's own add on 2026-09-03.
    //
    //   POST /commerce/cart/carts/lineitems?api-version=2024-02-19-preview
    //
    // "lineitems", one word. Every hyphenated and RESTful guess -- /carts/{id},
    // /carts/{id}/line-items, /carts/items, PUT, PATCH -- came back as a bare
    // "Failed to fetch", because this gateway rejects an unknown route before it
    // adds CORS headers. Guessing could not have found it; watching the site
    // could, and did.
    var body = {
      StoreKey: storeKey,
      cartData: [{
        cartID: before.cartId,
        cartVersion: before.version,
        custom: [
          { name: 'orderLevelAdjustments', value: '[]' },
          { name: 'storeNumber', value: String(storeNo) },
          { name: 'fulfillmentType', value: 'pickup' },
        ],
        isAlcoholic: false,
        lineItems: lineItems,
      }],
      customerEmail: who.email,
      customerID: who.id,
    };
    var res = await WG.commerce('${CART_WRITE_PATH}', tok, { method: 'POST', body: JSON.stringify(body) }, 25000);
    if (!res.ok) {
      for (var f = 0; f < planned.length; f++) report(planned[f].it, false, 'write_refused',
        res.why + (res.status ? ' ' + res.status : '') + (res.detail ? ': ' + res.detail : ''));
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, why: res.why, status: res.status || null });
      return;
    }

    // THE CART DECIDES. Never the write's own report.
    var after = await readCart(tok);
    var wrote = 0;
    for (var p = 0; p < planned.length; p++) {
      var pl = planned[p];
      var now = after ? Number(after.held[pl.it.productId] || 0) : null;
      if (now == null) { report(pl.it, true, null, 'written, cart not re-read', pl.want); wrote++; continue; }
      if (now >= pl.sent) { report(pl.it, true, null, null, pl.want); wrote++; }
      else report(pl.it, false, 'not_in_cart_after_write', 'expected ' + pl.sent + ', cart holds ' + now, pl.want);
    }
    post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: wrote,
           writeStatus: res.status || null,
           // The gateway answers 200 with a body that can still describe a
           // rejection, so the answer is carried for diagnosis rather than
           // trusted. The CART is what decided the per-item verdicts above.
           writePeek: (function () { try { return JSON.stringify(res.data).slice(0, 200); } catch (e) { return null; } })(),
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
 * Wegmans. The only store here whose SEARCH needs no session at all.
 *
 * Algolia answers in 13ms with a public search key, so a Wegmans search works
 * signed-out and cannot be broken by an expired token. The cart half needs a
 * bearer that MSAL keeps encrypted, which is why sessionUsable below is the
 * strictest of the three rails.
 */
export const WEGMANS_RAIL: NetworkRail = {
  sessionMessageType: 'WEGMANS_SESSION',
  sessionScript: buildWegmansSessionScript,
  searchBatch: (terms, sess) =>
    buildWegmansNetworkSearchBatchScript(terms, {
      storeNumber: sess.storeId,
      requestMs: WEGMANS_RAIL.budgets.searchRequestMs,
    }),
  cartRead: () => buildWegmansCartReadScript(),
  addBatch: (items, opts) =>
    buildWegmansNetworkAddBatchScript(
      items.map((i) => ({
        idx: i.idx, productId: i.productId, skuId: i.skuId ?? null,
        quantity: i.quantity, name: i.name,
      })),
      {
        knownLines: opts?.knownLines ?? null,
        // Passed THROUGH, so the semantics can be measured with the rail's own
        // script rather than a reimplementation of it. Still null in the app
        // until the measurement says otherwise.
        absoluteQty: opts?.absoluteQty ?? null,
      },
    ),
  // The cart is addressed by productId, and the search returns skuId as the
  // same value. Nothing needs both, so requiring both would break this store
  // the way it broke Albertsons.
  writable: (c) => !!c.productId,
  /**
   * TWO ANSWERS, and the second is the one the run waits for.
   *
   * `early` settles the login gate the instant the localStorage read is done --
   * no budget of ours may make a signed-in user wait to be told they are signed
   * in. But a run needs the cart, the cart needs a bearer, and the bearer is in
   * an encrypted MSAL cache. `cartCapable` is the probe having actually used
   * one, so it is what lets the run start.
   *
   * Exactly the shape Albertsons taught us, for a different reason.
   */
  sessionUsable: (msg) => !(msg as { early?: boolean }).early,
  // No preference concept on this store.
  needsPreference: () => false,
  // MEASURED 2026-09-02: Algolia 13ms filtered, 26ms not. Nothing here shows the
  // Albertsons cold-start, so the budgets are the tighter H-E-B shape.
  budgets: {
    sessionMs: 15_000,
    // Base above the 12s per-request budget below, for the same reason as
    // Walmart's: at 10_000 a single-term search deadlined at 11.5s over a
    // request allowed 12s.
    searchMs: (terms) => Math.min(15_000 + terms * 1_500, 45_000),
    searchResumeMs: 15_000,
    addMs: (items) => Math.min(30_000 + items * 3_000, 120_000),
    cartProbeMs: 15_000,
    searchRequestMs: 12_000,
    searchFirstRequestMs: 12_000,
  },
};
