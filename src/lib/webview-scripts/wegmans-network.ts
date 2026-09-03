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

  WG.tokenFromCache = async function () {
    if (!window.crypto || !window.crypto.subtle) return null;
    var raw = null;
    var parts = document.cookie.split(';');
    for (var p = 0; p < parts.length; p++) {
      var t = parts[p].replace(/^ +/, '');
      if (t.indexOf('msal.cache.encryption') === 0) { raw = t.slice(t.indexOf('=') + 1); break; }
    }
    if (!raw) return null;
    var meta;
    try { meta = JSON.parse(decodeURIComponent(raw)); } catch (e) { return null; }
    if (!meta || !meta.key) return null;
    var base;
    try {
      base = await window.crypto.subtle.importKey('raw', WG.b64(meta.key), 'HKDF', false, ['deriveKey']);
    } catch (e) { return null; }
    var ids = WG.clientIds();
    var best = null;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || k.indexOf('msal') < 0) continue;
      var j;
      try { j = JSON.parse(localStorage.getItem(k) || ''); } catch (e) { continue; }
      if (!j || !j.data || !j.nonce) continue;
      // THE CONTEXT COMES OUT OF THE KEY ITSELF.
      //
      // MSAL's getContext returns its clientId when the storage key contains
      // it, and window.msal.clientIds is where the shop app publishes those --
      // but the rail runs on robots.txt, where no site code has run and that
      // global does not exist. Reading it from there meant an empty context for
      // every entry, the wrong derived key every time, and no token at all.
      //
      // The clientId is a UUID inside the key. Try each one the key carries,
      // and the empty context for entries that carry none.
      var ctxs = WG.uuidsIn(k);
      for (var q = 0; q < ids.length; q++) { if (ids[q] && k.indexOf(ids[q]) >= 0) ctxs.unshift(ids[q]); }
      ctxs.push('');
      for (var ci = 0; ci < ctxs.length; ci++) {
        try {
          var dk = await window.crypto.subtle.deriveKey(
            { name: 'HKDF', salt: WG.b64(j.nonce), hash: 'SHA-256', info: new TextEncoder().encode(ctxs[ci]) },
            base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
          var pt = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(12) }, dk, WG.b64(j.data));
          var o = JSON.parse(new TextDecoder().decode(pt));
          if (!o || o.credentialType !== 'AccessToken' || !o.secret) break;
          // The commerce API's own audience, not any token the app happens to hold.
          if (String(o.target || '').indexOf('wegmans.cloud') < 0) break;
          var left = Number(o.expiresOn || 0) - Math.floor(Date.now() / 1000);
          if (left < 60) break;
          if (!best || left > best.left) best = { secret: o.secret, left: left };
          break;
        } catch (e) { /* wrong context for this entry; try the next */ }
      }
    }
    if (!best) return null;
    WG.cacheToken(best.secret);
    return best.secret;
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
  };
  WG.versioned = function (path) {
    if (path.indexOf('api-version=') >= 0) return path;
    var base = path.split('?')[0];
    var v = WG.API_VERSION[base] || '2024-03-06-preview';
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'api-version=' + v;
  };

  WG.commerce = async function (path, tok, init, budgetMs) {
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
      return { ok: false, why: 'no_response', ms: Date.now() - t0 };
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
    var tok0 = WG.cachedToken();
    if (!tok0) { try { tok0 = await WG.tokenFromCache(); } catch (e) { tok0 = null; } }
    var stores = await WG.findStoreNumber(tok0, 10000);
    var storeNumber = null;
    for (var sx = 0; sx < stores.length; sx++) if (stores[sx] && stores[sx].v) { storeNumber = String(stores[sx].v); break; }

    if (!accounts) {
      // DEFINITIVE, and cheap: MSAL keeps this list whether or not the
      // credential cache is readable.
      post({ ok: true, loggedIn: false, source: 'msal', storeTries: stores });
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
      isWeightItem: !!h.isSoldByWeight,
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
    var tok = WG.cachedToken();
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
    { reason: 'qty_semantics_unproven' },
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
    var rows = [];
    var cartId = cart.id || null;
    if (!cartId) { try { cartId = (r.data && (r.data.cartId || r.data.id)) || null; } catch (e) {} }
    for (var i2 = 0; i2 < lines.length; i2++) {
      var li = lines[i2] || {};
      // variant.sku — the ONLY id a cart line shares with a search result.
      var id = WG.lineSku(li);
      var q = Number(li.quantity != null ? li.quantity : (li.qty != null ? li.qty : 1));
      if (!(q > 0)) q = 1;
      if (id) held[id] = (held[id] || 0) + q;
      rows.push({ name: WG.lineName(li, id), qty: q, itemId: id, available: true });
    }
    return { cartId: cartId ? String(cartId) : null, held: held, rows: rows,
             version: cart.version != null ? cart.version : null };
  };

  try {
    WG.watchForToken();
    var tok = WG.cachedToken();
    if (!tok) {
      for (var n = 0; n < ITEMS.length; n++) report(ITEMS[n], false, 'no_token', 'no bearer for the commerce API');
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, why: 'no_token' });
      return;
    }

    var before = KNOWN ? { cartId: null, held: KNOWN, rows: [] } : await readCart(tok);
    if (!before) {
      for (var z = 0; z < ITEMS.length; z++) report(ITEMS[z], false, 'no_cart', 'could not read the cart to baseline against');
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0 });
      return;
    }

    var list = [];
    var planned = [];
    for (var i = 0; i < ITEMS.length; i++) {
      var it = ITEMS[i];
      var have = Number(before.held[it.productId] || 0);
      var want = Math.max(1, Math.round(it.quantity || 1));
      if (have > 0 && ABSOLUTE !== true) {
        report(it, false, 'qty_semantics_unproven',
               'the cart already holds ' + have + ' of this and it is not yet measured whether this store SETS or ADDS the quantity');
        continue;
      }
      list.push({ productId: it.productId, skuId: it.skuId || it.productId, quantity: have + want });
      planned.push({ it: it, want: want, sent: have + want });
    }
    if (!list.length) { post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0 }); return; }

    var path = '/commerce/cart/carts/' + (before.cartId ? before.cartId + '/' : '') + '${opts.itemsPath ?? 'items'}';
    var res = await WG.commerce(path, tok, { method: 'POST', body: JSON.stringify({ items: list }) }, 25000);
    if (!res.ok) {
      for (var f = 0; f < planned.length; f++) report(planned[f].it, false, 'write_refused',
        res.why + (res.status ? ' ' + res.status : '') + (res.detail ? ': ' + res.detail : ''));
      post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, why: res.why, status: res.status || null,
             triedPath: path });
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
           cartBefore: before.rows, cartAfter: after ? after.rows : [],
           cartLines: after ? after.rows.length : null, ms: res.ms });
  } catch (e) {
    post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0, threw: String(e).slice(0, 140) });
  }
})(); true;`;
}
