// Albertsons network rail — search and add over the store's own REST API.
//
// The shape of this file mirrors heb-network-search.ts on purpose: same message
// types, same candidate fields, same "the caller cannot tell where a candidate
// came from" rule. What is NOT shared is the transport. H-E-B is GraphQL; this
// is REST behind Azure API Management, so none of the query text carries over —
// only the method.
//
// MEASURED 2026-08-31 (MEAL-194, MEAL-204). The three things that shaped it:
//
//   1. `qty` on the add SETS the line, it does not increment it. Sending the
//      recipe's quantity against a cart that already holds the item silently
//      REDUCES what the user had. Every write here is base + wanted, where base
//      comes from a cart read, never from a card label.
//   2. A repeat of the identical write is idempotent, so a retry after an
//      ambiguous response is safe. That is why the verify step can re-read
//      rather than having to guess.
//   3. HTTP 200 does not mean the search succeeded. The envelope is per-section:
//      a failed search still returns 200 with primaryProducts.appCode "400" and
//      NO docs array. Treating that as "no products" is what makes the app tell
//      a user their groceries do not exist (MEAL-207), so it is a hard failure
//      here, never an empty result.
//
// Auth differs per operation, which is easy to get wrong:
//   search -> Ocp-Apim-Subscription-Key only, from searchConfig.apimProgramSubscriptionKey
//   cart   -> Authorization: Bearer <SWY_SHOP_TOKEN> AND a subscription key
// Keys are read from the page's own SWY.CONFIGSERVICE at runtime and never
// hardcoded — they are the store's credentials, they rotate, and a stale copy
// compiled into the app would fail closed for every user at once.

export const ALB_SEARCH_PATH = '/abs/pub/xapi/pgmsearch/v1/search/products';
/**
 * The PLAIN product search, which is a different service from the one above.
 *
 * pgmsearch is the *program* search: it also resolves offers, sponsored
 * carousels, merch banners and past-purchase personalisation, none of which we
 * read. The site uses this lighter path for its own "more results" calls.
 * Config: apimSearchProductsAPIPath, keyed by searchConfig.apimSubscriptionKey
 * rather than apimProgramSubscriptionKey.
 */
export const ALB_PLAIN_SEARCH_PATH = '/abs/pub/xapi/search/products';
export const ALB_CART_ITEMS_PATH = '/abs/pub/erums/cartservice/api/v2/cart/items';
/**
 * READING the cart is a different call from writing to it.
 *
 * GET /cart/items is not a read endpoint -- the service routes it as
 * /cart/{id} and answers, in its own words:
 *
 *   {"title":"Bad Request","status":400,
 *    "detail":"Failed to convert 'id' with value: 'items'",
 *    "instance":"/osms-cartservice/api/v2/cart/items"}
 *
 * /cart/items is the WRITE endpoint (the site POSTs to it, and so do we). The
 * read is POST /cart/customer/{customerId}?type=full, which is what the site's
 * own cart service calls on load. customerId comes from the userinfo endpoint
 * the login probe already reads.
 */
export const ALB_CART_CUSTOMER_PATH = '/abs/pub/erums/cartservice/api/v2/cart/customer/';

/**
 * Shared preamble: resolves session facts and API keys once and parks them on
 * window.__mealioAlb so the search and add scripts injected after it do not each
 * have to rediscover them.
 *
 * The cart key is resolved by PROBING the candidate config fields rather than
 * naming one. The search key sits at a stable, identifiable field; the cart key
 * did not match any field we could name, and a rail that hardcodes the wrong
 * one fails with a 401 that looks exactly like a logged-out user. Probing costs
 * one cart read per run and cannot go stale.
 */
