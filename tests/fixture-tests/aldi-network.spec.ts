// ALDI over the network — the Instacart Storefront rail.
//
// Three things are under test and only one of them is "a request goes out".
//
// The first is the SHAPE: a network candidate has to be indistinguishable from
// one any other rail produces, because the matcher, the review screen and the
// add gate all read that shape and must not be able to tell which store filled
// it.
//
// The second is the arithmetic, and on this store it is a refusal. Nobody has
// measured whether Instacart SETS a cart line or ADDS to it, so the script
// writes only where the two readings agree (the cart holds none of the item)
// and declines where they do not. The stub below implements SET semantics; a
// second stub implements ADD. The point of having both is that the script must
// behave correctly under EITHER, which is what "unproven" has to mean.
//
// The third is the hash cache: Instacart refuses any query it has not
// allow-listed, so a stale hash has to invalidate the cache rather than fail the
// run for twelve hours.

import {
  buildAldiSessionScript,
  buildAldiNetworkSearchBatchScript,
  buildAldiCartReadScript,
  buildAldiNetworkAddBatchScript,
} from '../../src/lib/webview-scripts/aldi-network';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('aldi');

/**
 * A GraphQL endpoint that behaves the way the real one does: it routes on
 * operationName, records what was asked, and answers from canned data.
 *
 * `cart` is the live cart, keyed by itemId, and `setSemantics` decides whether a
 * write SETS the line or ADDS to it — the question this store has not answered.
 */
function gqlStub(opts: {
  cart?: Record<string, number>;
  setSemantics?: boolean;
  searchIds?: string[];
  details?: unknown;
  fail?: string;
  failCode?: string;
} = {}) {
  const cart = opts.cart ?? {};
  const ids = opts.searchIds ?? ['items_23898-1', 'items_23898-2'];
  const details = opts.details ?? {
    products: ids.map((id, n) => ({
      id, name: 'Product ' + (n + 1),
      viewSection: { priceString: '$2.49', itemImage: { url: 'https://img/' + id } },
      availability: { available: true },
    })),
  };
  return [
    '(function () {',
    '  window.__lines = ' + JSON.stringify(cart) + ';',
    '  window.__calls = [];',
    '  window.__writes = [];',
    '  var SET = ' + JSON.stringify(opts.setSemantics !== false) + ';',
    '  var FAIL = ' + JSON.stringify(opts.fail ?? null) + ';',
    '  var FAILCODE = ' + JSON.stringify(opts.failCode ?? 'PERSISTED_QUERY_NOT_FOUND') + ';',
    '  function cartLines() {',
    '    var out = [];',
    '    for (var k in window.__lines) out.push({ itemId: k, quantity: window.__lines[k], name: "Item " + k });',
    '    return out;',
    '  }',
    '  window.fetch = function (url, init) {',
    '    var u = String(url);',
    '    if (u.indexOf("/graphql") < 0) {',
    // Anything that is not the API is a bundle fetch from the harvest.
    '      return Promise.resolve({ status: 200, text: function () { return Promise.resolve("no hashes here"); } });',
    '    }',
    '    var body = JSON.parse(init.body);',
    '    window.__calls.push({ op: body.operationName, vars: body.variables });',
    '    var data = null;',
    '    if (FAIL && body.operationName === FAIL) {',
    '      return Promise.resolve({ status: 200, text: function () { return Promise.resolve(JSON.stringify(',
    '        { errors: [{ message: "nope", extensions: { code: FAILCODE } }] })); } });',
    '    }',
    '    if (body.operationName === "ActiveCarts") {',
    '      data = { userCarts: { carts: [{ id: "16636288909", itemCount: 0,',
    '        retailer: { id: "12", name: "ALDI", slug: "aldi" } }] } };',
    '    } else if (body.operationName === "CartItems") {',
    '      data = { userCart: { id: "16636288909", cartItemCollection: { cartItems: cartLines() } } };',
    '    } else if (body.operationName === "AsyncItemSearch") {',
    '      data = { itemSearch: { itemResultList: { itemIds: ' + JSON.stringify(ids) + ' } } };',
    '    } else if (body.operationName === "ItemDetailsRetailerProduct") {',
    '      data = ' + JSON.stringify(details) + ';',
    '    } else if (body.operationName === "UpdateCartItemsMutation") {',
    '      var ups = body.variables.cartItemUpdates || [];',
    '      for (var i = 0; i < ups.length; i++) {',
    '        window.__writes.push({ itemId: ups[i].itemId, quantity: ups[i].quantity });',
    '        if (SET) window.__lines[ups[i].itemId] = ups[i].quantity;',
    '        else window.__lines[ups[i].itemId] = (window.__lines[ups[i].itemId] || 0) + ups[i].quantity;',
    '      }',
    '      data = { updateCartItems: { id: "16636288909" } };',
    '    }',
    '    return Promise.resolve({ status: 200, text: function () { return Promise.resolve(JSON.stringify({ data: data })); } });',
    '  };',
    '})(); true;',
  ].join('\n');
}

