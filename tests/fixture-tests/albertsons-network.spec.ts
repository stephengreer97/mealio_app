// Albertsons over the network (MEAL-204).
//
// Two things are under test, and only one of them is "a request goes out".
//
// The first is that a network candidate is INDISTINGUISHABLE from one the page
// reader produces — same keys, same meanings — because the add gate, the review
// screen and the weight chooser all read that shape and must not be able to tell
// which path filled it.
//
// The second is the arithmetic. Albertsons' qty is ABSOLUTE (MEAL-194): the
// write sets the line rather than adding to it, so every guard here is protecting
// a cart the user already had. The cart stub below therefore implements SET
// semantics for real — a stub that accumulated would let a wrong script pass.

import {
  buildAlbertsonsNetworkAddBatchScript,
  buildAlbertsonsNetworkSearchBatchScript,
  buildAlbertsonsSessionScript,
  buildAlbertsonsCartReadScript,
} from '../../src/lib/webview-scripts/albertsons-network';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('albertsons');

/** One product as the search API returns it. */
function doc(over: Record<string, unknown> = {}) {
  return {
    name: 'Medium Hass Avocado',
    pid: '184040105',
    id: '184040105',
    upc: '0048404010501',
    price: 0.79,
    basePrice: 1.29,
    status: 'active',
    inventoryAvailable: '1',
    imageUrl: 'https://images.albertsons-media.com/is/image/ABS/184040105',
    // 'I' is sold-by-item. Every doc in a real result set read 'I'.
    sellByWeight: 'I',
    unitOfMeasure: 'EA',
    unitQuantity: 'EACH',
    maxPurchaseQty: 99,
    restrictedValue: '0',
    ...over,
  };
}

const found = (docs: unknown[], over: Record<string, unknown> = {}) => ({
  appCode: '[PS: 200]',
  appMsg: '[PS: Success.]',
  primaryProducts: {
    appCode: '[GR200#A-CT: 200] [PP: 200] [SD200]',
    response: { numFound: docs.length, start: 0, docs },
    ...over,
  },
});

/** The site's page context: the config the keys come from, and the user. */
const CONTEXT = [
  '(function () {',
  '  window.SWY = { CONFIGSERVICE: {',
  '    searchConfig: { apimProgramSubscriptionKey: "0123456789abcdef0123456789abcdef" },',
  '    datapowerConfig: { cncSubscriptionKey: "fedcba9876543210fedcba9876543210" } } };',
  '  window.AB = { userInfo: { SWY_SHOP_TOKEN: "tok", branchId: "161",',
  '    zipcode: "83713", UUID: "uuid-1", customerId: "cust-1" } };',
  '})(); true;',
].join('\n');

/** Search stub: one canned payload, and a record of what was asked. */
function searchStub(payload: unknown, opts: { status?: number; reject?: boolean } = {}) {
  return [
    '(function () {',
    '  window.__urls = [];',
    '  window.fetch = function (url) {',
    '    window.__urls.push(String(url));',
    opts.reject
      ? '    return Promise.reject(new Error("aborted"));'
      : [
        '    return Promise.resolve({',
        '      status: ' + String(opts.status ?? 200) + ',',
        '      text: function () { return Promise.resolve(' + JSON.stringify(JSON.stringify(payload)) + '); },',
        '    });',
      ].join('\n'),
    '  };',
    '})(); true;',
  ].join('\n');
}

/**
 * A cart that behaves like the real one: GET returns the lines, POST SETS the
 * quantity for an itemId and returns the whole cart back, exactly as Albertsons
 * does. Writes are recorded so a test can assert the NUMBER that was sent, which
 * is the whole point — base + wanted, not wanted.
 */
function cartStub(initial: Record<string, number>, opts: { getStatus?: number; override?: number } = {}) {
  return [
    '(function () {',
    '  window.__lines = ' + JSON.stringify(initial) + ';',
    '  window.__writes = [];',
    '  function cartBody() {',
    '    var list = [];',
    '    for (var k in window.__lines) list.push({ itemId: k, qty: window.__lines[k], name: "Item " + k });',
    '    return { carts: [{ cartItemsList: list }], multiCartSummary: { totalAvailableQuantity: list.length } };',
    '  }',
    '  window.fetch = function (url, init) {',
    // READ and WRITE are both POSTs now and differ by PATH: the read is
    // /cart/customer/{id}?type=full, the write is /cart/items. Routing on the
    // method — which this stub used to do — makes a read look like a write.
    '    if (String(url).indexOf("/cart/customer/") !== -1) {',
    '      return Promise.resolve({ status: ' + String(opts.getStatus ?? 200) + ',',
    '        text: function () { return Promise.resolve("nope"); },',
    '        json: function () { return Promise.resolve(cartBody()); } });',
    '    }',
    '    var body = JSON.parse(init.body);',
    '    var line = body.cartItemsList[0];',
    '    window.__writes.push({ itemId: line.itemId, qty: line.qty });',
    // SET, not add — this is the behaviour MEAL-194 measured.
    '    window.__lines[line.itemId] = ' +
      (opts.override !== undefined ? String(opts.override) : 'line.qty') + ';',
    '    return Promise.resolve({ status: 200, json: function () { return Promise.resolve(cartBody()); } });',
    '  };',
    '})(); true;',
  ].join('\n');
}

const REPORT = [
  '(function () {',
  '  window.ReactNativeWebView.postMessage(JSON.stringify({',
  '    type: "PROBE", writes: window.__writes || [], urls: window.__urls || [],',
  '    lines: window.__lines || null }));',
  '})(); true;',
].join('\n');

const searchScript = (terms: string[]) =>
  buildAlbertsonsNetworkSearchBatchScript(terms, { storeId: '161' })!;

