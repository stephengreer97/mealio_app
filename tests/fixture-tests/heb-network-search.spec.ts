// H-E-B search over the network (MEAL-202).
//
// The contract under test is not "a request goes out" — it is that a candidate
// produced from the network is INDISTINGUISHABLE from one the page reader
// produces. Everything downstream (the exact-name add gate, the review screen,
// the weight chooser, the preference modal) reads that shape and must not be
// able to tell which path filled it.
//
// So these tests assert the shape, the name (which the add path matches
// EXACTLY, so a missing size means matching nothing), and the failure
// behaviour — because the caller's answer to every failure is the same: load the
// page and read it, and that only works if failure is reported rather than
// thrown.

import {
  buildHebNetworkAddBatchScript,
  buildHebNetworkSearchBatchScript,
  buildHebNetworkSearchScript,
  buildHebSessionScript,
} from '../../src/lib/webview-scripts/heb-network-search';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('heb');

/** One product as H-E-B's gateway returns it. */
function product(over: Record<string, unknown> = {}) {
  return {
    __typename: 'Product',
    id: '314026',
    displayName: 'H-E-B Regular Sour Cream',
    decodedDisplayName: 'H-E-B Regular Sour Cream',
    fullDisplayName: 'H-E-B Regular Sour Cream',
    pricedByWeight: false,
    shoppingContext: 'CURBSIDE_DELIVERY',
    minimumOrderQuantity: 1,
    maximumOrderQuantity: 20,
    inventory: { inventoryState: 'IN_STOCK' },
    productImageUrls: [
      { size: 'SMALL', url: 'https://images.heb.com/small/000314026.jpg' },
      { size: 'MEDIUM', url: 'https://images.heb.com/medium/000314026.jpg' },
    ],
    purchasePreferenceList: null,
    SKUs: [{
      id: '4122025475',
      customerFriendlySize: '16 oz',
      weightSelectionIncrements: [],
      contextPrices: [{ context: 'CURBSIDE', salePrice: null, listPrice: { formattedAmount: '$2.48' } }],
    }],
    ...over,
  };
}

/** Replace fetch so no test reaches H-E-B, and record what was asked for. */
function stub(payload: unknown, opts: { status?: number; body?: string } = {}) {
  return [
    '(function () {',
    '  window.__calls = [];',
    '  window.fetch = function (url, init) {',
    '    var body = null;',
    '    try { body = JSON.parse((init && init.body) || "null"); } catch (e) {}',
    '    window.__calls.push(body);',
    '    return Promise.resolve({',
    '      ok: ' + String((opts.status ?? 200) < 400) + ',',
    '      status: ' + String(opts.status ?? 200) + ',',
    '      text: function () { return Promise.resolve(' +
        (opts.body !== undefined ? JSON.stringify(opts.body) : JSON.stringify(JSON.stringify(payload))) + '); },',
    '    });',
    '  };',
    '})(); true;',
  ].join('\n');
}

const searchPayload = (items: unknown[]) => ({
  data: {
    productSearchPageV2: {
      __typename: 'SearchPage',
      layout: { visualComponents: [{ __typename: 'SearchGridV2', items }] },
    },
  },
});

const REPORT_CALLS = [
  '(function () {',
  '  var last = null;',
  '  for (var i = 0; i < (window.__calls || []).length; i++) last = window.__calls[i];',
  '  window.ReactNativeWebView.postMessage(JSON.stringify({',
  '    type: "CALLS", count: (window.__calls || []).length,',
  '    params: last && last.variables ? last.variables.params : null,',
  '  }));',
  '})(); true;',
].join('\n');

const search = (over: Record<string, unknown> = {}) =>
  buildHebNetworkSearchScript('H-E-B Regular Sour Cream, 16 oz', {
    storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY', ...over,
  })!;

