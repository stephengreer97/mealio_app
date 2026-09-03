/**
 * The Walmart rail, against a stubbed store.
 *
 * Everything asserted here was MEASURED against a signed-in session on
 * 2026-09-03 (docs/network-rail-research/03-walmart.md). The stub answers the
 * shapes the real store answers — including the two that are traps.
 */
import { storeFixtures } from './_helpers';
import {
  buildWalmartSessionScript,
  buildWalmartCartReadScript,
  buildWalmartNetworkSearchBatchScript,
  buildWalmartNetworkAddBatchScript,
} from '../../src/lib/webview-scripts/walmart-network';

const { itWithFixture } = storeFixtures('walmart');
const AT_WALMART = { url: 'https://www.walmart.com/robots.txt' };

const item = (idx: number, offerId: string, qty: number) =>
  ({ idx, productId: offerId, skuId: 'us' + offerId, quantity: qty, name: 'Item ' + offerId });

/** glassCartIdMap: the cart id AND the login state, in one key, no network. */
function cartMap(opts: { isGuest?: boolean; missing?: boolean } = {}) {
  if (opts.missing) return '(function () { localStorage.removeItem("glassCartIdMap"); })(); true;';
  return '(function () { localStorage.setItem("glassCartIdMap", JSON.stringify('
    + JSON.stringify({ crt: 'cart-1', id: 'other-1', isGuest: !!opts.isGuest })
    + ')); })(); true;';
}

/**
 * The search document.
 *
 * THE DECOY IS DELIBERATE. Walmart's real page has an inline script near the
 * top that reads document.getElementById("__NEXT_DATA__"), so a plain indexOf
 * for the id lands ~900 bytes short of the payload and parses minified
 * JavaScript. The rail anchors on the opening TAG; this fixture is what proves
 * it, and without the decoy the test would pass either way.
 */
function searchDoc(items: unknown[]) {
  const payload = JSON.stringify({
    props: { pageProps: { initialData: { searchResult: { itemStacks: [{ items }] } } } },
  });
  return '<!doctype html><html><head>'
    + '<script>(function(){var n=document.getElementById("__NEXT_DATA__");})();</script>'
    + '</head><body>'
    + '<script id="__NEXT_DATA__" type="application/json">' + payload + '</script>'
    + '</body></html>';
}

const hit = (over: Record<string, unknown> = {}) => ({
  name: 'Daisy Pure and Natural Sour Cream, 14 oz',
  offerId: 'C9CD90D38EC24123AB6FBB669B830D0F',
  usItemId: '43365585',
  availabilityStatusDisplayValue: 'In stock',
  canAddToCart: true,
  salesUnitType: 'EACH',
  imageInfo: { thumbnailUrl: 'https://i5.walmartimages.com/x.jpg' },
  ...over,
});

/**
 * The store, stubbed.
 *
 * `cart` is a map of offerId -> quantity. Line ids are derived, and the write
 * only CHANGES a line when it is given one — which is the measured behaviour
 * and the whole reason lineItemId is sent.
 */
function netStub(opts: {
  cart?: Record<string, number>; searchStatus?: number; cartStatus?: number;
  items?: unknown[]; blockUpdate?: number;
} = {}) {
  const cart = opts.cart ?? {};
  return [
    '(function () {',
    '  window.__writes = [];',
    '  window.__cart = ' + JSON.stringify(cart) + ';',
    '  window.__searchDoc = ' + JSON.stringify(searchDoc(opts.items ?? [hit()])) + ';',
    '  var lineIdFor = function (offer) { return "line-" + offer.slice(0, 6); };',
    '  var cartPayload = function () {',
    '    var lines = [];',
    '    for (var k in window.__cart) {',
    '      lines.push({ id: lineIdFor(k), quantity: window.__cart[k],',
    '                   product: { offerId: k, usItemId: "us" + k, name: "Item " + k } });',
    '    }',
    '    return JSON.stringify({ data: { mergeAndGetCart: { lineItems: lines } } });',
    '  };',
    '  window.fetch = function (url, init) {',
    '    var u = String(url);',
    '    var m = (init && init.method) || "GET";',
    '    if (u.indexOf("/search?q=") >= 0) {',
    '      return Promise.resolve({ status: ' + String(opts.searchStatus ?? 200) + ',',
    '        text: function () { return Promise.resolve(window.__searchDoc); } });',
    '    }',
    '    if (u.indexOf("/MergeAndGetCart/") >= 0) {',
    '      return Promise.resolve({ status: ' + String(opts.cartStatus ?? 200) + ',',
    '        text: function () { return Promise.resolve(cartPayload()); } });',
    '    }',
    '    if (u.indexOf("/updateItems/") >= 0) {',
    '      var st = ' + String(opts.blockUpdate ?? 200) + ';',
    '      var body = JSON.parse(init.body);',
    '      window.__writes.push(body);',
    '      if (st === 200) {',
    '        var list = body.variables.input.items || [];',
    '        for (var i = 0; i < list.length; i++) {',
    '          var e = list[i];',
    // MEASURED: without lineItemId the write CREATES and does nothing to an
    // existing line; with it, quantity is absolute.
    '          if (e.lineItemId) window.__cart[e.offerId] = e.quantity;',
    '          else if (window.__cart[e.offerId] == null) window.__cart[e.offerId] = e.quantity;',
    '        }',
    '      }',
    '      return Promise.resolve({ status: st, text: function () {',
    '        return Promise.resolve(st === 200 ? JSON.stringify({ data: { updateItems: {} } }) : "blocked"); } });',
    '    }',
    '    return Promise.resolve({ status: 404, text: function () { return Promise.resolve(""); } });',
    '  };',
    '})(); true;',
  ].join('\n');
}