describe('Albertsons search over the network', () => {
  itWithFixture('search-results-tortillas.html', 'emits the candidate shape every reader in the app emits', async (runner) => {
    await runner.inject(CONTEXT);
    await runner.inject(searchStub(found([doc()])));
    await runner.inject(searchScript(['avocado']));
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000);
    expect(msg.source).toBe('network');
    expect(msg.candidates).toEqual([{
      productName: 'Medium Hass Avocado',
      imageUrl: 'https://images.albertsons-media.com/is/image/ABS/184040105',
      outOfStock: false,
      preferences: null,
      price: '$0.79',
      isWeightItem: false,
      weightOptions: [],
      productId: '184040105',
      // Albertsons addresses a line by itemId alone; echoing it here would imply
      // a second identifier that does not exist.
      skuId: null,
      maxOrderQuantity: 99,
    }]);
  });

  itWithFixture('search-results-tortillas.html', 'a 200 whose envelope says the search FAILED is a failure, never an empty result', async (runner) => {
    await runner.inject(CONTEXT);
    // The exact shape the live API returns when it breaks: HTTP 200, the outer
    // envelope claims success, and primaryProducts carries a 400 with no docs.
    await runner.inject(searchStub({
      appCode: '[PS: 200]', appMsg: '[PS: Success.]',
      primaryProducts: { appCode: '400', appMsg: 'Search encountered a problem. Please try again OSSR0033-R' },
    }));
    await runner.inject(searchScript(['avocado']));
    const msg = await runner.waitForMessage('SEARCH_RESULT_FAILED', 15_000);
    expect(msg.why).toBe('search_error');
    expect(msg.appCode).toBe('400');
    expect(String(msg.detail)).toContain('OSSR0033-R');
  });

  itWithFixture('search-results-tortillas.html', 'a genuinely empty docs array IS a result — the store simply has nothing', async (runner) => {
    await runner.inject(CONTEXT);
    await runner.inject(searchStub(found([])));
    await runner.inject(searchScript(['xyzzy']));
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000);
    expect(msg.candidates).toEqual([]);
    expect(msg.numFound).toBe(0);
  });

  itWithFixture('search-results-tortillas.html', 'an unanswered request is reported, not treated as no results', async (runner) => {
    await runner.inject(CONTEXT);
    await runner.inject(searchStub(null, { reject: true }));
    await runner.inject(searchScript(['avocado']));
    const msg = await runner.waitForMessage('SEARCH_RESULT_FAILED', 15_000);
    expect(msg.why).toBe('no_response');
  });

  itWithFixture('search-results-tortillas.html', 'reads sellByWeight, not the package unit, for weight items', async (runner) => {
    await runner.inject(CONTEXT);
    await runner.inject(searchStub(found([
      // A 14 OZ tub is sold BY ITEM. Reading unitOfMeasure as a weight flag
      // would decline most of the store.
      doc({ pid: '1', name: 'Guacamole Mild - 14 OZ', unitOfMeasure: 'OZ', unitQuantity: 'OUNCE', sellByWeight: 'I' }),
      // Loose bananas: 'W' AND displayType '3' is the site's own test for a
      // line it prices by the pound.
      doc({ pid: '2', name: 'Bananas', sellByWeight: 'W', displayType: '3' }),
    ])));
    await runner.inject(searchScript(['avocado']));
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000);
    expect(msg.candidates.map((c: { isWeightItem: boolean }) => c.isWeightItem)).toEqual([false, true]);
  });

  itWithFixture('search-results-tortillas.html', 'marks a sold-out product out of stock', async (runner) => {
    await runner.inject(CONTEXT);
    await runner.inject(searchStub(found([doc({ inventoryAvailable: '0' })])));
    await runner.inject(searchScript(['avocado']));
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000);
    expect(msg.candidates[0].outOfStock).toBe(true);
  });

  itWithFixture('search-results-tortillas.html', 'sends the store id and term the API expects', async (runner) => {
    await runner.inject(CONTEXT);
    await runner.inject(searchStub(found([doc()])));
    await runner.inject(searchScript(['avocado']));
    await runner.waitForMessage('SEARCH_RESULT', 15_000);
    await runner.inject(REPORT);
    const probe = await runner.waitForMessage('PROBE', 8_000);
    // The heavy service leads because it is the one that answers on a real
    // account; the lighter /xapi/search/products is the fallback.
    const url = String(probe.urls[0]);
    expect(url).toContain('/abs/pub/xapi/pgmsearch/v1/search/products');
    expect(url).toContain('q=avocado');
    expect(url).toContain('storeid=161');
    // Generated per call — a reused one returned a stale error body in testing.
    expect(url).toMatch(/request-id=\d+/);
  });

  it('refuses to build for a store id that is not a positive integer', () => {
    // "abc" | 0 would search store zero and return a plausible empty result.
    expect(buildAlbertsonsNetworkSearchBatchScript(['x'], { storeId: 'abc' })).toBeNull();
    expect(buildAlbertsonsNetworkSearchBatchScript(['x'], { storeId: '0' })).toBeNull();
    expect(buildAlbertsonsNetworkSearchBatchScript([], { storeId: '161' })).toBeNull();
  });
});

describe('Albertsons add over the network — qty is ABSOLUTE', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    idx: 0, productId: '184040105', quantity: 2, name: 'Medium Hass Avocado',
    maxOrderQuantity: 99, ...over,
  });

  itWithFixture('search-results-tortillas.html', 'writes cart-held PLUS wanted, never wanted alone', async (runner) => {
    await runner.inject(CONTEXT);
    // The user already had 3 of this item.
    await runner.inject(cartStub({ '184040105': 3 }));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript([item({ quantity: 2 })])!);
    const done = await runner.waitForMessage('NET_ADD_DONE', 15_000);
    expect(done.wrote).toBe(1);
    await runner.inject(REPORT);
    const probe = await runner.waitForMessage('PROBE', 8_000);
    // 3 held + 2 wanted = 5. Writing 2 would have DELETED one the user had.
    expect(probe.writes).toEqual([{ itemId: '184040105', qty: 5 }]);
  });

  itWithFixture('search-results-tortillas.html', 'coalesces two ingredients that resolve to one product into ONE write', async (runner) => {
    await runner.inject(CONTEXT);
    await runner.inject(cartStub({ '184040105': 1 }));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript([
      item({ idx: 0, quantity: 2, name: 'Avocado' }),
      item({ idx: 1, quantity: 3, name: 'Hass Avocado' }),
    ])!);
    await runner.waitForMessage('NET_ADD_DONE', 15_000);
    await runner.inject(REPORT);
    const probe = await runner.waitForMessage('PROBE', 8_000);
    // set(1+2) then set(1+3) would land 4, not 6. One write of 1+2+3.
    expect(probe.writes).toEqual([{ itemId: '184040105', qty: 6 }]);
  });

  itWithFixture('search-results-tortillas.html', 'declines a weight item rather than writing a count to it', async (runner) => {
    await runner.inject(CONTEXT);
    await runner.inject(cartStub({}));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript([item({ isWeightItem: true })])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 15_000);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('weight_item_declined');
    await runner.inject(REPORT);
    const probe = await runner.waitForMessage('PROBE', 8_000);
    expect(probe.writes).toEqual([]);
  });

  itWithFixture('search-results-tortillas.html', 'refuses when the cart already holds the store cap', async (runner) => {
    await runner.inject(CONTEXT);
    await runner.inject(cartStub({ '184040105': 4 }));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript([item({ quantity: 2, maxOrderQuantity: 4 })])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 15_000);
    expect(res.reason).toBe('quantity_limit_reached');
    await runner.inject(REPORT);
    const probe = await runner.waitForMessage('PROBE', 8_000);
    // Nothing sent: the store would refuse the whole write anyway.
    expect(probe.writes).toEqual([]);
  });

  itWithFixture('search-results-tortillas.html', 'clamps to the cap instead of overshooting it', async (runner) => {
    await runner.inject(CONTEXT);
    await runner.inject(cartStub({ '184040105': 2 }));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript([item({ quantity: 5, maxOrderQuantity: 4 })])!);
    await runner.waitForMessage('NET_ADD_DONE', 15_000);
    await runner.inject(REPORT);
    const probe = await runner.waitForMessage('PROBE', 8_000);
    expect(probe.writes).toEqual([{ itemId: '184040105', qty: 4 }]);
  });

  itWithFixture('search-results-tortillas.html', 'writes nothing at all when the cart cannot be read', async (runner) => {
    await runner.inject(CONTEXT);
    // Every candidate key is refused, so no baseline can be established.
    await runner.inject(cartStub({}, { getStatus: 401 }));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript([item()])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 15_000);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no_cart_baseline');
    await runner.inject(REPORT);
    const probe = await runner.waitForMessage('PROBE', 8_000);
    expect(probe.writes).toEqual([]);
  });

  itWithFixture('search-results-tortillas.html', 'reports a mismatch when the cart came back holding a different quantity', async (runner) => {
    await runner.inject(CONTEXT);
    // The store overrode us — a cap we did not know about, say.
    await runner.inject(cartStub({ '184040105': 1 }, { override: 2 }));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript([item({ quantity: 4 })])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 15_000);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('quantity_mismatch');
    expect(String(res.detail)).toContain('asked 5');
  });

  itWithFixture('search-results-tortillas.html', 'reports the cart before and after, so the done screen matches H-E-B', async (runner) => {
    // The user should not be able to tell which rail ran. H-E-B's add emits the
    // cart before and after for the done-screen breakdown; this must too, or
    // Albertsons silently loses the green/grey split.
    await runner.inject(CONTEXT);
    await runner.inject(cartStub({ '999': 2 }));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript([
      { idx: 0, productId: '184040105', quantity: 1, name: 'Avocado' },
    ])!);
    const done = await runner.waitForMessage('NET_ADD_DONE', 15_000);
    // `available` is null when the store said nothing about it, which this stub
    // does not — an unavailable line is IN the cart and blocks checkout, so the
    // rows carry it.
    // itemId is the id the WRITE addresses this line by — it is what lets a
    // baseline be handed to the write instead of the write reading the cart a
    // second time.
    expect(done.cartBefore).toEqual([{ name: 'Item 999', qty: 2, available: null, itemId: '999' }]);
    // The item the run wrote is present after and absent before, which is what
    // makes it render green rather than grey.
    expect(done.cartAfter).toEqual(expect.arrayContaining([
      { name: 'Item 999', qty: 2, available: null, itemId: '999' },
      { name: 'Item 184040105', qty: 1, available: null, itemId: '184040105' },
    ]));
  });

  it('refuses to build with nothing writable', () => {
    expect(buildAlbertsonsNetworkAddBatchScript([])).toBeNull();
    expect(buildAlbertsonsNetworkAddBatchScript([
      { idx: 0, productId: '', quantity: 1, name: 'x' },
    ])).toBeNull();
    expect(buildAlbertsonsNetworkAddBatchScript([
      { idx: 0, productId: '1', quantity: 0, name: 'x' },
    ])).toBeNull();
  });
});