describe('HEB MEAL-202: search over the network', () => {
  itWithFixture('logged-in-home.html', 'produces the same candidate shape the page readers do', async (runner) => {
    await runner.inject(stub(searchPayload([product()])));
    await runner.inject(search());
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000);
    expect(msg.source).toBe('network');
    expect(msg.candidates).toHaveLength(1);
    const c = msg.candidates[0];
    // Every key the page readers emit, none missing, none extra in meaning.
    expect(c).toEqual({
      // The size is appended because the CARD carries it and the add path
      // matches names exactly — without it this candidate matches nothing.
      productName: 'H-E-B Regular Sour Cream, 16 oz',
      imageUrl: 'https://images.heb.com/medium/000314026.jpg',
      outOfStock: false,
      preferences: null,
      price: '$2.48',
      isWeightItem: false,
      weightOptions: [],
      productId: '314026',
      skuId: '4122025475',
      // The store's per-item cap, carried because the write sets an ABSOLUTE
      // quantity and cart-held + asked can exceed it.
      maxOrderQuantity: 20,
    });
  });

  itWithFixture('logged-in-home.html', 'asks the store not to send sponsored tiles', async (runner) => {
    // The page reader has to RECOGNISE sponsored tiles and discard them, which is
    // where a whole class of extraction bug lives. Not asking for them means they
    // cannot be mistaken for a result at all.
    await runner.inject(stub(searchPayload([product()])));
    await runner.inject(search());
    await runner.waitForMessage('SEARCH_RESULT', 15_000);
    runner.clearMessages();
    await runner.inject(REPORT_CALLS);
    const calls = await runner.waitForMessage('CALLS', 10_000);
    expect(calls.params.excludeSponsoredContent).toBe(true);
    expect(calls.params.storeId).toBe(476);
    expect(calls.params.shoppingContext).toBe('CURBSIDE_DELIVERY');
    expect(calls.params.pageSize).toBeGreaterThan(10);
  });

  itWithFixture('logged-in-home.html', 'reports out of stock from the field, not from button text', async (runner) => {
    await runner.inject(stub(searchPayload([product({ inventory: { inventoryState: 'OUT_OF_STOCK' } })])));
    await runner.inject(search());
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000);
    expect(msg.candidates[0].outOfStock).toBe(true);
  });

  itWithFixture('logged-in-home.html', 'carries weight options and preferences through', async (runner) => {
    await runner.inject(stub(searchPayload([product({
      pricedByWeight: true,
      purchasePreferenceList: { label: 'thickness', purchasePreferences: [
        { preferenceId: 'default', text: 'No preference' },
        { preferenceId: 'b58', text: 'Shaved' },
      ] },
      SKUs: [{ id: 'S1', customerFriendlySize: 'lb', weightSelectionIncrements: [0.25, 0.5, 1], contextPrices: [] }],
    })])));
    await runner.inject(search());
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000);
    const c = msg.candidates[0];
    expect(c.isWeightItem).toBe(true);
    expect(c.weightOptions).toEqual([0.25, 0.5, 1]);
    // text/value keep the shape the page path built from a modal row label, so a
    // candidate stays interchangeable. preferenceId is additive and only the
    // network add reads it — the page path cannot click an id.
    expect(c.preferences).toEqual([
      { text: 'No preference', value: 'No preference', preferenceId: 'default' },
      { text: 'Shaved', value: 'Shaved', preferenceId: 'b58' },
    ]);
  });

  itWithFixture('logged-in-home.html', 'tells the caller to fall back when the wall is up', async (runner) => {
    // Every failure has the same answer — load the page and read it — so failure
    // has to be REPORTED, never thrown, or the run stalls instead of falling back.
    await runner.inject(stub(null, { status: 403, body: '<html>blocked</html>' }));
    await runner.inject(search());
    const msg = await runner.waitForMessage('SEARCH_RESULT_FAILED', 15_000);
    expect(msg.why).toBe('blocked');
    expect(msg.source).toBe('network');
  });

  itWithFixture('logged-in-home.html', 'treats a page with no grid as no results, not as a failure', async (runner) => {
    // A no-results search renders a different set of components instead of an
    // empty grid. Calling that a transport failure sent the caller off to load a
    // page that would show the same nothing 1.8 s later — and on the first device
    // run it fell the ENTIRE run back to the pool over one such term.
    await runner.inject(stub({
      data: { productSearchPageV2: { __typename: 'SearchPage',
        layout: { visualComponents: [{ __typename: 'SearchSuggestions' }] } } },
    }));
    await runner.inject(search());
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000);
    expect(msg.candidates).toEqual([]);
    expect(msg.noGrid).toBe(true);
  });

  itWithFixture('logged-in-home.html', 'separates "no such product" from "could not ask"', async (runner) => {
    // An EMPTY grid is a real answer and must NOT trigger a page load: the store
    // genuinely has nothing, and re-asking a slower way changes nothing.
    await runner.inject(stub(searchPayload([])));
    await runner.inject(search());
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000);
    expect(msg.candidates).toEqual([]);
  });
});

