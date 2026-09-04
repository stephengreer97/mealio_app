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
  buildHebCartReadScript,
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
  const addStub = (
    armByProduct: Record<string, string | { arm: string; code?: string; message?: string }>,
    cartLines: unknown[],
  ) => [
    '(function () {',
    '  window.__writes = [];',
    '  var ARMS = ' + JSON.stringify(armByProduct) + ';',
    '  var LINES = ' + JSON.stringify(cartLines) + ';',
    '  window.fetch = function (url, init) {',
    '    var body = JSON.parse(init.body);',
    // ONE DOCUMENT, N ALIASED MUTATIONS. addItemToCartV2 takes a single product,
    // so H-E-B is batched the GraphQL way: a0/a1/... root fields with $p0/$s0/$q0
    // variables, executed serially by the spec. This unpacks that back into the
    // per-write shape the assertions are written against, so what they check --
    // the cap clamp, the omitted preference -- is unchanged.
    '    function unpack(b) {',
    '      var out = [];',
    '      if (b.operationName === "cartItemV2") { out.push(b.variables); return out; }',
    '      if (b.operationName !== "cartItemsV2") return out;',
    '      for (var n = 0; ; n++) {',
    '        if (!(("p" + n) in b.variables)) break;',
    '        var v = { productId: b.variables["p" + n], skuId: b.variables["s" + n],',
    '                  quantity: b.variables["q" + n] };',
    '        if (("r" + n) in b.variables) v.purchasePreferenceId = b.variables["r" + n];',
    '        out.push(v);',
    '      }',
    '      return out;',
    '    }',
    '    var sent = unpack(body);',
    '    if (sent.length > 0) {',
    '      var answers = {};',
    '      for (var w = 0; w < sent.length; w++) {',
    '      var vars = sent[w];',
    '      window.__writes.push(vars);',
    '      var spec = ARMS[vars.productId] || "Cart";',
    // An entry may be a bare arm name, or { arm, code, message } for the error
    // arms — which is what lets a test say what the STORE said, not just that it
    // said no.
    '      var arm = (spec && spec.arm) ? spec.arm : spec;',
    // The cart REFLECTS an accepted write, which a real one does. Without this
    // the stub accepts every write and then reports a cart that never changed,
    // and the rail's own verification -- accepted but absent, write it once more
    // -- fires on every item. That is the verification working; the stub was
    // the unfaithful half.
    '      if (arm === "Cart" || arm === "AddOnsCart") {',
    '        var pid = String(vars.productId);',
    '        var found = null;',
    '        for (var i = 0; i < LINES.length; i++) {',
    '          if (String(LINES[i].product.id) === pid) { found = LINES[i]; break; }',
    '        }',
    '        if (found) found.quantity = vars.quantity;',
    '        else LINES.push({ id: "i" + pid, quantity: vars.quantity,',
    '          estimatedWeight: null, product: { id: pid, fullDisplayName: "X" },',
    '          sku: { id: String(vars.skuId) } });',
    '      }',
    '      var ans = { __typename: arm, id: "c1",',
    '        message: (spec && spec.message) ? spec.message : "Quantity limit reached." };',
    '      if (spec && spec.code) ans.code = spec.code;',
    '      answers[body.operationName === "cartItemV2" ? "single" : ("a" + w)] = ans;',
    '      }',
    '      if (body.operationName === "cartItemV2") {',
    '        return Promise.resolve({ ok: true, status: 200, text: function () {',
    '          return Promise.resolve(JSON.stringify({ data: { addItemToCartV2: answers.single } })); } });',
    '      }',
    '      return Promise.resolve({ ok: true, status: 200, text: function () {',
    '        return Promise.resolve(JSON.stringify({ data: answers })); } });',
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

  itWithFixture('logged-in-home.html', 'an unavailable item is out of stock, not a generic error', async (runner) => {
    // Stephen's run, 2026-09-04 12:09. H-E-B refused the write and SAID WHY:
    //
    //   name 'Morton Salt, 26 oz'  reason 'error_arm'
    //   detail 'This item is out of stock. Try searching for a different item.'
    //
    // error_arm is not a definitive failure, so the reconcile sent it to RETRY.
    // The retry hit the identical wall and the run finished telling him "could
    // not add Morton Salt" with no review card, no alternatives, and nothing he
    // could do — while the store's own message was advising exactly the thing
    // the review screen exists for.
    await runner.inject(addStub({
      '88955': {
        arm: 'AddItemToCartV2Error', code: 'OUT_OF_STOCK',
        message: 'This item is out of stock. Try searching for a different item.',
      },
    }, []));
    await runner.inject(buildHebNetworkAddBatchScript([{
      idx: 0, productId: '88955', skuId: '2460001001', quantity: 1,
      name: 'Morton Salt, 26 oz',
    }])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 15_000);
    expect(res.success).toBe(false);
    // out_of_stock is a DEFINITIVE failure: it routes to review with the
    // ingredient-name candidates, instead of round-tripping the same refusal.
    expect(res.reason).toBe('out_of_stock');
    // The store's own words and its code both reach us — the code was selected
    // by the mutation from the start and had never been read.
    expect(res.code).toBe('OUT_OF_STOCK');
    expect(res.detail).toMatch(/out of stock/i);
  });

  itWithFixture('logged-in-home.html', 'every flavour of UNAVAILABLE goes the same way', async (runner) => {
    // H-E-B's own bundles carry the vocabulary: OUT_OF_STOCK, UNAVAILABLE,
    // UNAVAILABLE_FOR_STORE / _TIMESLOT / _DELIVERY / _PICKUP,
    // ITEM_UNAVAILABLE_DUE_TO_BLACKOUT, UNAVAILABLE_DUE_TO_OUTAGE. Every one of
    // them means the same thing to a shopper — not this product, today — and
    // every one of them is answerable by picking something else.
    await runner.inject(addStub({
      '1': { arm: 'AddItemToCartV2Error', code: 'UNAVAILABLE_FOR_STORE', message: 'no' },
      '2': { arm: 'AddItemToCartV2TimeslotError', code: 'UNAVAILABLE_FOR_TIMESLOT', message: 'no' },
      '3': { arm: 'ITEM_UNAVAILABLE_DUE_TO_BLACKOUT', code: 'ITEM_UNAVAILABLE_DUE_TO_BLACKOUT', message: 'no' },
    }, []));
    await runner.inject(buildHebNetworkAddBatchScript([
      { idx: 0, productId: '1', skuId: 's1', quantity: 1, name: 'A' },
      { idx: 1, productId: '2', skuId: 's2', quantity: 1, name: 'B' },
      { idx: 2, productId: '3', skuId: 's3', quantity: 1, name: 'C' },
    ])!);
    await runner.waitForMessage('NET_ADD_DONE', 20_000);
    const results = runner.messagesOfType('NET_ADD_RESULT') as Array<Record<string, unknown>>;
    expect(results.map((r) => r.reason)).toEqual(['out_of_stock', 'out_of_stock', 'out_of_stock']);
  });

  itWithFixture('logged-in-home.html', 'and a refusal that is NOT about availability still is not', async (runner) => {
    // The other half. A cap, a timeslot conflict, a payment problem — those are
    // not answered by picking a different product, and calling them out of stock
    // would send the user to a review screen to solve the wrong problem.
    await runner.inject(addStub({
      '1': { arm: 'AddItemToCartV2Error', code: 'ALCOHOL_LIMIT', message: 'Too much wine.' },
    }, []));
    await runner.inject(buildHebNetworkAddBatchScript([
      { idx: 0, productId: '1', skuId: 's1', quantity: 1, name: 'A' },
    ])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 15_000);
    expect(res.reason).toBe('error_arm');
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
    // Batched the GraphQL way: N aliased root mutations in one document, so the
    // stub unpacks them back into the per-write shape the assertions use.
    '    function unpack(b) {',
    '      var out = [];',
    '      if (b.operationName === "cartItemV2") { out.push(b.variables); return out; }',
    '      if (b.operationName !== "cartItemsV2") return out;',
    '      for (var n = 0; ; n++) {',
    '        if (!(("p" + n) in b.variables)) break;',
    '        var v = { productId: b.variables["p" + n], skuId: b.variables["s" + n],',
    '                  quantity: b.variables["q" + n] };',
    '        if (("r" + n) in b.variables) v.purchasePreferenceId = b.variables["r" + n];',
    '        out.push(v);',
    '      }',
    '      return out;',
    '    }',
    '    var sent = unpack(body);',
    '    if (sent.length > 0) {',
    '      var answers = {};',
    '      for (var w = 0; w < sent.length; w++) {',
    '      var vars = sent[w];',
    '      window.__writes.push(vars);',
    // An accepted write CHANGES the cart, which a real one does. Without this
    // the rail's own verification -- accepted but absent, so write it once more
    // -- fires on every item, because the stub reports a cart that never moved.
    '      var pid = String(vars.productId);',
    '      var hit = null;',
    '      for (var i = 0; i < window.__lines.length; i++) {',
    '        if (String(window.__lines[i].product.id) === pid) { hit = window.__lines[i]; break; }',
    '      }',
    '      if (hit) hit.quantity = vars.quantity;',
    '      else window.__lines.push({ id: "i" + pid, quantity: vars.quantity,',
    '        estimatedWeight: null, product: { id: pid, fullDisplayName: "X" },',
    '        sku: { id: String(vars.skuId) } });',
    '      answers["a" + w] = { __typename: "Cart", id: "c1" };',
    '      }',
    '      if (body.operationName === "cartItemV2") {',
    '        return Promise.resolve({ ok: true, status: 200, text: function () {',
    '          return Promise.resolve(JSON.stringify({ data: { addItemToCartV2: answers.a0 } })); } });',
    '      }',
    '      return Promise.resolve({ ok: true, status: 200, text: function () {',
    '        return Promise.resolve(JSON.stringify({ data: answers })); } });',
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

  itWithFixture('logged-in-home.html', 'a write the store ACCEPTS but does not apply is caught and re-written', async (runner) => {
    // Stephen's 17:34 run. Eleven writes, all accepted, and the cart came back
    // without the spinach:
    //
    //   NET_ADD_RESULT  name: "Fresh Spinach, 1 Bundle"  sent: 1  success: true
    //   ...and no Spinach line in the cart read a moment later.
    //
    // The mutation selects "... on Cart { id }" and nothing else, so its answer
    // can only say H-E-B TOOK the write. The reconcile caught the miss a second
    // later and topped it up, which is what it is for -- but the rail already
    // reads the cart after the batch and could have caught it itself.
    //
    // This stub accepts the first write and drops it on the floor, then behaves
    // on the second.
    await runner.inject([
      '(function () {',
      '  window.__writes = 0; window.__lines = [];',
      '  window.fetch = function (url, init) {',
      '    var body = JSON.parse(init.body);',
      // Either shape: the batch sends cartItemsV2 with $q0, the unlanded retry
      // sends the single cartItemV2 with $quantity.
      '    var qty = body.operationName === "cartItemsV2" ? body.variables.q0',
      '            : (body.operationName === "cartItemV2" ? body.variables.quantity : null);',
      '    if (qty != null) {',
      '      window.__writes++;',
      '      // The FIRST write is accepted and never applied.',
      '      if (window.__writes > 1) {',
      '        window.__lines = [{ id: "l1", quantity: qty, estimatedWeight: null,',
      '          product: { id: "319108", fullDisplayName: "Fresh Spinach" },',
      '          sku: { id: "4090", customerFriendlySize: "1 Bundle" } }];',
      '      }',
      '      return Promise.resolve({ ok: true, status: 200, text: function () {',
      '        return Promise.resolve(JSON.stringify({ data: body.operationName === "cartItemsV2"',
      '          ? { a0: { __typename: "Cart", id: "c1" } }',
      '          : { addItemToCartV2: { __typename: "Cart", id: "c1" } } })); } });',
      '    }',
      '    return Promise.resolve({ ok: true, status: 200, text: function () {',
      '      return Promise.resolve(JSON.stringify({ data: { cartV2: { __typename: "Cart", id: "c1", items: window.__lines } } })); } });',
      '  };',
      '})(); true;',
    ].join('\n'));

    await runner.inject(buildHebNetworkAddBatchScript([{
      idx: 0, productId: '319108', skuId: '4090', quantity: 1, name: 'Fresh Spinach, 1 Bundle',
    }])!);

    // It says out loud that something it was told landed had not.
    const unlanded = await runner.waitForMessage('NET_ADD_UNLANDED', 15_000);
    expect(unlanded.count).toBe(1);
    expect(unlanded.names).toEqual(['Fresh Spinach, 1 Bundle']);

    const done = await runner.waitForMessage('NET_ADD_DONE', 15_000);
    // Two writes: the accepted-and-lost one, and the retry.
    expect(done.cartAfter).toContainEqual({ name: 'Fresh Spinach, 1 Bundle', qty: 1 });
    // And the per-item record matches the CART, not the mutation.
    const results = runner.messagesOfType('NET_ADD_RESULT');
    expect(results[results.length - 1]).toMatchObject({
      name: 'Fresh Spinach, 1 Bundle', success: true, detail: 'landed on retry',
    });
  });

  itWithFixture('logged-in-home.html', 'a write that is still absent after the retry is reported FAILED', async (runner) => {
    // The other half. Retrying once is the whole allowance: if the cart still
    // does not have it, the run must say so rather than report the mutation's
    // "Cart" as a landing. Reporting it landed is how an item ends up in neither
    // the added list nor the failed one.
    await runner.inject([
      '(function () {',
      '  window.fetch = function (url, init) {',
      '    var body = JSON.parse(init.body);',
      // Both shapes accept and neither ever applies — the point of the case.
      '    if (body.operationName === "cartItemV2" || body.operationName === "cartItemsV2") {',
      '      return Promise.resolve({ ok: true, status: 200, text: function () {',
      '        return Promise.resolve(JSON.stringify({ data: body.operationName === "cartItemsV2"',
      '          ? { a0: { __typename: "Cart", id: "c1" } }',
      '          : { addItemToCartV2: { __typename: "Cart", id: "c1" } } })); } });',
      '    }',
      '    return Promise.resolve({ ok: true, status: 200, text: function () {',
      '      return Promise.resolve(JSON.stringify({ data: { cartV2: { __typename: "Cart", id: "c1", items: [] } } })); } });',
      '  };',
      '})(); true;',
    ].join('\n'));

    await runner.inject(buildHebNetworkAddBatchScript([{
      idx: 0, productId: '319108', skuId: '4090', quantity: 1, name: 'Fresh Spinach, 1 Bundle',
    }])!);

    const done = await runner.waitForMessage('NET_ADD_DONE', 15_000);
    // `wrote` is corrected too, or the run reports adding something it did not.
    expect(done.wrote).toBe(0);
    const results = runner.messagesOfType('NET_ADD_RESULT');
    expect(results[results.length - 1]).toMatchObject({
      name: 'Fresh Spinach, 1 Bundle', success: false, reason: 'cart_not_incremented',
    });
  });

  itWithFixture('logged-in-home.html', 'reads the cart ON ITS OWN, answering as the cart page would', async (runner) => {
    // THE TEST THAT SHOULD HAVE COME WITH THE CODE.
    //
    // cartRead was written on a branch WITH this test, then ported to main
    // without it. The port extracted the wrong lines, so CART_READ_FN shipped
    // EMPTY and every rail cart read threw:
    //
    //   CART_COUNT  count: null  reason: rail_read_threw
    //   detail: "ReferenceError: readCart is not defined"
    //
    // The suite stayed green the whole time, because the add batch still had its
    // own copy of readCart inline and nothing exercised the standalone one.
    // Stephen saw "Couldn't verify your H-E-B cart".
    await runner.inject([
      '(function () {',
      '  window.fetch = function () {',
      '    var out = { data: { cartV2: { __typename: "Cart", id: "c1", items: [',
      '      { id: "l1", quantity: 2, estimatedWeight: null,',
      '        product: { id: "p1", fullDisplayName: "H-E-B Bakery Southwestern Flour Tortillas" },',
      '        sku: { id: "s1", customerFriendlySize: "10 ct" } },',
      '      { id: "l2", quantity: 3, estimatedWeight: null,',
      '        product: { id: "p2", fullDisplayName: "Fresh Lime, Each" },',
      '        sku: { id: "s2", customerFriendlySize: "Each" } }',
      '    ] } } };',
      '    return Promise.resolve({ ok: true, status: 200,',
      '      text: function () { return Promise.resolve(JSON.stringify(out)); } });',
      '  };',
      '})(); true;',
    ].join('\n'));

    await runner.inject(buildHebCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 15_000);
    // Not merely "it answered" — it answered with the CART. A throw also posts a
    // CART_COUNT, which is exactly how this got past the last check.
    expect(msg.reason).toBeUndefined();
    expect(msg.count).toBe(5);            // total quantity, as the page sums it
    expect(msg.items).toEqual([
      { name: 'H-E-B Bakery Southwestern Flour Tortillas, 10 ct', qty: 2 },
      { name: 'Fresh Lime, Each', qty: 3 },
    ]);
  });

  itWithFixture('logged-in-home.html', 'a failed cart read is UNKNOWN, never zero', async (runner) => {
    // A zero would tell the reconcile the cart is empty and invite it to re-add
    // everything the user already has.
    await runner.inject([
      '(function () {',
      '  window.fetch = function () { return Promise.resolve({ ok: false, status: 500,',
      '    text: function () { return Promise.resolve("nope"); } }); };',
      '})(); true;',
    ].join('\n'));

    await runner.inject(buildHebCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 15_000);
    expect(msg.count).toBeNull();
    expect(msg.reason).toBe('rail_read_failed');
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

describe('H-E-B batches too, the GraphQL way', () => {
  // addItemToCartV2 takes a single productId/skuId — there is no list parameter,
  // so H-E-B cannot be batched the way Albertsons was. GraphQL provides the
  // equivalent: several ALIASED root fields in one document. The spec requires
  // root mutation fields to execute SERIALLY, in order, which is exactly what a
  // shared cart needs — one round trip and never two writes in flight against
  // the same cart.

  /** Counts documents, and answers a0/a1/... or the single arm. */
  const countingStub = (opts: { failBatch?: boolean } = {}) => [
    '(function () {',
    '  window.__docs = []; window.__lines = [];',
    '  window.fetch = function (url, init) {',
    '    var body = JSON.parse(init.body);',
    '    if (body.operationName === "cartItemsV2") {',
    '      window.__docs.push({ op: body.operationName, vars: body.variables });',
    opts.failBatch
      ? '      return Promise.resolve({ ok: false, status: 400, text: function () { return Promise.resolve("nope"); } });'
      : [
        '      var answers = {};',
        '      for (var n = 0; ("p" + n) in body.variables; n++) {',
        '        answers["a" + n] = { __typename: "Cart", id: "c1" };',
        '        window.__lines.push({ id: "l" + n, quantity: body.variables["q" + n],',
        '          estimatedWeight: null,',
        '          product: { id: String(body.variables["p" + n]), fullDisplayName: "P" + n },',
        '          sku: { id: String(body.variables["s" + n]) } });',
        '      }',
        '      return Promise.resolve({ ok: true, status: 200, text: function () {',
        '        return Promise.resolve(JSON.stringify({ data: answers })); } });',
      ].join('\n'),
    '    }',
    '    if (body.operationName === "cartItemV2") {',
    '      window.__docs.push({ op: body.operationName, vars: body.variables });',
    '      window.__lines.push({ id: "s" + window.__docs.length, quantity: body.variables.quantity,',
    '        estimatedWeight: null,',
    '        product: { id: String(body.variables.productId), fullDisplayName: "P" },',
    '        sku: { id: String(body.variables.skuId) } });',
    '      return Promise.resolve({ ok: true, status: 200, text: function () {',
    '        return Promise.resolve(JSON.stringify({ data: { addItemToCartV2: { __typename: "Cart", id: "c1" } } })); } });',
    '    }',
    '    return Promise.resolve({ ok: true, status: 200, text: function () {',
    '      return Promise.resolve(JSON.stringify({ data: { cartV2: { __typename: "Cart", id: "c1", items: window.__lines } } })); } });',
    '  };',
    '})(); true;',
  ].join('\n');

  const docsProbe = '(function(){ window.ReactNativeWebView.postMessage(JSON.stringify('
    + '{ type: "DOCS", docs: window.__docs })); })(); true;';

  const four = [1, 2, 3, 4].map((n) => ({
    idx: n - 1, productId: String(300 + n), skuId: String(400 + n),
    quantity: n === 3 ? 2 : 1, name: 'Item ' + n,
  }));

  itWithFixture('logged-in-home.html', 'four items, one document', async (runner) => {
    await runner.inject(countingStub());
    await runner.inject(buildHebNetworkAddBatchScript(four)!);
    const done = await runner.waitForMessage('NET_ADD_DONE', 25_000);
    expect(done.wrote).toBe(4);

    await runner.inject(docsProbe);
    const seen = await runner.waitForMessage('DOCS', 10_000);
    const writes = seen.docs.filter((d: { op: string }) => d.op !== 'cartV2');
    expect(writes.length).toBe(1);
    expect(writes[0].op).toBe('cartItemsV2');
    // Quantities stay per item and absolute.
    expect(writes[0].vars.q2).toBe(2);
    expect(writes[0].vars.p0).toBe('301');
  });

  itWithFixture('logged-in-home.html', 'every item still gets its own verdict', async (runner) => {
    await runner.inject(countingStub());
    await runner.inject(buildHebNetworkAddBatchScript(four)!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    const results = runner.messagesOfType('NET_ADD_RESULT') as Array<Record<string, unknown>>;
    expect(results.length).toBe(4);
    expect(results.every((r) => r.success === true)).toBe(true);
    expect(new Set(results.map((r) => r.idx)).size).toBe(4);
  });

  itWithFixture('logged-in-home.html', 'a document the gateway refuses falls back per item', async (runner) => {
    // A gateway that dislikes the shape must not be able to take a whole run
    // with it. This is the only reason the single-write path still exists.
    await runner.inject(countingStub({ failBatch: true }));
    await runner.inject(buildHebNetworkAddBatchScript(four)!);
    const fell = await runner.waitForMessage('NET_ADD_BATCH_FELL_BACK', 25_000);
    expect(fell.count).toBe(4);
    const done = await runner.waitForMessage('NET_ADD_DONE', 25_000);
    expect(done.wrote).toBe(4);

    await runner.inject(docsProbe);
    const seen = await runner.waitForMessage('DOCS', 10_000);
    const singles = seen.docs.filter((d: { op: string }) => d.op === 'cartItemV2');
    expect(singles.length).toBe(4);
  });
});