/**
 * The page context the probe now needs: a server-set session cookie for the
 * store, and one cookie-authenticated endpoint for the customer. Neither
 * involves the site's bootstrap, which is the whole point.
 */
function albStub(opts: {
  shared?: Record<string, unknown> | null;
  userInfoStatus?: number;
  userInfoBody?: unknown;
  userInfoHang?: boolean;
  userInfoReject?: boolean;
  cartStatus?: number;
  page?: Record<string, unknown> | null;
} = {}) {
  const shared = opts.shared === undefined
    ? { info: { SHOP: { storeId: '161', zipcode: '83713' }, COMMON: { userType: 'R' } } }
    : opts.shared;
  const body = opts.userInfoBody === undefined
    ? { SWY_SHOP_TOKEN: 'tok', customerId: 'c1', firstName: 'Stephen', UUID: 'uuid-1' }
    : opts.userInfoBody;
  return [
    '(function () {',
    '  window.__urls = [];',
    shared
      ? '  Object.defineProperty(document, "cookie", { configurable: true, get: function () {'
        + ' return "SWY_SHARED_SESSION_INFO=" + encodeURIComponent(' + JSON.stringify(JSON.stringify(shared)) + '); } });'
      : '  Object.defineProperty(document, "cookie", { configurable: true, get: function () { return ""; } });',
    opts.page
      ? '  window.AB = { userInfo: ' + JSON.stringify(opts.page) + ' };'
      : '  delete window.AB;',
    '  window.SWY = { CONFIGSERVICE: { searchConfig: { apimProgramSubscriptionKey: "0123456789abcdef0123456789abcdef" },',
    '    erumsConfig: { store: { apim: { key: "fedcba9876543210fedcba9876543210" } } } } };',
    '  window.fetch = function (url) {',
    '    var u = String(url); window.__urls.push(u);',
    '    if (u.indexOf("/bin/safeway/unified/userinfo") !== -1) {',
    opts.userInfoHang ? '      return new Promise(function () {});' : '',
    opts.userInfoReject ? '      return Promise.reject(new Error("offline"));' : '',
    '      return Promise.resolve({ status: ' + String(opts.userInfoStatus ?? 200) + ',',
    '        text: function () { return Promise.resolve(' + JSON.stringify(JSON.stringify(body)) + '); } });',
    '    }',
    '    return Promise.resolve({ status: ' + String(opts.cartStatus ?? 200) + ',',
    '      json: function () { return Promise.resolve({ carts: [{ cartItemsList: ['
      + ' { itemId: "1", qty: 2, name: "Item 1" } ] }] }); } });',
    '  };',
    '})(); true;',
  ].filter(Boolean).join('\n');
}

/**
 * The heavy service refuses with a hard 400 -- the shape the light service was
 * really answering all morning -- and the light one answers. Records every URL,
 * so a test can count which service was asked and how often.
 */
const REFUSE_HEAVY = [
  '(function () {',
  '  window.__urls = window.__urls || [];',
  '  window.fetch = function (url) {',
  '    var u = String(url); window.__urls.push(u);',
  '    if (u.indexOf("pgmsearch") !== -1) {',
  '      return Promise.resolve({ status: 400, text: function () { return Promise.resolve(',
  '        JSON.stringify({ status: "BAD_REQUEST", message: "Search encountered a problem. OSSR0034-D" })); } });',
  '    }',
  '    if (u.indexOf("/xapi/search/products") !== -1) {',
  '      return Promise.resolve({ status: 200, text: function () { return Promise.resolve(',
  '        ' + JSON.stringify(JSON.stringify({
      appCode: '[PS: 200]',
      primaryProducts: { appCode: '[PS: 200]', response: { numFound: 1, start: 0, docs: [{
        name: 'Medium Hass Avocado', pid: '184040105', id: '184040105', upc: '0048404010501',
        price: 0.79, status: 'active', inventoryAvailable: '1', sellByWeight: 'I',
        unitOfMeasure: 'EA', unitQuantity: 'EACH', maxPurchaseQty: 99, restrictedValue: '0',
      }] } },
    })) + '); } });',
  '    }',
  '    return Promise.resolve({ status: 200, json: function () {',
  '      return Promise.resolve({ carts: [{ cartItemsList: [] }] }); } });',
  '  };',
  '})(); true;',
].join('\n');

const urlsProbe = '(function(){ window.ReactNativeWebView.postMessage(JSON.stringify('
  + '{ type: "PROBE", urls: window.__urls })); })(); true;';