const ALB_PRELUDE = `
  var A = window.__mealioAlb = window.__mealioAlb || {};

  function __albCfg() {
    var C = (window.SWY && window.SWY.CONFIGSERVICE) || {};
    return { dp: C.datapowerConfig || {}, sc: C.searchConfig || {}, all: C };
  }

  // ASK THE SERVER, DO NOT WAIT FOR THE PAGE.
  //
  // MEASURED 2026-09-01 from the site's own bundles. window.AB.userInfo is not
  // something the page knows -- it is the parsed body of ONE cookie-authenticated
  // GET the page makes on boot:
  //
  //   AB.userInfoPath = '/bin/safeway/unified/userinfo?rand=<n>&banner=<banner>'
  //   $.get(AB.userInfoPath).done(AB.COMMON.processUserInfoFlow)
  //   processUserInfoFlow(a): !JSON.parse(a).SWY_SHOP_TOKEN -> expired session
  //                           otherwise -> mapUserInfo(JSON.parse(a))
  //   on 403                -> processUserInfoFlow('{}')
  //
  // and the store and zip come from a cookie the SERVER set, which is readable
  // the instant the document exists:
  //
  //   prepareSharedInfo(): JSON.parse(unescape(cookie SWY_SHARED_SESSION_INFO))
  //   mapSharedInfo(a):    branchId = a.info.SHOP.storeId
  //                        zipcode  = a.info.SHOP.zipcode
  //                        userType = a.info.COMMON.userType   ('C' or 'R')
  //
  // So every fact we need is one request and one cookie. Waiting for the page's
  // bootstrap to publish them was the whole problem: polling window.AB with
  // setTimeout put the answer behind the site's Angular + Next + ad bundles AND
  // behind Chromium's timer throttling in a WebView the user is not looking at.
  // Stephen's 22:10 run took 142 SECONDS to answer a question with no network in
  // it, while H-E-B -- which only ever fetches -- answered in 1.1 s from a hidden
  // WebView on the same device in the same minute.
  //
  // This is H-E-B's shape: one request, and its answer decides.
  function __albCookie(name) {
    try {
      var all = String(document.cookie || '').split(';');
      for (var i = 0; i < all.length; i++) {
        // NO REGEX HERE. This block is the body of a template literal, so a
        // backslash in it is eaten before the script is ever injected: a
        // whitespace class became a literal 's', which matches no leading space,
        // so only the FIRST cookie in the header could ever be found. trim() has
        // nothing to escape. (Same trap as backticks in these scripts.)
        var c = all[i];
        var eq = c.indexOf('=');
        if (eq <= 0) continue;
        if (c.slice(0, eq).trim() !== name) continue;
        return c.slice(eq + 1);
      }
    } catch (e) {}
    return '';
  }

  /** The server-set session cookie: store, zip and customer type. Synchronous. */
  function __albShared() {
    var raw = __albCookie('SWY_SHARED_SESSION_INFO');
    if (!raw) return {};
    var txt = raw;
    try { txt = decodeURIComponent(raw); } catch (e) {
      try { txt = unescape(raw); } catch (e2) { txt = raw; }
    }
    var j = null;
    try { j = JSON.parse(txt); } catch (e) { return {}; }
    var info = (j && j.info) || {};
    var shop = info.SHOP || {}, common = info.COMMON || {};
    return {
      storeId: shop.storeId != null ? String(shop.storeId) : '',
      zipcode: shop.zipcode != null ? String(shop.zipcode) : '',
      // 'C' or 'R' is the site's own test for a signed-in customer.
      userType: common.userType != null ? String(common.userType) : '',
      preference: common.preference != null ? String(common.preference) : '',
    };
  }

  // PICKUP OR DELIVERY IS NOT OURS TO ASSUME.
  //
  // The site derives both the cart's serviceType and the search's channel from
  // info.COMMON.preference in the session cookie:
  //   serviceType = 'dug' === preference.toLowerCase() ? 'Dug' : 'Delivery'
  // We hardcoded 'Dug' and 'pickup'. A delivery shopper therefore got every cart
  // request built for a cart that is not theirs -- and the cart endpoint answered
  // 400 all evening.
  function __albPreference() {
    var pref = String(__albShared().preference || '').toLowerCase();
    if (pref === 'delivery') return { serviceType: 'Delivery', channel: 'delivery', context: 'delivery' };
    if (pref === 'instore') return { serviceType: 'Dug', channel: 'instore', context: 'instore' };
    // 'dug', empty, or anything unrecognised: pickup is the safe default and is
    // what the site falls back to as well.
    return { serviceType: 'Dug', channel: 'pickup', context: 'pickup' };
  }

  function __albBanner() {
    try {
      var c = (window.SWY && window.SWY.CONFIGSERVICE) || null;
      if (c && typeof c.getResolvedBanner === 'function') {
        var b = c.getResolvedBanner();
        if (typeof b === 'string' && b) return b;
      }
    } catch (e) {}
    // The host IS the banner -- www.albertsons.com -> albertsons, www.safeway.com
    // -> safeway. The site's own analytics derives it exactly this way, and it
    // needs no part of the bootstrap, which is the point.
    var h = String((window.location && window.location.hostname) || '').split('.');
    return h.length > 1 ? h[h.length - 2] : 'albertsons';
  }

  async function __albFetchUserInfo(budgetMs) {
    var ctl = new AbortController();
    // A backstop, not the mechanism. Timers are the thing that gets throttled in
    // a backgrounded WebView, so nothing here DEPENDS on this firing on time --
    // the fetch settles on its own.
    var to = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, budgetMs || 8000);
    try {
      var url = '/bin/safeway/unified/userinfo?rand=' + Math.floor(1e6 * Math.random())
        + '&banner=' + encodeURIComponent(__albBanner());
      var r = await fetch(url, {
        credentials: 'include',
        headers: { 'accept': 'text/plain, application/json, */*' },
        signal: ctl.signal,
      });
      clearTimeout(to);
      // The site treats 403 here as signed out -- it calls processUserInfoFlow('{}').
      if (r.status === 401 || r.status === 403) return { state: 'out', status: r.status };
      if (r.status !== 200) return { state: 'unknown', why: 'http', status: r.status };
      var txt = await r.text();
      var j = null;
      try { j = JSON.parse(txt); } catch (e) { return { state: 'unknown', why: 'unparseable', status: r.status }; }
      // A 200 with no token IS the expired-session answer: the site responds to
      // it by tearing the user's session down.
      if (!j || !j.SWY_SHOP_TOKEN) return { state: 'out', status: r.status };
      return { state: 'in', user: j, status: r.status };
    } catch (e) {
      clearTimeout(to);
      var abort = !!(e && e.name === 'AbortError');
      return { state: 'unknown', why: abort ? 'timeout' : 'network', detail: String(e).slice(0, 120) };
    }
  }

  /**
   * The session, however we can get it. Parks the result on A.user so every
   * script injected after this one reads it without asking again.
   *
   * Returns { state: 'in' | 'out' | 'unknown', ... }.
   */
  async function __albResolveUser(budgetMs) {
    if (A.user && A.user.SWY_SHOP_TOKEN && A.user.branchId) return { state: 'in', user: A.user, cached: true };
    // Free when the page HAS finished booting -- most injections after the first.
    var page = (window.AB && window.AB.userInfo) || null;
    if (page && page.SWY_SHOP_TOKEN && page.branchId) { A.user = page; return { state: 'in', user: page, fromPage: true }; }
    var shared = __albShared();
    var got = await __albFetchUserInfo(budgetMs);
    if (got.state !== 'in') return got;
    var u = got.user || {};
    A.user = {
      SWY_SHOP_TOKEN: u.SWY_SHOP_TOKEN,
      customerId: u.customerId != null ? u.customerId : null,
      firstName: typeof u.firstName === 'string' ? u.firstName : '',
      UUID: u.UUID != null ? u.UUID : null,
      // The endpoint carries the customer; the cookie carries the store. Neither
      // knows both, which is why the page merges them and so do we.
      branchId: shared.storeId || (page && page.branchId) || '',
      zipcode: shared.zipcode || (page && page.zipcode) || '',
      userType: shared.userType || (u.userType != null ? String(u.userType) : ''),
    };
    return { state: 'in', user: A.user, fetched: true, hasStore: !!A.user.branchId };
  }

  function __albUser() {
    return A.user || (window.AB && window.AB.userInfo) || {};
  }

  function __albSearchKey() {
    if (A.searchKey) return A.searchKey;
    var c = __albCfg();
    return c.sc.apimProgramSubscriptionKey || c.dp.xapiSubscriptionKey || null;
  }

  /** The plain /search/products service takes a DIFFERENT subscription key. */
  function __albPlainSearchKey() {
    if (A.plainKey) return A.plainKey;
    var c = __albCfg();
    return c.sc.apimSubscriptionKey || null;
  }

  // THE KEYS ARE IN THE PAGE'S HTML, NOT ONLY IN ITS RUNTIME.
  //
  // window.SWY.CONFIGSERVICE is built by an inline SWY.CONFIGSERVICE.init('{...}')
  // in every store page, so a script injected before that runs sees no keys at
  // all -- 'no_search_key' for every term and 'rail_read_no_key' for the cart,
  // which is exactly what a run that skipped the login check hit on the device
  // at 22:49. Same shape as the login bug: we were waiting for the page to
  // finish telling itself something the server had already sent.
  //
  // So when the runtime has not got there yet, read the document instead. It is
  // the page the WebView is already sitting on, so it comes from the HTTP cache.
  // Nothing is hardcoded -- these rotate, and a copy compiled into the app would
  // fail closed for every user at once.
  async function __albEnsureKeys(budgetMs) {
    if (A.searchKey || (A.keyCandidates && A.keyCandidates.length)) return;
    var fromPage = __albCfg().sc.apimProgramSubscriptionKey;
    if (fromPage) return;                       // the runtime has it; use it
    var ctl = new AbortController();
    var to = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, budgetMs || 8000);
    var html = '';
    try {
      var r = await fetch('/', { credentials: 'include', signal: ctl.signal });
      clearTimeout(to);
      if (r.status !== 200) return;
      html = await r.text();
    } catch (e) { clearTimeout(to); return; }
    // Found by INDEX then a class with nothing to escape. A backslash written
    // here is eaten by the template literal before the script is injected, so
    // \\s would have shipped as a literal 's' and matched nothing -- which is how
    // this file has already broken twice today.
    var kIdx = html.indexOf('"apimProgramSubscriptionKey"');
    if (kIdx >= 0) {
      var kM = html.slice(kIdx, kIdx + 160).match(/[0-9a-f]{32}/);
      if (kM) A.searchKey = kM[0];
    }
    var pIdx = html.indexOf('"apimSubscriptionKey"');
    if (pIdx >= 0) {
      var pM = html.slice(pIdx, pIdx + 160).match(/[0-9a-f]{32}/);
      if (pM) A.plainKey = pM[0];
    }
    // The cart key is not at a field we can name -- that is why the rail PROBES
    // candidates. Same probe, sourced from the document: every 32-hex value,
    // with the ones sitting near erumsConfig first, because that is the service
    // the cart lives under.
    var all = html.match(/[0-9a-f]{32}/g) || [];
    var near = [];
    // Named first, exactly as the runtime path does: the erums block in the page
    // is a JSON string whose keys have dots in them.
    var named = ['"cart.apim.key"', '"store.apim.key"', '"apim.key"', '"xapi.apim.key"'];
    for (var nn = 0; nn < named.length; nn++) {
      var at = html.indexOf(named[nn]);
      if (at < 0) continue;
      var hit = html.slice(at, at + 120).match(/[0-9a-f]{32}/);
      if (hit) near.push(hit[0]);
    }
    var e = html.indexOf('erumsConfig');
    if (e >= 0) near = near.concat(html.slice(e, e + 4000).match(/[0-9a-f]{32}/g) || []);
    var out = [], seen = {};
    for (var i = 0; i < near.length; i++) { if (!seen[near[i]]) { seen[near[i]] = 1; out.push(near[i]); } }
    for (var k = 0; k < all.length && out.length < 12; k++) {
      if (!seen[all[k]]) { seen[all[k]] = 1; out.push(all[k]); }
    }
    A.keyCandidates = out;
  }

  // Every 32-hex value anywhere in the config, most-likely first. The cart key is
  // one of these; which one is not something the page tells us.
  function __albKeyCandidates() {
    if (A.keyCandidates && A.keyCandidates.length) return A.keyCandidates;
    var c = __albCfg(), out = [], seen = {};
    // The cart lives under /abs/pub/erums/, and its key is erumsConfig's — NOT
    // any of datapowerConfig's, all twelve of which answer 401. Measured on a
    // signed-in device 2026-09-01: erumsConfig.store.apim.key is the only value
    // in the whole config that the cart endpoint accepts.
    // THE FIELD NAMES ARE DOTTED STRINGS, NOT NESTED OBJECTS.
    //
    // The site builds this with SWY.CONFIGSERVICE.initErumsConfig('{...}') and
    // the JSON inside reads:
    //   "cart.apim.key":"...", "store.apim.key":"...", "apim.key":"...",
    //   "xapi.apim.key":"...", "cart.service.endpoint":"/abs/pub/erums/cartservice/api/v1"
    // so erumsConfig['cart.apim.key'] is ONE property with a dot in its name.
    // Reading it as er.store.apim.key -- which is what this did -- resolves to
    // undefined every time, and the cart fell back to sweeping every 32-hex
    // value in the config in arbitrary order.
    try {
      var er = c.all.erumsConfig || {};
      var named = ['cart.apim.key', 'store.apim.key', 'apim.key', 'xapi.apim.key'];
      for (var n = 0; n < named.length; n++) {
        var v0 = er[named[n]];
        if (typeof v0 === 'string' && !seen[v0]) { seen[v0] = 1; out.push(v0); }
      }
      // The old nested reading, kept in case a banner really does publish it
      // that way. Costs nothing when it is undefined.
      var direct = (er.store && er.store.apim && er.store.apim.key) || null;
      if (typeof direct === 'string' && !seen[direct]) { seen[direct] = 1; out.push(direct); }
    } catch (e) {}
    var preferred = ['cncSubscriptionKey', 'apimSubscriptionKey', 'xapiSubscriptionKey'];
    for (var i = 0; i < preferred.length; i++) {
      var v = c.dp[preferred[i]];
      if (typeof v === 'string' && !seen[v]) { seen[v] = 1; out.push(v); }
    }
    for (var sec in c.all) {
      var o = c.all[sec];
      if (!o || typeof o !== 'object') continue;
      for (var k in o) {
        var val = o[k];
        if (typeof val === 'string' && /^[0-9a-f]{32}$/i.test(val) && !seen[val]) { seen[val] = 1; out.push(val); }
      }
    }
    return out;
  }

  /** The WRITE endpoint. Unchanged: this one is a POST and it is correct. */
  function __albCartUrl() {
    var u = __albUser();
    return '${ALB_CART_ITEMS_PATH}'
      + '?storeId=' + encodeURIComponent(u.branchId || '')
      + '&serviceType=' + encodeURIComponent(__albPreference().serviceType)
      + '&zipCode=' + encodeURIComponent(u.zipcode || '')
      + '&cartCategoryList=1P,3P_MARKETPLACE,1P_Wine';
  }

  /** The READ endpoint. POST, keyed by customer, and NOT /cart/items. */
  function __albCartReadUrl() {
    var u = __albUser();
    return '${ALB_CART_CUSTOMER_PATH}' + encodeURIComponent(u.customerId || '')
      + '?type=full'
      + '&storeId=' + encodeURIComponent(u.branchId || '')
      + '&zipCode=' + encodeURIComponent(u.zipcode || '')
      + '&expressChk=true'
      + '&cartCategoryList=1P,3P_MARKETPLACE,1P_Wine,1P_B2B';
  }

  function __albCartHeaders(key) {
    var u = __albUser();
    return {
      'Authorization': 'Bearer ' + String(u.SWY_SHOP_TOKEN || ''),
      'ocp-apim-subscription-key': key,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      // The site's own HTTP interceptor sets this on EVERY erums/cartservice
      // request. We were the only client not sending it.
      'x-swy-client-id': 'web-portal',
      'Sort-Order': 'date'
    };
  }

  // ASK ONLY ONCE THE PAGE CAN ANSWER.
  //
  // window.AB.userInfo is filled by the site's own bootstrap, so a script
  // injected into a fresh document sees an EMPTY object rather than an absent
  // one. Every request below is built out of it: the URL carries the store and
  // the zip, the header carries the token. Built from {} that is
  // '?storeId=&zipCode=' with a bare 'Bearer ' -- which the gateway answers
  // with a 4xx, and which the caller then reads as "your cart could not be
  // read" when the truth is "we asked too early".
  //
  // Measured 2026-09-01: the before-run cart read is injected immediately after
  // the store page redirects, i.e. into exactly that empty window, and came
  // back rail_read_http. The session probe already waited for the token before
  // reading; nothing else did.
  // NO POLLING. The previous version waited for window.AB.userInfo in 250 ms
  // ticks, which is exactly the wrong instrument: setTimeout is what Chromium
  // throttles in a WebView nobody is looking at, so the wait outlived its own
  // budget by two minutes on the device. __albResolveUser asks the server
  // instead, and asks it once.
  async function __albAwaitUser(budgetMs) {
    var got = await __albResolveUser(budgetMs == null ? 8000 : budgetMs);
    if (got.state !== 'in') return null;
    var u = got.user || {};
    // The token alone cannot build the URL: it carries the store and the zip.
    return (u.SWY_SHOP_TOKEN && u.branchId) ? u : null;
  }

  // Reads the cart, and on the way resolves which subscription key the cart
  // accepts. Returns { ok, lines: { itemId: qty }, why }.
  async function __albReadCart(budgetMs, hydrateMs) {
    // Free when the caller already waited (the session probe does); the whole
    // budget only when we genuinely arrived before the page did.
    if (!(await __albAwaitUser(hydrateMs))) return { ok: false, why: 'not_hydrated' };
    await __albEnsureKeys(6000);
    var keys = A.cartKey ? [A.cartKey] : __albKeyCandidates();
    var lastStatus = null;
    for (var i = 0; i < keys.length; i++) {
      var ctl = new AbortController();
      var to = setTimeout(function () { ctl.abort(); }, budgetMs || 12000);
      var t0 = Date.now();
      try {
        var r = await fetch(__albCartReadUrl(), {
          method: 'POST', body: '{}',
          credentials: 'include', headers: __albCartHeaders(keys[i]), signal: ctl.signal
        });
        clearTimeout(to);
        A.lastReadMs = Date.now() - t0;
        A.lastReadTry = i + 1;
        lastStatus = r.status;
        if (r.status === 401 || r.status === 403) continue;
        if (r.status !== 200) {
          // The gateway names its own complaint in the body. Without it a 400 is
          // just "a request failed", which is where this sat for a day.
          var errText = '';
          try { errText = (await r.text()).slice(0, 200); } catch (e2) { errText = ''; }
          return { ok: false, why: 'http', status: r.status, detail: errText || null };
        }
        var j = await r.json();
        A.cartKey = keys[i];
        var cart = (j.carts || [])[0] || j || {};
        // The write endpoint answers with cartItemsList; the customer read has
        // been seen to use cartItems. Accept either rather than reporting an
        // empty cart, which would invite the reconcile to re-add everything.
        var lines = {}, rows = [], list = cart.cartItemsList || cart.cartItems || j.cartItems || [];
        for (var n = 0; n < list.length; n++) {
          var it = list[n];
          if (!it || it.itemId == null) continue;
          lines[String(it.itemId)] = Number(it.qty) || 0;
          // The same CartItem shape H-E-B's rail emits, so the done screen's
          // breakdown works identically on both stores — which is the point:
          // the user should not be able to tell which rail ran.
          if (it.name) rows.push({ name: String(it.name), qty: Number(it.qty) || 0 });
        }
        return { ok: true, lines: lines, rows: rows,
                 totalQty: (j.multiCartSummary || {}).totalAvailableQuantity };
      } catch (e) {
        clearTimeout(to);
        return { ok: false, why: 'threw', detail: String(e).slice(0, 80) };
      }
    }
    // No candidates at all is a different fact from candidates that were
    // refused. The first means we could not ask — the page carried no key, so
    // the config shape moved or the bundle had not finished loading. The second
    // means we asked and the token was rejected, which IS signed out. Collapsing
    // them would report a signed-in user as signed out on any config change.
    if (!keys.length) return { ok: false, why: 'no_key' };
    return { ok: false, why: 'auth', status: lastStatus };
  }
`;