describe('HEB MEAL-202: the store id', () => {
  it('refuses a store id that is not a positive whole number', () => {
    // "abc" | 0 is 0 — a real store id somewhere, answering with a real
    // catalogue for a shop the user has never been to, with nothing to notice.
    for (const bad of ['', 'abc', '0', '-5', '47.6', 'null']) {
      expect(buildHebNetworkSearchScript('milk', { storeId: bad, shoppingContext: 'CURBSIDE_DELIVERY' })).toBeNull();
    }
    expect(buildHebNetworkSearchScript('milk', { storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY' })).not.toBeNull();
  });

  it('refuses a missing shopping context', () => {
    // Pickup and delivery price and stock differently, so guessing one is not
    // a harmless default.
    expect(buildHebNetworkSearchScript('milk', { storeId: '476', shoppingContext: '' })).toBeNull();
  });
});

describe('HEB MEAL-202: the session, which is also the login gate', () => {
  itWithFixture('logged-in-home.html', 'reports signed out when there is no user', async (runner) => {
    await runner.inject(stub({ data: { me: null } }));
    await runner.inject(buildHebSessionScript());
    const msg = await runner.waitForMessage('HEB_SESSION', 15_000);
    expect(msg.ok).toBe(true);
    expect(msg.loggedIn).toBe(false);
  });

  itWithFixture('logged-in-home.html', 'takes the store from fulfillment, not from the preferred store', async (runner) => {
    // These are two different identifiers for one shop — measured 243 and 476.
    // Search wants the fulfillment store's id; the preferred store's NUMBER
    // searches a different catalogue and looks entirely reasonable doing it.
    await runner.inject([
      '(function () {',
      '  window.fetch = function (url, init) {',
      '    var body = JSON.parse(init.body);',
      '    var payload = body.operationName === "myPreferredStore"',
      '      ? { data: { me: { id: "u1", preferredStore: { storeNumber: 243 } } } }',
      '      : { data: { cartV2: { __typename: "Cart", id: "c1", fulfillment: {',
      '            selectionState: "SELECTED", curbsideFulfillmentMode: "delivery",',
      '            store: { id: "476", name: "Tech Ridge H-E-B" } } } } };',
      '    return Promise.resolve({ ok: true, status: 200,',
      '      text: function () { return Promise.resolve(JSON.stringify(payload)); } });',
      '  };',
      '})(); true;',
    ].join('\n'));
    await runner.inject(buildHebSessionScript());
    const msg = await runner.waitForMessage('HEB_SESSION', 15_000);
    expect(msg.loggedIn).toBe(true);
    expect(msg.storeId).toBe('476');
    expect(msg.preferredStoreNumber).toBe('243');
    expect(msg.shoppingContext).toBe('CURBSIDE_DELIVERY');
  });

  itWithFixture('logged-in-home.html', 'maps a pickup session to the pickup context', async (runner) => {
    await runner.inject([
      '(function () {',
      '  window.fetch = function (url, init) {',
      '    var body = JSON.parse(init.body);',
      '    var payload = body.operationName === "myPreferredStore"',
      '      ? { data: { me: { id: "u1", preferredStore: { storeNumber: 243 } } } }',
      '      : { data: { cartV2: { __typename: "Cart", id: "c1", fulfillment: {',
      '            selectionState: "SELECTED", curbsideFulfillmentMode: "PICKUP",',
      '            store: { id: "476", name: "Tech Ridge H-E-B" } } } } };',
      '    return Promise.resolve({ ok: true, status: 200,',
      '      text: function () { return Promise.resolve(JSON.stringify(payload)); } });',
      '  };',
      '})(); true;',
    ].join('\n'));
    await runner.inject(buildHebSessionScript());
    const msg = await runner.waitForMessage('HEB_SESSION', 15_000);
    expect(msg.shoppingContext).toBe('CURBSIDE_PICKUP');
  });
});

describe('HEB MEAL-202: many terms, one page, no navigation', () => {
  // This is where the run's time actually goes. The worker pool exists to load
  // four results pages at once because loading a page is the ~1.8 s cost per
  // ingredient; a network search needs no page, so twelve ingredients are twelve
  // requests from where the WebView already is.
  const batch = (terms: string[], over: Record<string, unknown> = {}) =>
    buildHebNetworkSearchBatchScript(terms, {
      storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY', ...over,
    })!;

  itWithFixture('logged-in-home.html', 'answers every term and says when it is finished', async (runner) => {
    await runner.inject(stub(searchPayload([product()])));
    await runner.inject(batch(['sour cream', 'tortillas', 'limes']));
    const done = await runner.waitForMessage('SEARCH_BATCH_DONE', 20_000);
    expect(done.count).toBe(3);
    const results = runner.messagesOfType('SEARCH_RESULT');
    expect(results).toHaveLength(3);
    expect(results.map((r: any) => r.term).sort()).toEqual(['limes', 'sour cream', 'tortillas']);
  });

  itWithFixture('logged-in-home.html', 'answers a ONE-term batch — that is a substitute search', async (runner) => {
    // "Pick a Substitute" runs a search of its own. On a network store it has to
    // be this same rail: the DOM search drives the store's header search box,
    // which does not exist on the cart page a network run finishes on, so it
    // found no input, returned silently, and the screen sat there until the
    // 15s recovery timeout. Stephen typed "Onion" and nothing happened.
    await runner.inject(stub(searchPayload([product({ productName: 'Fresh White Onion' })])));
    await runner.inject(batch(['Onion']));
    const done = await runner.waitForMessage('SEARCH_BATCH_DONE', 20_000);
    expect(done.count).toBe(1);
    const results = runner.messagesOfType('SEARCH_RESULT');
    expect(results).toHaveLength(1);
    expect(results[0].term).toBe('Onion');
    // Candidates are the whole point — an empty answer is the same dead end.
    expect(results[0].candidates.length).toBeGreaterThan(0);
  });

  itWithFixture('logged-in-home.html', 'never loads a page — the WebView stays put', async (runner) => {
    // The whole point. If this ever starts navigating, the speed is gone and the
    // worker WebViews come back with it.
    // Read from inside the page, which is the only place that knows.
    const whereAmI = '(function(){ window.ReactNativeWebView.postMessage(JSON.stringify({ type: "WHERE", href: location.href })); })(); true;';
    await runner.inject(whereAmI);
    const before = (await runner.waitForMessage('WHERE', 10_000)).href;
    runner.clearMessages();
    await runner.inject(stub(searchPayload([product()])));
    await runner.inject(batch(['sour cream', 'tortillas']));
    await runner.waitForMessage('SEARCH_BATCH_DONE', 20_000);
    await runner.inject(whereAmI);
    expect((await runner.waitForMessage('WHERE', 10_000)).href).toBe(before);
    // And every result carries the identifiers the network ADD needs, which is
    // the thing a page-read candidate cannot supply.
    for (const r of runner.messagesOfType('SEARCH_RESULT')) {
      expect(r.candidates[0].productId).toBe('314026');
      expect(r.candidates[0].skuId).toBe('4122025475');
    }
  });

  itWithFixture('logged-in-home.html', 'reports failures per term, not per batch', async (runner) => {
    // A term that fails must not take the other eleven down with it: the caller
    // falls back to loading a page for JUST that term.
    await runner.inject([
      '(function () {',
      '  window.fetch = function (url, init) {',
      '    var body = JSON.parse(init.body);',
      '    var term = body.variables.params.query;',
      '    if (term === "tortillas") {',
      '      return Promise.resolve({ ok: false, status: 403,',
      '        text: function () { return Promise.resolve("<html>blocked</html>"); } });',
      '    }',
      '    return Promise.resolve({ ok: true, status: 200, text: function () {',
      '      return Promise.resolve(JSON.stringify(' + JSON.stringify(searchPayload([product()])) + '));',
      '    } });',
      '  };',
      '})(); true;',
    ].join('\n'));
    await runner.inject(batch(['sour cream', 'tortillas', 'limes']));
    await runner.waitForMessage('SEARCH_BATCH_DONE', 20_000);
    const ok = runner.messagesOfType('SEARCH_RESULT').map((r: any) => r.term).sort();
    const bad = runner.messagesOfType('SEARCH_RESULT_FAILED');
    expect(ok).toEqual(['limes', 'sour cream']);
    expect(bad).toHaveLength(1);
    expect(bad[0].term).toBe('tortillas');
    expect(bad[0].why).toBe('blocked');
  });

  itWithFixture('logged-in-home.html', 'keeps concurrency small rather than firing all at once', async (runner) => {
    // Twelve simultaneous requests is a burst shape nothing has measured. The
    // bot defence tolerated 30 writes at about 2/s (MEAL-115); this stays inside
    // what has actually been observed.
    await runner.inject([
      '(function () {',
      '  window.__inflight = 0; window.__peak = 0;',
      '  window.fetch = function () {',
      '    window.__inflight++;',
      '    if (window.__inflight > window.__peak) window.__peak = window.__inflight;',
      '    return new Promise(function (resolve) {',
      '      setTimeout(function () {',
      '        window.__inflight--;',
      '        resolve({ ok: true, status: 200, text: function () {',
      '          return Promise.resolve(JSON.stringify(' + JSON.stringify(searchPayload([product()])) + ')); } });',
      '      }, 60);',
      '    });',
      '  };',
      '})(); true;',
    ].join('\n'));
    await runner.inject(batch(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']));
    await runner.waitForMessage('SEARCH_BATCH_DONE', 20_000);
    await runner.inject('(function(){ window.ReactNativeWebView.postMessage(JSON.stringify({ type: "PEAK", peak: window.__peak })); })(); true;');
    const peak = await runner.waitForMessage('PEAK', 10_000);
    expect(peak.peak).toBeLessThanOrEqual(3);
    expect(peak.peak).toBeGreaterThan(1);
  });

  it('refuses a batch it cannot address', () => {
    expect(buildHebNetworkSearchBatchScript([], { storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY' })).toBeNull();
    expect(buildHebNetworkSearchBatchScript(['x'], { storeId: 'abc', shoppingContext: 'CURBSIDE_DELIVERY' })).toBeNull();
    expect(buildHebNetworkSearchBatchScript(['x'], { storeId: '476', shoppingContext: '' })).toBeNull();
  });
});

describe('HEB MEAL-202: the store\'s own limits', () => {
  const addStub = (armByProduct: Record<string, string>, cartLines: unknown[]) => [
    '(function () {',
    '  window.__writes = [];',
    '  var ARMS = ' + JSON.stringify(armByProduct) + ';',
    '  var LINES = ' + JSON.stringify(cartLines) + ';',
    '  window.fetch = function (url, init) {',
    '    var body = JSON.parse(init.body);',
    '    if (body.operationName === "cartItemV2") {',
    '      window.__writes.push(body.variables);',
    '      var arm = ARMS[body.variables.productId] || "Cart";',
    '      return Promise.resolve({ ok: true, status: 200, text: function () {',
    '        return Promise.resolve(JSON.stringify({ data: { addItemToCartV2: {',
    '          __typename: arm, id: "c1", message: "Quantity limit reached." } } })); } });',
    '    }',
    '    return Promise.resolve({ ok: true, status: 200, text: function () {',
    '      return Promise.resolve(JSON.stringify({ data: { cartV2: {',
    '        __typename: "Cart", id: "c1", items: LINES } } })); } });',
    '  };',
    '})(); true;',
  ].join('\n');

  const line = (pid: string, qty: number) => ({
    id: 'i' + pid, quantity: qty, estimatedWeight: null,
    product: { id: pid, fullDisplayName: 'X' }, sku: { id: 's' + pid },
  });

  const REPORT_WRITES = [
    '(function () {',
    '  window.ReactNativeWebView.postMessage(JSON.stringify({ type: "WRITES", writes: window.__writes || [] }));',
    '})(); true;',
  ].join('\n');

  itWithFixture('logged-in-home.html', 'clamps to the cap instead of being refused outright', async (runner) => {
    // The write sets an ABSOLUTE quantity, so cart-held + asked can exceed the
    // store's per-item cap and it refuses the WHOLE write. Measured on a device:
    // an avocado came back "Quantity limit reached." because earlier runs had
    // already stocked the cart. Adding what fits beats adding nothing.
    await runner.inject(addStub({}, [line('377478', 18)]));
    await runner.inject(buildHebNetworkAddBatchScript([{
      idx: 0, productId: '377478', skuId: '4046', quantity: 3,
      name: 'Fresh Small Hass Avocado, Each', maxOrderQuantity: 20,
    }])!);
    await runner.waitForMessage('NET_ADD_DONE', 15_000);
    runner.clearMessages();
    await runner.inject(REPORT_WRITES);
    const w = await runner.waitForMessage('WRITES', 10_000);
    // 18 held + 3 asked = 21, over the cap of 20 — so it asks for 20, not 21.
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0].quantity).toBe(20);
  });

  itWithFixture('logged-in-home.html', 'refuses rather than writing a quantity the cart already has', async (runner) => {
    // Clamping to a number the cart ALREADY holds writes no change and would
    // report success — an under-add dressed as a win. It has to be a failure.
    await runner.inject(addStub({}, [line('377478', 20)]));
    await runner.inject(buildHebNetworkAddBatchScript([{
      idx: 0, productId: '377478', skuId: '4046', quantity: 3,
      name: 'Fresh Small Hass Avocado, Each', maxOrderQuantity: 20,
    }])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 15_000);
    expect(res.success).toBe(false);
    expect(res.reason).toBe('quantity_limit_reached');
    runner.clearMessages();
    await runner.inject(REPORT_WRITES);
    expect((await runner.waitForMessage('WRITES', 10_000)).writes).toHaveLength(0);
  });

  itWithFixture('logged-in-home.html', 'sends a chosen purchase preference, and omits it when there is none', async (runner) => {
    // Deli thickness, avocado ripeness. The storefront OMITS the field rather
    // than nulling it when nothing was chosen, and a null is a different
    // statement from an absent one.
    await runner.inject(addStub({}, []));
    await runner.inject(buildHebNetworkAddBatchScript([
      { idx: 0, productId: '1', skuId: 's1', quantity: 1, name: 'Sliced', purchasePreferenceId: 'b58-shaved' },
      { idx: 1, productId: '2', skuId: 's2', quantity: 1, name: 'Plain' },
    ])!);
    await runner.waitForMessage('NET_ADD_DONE', 15_000);
    runner.clearMessages();
    await runner.inject(REPORT_WRITES);
    const w = await runner.waitForMessage('WRITES', 10_000);
    const withPref = w.writes.find((v: any) => v.productId === '1');
    const without = w.writes.find((v: any) => v.productId === '2');
    expect(withPref.purchasePreferenceId).toBe('b58-shaved');
    expect('purchasePreferenceId' in without).toBe(false);
  });
});

describe('HEB MEAL-202: an out-of-stock exact match must not change rails', () => {
  // Measured on a device: an out-of-stock product was reported as
  // low_confidence, which sent it to the reconcile's top-up — abandoning a rail
  // that answered in 280 ms to LOAD A PAGE and be told the same thing 1.8 s
  // later. The store has it and will not sell it today; re-asking finds that out
  // again. The reason has to say so, because the reconcile routes on it.
  const oos = (over: Record<string, unknown> = {}) => product({
    inventory: { inventoryState: 'OUT_OF_STOCK' }, ...over,
  });

  itWithFixture('logged-in-home.html', 'marks an out-of-stock exact match out_of_stock, not low_confidence', async (runner) => {
    await runner.inject(stub(searchPayload([oos()])));
    await runner.inject(search());
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000);
    // The search itself just reports the flag; the routing decision is the
    // engine's, and it needs this to be true to make it.
    expect(msg.candidates[0].outOfStock).toBe(true);
    expect(msg.candidates[0].productName).toBe('H-E-B Regular Sour Cream, 16 oz');
  });
});

describe('HEB MEAL-202: the absolute quantity, and what it makes unsafe', () => {
  const addStub2 = (cartLines: unknown[]) => [
    '(function () {',
    '  window.__writes = [];',
    '  var LINES = ' + JSON.stringify([]) + ';',
    '  window.__lines = ' + JSON.stringify(cartLines) + ';',
    '  window.fetch = function (url, init) {',
    '    var body = JSON.parse(init.body);',
    '    if (body.operationName === "cartItemV2") {',
    '      window.__writes.push(body.variables);',
    '      return Promise.resolve({ ok: true, status: 200, text: function () {',
    '        return Promise.resolve(JSON.stringify({ data: { addItemToCartV2: { __typename: "Cart", id: "c1" } } })); } });',
    '    }',
    '    return Promise.resolve({ ok: true, status: 200, text: function () {',
    '      return Promise.resolve(JSON.stringify({ data: { cartV2: { __typename: "Cart", id: "c1", items: window.__lines } } })); } });',
    '  };',
    '})(); true;',
  ].join('\n');

  const cartLine = (pid: string, qty: number) => ({
    id: 'i' + pid, quantity: qty, estimatedWeight: null,
    product: { id: pid, fullDisplayName: 'X' }, sku: { id: 's' + pid },
  });

  const REPORT = [
    '(function () {',
    '  window.ReactNativeWebView.postMessage(JSON.stringify({ type: "WRITES", writes: window.__writes || [] }));',
    '})(); true;',
  ].join('\n');

  itWithFixture('logged-in-home.html', 'declines a preference write when the product already has a line', async (runner) => {
    // Lines are keyed by preference and the cart read does not say which one a
    // line belongs to. One existing line of 2 under "Ripe" plus a write under
    // "Firm" would set the Firm line to 2 + asked while Ripe keeps its 2 — the
    // cart ends up over by 2, and the single-line case slips past the multi-line
    // guard precisely because there is only one line so far.
    await runner.inject(addStub2([cartLine('377478', 2)]));
    await runner.inject(buildHebNetworkAddBatchScript([{
      idx: 0, productId: '377478', skuId: '4046', quantity: 1,
      name: 'Avocado', purchasePreferenceId: 'firm',
    }])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 15_000);
    expect(res.success).toBe(false);
    expect(res.reason).toBe('preference_line_ambiguous');
    runner.clearMessages();
    await runner.inject(REPORT);
    expect((await runner.waitForMessage('WRITES', 10_000)).writes).toHaveLength(0);
  });

  itWithFixture('logged-in-home.html', 'still writes a preference for a product the cart does not hold', async (runner) => {
    await runner.inject(addStub2([]));
    await runner.inject(buildHebNetworkAddBatchScript([{
      idx: 0, productId: '377478', skuId: '4046', quantity: 1,
      name: 'Avocado', purchasePreferenceId: 'firm',
    }])!);
    await runner.waitForMessage('NET_ADD_DONE', 15_000);
    runner.clearMessages();
    await runner.inject(REPORT);
    const w = await runner.waitForMessage('WRITES', 10_000);
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0].purchasePreferenceId).toBe('firm');
  });
});

describe('MEAL-209: the done screen breakdown comes off the rail, not a page load', () => {
  const line = (name: string, quantity: number, over: Record<string, unknown> = {}) => ({
    id: 'l' + name, quantity, estimatedWeight: null,
    product: { id: 'p' + name, fullDisplayName: name }, sku: { id: 's' + name }, ...over,
  });

  itWithFixture('logged-in-home.html', 'reports the cart before and after, in the shape the diff expects', async (runner) => {
    // Two reads already happened here — the rail just threw the rows away and
    // posted a count, which is why the breakdown needed a cart page.
    await runner.inject([
      '(function () {',
      '  var n = 0;',
      '  window.fetch = function (url, init) {',
      '    var body = JSON.parse((init && init.body) || "{}");',
      '    var out;',
      '    if (body.operationName === "CartLines") {',
      '      n++;',
      // Before: one item the user already had. After: that plus what we wrote.
      '      var items = n === 1',
      '        ? [' + JSON.stringify(line('Eggs', 2)) + ']',
      '        : [' + JSON.stringify(line('Eggs', 2)) + ', ' + JSON.stringify(line('Sour Cream', 1)) + '];',
      '      out = { data: { cartV2: { __typename: "Cart", id: "c1", items: items } } };',
      '    } else {',
      '      out = { data: { addItemToCartV2: { __typename: "Cart", id: "c1" } } };',
      '    }',
      '    return Promise.resolve({ ok: true, status: 200,',
      '      text: function () { return Promise.resolve(JSON.stringify(out)); } });',
      '  };',
      '})(); true;',
    ].join('\n'));

    await runner.inject(buildHebNetworkAddBatchScript([
      { idx: 0, productId: 'pSour Cream', skuId: 'sSour Cream', quantity: 1, name: 'Sour Cream' },
    ])!);

    const done = await runner.waitForMessage('NET_ADD_DONE', 15_000);
    expect(Array.isArray(done.cartBefore)).toBe(true);
    expect(Array.isArray(done.cartAfter)).toBe(true);
    // The user's own item is in BOTH, so the diff can render it grey rather than
    // crediting this run with it.
    expect(done.cartBefore).toEqual([{ name: 'Eggs', qty: 2 }]);
    expect(done.cartAfter).toEqual([{ name: 'Eggs', qty: 2 }, { name: 'Sour Cream', qty: 1 }]);
  });

  itWithFixture('logged-in-home.html', 'cart rows carry the SIZE, or the done screen reshuffles', async (runner) => {
    // These rows are diffed against the cart-page probe's rows BY NAME, and the
    // probe reads the card, which says "..., 10 ct". Without the size nothing
    // matched: the done screen opened with every line green, then redrew into
    // green-and-grey the moment the probe answered. Stephen saw the list
    // separate itself in front of him.
    await runner.inject([
      '(function () {',
      '  window.fetch = function (url, opts) {',
      '    var body = JSON.parse(opts.body); var out;',
      '    if (body.operationName === "CartLines") {',
      '      out = { data: { cartV2: { __typename: "Cart", id: "c1", items: [',
      '        { id: "l1", quantity: 2, estimatedWeight: null,',
      '          product: { id: "p1", fullDisplayName: "H-E-B Bakery Southwestern Flour Tortillas" },',
      '          sku: { id: "s1", customerFriendlySize: "10 ct" } },',
      '        { id: "l2", quantity: 1, estimatedWeight: null,',
      '          product: { id: "p2", fullDisplayName: "Fresh Lime, Each" },',
      '          sku: { id: "s2", customerFriendlySize: "Each" } }',
      '      ] } } };',
      '    } else {',
      '      out = { data: { addItemToCartV2: { __typename: "Cart", id: "c1" } } };',
      '    }',
      '    return Promise.resolve({ ok: true, status: 200,',
      '      text: function () { return Promise.resolve(JSON.stringify(out)); } });',
      '  };',
      '})(); true;',
    ].join('\n'));

    await runner.inject(buildHebNetworkAddBatchScript([
      { idx: 0, productId: 'p1', skuId: 's1', quantity: 1, name: 'x' },
    ])!);

    const done = await runner.waitForMessage('NET_ADD_DONE', 15_000);
    // The size is appended...
    expect(done.cartBefore).toContainEqual({ name: 'H-E-B Bakery Southwestern Flour Tortillas, 10 ct', qty: 2 });
    // ...and NOT duplicated when the name already ends in it.
    expect(done.cartBefore).toContainEqual({ name: 'Fresh Lime, Each', qty: 1 });
  });

  itWithFixture('logged-in-home.html', 'marks a weight line by presence, as the page reader does', async (runner) => {
    await runner.inject([
      '(function () {',
      '  window.fetch = function (url, init) {',
      '    var body = JSON.parse((init && init.body) || "{}");',
      '    var out = body.operationName === "CartLines"',
      '      ? { data: { cartV2: { __typename: "Cart", id: "c1", items: [',
      '          ' + JSON.stringify(line('Deli Turkey', 1, { estimatedWeight: 0.75 })),
      '        ] } } }',
      '      : { data: { addItemToCartV2: { __typename: "Cart", id: "c1" } } };',
      '    return Promise.resolve({ ok: true, status: 200,',
      '      text: function () { return Promise.resolve(JSON.stringify(out)); } });',
      '  };',
      '})(); true;',
    ].join('\n'));
    await runner.inject(buildHebNetworkAddBatchScript([
      { idx: 0, productId: 'x', skuId: 'y', quantity: 1, name: 'x' },
    ])!);
    const done = await runner.waitForMessage('NET_ADD_DONE', 15_000);
    expect(done.cartAfter[0]).toEqual({ name: 'Deli Turkey', qty: 1, isWeight: true, weight: 0.75 });
  });
});