describe('Albertsons session probe', () => {
  // Every earlier version of this probe read the PAGE, and every one of them
  // told Stephen he was signed out while he was signed in -- from both
  // directions, three times, over two days. window.AB.userInfo is not something
  // the page KNOWS: it is the parsed body of one cookie-authenticated GET the
  // site makes on boot. Waiting for it put our answer behind the site's whole
  // bootstrap and behind Chromium's timer throttling in a WebView the user is
  // not looking at -- 142 seconds on the 22:10 run. So the probe asks the
  // server, exactly as H-E-B's does, and its answer decides.

  itWithFixture('logged-in-home.html', 'answers from the endpoint with NO page bootstrap at all', async (runner) => {
    // window.AB never appears. Before this that was unanswerable.
    await runner.inject(albStub());
    await runner.inject(buildAlbertsonsSessionScript());
    const started = Date.now();
    const msg = await runner.waitForMessage('ALB_SESSION', 20_000);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(msg).toMatchObject({ ok: true, loggedIn: true, source: 'userinfo' });
    // Customer from the endpoint, store from the cookie. Neither carries both.
    expect(msg.storeId).toBe('161');
    expect(msg.zipCode).toBe('83713');
    expect(msg.uuid).toBe('uuid-1');
  });

  itWithFixture('logged-in-home.html', 'a 200 with no token IS signed out, definitively', async (runner) => {
    // The site's own reading: processUserInfoFlow sees no SWY_SHOP_TOKEN and
    // tears the session down. So this is not a guess and not an absence.
    await runner.inject(albStub({ userInfoBody: {} }));
    await runner.inject(buildAlbertsonsSessionScript());
    const msg = await runner.waitForMessage('ALB_SESSION', 20_000);
    expect(msg).toMatchObject({ ok: true, loggedIn: false, source: 'userinfo' });
  });

  itWithFixture('logged-in-home.html', 'a 403 is signed out — the site reads it the same way', async (runner) => {
    await runner.inject(albStub({ userInfoStatus: 403 }));
    await runner.inject(buildAlbertsonsSessionScript());
    const msg = await runner.waitForMessage('ALB_SESSION', 20_000);
    expect(msg).toMatchObject({ ok: true, loggedIn: false, status: 403 });
  });

  itWithFixture('logged-in-home.html', 'a 500 says nothing about the user — handed back, not guessed', async (runner) => {
    // The rule that survived being wrong in both directions: our inability to
    // make a request is a fact about us. Answering it either way is what walled
    // a signed-in user once and started a run under a signed-out one before that.
    await runner.inject(albStub({ userInfoStatus: 500 }));
    await runner.inject(buildAlbertsonsSessionScript());
    const msg = await runner.waitForMessage('ALB_SESSION', 20_000);
    expect(msg.ok).toBe(false);
    expect(msg.why).toBe('http');
    expect(msg.status).toBe(500);
    expect(msg.loggedIn).toBeUndefined();
  });

  itWithFixture('logged-in-home.html', 'a network error is inconclusive too', async (runner) => {
    await runner.inject(albStub({ userInfoReject: true }));
    await runner.inject(buildAlbertsonsSessionScript());
    const msg = await runner.waitForMessage('ALB_SESSION', 20_000);
    expect(msg.ok).toBe(false);
    expect(msg.loggedIn).toBeUndefined();
  });

  itWithFixture('logged-in-home.html', 'uses the page when it IS booted, without asking again', async (runner) => {
    await runner.inject(albStub({
      page: { SWY_SHOP_TOKEN: 'tok', branchId: '161', zipcode: '83713', UUID: 'uuid-1' },
    }));
    await runner.inject(buildAlbertsonsSessionScript());
    const msg = await runner.waitForMessage('ALB_SESSION', 20_000);
    expect(msg).toMatchObject({ ok: true, loggedIn: true, storeId: '161' });
    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    // The request is the fallback, not the routine.
    expect(seen.urls.some((u: string) => u.indexOf('/bin/safeway/unified/userinfo') !== -1)).toBe(false);
  });

  itWithFixture('logged-in-home.html', 'the cart read refines the answer, it never downgrades it', async (runner) => {
    // Two answers. The first settles the login gate the moment the endpoint has
    // spoken; the second says whether the token actually works. A cart that
    // fails proves nothing about the user, only about us.
    await runner.inject(albStub({ cartStatus: 401 }));
    await runner.inject(buildAlbertsonsSessionScript());
    const early = await runner.waitForMessage('ALB_SESSION', 20_000);
    expect(early).toMatchObject({ ok: true, loggedIn: true, early: true });
    expect(early.cartReadable).toBeNull();
    const refined = await runner.waitForMessage('ALB_SESSION', 20_000, (m) => !m.early);
    expect(refined).toMatchObject({ ok: true, loggedIn: true, verified: false, cartReadable: false });
  });

  itWithFixture('logged-in-home.html', 'marks the session VERIFIED when the cart actually reads', async (runner) => {
    await runner.inject(albStub());
    await runner.inject(buildAlbertsonsSessionScript());
    await runner.waitForMessage('ALB_SESSION', 20_000);
    const refined = await runner.waitForMessage('ALB_SESSION', 20_000, (m) => !m.early);
    expect(refined).toMatchObject({ ok: true, loggedIn: true, verified: true, cartReadable: true });
    expect(refined.hasSearchKey).toBe(true);
  });

  itWithFixture('logged-in-home.html', 'signed in with no store still answers the login gate', async (runner) => {
    // The cookie had no SHOP section. The run cannot search without a store, but
    // that is not a reason to tell a signed-in user they are signed out.
    await runner.inject(albStub({ shared: { info: { COMMON: { userType: 'R' } } } }));
    await runner.inject(buildAlbertsonsSessionScript());
    const msg = await runner.waitForMessage('ALB_SESSION', 20_000);
    expect(msg).toMatchObject({ ok: true, loggedIn: true });
    expect(msg.storeId).toBeNull();
  });

  itWithFixture('logged-in-home.html', 'never reports a token or any credential value', async (runner) => {
    await runner.inject(albStub());
    await runner.inject(buildAlbertsonsSessionScript());
    const msg = await runner.waitForMessage('ALB_SESSION', 20_000);
    expect(JSON.stringify(msg)).not.toContain('tok');
  });
});

