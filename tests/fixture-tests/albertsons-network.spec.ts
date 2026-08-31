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
    '    for (var k in window.__lines) list.push({ itemId: k, qty: window.__lines[k] });',
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

describe('Albertsons session probe', () => {
  itWithFixture('search-results-tortillas.html', 'reports logged out without a token', async (runner) => {
    await runner.inject('(function(){ window.AB = { userInfo: {} }; window.SWY = { CONFIGSERVICE: {} }; })(); true;');
    await runner.inject(buildAlbertsonsSessionScript());
    const msg = await runner.waitForMessage('ALB_SESSION', 15_000);
    expect(msg.ok).toBe(true);
    expect(msg.loggedIn).toBe(false);
  });

  itWithFixture('search-results-tortillas.html', 'reports the store and that the cart is actually reachable', async (runner) => {
    await runner.inject(CONTEXT);
    await runner.inject(cartStub({ '1': 1 }));
    await runner.inject(buildAlbertsonsSessionScript());
    const msg = await runner.waitForMessage('ALB_SESSION', 15_000);
    expect(msg.loggedIn).toBe(true);
    expect(msg.storeId).toBe('161');
    expect(msg.hasSearchKey).toBe(true);
    // A token alone is not proof the add path works — the subscription key is a
    // separate gate, so the probe reads the cart to find out.
    expect(msg.cartReadable).toBe(true);
  });
});