/**
 * Session probe. Posts ALB_SESSION with what the rail needs to decide whether it
 * can run at all: a signed-in token, a store, and a search key.
 */
export function buildAlbertsonsSessionScript(): string {
  return `(async function () {
${ALB_PRELUDE}
  var post = function (o) {
    o.type = 'ALB_SESSION';
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };
  // IS THE DOCUMENT EVEN AWAKE? See the note in the search batch: a request that
  // reports 90s while its own 15s abort timer never fired was not slow, it was
  // FROZEN. This measures both -- what the page says about itself, and the real
  // gap between ticks of a one-second interval.
  var beat = { last: Date.now(), worst: 0, t0: Date.now() };
  try {
    setInterval(function () {
      var now = Date.now(), gap = now - beat.last;
      beat.last = now;
      if (gap > beat.worst) beat.worst = gap;
    }, 1000);
  } catch (e) {}
  var vis = function () { try { return document.visibilityState; } catch (e) { return null; } };
  try {
    // ONE REQUEST, AND ITS ANSWER DECIDES. See __albResolveUser for the evidence
    // this is built on -- the site's own bootstrap does exactly this and nothing
    // more, so there is nothing to wait for that we cannot ask for ourselves.
    //
    // The three previous versions of this probe all failed the same way, from
    // both directions, because they all read the PAGE:
    //   - stopped as soon as window.AB.userInfo had any keys -> a signed-in user
    //     reported signed out in 293 ms
    //   - waited for the token, then read the cart to confirm -> 17 s against a
    //     20 s deadline, so a signed-in user was reported signed out slowly
    //   - answered early from token + firstName -> and then Stephen's account
    //     turned out not to carry firstName at that moment, so the early answer
    //     never fired and the whole thing hung on an unreadable cart for 142 s
    // Reading the page was the mistake each time. This asks the server.
    var shared = __albShared();
    var got = await __albResolveUser(8000);

    if (got.state === 'out') {
      // DEFINITIVE. Not a guess from a DOM label and not the absence of
      // something: the endpoint that hands the site its session handed us a
      // signed-out answer, which is the same fact the site acts on.
      post({ ok: true, loggedIn: false, source: 'userinfo', status: got.status || null });
      return;
    }
    if (got.state !== 'in') {
      // A 5xx, a timeout, a network error. That says something about the
      // request, nothing about the user, so it is handed back rather than
      // guessed in either direction -- the caller runs the page check instead.
      post({ ok: false, why: got.why || 'unknown', status: got.status || null,
             detail: got.detail || null });
      return;
    }

    var u = got.user || {};
    var storeId = u.branchId ? String(u.branchId) : null;
    // ANSWER THE LOGIN QUESTION IMMEDIATELY. The cart read only ever refined it,
    // and no budget of ours should be able to make the sheet think a signed-in
    // user is signed out by not answering in time.
    post({
      ok: true, loggedIn: true, verified: false, early: true, source: 'userinfo',
      storeId: storeId, zipCode: u.zipcode ? String(u.zipcode) : null,
      uuid: u.UUID || null, shoppingContext: __albPreference().context,
      userType: u.userType || null,
      hasSearchKey: !!__albSearchKey(), cartReadable: null,
      vis: vis(), worstTickMs: beat.worst, sinceInjectMs: Date.now() - beat.t0,
    });
    if (!storeId) {
      // Signed in with no store on the session. The run cannot search or write
      // without one, and the answer above has already settled the login gate.
      return;
    }
    // AFTER the login answer, never before it. Resolving the API keys can cost
    // a document fetch, and on the device that pushed the whole probe past the
    // sheet's 25 s session deadline -- so the run fell back to the slow route
    // while holding a perfectly good session.
    await __albEnsureKeys(6000);

    // The refinement: does the token actually work? A read that succeeds proves
    // the add path; one that fails proves nothing about the user, only about us,
    // so it never downgrades the answer above -- it only labels it.
    var cart = await __albReadCart(6000);
    post({
      ok: true, loggedIn: true, verified: !!cart.ok, source: 'userinfo',
      storeId: storeId, zipCode: u.zipcode ? String(u.zipcode) : null,
      uuid: u.UUID || null, shoppingContext: __albPreference().context,
      userType: u.userType || null,
      hasSearchKey: !!__albSearchKey(),
      cartReadable: !!cart.ok,
      cartWhy: cart.ok ? null : (cart.why || null),
      cartStatus: (!cart.ok && cart.status) || null,
      cartMs: A.lastReadMs || null,
      sharedStore: shared.storeId || null,
      vis: vis(), worstTickMs: beat.worst, sinceInjectMs: Date.now() - beat.t0,
    });
  } catch (e) {
    post({ ok: false, why: 'threw', detail: String(e).slice(0, 120) });
  }
})(); true;`;
}