describe('Albertsons cart read over the network', () => {
  /** Cart stub that also records every URL it was called with. */
  function recordingCartStub(lines: Record<string, number>, status = 200) {
    return [
      '(function () {',
      '  window.__urls = [];',
      '  window.fetch = function (url) {',
      '    window.__urls.push(String(url));',
      '    var list = [];',
      '    var L = ' + JSON.stringify(lines) + ';',
      '    for (var k in L) list.push({ itemId: k, qty: L[k], name: "Item " + k });',
      '    return Promise.resolve({ status: ' + String(status) + ',',
      '      json: function () { return Promise.resolve({ carts: [{ cartItemsList: list }] }); } });',
      '  };',
      '})(); true;',
    ].join('\n');
  }

  const CONFIG_ONLY = '(function(){ window.SWY = { CONFIGSERVICE: { erumsConfig: {'
    + ' store: { apim: { key: "0123456789abcdef0123456789abcdef" } } } } }; })(); true;';

  itWithFixture('logged-in-home.html',
    'fires no cart request until it has a store and a token', async (runner) => {
    // Stephen's run of 2026-09-01 came back rail_read_http and nothing was
    // reconciled. The read is injected the moment the store page settles, which
    // is BEFORE the site's bootstrap fills window.AB.userInfo -- so the URL was
    // built from {} and went out as '?storeId=&serviceType=Dug&zipCode=' under a
    // bare 'Bearer '. The gateway rejects that, and it reaches the log as "your
    // cart could not be read" when the truth is "we asked without a session".
    await runner.inject(albStub({ userInfoBody: {} }));   // signed out
    await runner.inject(buildAlbertsonsCartReadScript());

    const msg = await runner.waitForMessage('CART_COUNT', 20_000);
    // Unknown, never zero -- a zero would invite the reconcile to re-add
    // everything already in the cart.
    expect(msg.count).toBeNull();
    expect(msg.reason).toBe('rail_read_not_hydrated');

    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    expect(seen.urls.some((u: string) => u.indexOf('cartservice') !== -1)).toBe(false);
  });

  itWithFixture('logged-in-home.html',
    'resolves the session itself rather than waiting for the page', async (runner) => {
    // window.AB never appears at all. The read gets its token from the endpoint
    // and its store from the cookie, and goes.
    await runner.inject(albStub());
    await runner.inject(buildAlbertsonsCartReadScript());

    const msg = await runner.waitForMessage('CART_COUNT', 20_000);
    expect(msg.count).toBe(2);
    expect(msg.source).toBe('network');

    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    const cartUrl = seen.urls.find((u: string) => u.indexOf('cartservice') !== -1);
    expect(cartUrl).toContain('storeId=161');
    expect(cartUrl).not.toContain('storeId=&');
  });

  itWithFixture('search-results-tortillas.html',
    'carries the HTTP status so a failure is diagnosable', async (runner) => {
    // 'rail_read_http' alone says a request failed and nothing about why. A 400
    // is ours to fix and a 500 is the store's; without the status they are the
    // same line in the log, which is how this one went unexplained for a day.
    await runner.inject(CONFIG_ONLY);
    await runner.inject('(function(){ window.AB = { userInfo: { SWY_SHOP_TOKEN: "tok",'
      + ' branchId: "161", zipcode: "83713", customerId: "cust-1" } }; })(); true;');
    await runner.inject(recordingCartStub({}, 400));
    await runner.inject(buildAlbertsonsCartReadScript());

    const msg = await runner.waitForMessage('CART_COUNT', 20_000);
    expect(msg.count).toBeNull();
    expect(msg.reason).toBe('rail_read_http');
    expect(msg.status).toBe(400);
  });
});

describe('the request has to look like the site\'s own', () => {
  // The first time the network rail actually reached Albertsons on the device
  // (2026-09-01 22:26 -- every earlier attempt died at the login gate), all 20
  // searches came back 200-with-appCode-400, "Search encountered a problem.
  // Please try again OSSR0033-R", and the cart read came back 400. Both were
  // built from parameters we had invented rather than read off the site.



  itWithFixture('logged-in-home.html', 'sends the HOSTNAME as url and pageurl, not a full URL', async (runner) => {
    // mapProgramSearchParams: .set('url', i).set('pageurl', i) where i is the
    // hostname. We were sending 'https://www.albertsons.com'.
    await runner.inject(albStub());
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(['garlic'], { storeId: '161' })!);
    await runner.waitForMessage('SEARCH_BATCH_DONE', 20_000);
    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    const q = seen.urls.find((u: string) => u.indexOf('pgmsearch') !== -1)!;
    expect(q).toContain('url=www.albertsons.com');
    expect(q).toContain('pageurl=www.albertsons.com');
    expect(q).not.toContain(encodeURIComponent('https://'));
    // And the store came from the session, not from a page that may not have booted.
    expect(q).toContain('storeid=161');
  });

  itWithFixture('logged-in-home.html', 'omits pgm entirely, as the site does with no program list', async (runner) => {
    // The site DELETES pgm when pgmList is empty. We always sent
    // pgm=merch-banner, which is a program this search is not part of.
    await runner.inject(albStub());
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(['garlic'], { storeId: '161' })!);
    await runner.waitForMessage('SEARCH_BATCH_DONE', 20_000);
    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    const q = seen.urls.find((u: string) => u.indexOf('pgmsearch') !== -1)!;
    expect(q).not.toContain('pgm=');
  });

  itWithFixture('logged-in-home.html', 'takes pickup or delivery from the session, never assumes', async (runner) => {
    // serviceType = 'dug' === preference.toLowerCase() ? 'Dug' : 'Delivery'.
    // Hardcoding Dug builds every cart WRITE for a cart a delivery shopper does
    // not have. (The read is keyed by customer and carries no serviceType.)
    await runner.inject(albStub({
      shared: { info: { SHOP: { storeId: '161', zipcode: '83713' },
                        COMMON: { userType: 'R', preference: 'DELIVERY' } } },
    }));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript(
      [{ idx: 0, productId: '1', quantity: 1, name: 'Item 1' }])!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    const write = seen.urls.find((u: string) => u.indexOf('/cart/items') !== -1)!;
    expect(write).toContain('serviceType=Delivery');
  });

  itWithFixture('logged-in-home.html', 'still says Dug for a pickup shopper', async (runner) => {
    await runner.inject(albStub({
      shared: { info: { SHOP: { storeId: '161', zipcode: '83713' },
                        COMMON: { userType: 'R', preference: 'DUG' } } },
    }));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript(
      [{ idx: 0, productId: '1', quantity: 1, name: 'Item 1' }])!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    expect(seen.urls.find((u: string) => u.indexOf('/cart/items') !== -1)).toContain('serviceType=Dug');
  });

  itWithFixture('logged-in-home.html', 'READS from /cart/customer, never GETs /cart/items', async (runner) => {
    // The service routes GET /cart/items as /cart/{id} and says so:
    //   "Failed to convert 'id' with value: 'items'"
    // /cart/items is the WRITE endpoint. The read is POST /cart/customer/{id}.
    await runner.inject(albStub());
    await runner.inject(buildAlbertsonsCartReadScript());
    await runner.waitForMessage('CART_COUNT', 20_000);
    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    const read = seen.urls.find((u: string) => u.indexOf('cartservice') !== -1)!;
    expect(read).toContain('/cart/customer/');
    expect(read).toContain('type=full');
    expect(read).not.toContain('/cart/items');
  });

  itWithFixture('logged-in-home.html', 'carries the gateway\'s own words when the cart 400s', async (runner) => {
    // 'rail_read_http' plus a bare 400 is where this sat for a day. The body
    // names the complaint.
    await runner.inject(albStub({ cartStatus: 400 }));
    await runner.inject(buildAlbertsonsCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 20_000);
    expect(msg.reason).toBe('rail_read_http');
    expect(msg.status).toBe(400);
  });

  itWithFixture('logged-in-home.html', 'reports the query it sent, with identifiers stripped', async (runner) => {
    // So a failure names itself next time instead of needing another run.
    await runner.inject(albStub());
    // No docs array at all: the envelope that says the search itself broke.
    await runner.inject(searchStub({ appCode: '[PS: 400]',
      primaryProducts: { appCode: '400', appMsg: 'Search encountered a problem. OSSR0033-R' } }));
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(['garlic'], { storeId: '161' })!);
    const msg = await runner.waitForMessage('SEARCH_RESULT_FAILED', 25_000);
    expect(msg.why).toBe('search_error');
    expect(msg.sentQuery).toContain('storeid=161');
    expect(msg.sentQuery).toContain('q=garlic');
    // The request's own clock, so a slow service and a starved JS thread stop
    // looking the same in the log.
    expect(typeof msg.ms).toBe('number');
    // Never an identifier's value.
    expect(msg.sentQuery).not.toContain('uuid-1');
  });

  itWithFixture('logged-in-home.html', 'uses the site\'s own defaults on the heavy service', async (runner) => {
    // sort and featured are the EMPTY STRING there, and timezone is a hardcoded
    // America/Los_Angeles rather than the device's.
    await runner.inject(albStub());
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(['garlic'], { storeId: '161' })!);
    await runner.waitForMessage('SEARCH_BATCH_DONE', 25_000);
    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    const q = seen.urls.find((u: string) => u.indexOf('pgmsearch') !== -1)!;
    expect(q).toContain('sort=&');
    expect(q).toContain('featured=&');
    expect(q).toContain('timezone=' + encodeURIComponent('America/Los_Angeles'));
  });
});

