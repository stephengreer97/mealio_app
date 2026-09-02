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
export const ALB_CART_ITEMS_PATH = '/abs/pub/erums/cartservice/api/v2/cart/items';

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

  function __albUser() {
    return (window.AB && window.AB.userInfo) || {};
  }

  function __albSearchKey() {
    var c = __albCfg();
    return c.sc.apimProgramSubscriptionKey || c.dp.xapiSubscriptionKey || null;
  }

  // Every 32-hex value anywhere in the config, most-likely first. The cart key is
  // one of these; which one is not something the page tells us.
  function __albKeyCandidates() {
    var c = __albCfg(), out = [], seen = {};
    // The cart lives under /abs/pub/erums/, and its key is erumsConfig's — NOT
    // any of datapowerConfig's, all twelve of which answer 401. Measured on a
    // signed-in device 2026-09-01: erumsConfig.store.apim.key is the only value
    // in the whole config that the cart endpoint accepts.
    try {
      var er = c.all.erumsConfig || {};
      var direct = (er.store && er.store.apim && er.store.apim.key) || null;
      if (typeof direct === 'string' && !seen[direct]) { seen[direct] = 1; out.push(direct); }
      var xa = (er.xapi && er.xapi.apim && er.xapi.apim.key) || null;
      if (typeof xa === 'string' && !seen[xa]) { seen[xa] = 1; out.push(xa); }
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

  function __albCartUrl() {
    var u = __albUser();
    return '${ALB_CART_ITEMS_PATH}'
      + '?storeId=' + encodeURIComponent(u.branchId || '')
      + '&serviceType=Dug'
      + '&zipCode=' + encodeURIComponent(u.zipcode || '')
      + '&cartCategoryList=1P,3P_MARKETPLACE,1P_Wine';
  }

  function __albCartHeaders(key) {
    var u = __albUser();
    return {
      'Authorization': 'Bearer ' + String(u.SWY_SHOP_TOKEN || ''),
      'ocp-apim-subscription-key': key,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Sort-Order': 'date'
    };
  }

  // Reads the cart, and on the way resolves which subscription key the cart
  // accepts. Returns { ok, lines: { itemId: qty }, why }.
  async function __albReadCart(budgetMs) {
    var keys = A.cartKey ? [A.cartKey] : __albKeyCandidates();
    var lastStatus = null;
    for (var i = 0; i < keys.length; i++) {
      var ctl = new AbortController();
      var to = setTimeout(function () { ctl.abort(); }, budgetMs || 12000);
      try {
        var r = await fetch(__albCartUrl(), {
          credentials: 'include', headers: __albCartHeaders(keys[i]), signal: ctl.signal
        });
        clearTimeout(to);
        lastStatus = r.status;
        if (r.status === 401 || r.status === 403) continue;
        if (r.status !== 200) return { ok: false, why: 'http', status: r.status };
        var j = await r.json();
        A.cartKey = keys[i];
        var cart = (j.carts || [])[0] || {};
        var lines = {}, rows = [], list = cart.cartItemsList || [];
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
  try {
    // MEAL-124's reason 1, which applies to this probe too: window.AB.userInfo is
    // populated by the AEM/Angular bootstrap, so before hydration the property is
    // ABSENT rather than empty. Reading that as "signed out" walls a signed-in
    // user every time we inject early — the exact bug that kept the token out of
    // the page login check.
    //
    // So absence and emptiness are answered differently. Wait a bounded time for
    // the bootstrap, then:
    //   userInfo present, no token -> genuinely signed out, say so
    //   userInfo never appeared    -> we do not know; hand the question back so
    //                                 the page path runs its own check rather
    //                                 than asserting anything about the user
    // WAIT FOR THE TOKEN, NOT MERELY FOR THE OBJECT.
    //
    // This loop used to stop as soon as userInfo had ANY keys, and then read a
    // missing token as "signed out". That is only sound if the bootstrap fills
    // userInfo in one go. If it publishes the object first and the auth fields a
    // moment later -- or fills non-auth fields first -- we break out early, see
    // no token, and wall a signed-in user. Measured 2026-09-01: the probe
    // answered in 293ms, far inside its own 5s budget, with ok:true
    // loggedIn:false, while Stephen was signed in.
    //
    // So it keeps waiting while the object is there but the token is not, and
    // only calls it signed out when the budget is spent. A genuinely signed-out
    // user costs the full wait once; a signed-in one stops the moment the token
    // lands.
    var u = null, sawUser = false;
    for (var t = 0; t < 20; t++) {
      var cand = (window.AB && window.AB.userInfo) || null;
      if (cand && Object.keys(cand).length) {
        sawUser = true;
        if (cand.SWY_SHOP_TOKEN) { u = cand; break; }
        u = cand;
      }
      await new Promise(function (r) { setTimeout(r, 250); });
    }
    if (!sawUser) { post({ ok: false, why: 'not_hydrated' }); return; }
    if (!u || !u.SWY_SHOP_TOKEN) {
      // Report WHICH keys were there, never their values. Without this the log
      // cannot tell "the user is signed out" from "the token moved or arrives
      // late", which is the whole question when this answer is wrong.
      var keys = [];
      try { keys = Object.keys(u || {}).slice(0, 25); } catch (e) {}
      post({ ok: true, loggedIn: false, userInfoKeys: keys, waitedMs: 5000 });
      return;
    }
    // "Present" and "usable" are not the same property — MEAL-137 measured this
    // token at a 45-minute life, and a dead one still sits on the page global.
    // So the cart read DECIDES; it does not merely accompany the answer.
    //
    // This was wrong once, and the way it failed is worth keeping: loggedIn was
    // set from the token alone and the cart result was reported beside it as
    // cartReadable, which nothing consumed. A stale token then read as signed in,
    // the run started, and the user — who was signed out — watched the sign-in
    // prompt get replaced by an automation loading the cart page.
    //
    // Three outcomes, and the middle one is the point:
    //   cart reads          -> signed in, and the add path provably works
    //   every key gets 401  -> the token is dead. That IS signed out
    //   anything else       -> a timeout or a 5xx says nothing about the user,
    //                          so answer "do not know" and let the caller fall
    //                          back rather than guess in either direction
    var cart = await __albReadCart(12000);
    // A FAILED CART READ IS NEVER PROOF THE USER IS SIGNED OUT.
    //
    // This was wrong in both directions before it was right. First the token
    // alone decided, so a dead token read as signed in and an automation started
    // under a signed-out user. Then the cart read decided, so OUR OWN inability
    // to call the cart — wrong subscription key, wrong params, a 5xx — read as
    // signed out and a signed-in user was sent to a login wall. That second one
    // shipped and was caught on the device: window.AB.userInfo carried a live
    // token and firstName "Stephen" while the probe reported loggedIn false.
    //
    // The rule that survives both: a cart read that SUCCEEDS proves the session
    // works. A cart read that fails proves nothing about the user, only about
    // us. So a present token plus a failed read is INCONCLUSIVE — hand it back
    // and let the page check decide, rather than asserting something we cannot
    // know from a request we could not make.
    // When the cart cannot be read we fall back to what the page itself says
    // about the user, rather than to the DOM login heuristic. On the device the
    // heuristic ALSO got it wrong on the same page — it read "Account menu Sign
    // in" while userInfo already carried a live token and firstName "Stephen",
    // because it ran mid-bootstrap. Falling back to it just swaps one wrong
    // answer for another.
    //
    // A token plus a name is a weaker signal than a cart read, and it is marked
    // as such (verified:false) so telemetry can tell the two apart. It is the
    // right way to be wrong: if the session is actually dead the run fails at
    // the first write and the user is told, which is recoverable. Reporting a
    // signed-in user as signed out blocks them from the app entirely, which is
    // not.
    if (!cart.ok) {
      var named = typeof u.firstName === 'string' && u.firstName.length > 0;
      if (!named) {
        post({ ok: false, why: 'cart_unreadable', detail: cart.why || null, tokenPresent: true });
        return;
      }
      post({
        ok: true, loggedIn: true, verified: false, cartWhy: cart.why || null,
        storeId: u.branchId ? String(u.branchId) : null,
        zipCode: u.zipcode ? String(u.zipcode) : null,
        uuid: u.UUID || null, shoppingContext: 'pickup',
        hasSearchKey: !!__albSearchKey(), cartReadable: false,
      });
      return;
    }
    post({
      ok: true,
      verified: true,
      loggedIn: true,
      storeId: u.branchId ? String(u.branchId) : null,
      zipCode: u.zipcode ? String(u.zipcode) : null,
      uuid: u.UUID || null,
      // Pickup and delivery price and stock differently, same as H-E-B.
      shoppingContext: 'pickup',
      hasSearchKey: !!__albSearchKey(),
      // Same fact as loggedIn now, kept because a device log that shows both is
      // how the next person sees WHY the verdict was what it was.
      cartReadable: !!cart.ok,
      cartWhy: cart.ok ? null : (cart.why || null)
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

function albSearchUrlExpr(pageSize: number): string {
  return `
  function __albSearchUrl(term) {
    var u = __albUser();
    var p = new URLSearchParams({
      q: term,
      storeid: String(u.branchId || ''),
      rows: '${pageSize}',
      start: '0',
      banner: 'albertsons',
      channel: 'pickup',
      dvid: 'web-4.1search',
      featured: 'true',
      includeOffer: 'true',
      pagename: 'search',
      pageurl: 'https://www.albertsons.com',
      pgm: 'merch-banner',
      pp: 'true',
      'search-type': 'keyword',
      timezone: 'America/Denver',
      url: 'https://www.albertsons.com',
      uuid: String(u.UUID || ''),
      visitorId: String(u.UUID || '')
    });
    // request-id is per call. Reusing one returned a stale error body in testing,
    // so it is generated fresh rather than carried.
    p.set('request-id', String(Math.floor(Math.random() * 1000)) + String(Date.now()));
    return '${ALB_SEARCH_PATH}?' + p.toString();
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
    var cart = await __albReadCart(12000);
    if (!cart || !cart.ok) {
      // UNKNOWN, never zero -- a zero would tell the reconcile the cart is empty
      // and invite it to re-add everything already in it.
      var RAIL_READ_CODE = {
        no_key: 'rail_read_no_key', auth: 'rail_read_auth',
        http: 'rail_read_http', threw: 'rail_read_threw',
      };
      var why = (cart && cart.why) || '';
      post({ type: 'CART_COUNT', count: null, source: 'network',
             reason: RAIL_READ_CODE[why] || 'rail_read_failed' });
      return;
    }
    var rows = cart.rows || [];
    var count = 0;
    for (var i = 0; i < rows.length; i++) count += (rows[i].qty || 0);
    post({ type: 'CART_COUNT', count: count, items: rows, source: 'network' });
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
${albSearchUrlExpr(pageSize)}
  var TERMS = ${JSON.stringify(terms)};
  var post = function (o) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  };
  var key = __albSearchKey();
  if (!key) {
    for (var q = 0; q < TERMS.length; q++) {
      post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: TERMS[q], why: 'no_search_key' });
    }
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: TERMS.length });
    return;
  }

  async function one(term) {
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, 15000);
    var r, txt;
    try {
      r = await fetch(__albSearchUrl(term), {
        credentials: 'include', signal: ctl.signal,
        headers: { 'Ocp-Apim-Subscription-Key': key, 'Accept': 'application/json' }
      });
      clearTimeout(to);
      txt = await r.text();
    } catch (e) {
      clearTimeout(to);
      // The operation stops answering entirely when the client is being shaped —
      // no status, no headers. That is not "no results".
      post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: term, why: 'no_response' });
      return;
    }
    if (r.status !== 200) {
      post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: term, why: 'http', status: r.status });
      return;
    }
    var j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    if (!j) { post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: term, why: 'unparseable' }); return; }

    var pp = j.primaryProducts || {};
    var resp = pp.response || null;
    var docs = resp && resp.docs;
    // THE TRAP: 200 with primaryProducts.appCode 400 and no docs array at all.
    // Reported as a failure so the caller can fall back or tell the truth,
    // because calling it an empty result is how a user is told the store does
    // not stock their groceries when the search simply broke.
    if (!docs) {
      post({
        type: 'SEARCH_RESULT_FAILED', source: 'network', term: term, why: 'search_error',
        appCode: pp.appCode != null ? String(pp.appCode).slice(0, 40) : null,
        detail: pp.appMsg != null ? String(pp.appMsg).slice(0, 90) : null
      });
      return;
    }
    // A real empty result — docs present and genuinely zero-length — IS a result.
    post({
      type: 'SEARCH_RESULT', source: 'network', term: term,
      candidates: __albCandidates(docs),
      numFound: (typeof resp.numFound === 'number') ? resp.numFound : null
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