/** Maps one search doc to the candidate shape every reader in this app emits. */
const ALB_CANDIDATE_HELPERS = `
  function __albPrice(d) {
    var p = (typeof d.price === 'number') ? d.price : null;
    if (p == null) return null;
    return '$' + p.toFixed(2);
  }

  // sellByWeight is the signal, NOT unitOfMeasure. A 14 OZ tub of guacamole has
  // unitOfMeasure 'OZ' and is still sold as an item — reading the package unit as
  // a weight flag would decline most of the store. Across a real result set every
  // doc read 'I' (sold by item), so anything else is treated as sold by weight:
  // declining an item we cannot price is recoverable, silently writing a quantity
  // to a weight line is not.
  function __albIsWeight(d) {
    var s = d.sellByWeight;
    if (typeof s !== 'string' || !s) return false;
    return s.toUpperCase() !== 'I';
  }

  function __albCandidates(docs) {
    var out = [];
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || !d.name) continue;
      var id = d.pid != null ? String(d.pid) : (d.id != null ? String(d.id) : null);
      if (!id) continue;
      out.push({
        productName: String(d.name),
        imageUrl: d.imageUrl || null,
        // inventoryAvailable is a string flag; status goes 'active' / otherwise.
        outOfStock: String(d.inventoryAvailable) !== '1'
          || (typeof d.status === 'string' && d.status.toLowerCase() !== 'active'),
        preferences: null,
        price: __albPrice(d),
        isWeightItem: __albIsWeight(d),
        weightOptions: [],
        productId: id,
        // Albertsons addresses cart lines by itemId alone — there is no second
        // sku identifier, so this stays null rather than echoing productId and
        // implying a distinction that does not exist.
        skuId: null,
        // The store's own per-item cap. The write sets an ABSOLUTE quantity, so
        // held + wanted can exceed it and the store then refuses the whole write.
        maxOrderQuantity: (typeof d.maxPurchaseQty === 'number' && d.maxPurchaseQty > 0)
          ? d.maxPurchaseQty : null
      });
    }
    return out;
  }
`;