/**
 * The fixture is served from the real origin rather than about:blank.
 *
 * Not cosmetic: the rail caches its operation hashes in localStorage, and
 * about:blank denies access to it outright ("Access is denied for this
 * document"). Giving the page an origin gives it a real localStorage, which is
 * also what it has on the device.
 */
const AT_ALDI = { url: 'https://www.aldi.us/store/aldi/storefront' };

describe('the session probe', () => {
  itWithFixture('storefront.html', 'reports signed in, and hands back the cart it found', async (runner) => {
    await runner.inject(gqlStub());
    await runner.inject(buildAldiSessionScript());
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.ok).toBe(true);
    expect(msg.loggedIn).toBe(true);
    // ActiveCarts answers the session AND the cart identity in one call — no
    // other rail here gets both from one request.
    expect(msg.cartId).toBe('16636288909');
    // storeId is the SHOP, and there is none to find in a bare fixture — which
    // is the honest answer, because sending the retailer id here would search a
    // catalogue the user cannot buy from. The retailer is reported separately.
    expect(msg.retailerId).toBe('12');
    expect(msg.storeId).toBeNull();
  }, AT_ALDI);

  itWithFixture('storefront.html', 'a store that cannot answer is NOT a signed-out user', async (runner) => {
    // The mistake this project has made three times: an inconclusive check
    // reported as a negative walls a signed-in user out of their own run.
    await runner.inject(gqlStub({ fail: 'ActiveCarts', failCode: 'INTERNAL' }));
    await runner.inject(buildAldiSessionScript());
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.ok).toBe(false);
    expect(msg.loggedIn).toBeUndefined();
  }, AT_ALDI);
});

describe('search', () => {
  itWithFixture('storefront.html', 'produces the same candidate shape every other rail does', async (runner) => {
    await runner.inject(gqlStub());
    await runner.inject(buildAldiNetworkSearchBatchScript(['sour cream'], { shopId: '8583' })!);
    const msg = await runner.waitForMessage('SEARCH_RESULT', 20_000) as Record<string, unknown>;
    const cands = msg.candidates as Array<Record<string, unknown>>;
    expect(cands.length).toBe(2);
    expect(cands[0].productName).toBe('Product 1');
    expect(cands[0].productId).toBe('items_23898-1');
    // No sku on this platform at all, and the rail's `writable` is written for
    // that — requiring one would break this store the way it broke Albertsons.
    expect(cands[0].skuId).toBeNull();
    expect(cands[0].outOfStock).toBe(false);
    expect(cands[0].preferences).toBeNull();
  }, AT_ALDI);

  itWithFixture('storefront.html', 'hydrates every term in ONE call, not one per term', async (runner) => {
    // The search returns ids only. Hydrating per term would be N extra requests
    // against a store nobody has load-tested.
    await runner.inject(gqlStub());
    await runner.inject(buildAldiNetworkSearchBatchScript(['sour cream', 'tortillas', 'limes'], { shopId: '8583' })!);
    await runner.waitForMessage('SEARCH_BATCH_DONE', 25_000);
    const calls = await runner.page.evaluate('window.__calls') as Array<{ op: string }>;
    expect(calls.filter((c) => c.op === 'AsyncItemSearch').length).toBe(3);
    expect(calls.filter((c) => c.op === 'ItemDetailsRetailerProduct').length).toBe(1);
  }, AT_ALDI);

  itWithFixture('storefront.html', 'reads zoneId back out of the ids the search returned', async (runner) => {
    // Nobody ever observed zoneId being sent, so rather than hard-code a number
    // no one can explain, it comes out of the item ids themselves.
    await runner.inject(gqlStub({ searchIds: ['items_44100-9', 'items_44100-10'] }));
    await runner.inject(buildAldiNetworkSearchBatchScript(['sour cream'], { shopId: '8583' })!);
    await runner.waitForMessage('SEARCH_BATCH_DONE', 20_000);
    const calls = await runner.page.evaluate('window.__calls') as Array<{ op: string; vars: Record<string, unknown> }>;
    const det = calls.find((c) => c.op === 'ItemDetailsRetailerProduct')!;
    expect(det.vars.zoneId).toBe('44100');
  }, AT_ALDI);

  itWithFixture('storefront.html', 'a term the store refused does not take the batch with it', async (runner) => {
    await runner.inject(gqlStub({ fail: 'AsyncItemSearch' }));
    await runner.inject(buildAldiNetworkSearchBatchScript(['sour cream'], { shopId: '8583' })!);
    const failed = await runner.waitForMessage('SEARCH_RESULT_FAILED', 20_000) as Record<string, unknown>;
    expect(failed.term).toBe('sour cream');
    await runner.waitForMessage('SEARCH_BATCH_DONE', 20_000);
  }, AT_ALDI);
});

