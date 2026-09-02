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
  '    zipcode: "83713", UUID: "uuid-1" } };',
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
    '    var method = (init && init.method) || "GET";',
    '    if (method === "GET") {',
    '      return Promise.resolve({ status: ' + String(opts.getStatus ?? 200) + ',',
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
      doc({ pid: '2', name: 'Bananas', sellByWeight: 'W' }),
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
    expect(done.cartBefore).toEqual([{ name: 'Item 999', qty: 2 }]);
    // The item the run wrote is present after and absent before, which is what
    // makes it render green rather than grey.
    expect(done.cartAfter).toEqual(expect.arrayContaining([
      { name: 'Item 999', qty: 2 },
      { name: 'Item 184040105', qty: 1 },
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
      + ' branchId: "161", zipcode: "83713" } }; })(); true;');
    await runner.inject(recordingCartStub({}, 400));
    await runner.inject(buildAlbertsonsCartReadScript());

    const msg = await runner.waitForMessage('CART_COUNT', 20_000);
    expect(msg.count).toBeNull();
    expect(msg.reason).toBe('rail_read_http');
    expect(msg.status).toBe(400);
  });
});