function albSearchUrlExpr(pageSize: number, storeId: number): string {
  return `
  // BUILT FROM THE SITE'S OWN mapProgramSearchParams, PARAMETER BY PARAMETER.
  //
  // Every term came back 200-with-appCode-400, "Search encountered a problem.
  // Please try again OSSR0033-R", the first time this rail ran on the device.
  // The site's list, in its order, is:
  //
  //   request-id url pageurl pagename rows start search-type storeid featured
  //   q sort timezone dvid channel [category-id] [pp] [pgm] includeOffer banner
  //
  // and its defaults are not the obvious ones -- sort and featured are the
  // EMPTY STRING, and timezone is a hardcoded 'America/Los_Angeles', not the
  // device's. uuid and visitorId are not part of this call at all; they came
  // from a different endpoint of theirs and we had carried them over.
  var __ALB_TZ = 'America/Los_Angeles';

  function __albSearchParams(term, variant) {
    var u = __albUser();
    var host = String((window.location && window.location.hostname) || 'www.albertsons.com');
    var p = new URLSearchParams();
    p.set('request-id', String(Math.floor(900 * Math.random() + 100))
      + String(Date.now()) + String(Math.floor(900 * Math.random() + 100)));
    p.set('url', host);
    p.set('pageurl', host);
    p.set('pagename', 'search');
    p.set('rows', '${pageSize}');
    p.set('start', '0');
    p.set('search-type', 'keyword');
    // THE SESSION'S STORE, NOT THE PAGE'S. The caller already validated this as
    // a positive integer and refused to build otherwise; reading it back off
    // window.AB meant a batch injected before the page had booted went out as
    // 'storeid=', which searches nothing and explains nothing.
    p.set('storeid', '${storeId}');
    p.set('featured', variant === 'legacy' ? 'true' : '');
    p.set('q', term);
    if (variant !== 'legacy') p.set('sort', '');
    p.set('timezone', variant === 'legacy' ? __albDeviceTz() : __ALB_TZ);
    p.set('dvid', 'web-4.1search');
    if (variant !== 'no_channel') p.set('channel', __albPreference().channel);
    if (variant !== 'no_pp') p.set('pp', 'true');
    p.set('includeOffer', 'true');
    p.set('banner', __albBanner());
    if (variant === 'legacy') {
      p.set('uuid', String(u.UUID || ''));
      p.set('visitorId', String(__albCookie('absVisitorId') || u.UUID || ''));
    }
    return p;
  }

  function __albDeviceTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || __ALB_TZ; } catch (e) { return __ALB_TZ; }
  }

  function __albSearchUrl(term, variant) {
    if (variant === 'plain') {
      // The site's own lighter call: no offers, no sponsored carousel, no
      // personalisation, and seven rows rather than thirty.
      var u = __albUser();
      var host = String((window.location && window.location.hostname) || 'www.albertsons.com');
      var pp = new URLSearchParams();
      pp.set('request-id', String(Math.floor(900 * Math.random() + 100))
        + String(Date.now()) + String(Math.floor(900 * Math.random() + 100)));
      pp.set('url', host);
      pp.set('pageurl', host);
      pp.set('pagename', 'search');
      pp.set('rows', '10');
      pp.set('start', '0');
      pp.set('search-type', 'keyword');
      pp.set('storeid', '${storeId}');
      pp.set('featured', 'true');
      pp.set('q', term);
      pp.set('channel', __albPreference().channel);
      pp.set('banner', __albBanner());
      return '${ALB_PLAIN_SEARCH_PATH}?' + pp.toString();
    }
    return '${ALB_SEARCH_PATH}?' + __albSearchParams(term, variant).toString();
  }

  /** Each service has its own subscription key; sending the wrong one is a 401. */
  function __albKeyFor(variant) {
    return variant === 'plain' ? (__albPlainSearchKey() || __albSearchKey()) : __albSearchKey();
  }
`;
}