describe('when a search service refuses a term', () => {
  // The rail asks the HEAVY service first -- pgmsearch, the one that actually
  // answers on this account -- and falls back to the light /xapi/search/products
  // if it is ever refused.
  //
  // The trigger matters as much as the order. It used to test only for the SOFT
  // envelope (200 with appCode 400), so a hard HTTP 400 skipped the fallback
  // entirely. That is precisely how the light service failed when it was
  // primary: it answers a hard 400, so the run never reached the working service
  // and fifty terms in a row came back empty.

  itWithFixture('logged-in-home.html', 'falls back on a hard 400, not only a soft one', async (runner) => {
    await runner.inject(albStub());
    await runner.inject(REFUSE_HEAVY);
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(['avocado'], { storeId: '161' })!);

    const shape = await runner.waitForMessage('SEARCH_SHAPE_OK', 25_000);
    expect(shape.variant).toBe('plain');
    expect(shape.after).toBe('site');
    const got = await runner.waitForMessage('SEARCH_RESULT', 25_000);
    expect(got.candidates.length).toBeGreaterThan(0);
  });

  itWithFixture('logged-in-home.html', 'sticks with the service that answered', async (runner) => {
    await runner.inject(albStub());
    await runner.inject(REFUSE_HEAVY);
    // Serial, so the count is exact rather than a race between two terms both
    // discovering the fallback at once.
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(
      ['avocado', 'garlic', 'onion'], { storeId: '161', concurrency: 1 })!);
    await runner.waitForMessage('SEARCH_BATCH_DONE', 30_000);

    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    const heavy = seen.urls.filter((u: string) => u.indexOf('pgmsearch') !== -1);
    const light = seen.urls.filter((u: string) => u.indexOf('/xapi/search/products') !== -1);
    // Term one pays for the discovery; terms two and three go straight to the
    // service that works. Fifty pointless requests a run was the alternative.
    expect(heavy.length).toBe(1);
    expect(light.length).toBe(3);
  });

  itWithFixture('logged-in-home.html', 'does NOT fall back when the store is having a bad minute', async (runner) => {
    // A 5xx or a timeout is not a refusal, and asking the other service to meet
    // the same wall costs a second request per term for nothing.
    await runner.inject(albStub());
    await runner.inject(searchStub({}, { status: 503 }));
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(['avocado'], { storeId: '161' })!);
    const msg = await runner.waitForMessage('SEARCH_RESULT_FAILED', 25_000);
    expect(msg.why).toBe('http');
    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    expect(seen.urls.filter((u: string) => u.indexOf('search/products') !== -1).length).toBe(1);
  });

  itWithFixture('logged-in-home.html', 'a failure names BOTH services, not just the first', async (runner) => {
    // Reporting only the first attempt made every failure in the log read as
    // though one service had been asked, which is how fifty 400s looked like a
    // single endpoint problem for a morning.
    await runner.inject(albStub());
    await runner.inject(searchStub({ status: 400 } as never, { status: 400 }));
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(['avocado'], { storeId: '161' })!);
    const msg = await runner.waitForMessage('SEARCH_RESULT_FAILED', 25_000);
    expect(msg.firstVariant).toBe('site');
    expect(msg.variant).toBe('plain');
  });
});

describe('the cart subscription key', () => {
  itWithFixture('logged-in-home.html', 'reads the DOTTED erums field names', async (runner) => {
    // The site publishes this with SWY.CONFIGSERVICE.initErumsConfig('{...}'),
    // and inside it the keys have dots in their NAMES:
    //   "cart.apim.key", "store.apim.key", "apim.key", "xapi.apim.key"
    // The rail read them as nested objects (er.store.apim.key), which is
    // undefined every time -- so it swept every 32-hex value in the config in
    // arbitrary order instead, and the cart answered 401 all evening.
    const RIGHT = 'c645e9387c654aa8ae253045f648bfac';
    await runner.inject([
      '(function () {',
      '  window.__urls = [];',
      '  window.AB = { userInfo: { SWY_SHOP_TOKEN: "tok", branchId: "161", zipcode: "83713",',
      '    customerId: "cust-1" } };',
      '  window.SWY = { CONFIGSERVICE: {',
      '    searchConfig: { apimProgramSubscriptionKey: "0123456789abcdef0123456789abcdef" },',
      // Decoys first in enumeration order, exactly as the real config has them.
      '    datapowerConfig: { cncSubscriptionKey: "1111111111111111ffffffffffffffff",',
      '                       xapiSubscriptionKey: "2222222222222222ffffffffffffffff" },',
      '    erumsConfig: { "slot.service.endpoint": "/x",',
      '                   "cart.apim.key": "' + RIGHT + '" } } };',
      '  window.fetch = function (url, init) {',
      '    var u = String(url); window.__urls.push(u);',
      '    var key = ((init && init.headers) || {})["ocp-apim-subscription-key"];',
      '    if (key !== "' + RIGHT + '") return Promise.resolve({ status: 401,',
      '      text: function () { return Promise.resolve("no"); } });',
      '    return Promise.resolve({ status: 200, json: function () {',
      '      return Promise.resolve({ carts: [{ cartItemsList: [{ itemId: "1", qty: 3, name: "Item 1" }] }] }); } });',
      '  };',
      '})(); true;',
    ].join('\n'));
    await runner.inject(buildAlbertsonsCartReadScript());

    const msg = await runner.waitForMessage('CART_COUNT', 20_000);
    expect(msg.count).toBe(3);

    await runner.inject(urlsProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    // First try, not the twelfth: the named field is tried before the sweep.
    expect(seen.urls.filter((u: string) => u.indexOf('cartservice') !== -1).length).toBe(1);
  });
});

describe('what counts as sold by weight', () => {
  // Stephen, 2026-09-02: "I searched for ginger root and it sent that to
  // reconcile. Searching for ginger root again, I see an exact match. Same goes
  // for yellow sweet onion... reconcile is saying onion and ginger are weight
  // items. They are not."
  //
  // Both were the same bug: an exact match, scored 100, declined as needing a
  // weight. The rule was "anything that is not 'I' is sold by weight", inferred
  // from one result set in which every doc happened to read 'I'.
  //
  // The site's own test needs BOTH fields:
  //   "W" === sellByWeight && "3" === displayType
  const weighed = (over: Record<string, unknown>) =>
    found([doc({ name: 'Ginger Root', ...over })]);

  itWithFixture('logged-in-home.html', 'a plain produce item is NOT sold by weight', async (runner) => {
    // What ginger root and yellow sweet onion actually look like: not 'I', and
    // no weight display. The old rule declined every one of them.
    await runner.inject(albStub());
    await runner.inject(searchStub(weighed({ sellByWeight: 'N', displayType: '0' })));
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(['Ginger Root'], { storeId: '161' })!);
    const msg = await runner.waitForMessage('SEARCH_RESULT', 20_000);
    expect(msg.candidates[0].isWeightItem).toBe(false);
  });

  itWithFixture('logged-in-home.html', "'W' alone is not enough — the site wants displayType 3 too", async (runner) => {
    await runner.inject(albStub());
    await runner.inject(searchStub(weighed({ sellByWeight: 'W', displayType: '0' })));
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(['Ginger Root'], { storeId: '161' })!);
    const msg = await runner.waitForMessage('SEARCH_RESULT', 20_000);
    expect(msg.candidates[0].isWeightItem).toBe(false);
  });

  itWithFixture('logged-in-home.html', 'a real weight item IS still declined', async (runner) => {
    // The other direction matters as much: writing a count to a line the store
    // prices by the pound is the one thing that cannot be undone (MEAL-200).
    await runner.inject(albStub());
    await runner.inject(searchStub(weighed({ sellByWeight: 'W', displayType: '3' })));
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(['Ginger Root'], { storeId: '161' })!);
    const msg = await runner.waitForMessage('SEARCH_RESULT', 20_000);
    expect(msg.candidates[0].isWeightItem).toBe(true);
  });

  itWithFixture('logged-in-home.html', 'sold-by-item stays sold-by-item', async (runner) => {
    await runner.inject(albStub());
    await runner.inject(searchStub(weighed({ sellByWeight: 'I', displayType: '3' })));
    await runner.inject(buildAlbertsonsNetworkSearchBatchScript(['Ginger Root'], { storeId: '161' })!);
    const msg = await runner.waitForMessage('SEARCH_RESULT', 20_000);
    expect(msg.candidates[0].isWeightItem).toBe(false);
  });
});