describe('the shop it is shopping', () => {
  it('refuses to search without one, rather than searching the wrong catalogue', () => {
    // The shop is NOT the retailer. ALDI the chain is 12; the branch the user
    // shops is 8583, and every operation takes the branch. Sending the retailer
    // id searches a catalogue the user cannot buy from — every candidate would
    // be a product that is not there, which is the over-add rule wearing a
    // different hat.
    expect(buildAldiNetworkSearchBatchScript(['sour cream'], { shopId: null })).toBeNull();
    expect(buildAldiNetworkSearchBatchScript(['sour cream'], {})).toBeNull();
    expect(buildAldiNetworkSearchBatchScript(['sour cream'], { shopId: '8583' })).toBeTruthy();
  });

  itWithFixture('storefront.html', 'reports where it looked, so a device run can say', async (runner) => {
    // Finding the shop id is the one thing left to close on this store. The
    // probe lists its attempts rather than failing silently, so the next person
    // reads an answer instead of guessing again.
    await runner.inject(gqlStub());
    await runner.inject(buildAldiSessionScript());
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(Array.isArray(msg.shopTries)).toBe(true);
    // The retailer is reported SEPARATELY, so the two can never be confused
    // again by reading one field.
    expect(msg.retailerId).toBe('12');
  }, AT_ALDI);
});

describe('the cart read', () => {
  itWithFixture('storefront.html', 'posts the same CART_COUNT a page read would', async (runner) => {
    await runner.inject(gqlStub({ cart: { 'items_23898-1': 2, 'items_23898-7': 1 } }));
    await runner.inject(buildAldiCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 20_000) as Record<string, unknown>;
    expect(msg.count).toBe(3);
    const items = msg.items as Array<Record<string, unknown>>;
    expect(items.length).toBe(2);
    // The itemId is what makes this baseline usable by a write. A name-only
    // baseline looks up nothing and SETS a line the user already had.
    expect(items[0].itemId).toBe('items_23898-1');
  }, AT_ALDI);

  itWithFixture('storefront.html', 'an unreadable cart is null, never zero', async (runner) => {
    // "Nobody could read it" and "it is empty" are different facts, and calling
    // the first the second makes every item the user already owned look like
    // something this run just added.
    await runner.inject(gqlStub({ fail: 'CartItems', failCode: 'INTERNAL' }));
    await runner.inject(buildAldiCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 20_000) as Record<string, unknown>;
    expect(msg.count).toBeNull();
  }, AT_ALDI);
});