/**
 * Search every term from one page, posting a SEARCH_RESULT per term.
 *
 * Concurrency is capped low and defaults lower than H-E-B's. The Albertsons
 * search operation degrades under burst — MEAL-207 watched it go from healthy to
 * silently hanging to answering 200-with-an-error, and the parallel worker pool
 * firing several searches inside a second is the obvious suspect. Being slower
 * than we could be is the cheap side of that trade.
 */
/**
 * Read the cart, over the network, and answer as the cart PAGE would.
 *
 * __albReadCart already builds the rows; it was only ever called on the way to
 * doing something else. Offering it alone is what lets the sheet stop navigating
 * to the cart URL for its snapshots.
 */
export function buildAlbertsonsCartReadScript(): string {
  return `(async function () {
${ALB_PRELUDE}
  var post = function (o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };
  try {
    // THREE PLUS SIX, BECAUSE THE SHEET GIVES UP AT TEN.
    //
    // This read is the before-run and after-run snapshot, and the sheet stops
    // waiting for it after cartProbeMs (10 s). A twelve-second budget here could
    // never be spent -- the sheet had already moved on -- so the script's own
    // deadline is set inside the caller's, leaving the failure REPORTED rather
    // than merely abandoned.
    var cart = await __albReadCart(6000, 3000);
    if (!cart || !cart.ok) {
      // UNKNOWN, never zero -- a zero would tell the reconcile the cart is empty
      // and invite it to re-add everything already in it.
      var RAIL_READ_CODE = {
        no_key: 'rail_read_no_key', auth: 'rail_read_auth',
        http: 'rail_read_http', threw: 'rail_read_threw',
        not_hydrated: 'rail_read_not_hydrated',
      };
      var why = (cart && cart.why) || '';
      // CARRY THE STATUS. 'rail_read_http' on its own says a request failed and
      // nothing about why -- a 400 (we built the URL wrong) and a 500 (the store
      // is having a bad day) are the same line in the log, and one of them is
      // ours to fix. Status and detail are the store's own answer, never
      // anything of the user's.
      post({ type: 'CART_COUNT', count: null, source: 'network',
             reason: RAIL_READ_CODE[why] || 'rail_read_failed',
             status: (cart && cart.status) || null,
             ms: A.lastReadMs || null, tries: A.lastReadTry || null,
             detail: (cart && cart.detail) || null });
      return;
    }
    var rows = cart.rows || [];
    var count = 0;
    for (var i = 0; i < rows.length; i++) count += (rows[i].qty || 0);
    post({ type: 'CART_COUNT', count: count, items: rows, source: 'network',
           ms: A.lastReadMs || null, tries: A.lastReadTry || null });
  } catch (e) {
    post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_threw',
           detail: String(e).slice(0, 80) });
  }
})(); true;`;
}