describe('an out-of-stock item the store accepts anyway', () => {
  // Stephen, 2026-09-02: "Do we know if an item is out of stock? I think it may
  // still allow us to add to cart, but show an out of stock warning in the cart."
  //
  // He is right, and their own cart component says so:
  //   ngClass: item.isAvailable ? "" : "OOSItem"
  //   disableCheckoutButton = ... || !carts[0].isAvailable
  // The line lands, struck through, and its presence blocks checkout for the
  // whole basket.
  //
  // This matters most for the stored-product-id plan: skipping the search
  // removes the check that used to catch this BEFORE the write, so the write's
  // own response has to carry it.
  function cartStubWithAvailability(available: boolean) {
    return [
      '(function () {',
      '  window.__lines = {};',
      '  function body() {',
      '    var list = [];',
      '    for (var k in window.__lines) list.push({ itemId: k, qty: window.__lines[k],',
      '      name: "Mist Winter Pine - Each", isAvailable: ' + String(available) + ' });',
      '    return { carts: [{ cartItemsList: list }] };',
      '  }',
      '  var prior = window.fetch;',
      '  window.fetch = function (url, init) {',
      '    if (String(url).indexOf("/userinfo") !== -1) return prior.apply(window, arguments);',
      '    if (String(url).indexOf("/cart/customer/") !== -1) {',
      '      return Promise.resolve({ status: 200, json: function () { return Promise.resolve(body()); } });',
      '    }',
      '    var line = JSON.parse(init.body).cartItemsList[0];',
      '    window.__lines[line.itemId] = line.qty;',
      '    return Promise.resolve({ status: 200, json: function () { return Promise.resolve(body()); } });',
      '  };',
      '})(); true;',
    ].join('\n');
  }

  itWithFixture('logged-in-home.html', 'is reported as a failure, never as an add', async (runner) => {
    await runner.inject(albStub());
    await runner.inject(cartStubWithAvailability(false));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript(
      [{ idx: 0, productId: '184040105', quantity: 1, name: 'Mist Winter Pine - Each' }])!);

    const res = await runner.waitForMessage('NET_ADD_RESULT', 20_000);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('out_of_stock');
    const done = await runner.waitForMessage('NET_ADD_DONE', 20_000);
    // The write happened — it is in the cart — but the run does not claim it.
    expect(done.wrote).toBe(0);
  });

  itWithFixture('logged-in-home.html', 'an available line is still a success', async (runner) => {
    await runner.inject(albStub());
    await runner.inject(cartStubWithAvailability(true));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript(
      [{ idx: 0, productId: '184040105', quantity: 1, name: 'Mist Winter Pine - Each' }])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 20_000);
    expect(res.ok).toBe(true);
  });

  itWithFixture('logged-in-home.html', 'silence is not a verdict — no flag means no claim', async (runner) => {
    // A store that never sends the field must not have every line read as
    // out of stock. Absent is null, and null is a success.
    await runner.inject(albStub());
    await runner.inject([
      '(function () {',
      '  window.__lines = {};',
      '  function body() {',
      '    var list = [];',
      '    for (var k in window.__lines) list.push({ itemId: k, qty: window.__lines[k], name: "X" });',
      '    return { carts: [{ cartItemsList: list }] };',
      '  }',
      '  var prior = window.fetch;',
      '  window.fetch = function (url, init) {',
      '    if (String(url).indexOf("/userinfo") !== -1) return prior.apply(window, arguments);',
      '    if (String(url).indexOf("/cart/customer/") !== -1) {',
      '      return Promise.resolve({ status: 200, json: function () { return Promise.resolve(body()); } });',
      '    }',
      '    var line = JSON.parse(init.body).cartItemsList[0];',
      '    window.__lines[line.itemId] = line.qty;',
      '    return Promise.resolve({ status: 200, json: function () { return Promise.resolve(body()); } });',
      '  };',
      '})(); true;',
    ].join('\n'));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript(
      [{ idx: 0, productId: '1', quantity: 1, name: 'X' }])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 20_000);
    expect(res.ok).toBe(true);
  });
});