describe('the add, and the question nobody has answered', () => {
  const item = (idx: number, id: string, qty: number) =>
    ({ idx, productId: id, quantity: qty, name: 'Item ' + id });

  itWithFixture('storefront.html', 'writes every item in ONE call', async (runner) => {
    // The measured signature takes a LIST. One request for a whole meal is the
    // difference between this store and H-E-B, whose batched add still runs
    // serially on their side at ~240ms an item.
    await runner.inject(gqlStub());
    await runner.inject(buildAldiNetworkAddBatchScript(
      [item(0, 'items_23898-1', 2), item(1, 'items_23898-2', 1), item(2, 'items_23898-3', 3)],
    )!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    const calls = await runner.page.evaluate('window.__calls') as Array<{ op: string }>;
    expect(calls.filter((c) => c.op === 'UpdateCartItemsMutation').length).toBe(1);
    const writes = await runner.page.evaluate('window.__writes') as Array<Record<string, unknown>>;
    expect(writes.length).toBe(3);
  }, AT_ALDI);

  itWithFixture('storefront.html', 'REFUSES an item the cart already holds', async (runner) => {
    // The whole reason this rail ships with its add gated. Until someone
    // measures whether Instacart SETS or ADDS, an item already in the cart is
    // the one case where the two readings disagree — so it is declined rather
    // than guessed at, and it reaches the review screen instead.
    await runner.inject(gqlStub({ cart: { 'items_23898-1': 2 } }));
    await runner.inject(buildAldiNetworkAddBatchScript([item(0, 'items_23898-1', 1)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(res.reason).toBe('qty_semantics_unproven');
    const writes = await runner.page.evaluate('window.__writes') as unknown[];
    expect(writes.length).toBe(0);
  }, AT_ALDI);

  itWithFixture('storefront.html', 'is correct under SET semantics', async (runner) => {
    await runner.inject(gqlStub({ setSemantics: true }));
    await runner.inject(buildAldiNetworkAddBatchScript([item(0, 'items_23898-1', 2)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(true);
    const lines = await runner.page.evaluate('window.__lines') as Record<string, number>;
    expect(lines['items_23898-1']).toBe(2);
  }, AT_ALDI);

  itWithFixture('storefront.html', 'is correct under ADD semantics too — which is the point', async (runner) => {
    // The same script, the same input, a store that ADDS instead of SETTING.
    // The cart still ends up holding exactly what was asked for, because the
    // only items it writes are ones where the two readings agree. A script that
    // guessed SET and was wrong would double every line.
    await runner.inject(gqlStub({ setSemantics: false }));
    await runner.inject(buildAldiNetworkAddBatchScript([item(0, 'items_23898-1', 2)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(true);
    const lines = await runner.page.evaluate('window.__lines') as Record<string, number>;
    expect(lines['items_23898-1']).toBe(2);
  }, AT_ALDI);

  itWithFixture('storefront.html', 'once measured, absoluteQty lifts the refusal', async (runner) => {
    await runner.inject(gqlStub({ cart: { 'items_23898-1': 2 }, setSemantics: true }));
    await runner.inject(buildAldiNetworkAddBatchScript(
      [item(0, 'items_23898-1', 3)], { absoluteQty: true },
    )!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(true);
    const writes = await runner.page.evaluate('window.__writes') as Array<Record<string, number>>;
    // held 2 + wanted 3. Absolute means SET the line to five, not to three.
    expect(writes[0].quantity).toBe(5);
  }, AT_ALDI);

  itWithFixture('storefront.html', 'the CART decides, not the write', async (runner) => {
    // A write that reports success and does not land is the failure mode every
    // silent add defect in this project has had. The re-read is what disagrees.
    await runner.inject(gqlStub());
    await runner.inject([
      '(function () {',
      '  var real = window.fetch;',
      '  window.fetch = function (url, init) {',
      '    try {',
      '      var b = JSON.parse(init.body);',
      // Accept the write, then quietly drop it on the floor.
      '      if (b.operationName === "UpdateCartItemsMutation") {',
      '        return Promise.resolve({ status: 200, text: function () {',
      '          return Promise.resolve(JSON.stringify({ data: { updateCartItems: { id: "x" } } })); } });',
      '      }',
      '    } catch (e) {}',
      '    return real(url, init);',
      '  };',
      '})(); true;',
    ].join('\n'));
    await runner.inject(buildAldiNetworkAddBatchScript([item(0, 'items_23898-1', 2)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(res.reason).toBe('not_in_cart_after_write');
  }, AT_ALDI);
});

describe('the operation hashes', () => {
  itWithFixture('storefront.html', 'a hash the store no longer knows drops the cache', async (runner) => {
    // Instacart deploys and the hashes change. A cache that survived that would
    // fail every run for twelve hours; forgetting it means the next call
    // harvests again — the same trigger __albForgetKeys has.
    await runner.inject(gqlStub({ fail: 'ActiveCarts', failCode: 'PERSISTED_QUERY_NOT_FOUND' }));
    await runner.inject(buildAldiSessionScript());
    const msg = await runner.waitForMessage('ALDI_SESSION', 20_000) as Record<string, unknown>;
    expect(msg.ok).toBe(false);
    expect(msg.code).toBe('PERSISTED_QUERY_NOT_FOUND');
    const cached = await runner.page.evaluate('localStorage.getItem("__mealio_ic_ops_v1")');
    expect(cached).toBeNull();
  }, AT_ALDI);
});