export function buildAlbertsonsNetworkSearchBatchScript(
  terms: string[],
  opts: { storeId: string; pageSize?: number; concurrency?: number },
): string | null {
  const storeId = Number(opts.storeId);
  // "abc" | 0 would search store zero and return a plausible-looking empty result.
  if (!Number.isInteger(storeId) || storeId <= 0) return null;
  if (!terms.length) return null;
  const pageSize = opts.pageSize && opts.pageSize > 0 ? Math.min(opts.pageSize, 60) : 30;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 2, 3));
  return `(async function () {
${ALB_PRELUDE}
${ALB_CANDIDATE_HELPERS}
${albSearchUrlExpr(pageSize, storeId)}
  var TERMS = ${JSON.stringify(terms)};
  var post = function (o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };
  await __albEnsureKeys(6000);
  var key = __albSearchKey();
  if (!key) {
    for (var q = 0; q < TERMS.length; q++) {
      post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: TERMS[q], why: 'no_search_key' });
    }
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length });
    return;
  }
  // Free once anything has resolved the session, which the login probe already
  // has by this point in a run. Here so a batch injected into a fresh document
  // still carries the shopper's identifiers rather than blanks.
  await __albResolveUser(8000);

  // TWO SHAPES, NOT FIVE.
  //
  // The ladder started as a diagnostic -- 'Search encountered a problem, please
  // try again OSSR0033-R' names no parameter, so a rejected term was retried
  // through every shape that differed from the site's by one thing, and the one
  // that worked was reported. That question is answered now, and a five-deep
  // ladder is five requests per term against a service whose latency is the
  // complaint. What is left is the light service and the heavy one:
  //
  //   plain  /abs/pub/xapi/search/products     products only
  //   site   /abs/pub/xapi/pgmsearch/v1/...    + offers, sponsored, personalised
  //
  // Same result shape, so the fallback costs nothing but a second request, and
  // only on a term the light service refused.
  var VARIANTS = ['plain', 'site'];
  var winner = null;

  async function attempt(term, variant) {
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, 15000);
    var url = __albSearchUrl(term, variant);
    // MEASURED, NOT GUESSED. Stephen: "search and cart read are still extremely
    // slow... It is not acceptable to take several minutes." The device log
    // could show WHEN an answer arrived but not where the time went -- a slow
    // request and a starved JS thread look identical from outside. This is the
    // request's own clock.
    var t0 = Date.now();
    var r, txt;
    try {
      r = await fetch(url, {
        credentials: 'include', signal: ctl.signal,
        headers: { 'Ocp-Apim-Subscription-Key': __albKeyFor(variant), 'Accept': 'application/json' }
      });
      clearTimeout(to);
      txt = await r.text();
    } catch (e) {
      clearTimeout(to);
      return { why: 'no_response', url: url, ms: Date.now() - t0 };
    }
    var ms = Date.now() - t0;
    if (r.status !== 200) {
      // The gateway's own words. A 401 from us sending the wrong subscription
      // key and a 401 from the edge deciding we are a bot read identically
      // without this, and they need completely different fixes.
      return { why: 'http', status: r.status, url: url, ms: ms,
               detail: String(txt || '').slice(0, 160) };
    }
    var j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    if (!j) return { why: 'unparseable', url: url, ms: ms };
    var pp = j.primaryProducts || {};
    var resp = pp.response || null;
    if (!resp || !resp.docs) {
      return { why: 'search_error', url: url, ms: ms,
               appCode: pp.appCode != null ? String(pp.appCode).slice(0, 40) : null,
               detail: pp.appMsg != null ? String(pp.appMsg).slice(0, 90) : null };
    }
    return { ok: true, json: j, url: url, ms: ms, bytes: txt.length };
  }

  // IS THE PAGE EVEN AWAKE?
  //
  // A request that reports ms: 90415 while its own 15-second abort timer never
  // fired is not a slow server -- a timer that late means the document was
  // FROZEN, and Date.now() spans the freeze. Chromium throttles timers and can
  // suspend a document it considers hidden, and this WebView is rendered behind
  // the loading animation. document.visibilityState says so directly, and the
  // heartbeat measures the damage: the gap between ticks of a 1s interval IS
  // the throttle factor.
  var beat = { last: Date.now(), worst: 0 };
  try {
    setInterval(function () {
      var now = Date.now(), gap = now - beat.last;
      beat.last = now;
      if (gap > beat.worst) beat.worst = gap;
    }, 1000);
  } catch (e) {}

  function redact(url) {
    var q = String(url).split('?')[1];
    return q ? q.replace(/(uuid|visitorId|search-uid)=[^&]*/g, '$1=<redacted>').slice(0, 400) : null;
  }

  async function one(term) {
    var first = winner || VARIANTS[0];
    var got = await attempt(term, first);
    got.variant = first;
    if (!got.ok && got.why === 'search_error' && !winner) {
      // Only a REJECTED shape is worth re-shaping. A timeout or a 5xx is the
      // store having a bad minute and every variant would meet the same wall.
      for (var vi = 0; vi < VARIANTS.length; vi++) {
        if (VARIANTS[vi] === first) continue;
        var alt = await attempt(term, VARIANTS[vi]);
        alt.variant = VARIANTS[vi];
        if (alt.ok) {
          winner = VARIANTS[vi];
          post({ type: 'SEARCH_SHAPE_OK', source: 'network', variant: winner,
                 after: first, sentQuery: redact(alt.url) });
          got = alt;
          break;
        }
      }
    }
    var url = got.url;
    var j = got.json || null;
    if (!got.ok) {
      post({
        type: 'SEARCH_RESULT_FAILED', source: 'network', term: term, why: got.why,
        status: got.status != null ? got.status : null,
        appCode: got.appCode != null ? got.appCode : null,
        detail: got.detail != null ? got.detail : null,
        keyTail: (function () {
          // The LAST FOUR characters only, never the key. Enough to tell "we
          // sent the program key" from "we sent the plain one" or from "we sent
          // nothing", which is the whole question behind a 401.
          try { var k = __albKeyFor(got.variant || ''); return k ? String(k).slice(-4) : null; }
          catch (e) { return null; }
        })(),
        variant: winner || first, ms: got.ms != null ? got.ms : null,
        vis: (function () { try { return document.visibilityState; } catch (e) { return null; } })(),
        worstTickMs: beat.worst,
        sentQuery: redact(url)
      });
      return;
    }
    await handle(term, j, url);
  }

  /** Map an accepted response onto the candidate shape every reader here emits. */
  async function handle(term, j, url, got) {
    var pp = j.primaryProducts || {};
    var resp = pp.response || null;
    var docs = resp && resp.docs;
    // A real empty result -- docs present and genuinely zero-length -- IS a
    // result. The 200-with-appCode-400-and-no-docs case never reaches here; it
    // is a rejection, and attempt() has already re-shaped and reported it.
    post({
      type: 'SEARCH_RESULT', source: 'network', term: term,
      candidates: __albCandidates(docs || []),
      numFound: (resp && typeof resp.numFound === 'number') ? resp.numFound : null,
      ms: got ? got.ms : null, bytes: got ? got.bytes : null, variant: got ? got.variant : null,
      vis: (function () { try { return document.visibilityState; } catch (e) { return null; } })(),
      worstTickMs: beat.worst
    });
  }

  var next = 0;
  async function worker() {
    while (next < TERMS.length) {
      var i = next++;
      try { await one(TERMS[i]); }
      catch (e) {
        post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: TERMS[i],
               why: 'threw', detail: String(e).slice(0, 80) });
      }
    }
  }

  // The first term goes alone. MEAL-207 has this store's search degrading under
  // load, so opening with one request rather than two is cheap insurance. This
  // is Albertsons-specific: H-E-B had the same guard briefly on a misreading of
  // a stuck run, and it was removed once the cause turned out to be the page
  // navigating out from under the script.
  if (TERMS.length > 0) {
    try { await one(TERMS[0]); }
    catch (e) {
      post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: TERMS[0],
             why: 'threw', detail: String(e).slice(0, 80) });
    }
    next = 1;
  }

  var pool = [];
  for (var c = 0; c < ${concurrency}; c++) pool.push(worker());
  await Promise.all(pool);
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length });
})(); true;`;
}