describe('the session needs no network at all', () => {
  itWithFixture('logged-in-home.html', 'reads the login and the cart from glassCartIdMap', async (runner) => {
    await runner.inject(cartMap({ isGuest: false }));
    await runner.inject(netStub());
    await runner.inject(buildWalmartSessionScript());
    const msg = await runner.waitForMessage('WMT_SESSION', 20_000) as Record<string, unknown>;
    expect(msg.loggedIn).toBe(true);
    expect(msg.cartId).toBe('cart-1');
  }, AT_WALMART);

  itWithFixture('logged-in-home.html', 'a guest is signed out', async (runner) => {
    await runner.inject(cartMap({ isGuest: true }));
    await runner.inject(netStub());
    await runner.inject(buildWalmartSessionScript());
    const msg = await runner.waitForMessage('WMT_SESSION', 20_000) as Record<string, unknown>;
    expect(msg.loggedIn).toBe(false);
  }, AT_WALMART);

  itWithFixture('logged-in-home.html', 'no cart map is not a signed-out user', async (runner) => {
    // "The storefront has never run here" and "this person is signed out" are
    // different facts, and only one of them should surface a login screen.
    await runner.inject(cartMap({ missing: true }));
    await runner.inject(netStub());
    await runner.inject(buildWalmartSessionScript());
    const msg = await runner.waitForMessage('WMT_SESSION', 20_000) as Record<string, unknown>;
    expect(msg.why).toBe('no_cart_map');
  }, AT_WALMART);
});

describe('the search is the page, and the page is JSON', () => {
  itWithFixture('logged-in-home.html', 'parses the payload past the decoy', async (runner) => {
    await runner.inject(cartMap());
    await runner.inject(netStub());
    await runner.inject(buildWalmartNetworkSearchBatchScript(['sour cream'])!);
    const msg = await runner.waitForMessage('SEARCH_RESULT', 25_000) as Record<string, unknown>;
    const cands = msg.candidates as Array<Record<string, unknown>>;
    expect(cands).toHaveLength(1);
    // THE OFFER is the identifier — it is what the write names.
    expect(cands[0].productId).toBe('C9CD90D38EC24123AB6FBB669B830D0F');
    expect(cands[0].skuId).toBe('43365585');
    expect(cands[0].outOfStock).toBe(false);
  }, AT_WALMART);

  itWithFixture('logged-in-home.html', 'trusts canAddToCart over the words', async (runner) => {
    // An item can read "In stock" and still not be addable here.
    await runner.inject(cartMap());
    await runner.inject(netStub({ items: [hit({ canAddToCart: false })] }));
    await runner.inject(buildWalmartNetworkSearchBatchScript(['sour cream'])!);
    const msg = await runner.waitForMessage('SEARCH_RESULT', 25_000) as Record<string, unknown>;
    expect((msg.candidates as Array<Record<string, unknown>>)[0].outOfStock).toBe(true);
  }, AT_WALMART);

  itWithFixture('logged-in-home.html', 'sold by the pound is a weight item, EACH is not', async (runner) => {
    await runner.inject(cartMap());
    await runner.inject(netStub({ items: [hit({ salesUnitType: 'WEIGHT' }), hit({ offerId: 'B2', salesUnitType: 'EACH' })] }));
    await runner.inject(buildWalmartNetworkSearchBatchScript(['sour cream'])!);
    const msg = await runner.waitForMessage('SEARCH_RESULT', 25_000) as Record<string, unknown>;
    const cands = msg.candidates as Array<Record<string, unknown>>;
    expect(cands[0].isWeightItem).toBe(true);
    expect(cands[1].isWeightItem).toBe(false);
  }, AT_WALMART);

  itWithFixture('logged-in-home.html', 'an anti-bot answer is not an empty shelf', async (runner) => {
    // 418 and 429 mean the request did not look like the site's own. Calling
    // that "no results" would send the user to review for nothing.
    await runner.inject(cartMap());
    await runner.inject(netStub({ searchStatus: 418 }));
    await runner.inject(buildWalmartNetworkSearchBatchScript(['sour cream'])!);
    const msg = await runner.waitForMessage('SEARCH_RESULT_FAILED', 25_000) as Record<string, unknown>;
    expect(msg.why).toBe('blocked');
  }, AT_WALMART);
});