describe('the whole basket goes in one request', () => {
  // cartItemsList is a LIST, and the store's own "Add all to cart" uses it that
  // way: qscAddAllItems() passes getAllSelectedProducts() — an array of
  // { itemId, qty } — straight through to the same POST /cart/items we had been
  // calling once per item.
  //
  // Not only faster. Sending them separately is what made concurrent writes lose
  // each other: the cart is one document, so N read-modify-writes overwrite each
  // other. That cost Stephen seven items and forced the writes back to serial at
  // about a second each. A batch is one transaction — the store does the merging.

  /** Records every write body, and echoes a cart built from ALL of them. */
  const batchStub = (over: Record<string, unknown> = {}) => [
    '(function () {',
    '  window.__writes = []; window.__lines = {};',
    '  var prior = window.fetch;',
    '  function body() {',
    '    var list = [];',
    '    for (var k in window.__lines) list.push(Object.assign(',
    '      { itemId: k, qty: window.__lines[k], name: "Item " + k }, ' + JSON.stringify(over) + '));',
    '    return { carts: [{ cartItemsList: list }] };',
    '  }',
    '  window.fetch = function (url, init) {',
    '    var u = String(url);',
    '    if (u.indexOf("/userinfo") !== -1) return prior.apply(window, arguments);',
    '    if (u.indexOf("/cart/customer/") !== -1) {',
    '      return Promise.resolve({ status: 200, json: function () { return Promise.resolve(body()); } });',
    '    }',
    '    var sent = JSON.parse(init.body).cartItemsList;',
    '    window.__writes.push(sent);',
    '    for (var i = 0; i < sent.length; i++) window.__lines[sent[i].itemId] = sent[i].qty;',
    '    return Promise.resolve({ status: 200, json: function () { return Promise.resolve(body()); } });',
    '  };',
    '})(); true;',
  ].join('\n');

  const writesProbe = '(function(){ window.ReactNativeWebView.postMessage(JSON.stringify('
    + '{ type: "PROBE", writes: window.__writes })); })(); true;';

  const five = [1, 2, 3, 4, 5].map((n) => ({
    idx: n - 1, productId: String(100 + n), quantity: n === 4 ? 2 : 1, name: 'Item ' + (100 + n),
  }));

  itWithFixture('logged-in-home.html', 'five items, one POST', async (runner) => {
    await runner.inject(albStub());
    await runner.inject(batchStub());
    await runner.inject(buildAlbertsonsNetworkAddBatchScript(five)!);
    const done = await runner.waitForMessage('NET_ADD_DONE', 25_000);
    expect(done.wrote).toBe(5);

    await runner.inject(writesProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    expect(seen.writes.length).toBe(1);
    expect(seen.writes[0].length).toBe(5);
    // The quantities are still per product, and still absolute.
    expect(seen.writes[0].find((l: { itemId: string }) => l.itemId === '104').qty).toBe(2);
  });

  itWithFixture('logged-in-home.html', 'every item still gets its own verdict', async (runner) => {
    await runner.inject(albStub());
    await runner.inject(batchStub());
    await runner.inject(buildAlbertsonsNetworkAddBatchScript(five)!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    const results = runner.messagesOfType('NET_ADD_RESULT') as Array<Record<string, unknown>>;
    expect(results.length).toBe(5);
    expect(results.every((r) => r.ok === true)).toBe(true);
    // One verdict per item, not one for the batch.
    expect(new Set(results.map((r) => r.idx)).size).toBe(5);
  });

  itWithFixture('logged-in-home.html', 'an unavailable line in the batch fails only itself', async (runner) => {
    // The verification is still per item, so one out-of-stock product does not
    // take the other four down with it.
    await runner.inject(albStub());
    await runner.inject(batchStub({ isAvailable: false }));
    await runner.inject(buildAlbertsonsNetworkAddBatchScript(five)!);
    const done = await runner.waitForMessage('NET_ADD_DONE', 25_000);
    expect(done.wrote).toBe(0);
  });

  itWithFixture('logged-in-home.html', 'a weight item is declined without joining the request', async (runner) => {
    await runner.inject(albStub());
    await runner.inject(batchStub());
    await runner.inject(buildAlbertsonsNetworkAddBatchScript([
      { idx: 0, productId: '201', quantity: 1, name: 'Ginger Root', isWeightItem: true },
      { idx: 1, productId: '202', quantity: 1, name: 'Tortillas' },
    ])!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    await runner.inject(writesProbe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    // One request, and the weight item is not in it.
    expect(seen.writes.length).toBe(1);
    expect(seen.writes[0].map((l: { itemId: string }) => l.itemId)).toEqual(['202']);
  });
});

describe('the write can be handed a baseline instead of reading one', () => {
  // qty is ABSOLUTE — the write SETS the line — so every quantity is
  // held + wanted and the write needs to know what is held. It read the cart
  // itself to find out, which on a normal run is the second read of the same
  // cart about a second after the sheet's own.
  //
  // The danger is the reason the sheet guards this: a write addresses lines by
  // ID. A baseline keyed by anything else looks up nothing, finds no held
  // quantity, and SETS a line the user already had down to what this run asked
  // for — the absolute-quantity under-add MEAL-194 exists to prevent.
  const countingStub = [
    '(function () {',
    '  window.__reads = 0; window.__writes = [];',
    '  var prior = window.fetch;',
    '  window.fetch = function (url, init) {',
    '    var u = String(url);',
    '    if (u.indexOf("/userinfo") !== -1) return prior.apply(window, arguments);',
    '    if (u.indexOf("/cart/customer/") !== -1) {',
    '      window.__reads++;',
    '      return Promise.resolve({ status: 200, json: function () { return Promise.resolve(',
    '        { carts: [{ cartItemsList: [{ itemId: "500", qty: 3, name: "Held Item" }] }] }); } });',
    '    }',
    '    var sent = JSON.parse(init.body).cartItemsList;',
    '    window.__writes.push(sent);',
    '    return Promise.resolve({ status: 200, json: function () { return Promise.resolve(',
    '      { carts: [{ cartItemsList: sent.map(function (l) {',
    '        return { itemId: l.itemId, qty: l.qty, name: "Held Item" }; }) }] }); } });',
    '  };',
    '})(); true;',
  ].join('\n');

  const probe = '(function(){ window.ReactNativeWebView.postMessage(JSON.stringify('
    + '{ type: "PROBE", reads: window.__reads, writes: window.__writes })); })(); true;';

  itWithFixture('logged-in-home.html', 'given one, it does not read the cart to start', async (runner) => {
    await runner.inject(albStub());
    await runner.inject(countingStub);
    await runner.inject(buildAlbertsonsNetworkAddBatchScript(
      [{ idx: 0, productId: '500', quantity: 2, name: 'Held Item' }],
      { knownLines: { '500': 3 } })!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    await runner.inject(probe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    // One read left: the after-read that builds the done screen's breakdown.
    expect(seen.reads).toBe(1);
    // And the arithmetic is unchanged — held 3 plus wanted 2.
    expect(seen.writes[0][0].qty).toBe(5);
  });

  itWithFixture('logged-in-home.html', 'given none, it still reads for itself', async (runner) => {
    // The script stays runnable on its own, which is what every other test here
    // exercises and what a caller with no baseline depends on.
    await runner.inject(albStub());
    await runner.inject(countingStub);
    await runner.inject(buildAlbertsonsNetworkAddBatchScript(
      [{ idx: 0, productId: '500', quantity: 2, name: 'Held Item' }])!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    await runner.inject(probe);
    const seen = await runner.waitForMessage('PROBE', 10_000);
    expect(seen.reads).toBe(2);
    expect(seen.writes[0][0].qty).toBe(5);
  });
});