/**
 * Write every chosen product into the cart.
 *
 * The whole design follows from `qty` being absolute. Every guard below exists
 * because the same guard had to be added to H-E-B after it produced a wrong cart
 * (network-rail-playbook section 4) — the difference is that here they were
 * written before the first user ever ran it.
 */
export function buildAlbertsonsNetworkAddBatchScript(
  items: Array<{
    idx: number;
    productId: string;
    quantity: number;
    name: string;
    isWeightItem?: boolean;
    maxOrderQuantity?: number | null;
  }>,
  opts?: { concurrency?: number },
): string | null {
  const usable = items.filter(
    (it) => it && it.productId && Number.isFinite(it.quantity) && it.quantity > 0,
  );
  if (!usable.length) return null;
  // Writes are serialised by default. They mutate one shared cart, and the
  // response of each carries the cart state the next one's baseline depends on.
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? 1, 2));
  return `(async function () {
${ALB_PRELUDE}
  var ITEMS = ${JSON.stringify(usable)};
  var post = function (o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };
  var report = function (it, ok, reason, detail) {
    post({
      type: 'NET_ADD_RESULT', idx: it.idx, name: it.name, productId: it.productId,
      ok: !!ok, reason: reason || null, detail: detail || null
    });
  };

  // Baseline. Without it every write is a guess, and a guess against absolute
  // quantity semantics overwrites whatever the user already had.
  var base = await __albReadCart(12000);
  if (!base.ok) {
    for (var b = 0; b < ITEMS.length; b++) report(ITEMS[b], false, 'no_cart_baseline', base.why || null);
    post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: 0 });
    return;
  }

  // Two ingredients can resolve to one product. set(base+q1) then set(base+q2)
  // lands base + max, not the sum, so they are coalesced into a single write
  // BEFORE anything is sent.
  var byId = {}, order = [];
  for (var i = 0; i < ITEMS.length; i++) {
    var it = ITEMS[i];
    var id = String(it.productId);
    if (!byId[id]) { byId[id] = { first: it, want: 0, members: [] }; order.push(id); }
    byId[id].want += Number(it.quantity) || 0;
    byId[id].members.push(it);
    if (byId[id].first.maxOrderQuantity == null && it.maxOrderQuantity != null) {
      byId[id].first.maxOrderQuantity = it.maxOrderQuantity;
    }
  }

  var wrote = 0;
  async function writeOne(id) {
    var g = byId[id];
    var members = g.members;
    var head = g.first;

    // A weight line takes a weight, not a count. Declining is the honest outcome.
    for (var m = 0; m < members.length; m++) {
      if (members[m].isWeightItem) {
        for (var n = 0; n < members.length; n++) report(members[n], false, 'weight_item_declined');
        return;
      }
    }

    var held = Number(base.lines[id] || 0);
    var want = held + g.want;

    var cap = (typeof head.maxOrderQuantity === 'number' && head.maxOrderQuantity > 0)
      ? head.maxOrderQuantity : null;
    if (cap != null && want > cap) {
      if (held >= cap) {
        for (var c1 = 0; c1 < members.length; c1++) {
          report(members[c1], false, 'quantity_limit_reached', 'cart already holds ' + held + ' of ' + cap);
        }
        return;
      }
      want = cap;
    }

    var body = JSON.stringify({
      preferenceList: [{ cartCategory: '1P_WINE' }],
      cartItemsList: [{ itemId: id, qty: want }],
      cartCategory: 'abs'
    });
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, 15000);
    var r = null;
    try {
      r = await fetch(__albCartUrl(), {
        method: 'POST', credentials: 'include',
        headers: __albCartHeaders(A.cartKey), body: body, signal: ctl.signal
      });
      clearTimeout(to);
    } catch (e) {
      clearTimeout(to);
      // The write is idempotent, so an unanswered request is genuinely unknown
      // rather than known-bad. Reconcile decides, not this script.
      for (var u1 = 0; u1 < members.length; u1++) report(members[u1], false, 'write_unresolved');
      return;
    }
    if (r.status !== 200) {
      for (var h1 = 0; h1 < members.length; h1++) report(members[h1], false, 'http', 'status ' + r.status);
      return;
    }

    // Verify from the response the write itself returns — it carries the whole
    // cart, so no extra round trip is needed to know what actually landed.
    var after = null;
    try { after = await r.json(); } catch (e) {}
    var got = null;
    try {
      var list = ((after.carts || [])[0] || {}).cartItemsList || [];
      for (var v = 0; v < list.length; v++) {
        if (String(list[v].itemId) === id) { got = Number(list[v].qty); break; }
      }
    } catch (e) {}
    if (got == null) {
      for (var s1 = 0; s1 < members.length; s1++) report(members[s1], false, 'unexpected_shape');
      return;
    }
    if (got !== want) {
      for (var s2 = 0; s2 < members.length; s2++) {
        report(members[s2], false, 'quantity_mismatch', 'asked ' + want + ', cart holds ' + got);
      }
      return;
    }
    base.lines[id] = got;
    wrote++;
    for (var ok1 = 0; ok1 < members.length; ok1++) report(members[ok1], true, null);
  }

  var next = 0;
  async function worker() {
    while (next < order.length) {
      var k = next++;
      try { await writeOne(order[k]); }
      catch (e) {
        var g = byId[order[k]];
        for (var t = 0; t < g.members.length; t++) report(g.members[t], false, 'threw', String(e).slice(0, 80));
      }
    }
  }
  var pool = [];
  for (var w = 0; w < ${concurrency}; w++) pool.push(worker());
  await Promise.all(pool);

  // One read after the writes, so the done screen can show what THIS run added
  // in green and what was already in the cart in grey — without loading the
  // cart page to find out. Same contract as the H-E-B rail.
  var afterCart = await __albReadCart(10000);
  post({ type: 'NET_ADD_DONE', count: ITEMS.length, wrote: wrote,
         cartBefore: base.rows || null,
         cartAfter: afterCart.ok ? (afterCart.rows || null) : null });
})(); true;`;
}