describe('the cart', () => {
  itWithFixture('logged-in-home.html', 'is keyed by the OFFER, not the line', async (runner) => {
    // A line carries the line id, the offer and the usItemId. Only the offer is
    // what search returns and what the write names; keying by either of the
    // others makes every item look unheld. That bug shipped on two other rails.
    await runner.inject(cartMap());
    await runner.inject(netStub({ cart: { A1: 2, B2: 1 } }));
    await runner.inject(buildWalmartCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 20_000) as Record<string, unknown>;
    expect(msg.count).toBe(3);
    const items = msg.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.itemId).sort()).toEqual(['A1', 'B2']);
    expect(items[0].lineId).toBe('line-A1');
  }, AT_WALMART);

  itWithFixture('logged-in-home.html', 'an unreadable cart is null, never zero', async (runner) => {
    await runner.inject(cartMap());
    await runner.inject(netStub({ cartStatus: 418 }));
    await runner.inject(buildWalmartCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 20_000) as Record<string, unknown>;
    expect(msg.count).toBeNull();
    expect(msg.why).toBe('blocked');
  }, AT_WALMART);
});

describe('the add', () => {
  itWithFixture('logged-in-home.html', 'writes a whole meal in ONE request', async (runner) => {
    await runner.inject(cartMap());
    await runner.inject(netStub());
    await runner.inject(buildWalmartNetworkAddBatchScript([item(0, 'A1', 1), item(1, 'B2', 2)])!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    const writes = await runner.page.evaluate('window.__writes') as Array<Record<string, any>>;
    expect(writes).toHaveLength(1);
    expect(writes[0].variables.input.items).toHaveLength(2);
  }, AT_WALMART);

  itWithFixture('logged-in-home.html', 'ADDS ON TOP of a line the cart already holds', async (runner) => {
    // Cart writes add on top. Without lineItemId this endpoint only creates
    // lines and does nothing to one that exists; with it, quantity is absolute.
    // So held + wanted, addressed by the line.
    await runner.inject(cartMap());
    await runner.inject(netStub({ cart: { A1: 2 } }));
    await runner.inject(buildWalmartNetworkAddBatchScript([item(0, 'A1', 3)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(true);
    const writes = await runner.page.evaluate('window.__writes') as Array<Record<string, any>>;
    const sent = writes[0].variables.input.items[0];
    expect(sent.lineItemId).toBe('line-A1');
    expect(sent.quantity).toBe(5);
  }, AT_WALMART);

  itWithFixture('logged-in-home.html', 'a NEW item carries no line id and just the wanted amount', async (runner) => {
    await runner.inject(cartMap());
    await runner.inject(netStub({ cart: {} }));
    await runner.inject(buildWalmartNetworkAddBatchScript([item(0, 'A1', 3)])!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    const writes = await runner.page.evaluate('window.__writes') as Array<Record<string, any>>;
    const sent = writes[0].variables.input.items[0];
    expect(sent.lineItemId).toBeUndefined();
    expect(sent.quantity).toBe(3);
  }, AT_WALMART);

  itWithFixture('logged-in-home.html', 'a cart it cannot read is not an empty cart', async (runner) => {
    await runner.inject(cartMap());
    await runner.inject(netStub({ cartStatus: 418 }));
    await runner.inject(buildWalmartNetworkAddBatchScript([item(0, 'A1', 1)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(res.reason).toBe('no_cart');
    const writes = await runner.page.evaluate('window.__writes') as unknown[];
    expect(writes).toHaveLength(0);
  }, AT_WALMART);

  itWithFixture('logged-in-home.html', 'THE CART DECIDES, not the write', async (runner) => {
    // The write answers 200 and the cart does not change: the verdict follows
    // the cart. Every rail here learned this the same way.
    await runner.inject(cartMap());
    await runner.inject(netStub({ cart: { A1: 1 } }));
    await runner.inject(
      '(function () { var of = window.fetch; window.fetch = function (u, i) {'
      + ' if (String(u).indexOf("/updateItems/") >= 0) {'
      + '   return Promise.resolve({ status: 200, text: function () {'
      + '     return Promise.resolve(JSON.stringify({ data: { updateItems: {} } })); } }); }'
      + ' return of(u, i); }; })(); true;');
    await runner.inject(buildWalmartNetworkAddBatchScript([item(0, 'A1', 2)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(res.reason).toBe('not_in_cart_after_write');
  }, AT_WALMART);

  itWithFixture('logged-in-home.html', 'an anti-bot answer is reported as blocked', async (runner) => {
    await runner.inject(cartMap());
    await runner.inject(netStub({ cart: {}, blockUpdate: 429 }));
    await runner.inject(buildWalmartNetworkAddBatchScript([item(0, 'A1', 1)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.reason).toBe('blocked');
  }, AT_WALMART);
});
