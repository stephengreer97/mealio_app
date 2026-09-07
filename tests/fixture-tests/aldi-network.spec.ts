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
  INSTACART_RAIL,
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
  /** Answer every /graphql call with this HTTP status. 401 is how Instacart
   *  says "Not Authenticated" to a signed-out session. */
  httpStatus?: number;
  /** Status per operation, for the case the blanket one cannot express: a
   *  healthy cart AND a denied account, which is exactly what a guest is. */
  opStatus?: Record<string, number>;
  /** What CurrentUser returns on 200. `null` models a guest that the server
   *  answers politely rather than with a 401. */
  currentUser?: unknown;
  /** The carts the signed-in ACCOUNT holds, across retailers. Defaults to one
   *  ALDI cart, which is every case that existed before a second banner. */
  carts?: Array<{ id: string; itemCount: number; slug: string; retailerId?: string }>;
} = {}) {
  const cart = opts.cart ?? {};
  const ids = opts.searchIds ?? ['items_23898-1', 'items_23898-2'];
  const details = opts.details ?? ids.map((id, n) => ({
    id, name: 'Product ' + (n + 1), size: '16 oz',
    viewSection: { priceString: '$2.49', itemImage: { url: 'https://img/' + id } },
  }));
  return [
    '(function () {',
    '  window.__lines = ' + JSON.stringify(cart) + ';',
    '  window.__calls = [];',
    '  window.__writes = [];',
    '  var SET = ' + JSON.stringify(opts.setSemantics !== false) + ';',
    '  var FAIL = ' + JSON.stringify(opts.fail ?? null) + ';',
    '  var FAILCODE = ' + JSON.stringify(opts.failCode ?? 'PERSISTED_QUERY_NOT_FOUND') + ';',
    // THE REAL SHAPE, read off the live cart on 2026-09-03.
    //
    // A cart line's own `id` is the CART LINE (a bare number like 35303533299).
    // The item is one level down, on `basketProduct`, whose `itemId` is exactly
    // what Search returns as productId. The two are different id spaces.
    //
    // This stub used to emit a flat { itemId, quantity, name }, which is the
    // shape the old extractor happened to read — so every test here passed
    // against a cart the store does not send, while the real rail keyed its
    // held-quantity map by line ids that no search result could ever match.
    // A double is a model, not an oracle: it was right exactly where it had
    // been exercised.
    '  function cartLines() {',
    '    var out = [];',
    '    var line = 35303533299;',
    '    for (var k in window.__lines) {',
    '      out.push({ id: String(line++), quantity: window.__lines[k], quantityType: "each",',
    '                 basketProduct: { id: k, itemId: k, productId: String(k).split("-")[1] || null,',
    '                                  name: "Item " + k } });',
    '    }',
    '    return out;',
    '  }',
    '  window.fetch = function (url, init) {',
    '    var u = String(url);',
    '    if (u.indexOf("/store/") >= 0 && u.indexOf("storefront") > 0) {',
    // The storefront, fetched as TEXT for the shop id. The value is in the
    // URL-ENCODED server payload, which is why the plain string is not there.
    '      return Promise.resolve({ status: 200, text: function () {',
    '        return Promise.resolve("junk%5C%22shopId%5C%22%3A%5C%228583%5C%22junk"); } });',
    '    }',
    '    if (u.indexOf("/graphql") < 0) {',
    // Anything else is a bundle fetch from the harvest.
    '      return Promise.resolve({ status: 200, text: function () { return Promise.resolve("no hashes here"); } });',
    '    }',
    '    var HTTPSTATUS = ' + JSON.stringify(opts.httpStatus ?? 200) + ';',
    '    if (HTTPSTATUS !== 200) {',
    '      return Promise.resolve({ status: HTTPSTATUS, text: function () {',
    '        return Promise.resolve(JSON.stringify(',
    '          { errors: [{ message: "Not Authenticated" }] })); } });',
    '    }',
    '    var body = JSON.parse(init.body);',
    '    window.__calls.push({ op: body.operationName, vars: body.variables });',
    '    var OPSTATUS = ' + JSON.stringify(opts.opStatus ?? {}) + ';',
    '    if (OPSTATUS[body.operationName]) {',
    '      return Promise.resolve({ status: OPSTATUS[body.operationName], text: function () {',
    '        return Promise.resolve(JSON.stringify(',
    '          { errors: [{ message: "Not Authenticated" }] })); } });',
    '    }',
    '    var data = null;',
    '    if (FAIL && body.operationName === FAIL) {',
    '      return Promise.resolve({ status: 200, text: function () { return Promise.resolve(JSON.stringify(',
    '        { errors: [{ message: "nope", extensions: { code: FAILCODE } }] })); } });',
    '    }',
    '    if (body.operationName === "ActiveCarts") {',
    '      data = { userCarts: { carts: ' + JSON.stringify(
        (opts.carts ?? [{ id: '16636288909', itemCount: 0, slug: 'aldi', retailerId: '12' }])
          .map((c) => ({ id: c.id, itemCount: c.itemCount,
                         retailer: { id: c.retailerId ?? '12', name: c.slug, slug: c.slug } })),
      ) + ' } };',
    '    } else if (body.operationName === "CurrentUser") {',
    '      data = ' + JSON.stringify(
      opts.currentUser === undefined
        ? { currentUser: { id: 'usr_00000001', firstName: 'NAMEVALUE',
                           email: 'EMAILVALUE@example.com',
                           guest: false, ordersCount: 3 } }
        : opts.currentUser) + ';',
    '    } else if (body.operationName === "CartItems") {',
    '      data = { userCart: { id: "16636288909", cartItemCollection: { cartItems: cartLines() } } };',
    '    } else if (body.operationName === "AsyncItemSearch") {',
    '      data = { itemSearch: { itemResultList: { itemIds: ' + JSON.stringify(ids) + ' } } };',
    '    } else if (body.operationName === "Search") {',
    '      data = { searchResults: { primaryItemResultList: { items: ' + JSON.stringify(details) + ' } } };',
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
    // The SHOP, fetched out of the storefront's URL-encoded payload — it is
    // nowhere a page on robots.txt can be asked for it, and no operation
    // returns it.
    expect(msg.storeId).toBe('8583');
    expect(msg.shopFrom).toBe('storefront-fetch');
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
    // The size is folded into the name: "Sour Cream" and "Sour Cream, 24 oz"
    // are different products to a shopper, and the matcher only sees this string.
    expect(cands[0].productName).toBe('Product 1, 16 oz');
    expect(cands[0].productId).toBe('items_23898-1');
    // No sku on this platform at all, and the rail's `writable` is written for
    // that — requiring one would break this store the way it broke Albertsons.
    expect(cands[0].skuId).toBeNull();
    expect(cands[0].outOfStock).toBe(false);
    expect(cands[0].preferences).toBeNull();
  }, AT_ALDI);

  itWithFixture('storefront.html', 'one Search per term, and the zone probed ONCE', async (runner) => {
    // The first design was AsyncItemSearch for ids plus one bulk hydration —
    // N + 1 requests, which looked better. It did not work: MEASURED on the
    // device, the hydration answers with an empty list for ids the search had
    // just returned, under every combination of full and bare ids and of zone
    // and shop as the zoneId. Search carries the names itself.
    await runner.inject(gqlStub());
    await runner.inject(buildAldiNetworkSearchBatchScript(['sour cream', 'tortillas', 'limes'], { shopId: '8583' })!);
    await runner.waitForMessage('SEARCH_BATCH_DONE', 25_000);
    const calls = await runner.page.evaluate('window.__calls') as Array<{ op: string }>;
    expect(calls.filter((c) => c.op === 'Search').length).toBe(3);
    // Once for three terms, and cached for twelve hours after that.
    expect(calls.filter((c) => c.op === 'AsyncItemSearch').length).toBe(1);
  }, AT_ALDI);

  itWithFixture('storefront.html', 'reads zoneId back out of the ids a probe returned', async (runner) => {
    // Search needs a zoneId and nothing hands one over. AsyncItemSearch does NOT
    // need one and the ids it returns CARRY it, so one cheap call buys the zone
    // rather than a hard-coded number nobody could explain.
    await runner.inject(gqlStub({ searchIds: ['items_44100-9', 'items_44100-10'] }));
    await runner.inject(buildAldiNetworkSearchBatchScript(['sour cream'], { shopId: '8583' })!);
    await runner.waitForMessage('SEARCH_BATCH_DONE', 20_000);
    const calls = await runner.page.evaluate('window.__calls') as Array<{ op: string; vars: Record<string, unknown> }>;
    const search = calls.find((c) => c.op === 'Search')!;
    expect(search.vars.zoneId).toBe('44100');
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

describe('the add reads the cart it is writing to', () => {
  const item = (idx: number, id: string, qty: number) =>
    ({ idx, productId: id, quantity: qty, name: 'Item ' + id });

  // Stephen: "does this bug exist in ALDI too? I can add items which are
  // already in my cart, right?" It did, and it was worse than the Wegmans one.
  //
  // CartItems needs a shopId. The rail's addBatch is never given one — it gets
  // items and knownLines and nothing else — so SHOP was null, the cart read
  // inside the add answered with nothing usable, and `held` was EMPTY for a
  // cart full of items.
  //
  // On a store whose write is ABSOLUTE that does not degrade quietly. With have
  // stuck at 0 the script writes the WANTED amount as the line's whole total:
  // an item the user already had three of, asked for once, would be SET TO ONE.
  // It could take things out of the cart. The after-write check read the same
  // empty map, so it could not have caught it either.
  itWithFixture('storefront.html', 'finds the shop itself, so held quantities are real', async (runner) => {
    await runner.inject(gqlStub({ cart: { 'items_23898-1': 2 } }));
    // No shopId passed — exactly how the rail calls it.
    await runner.inject(buildAldiNetworkAddBatchScript([item(0, 'items_23898-1', 3)], { absoluteQty: true })!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    const writes = await runner.page.evaluate('window.__writes') as Array<Record<string, unknown>>;
    expect(writes).toHaveLength(1);
    // held 2 + wanted 3. Not 3, which is what an empty baseline would send —
    // and which would have REDUCED a line holding more than that.
    expect(writes[0].quantity).toBe(5);
  }, AT_ALDI);

  itWithFixture('storefront.html', 'a cart it cannot read is not an empty cart', async (runner) => {
    // The other half: if the read fails, the run must not fall through to
    // "nothing is held" and start writing absolute quantities against it.
    await runner.inject(gqlStub({ fail: 'CartItems', failCode: 'INTERNAL' }));
    await runner.inject(buildAldiNetworkAddBatchScript([item(0, 'items_23898-1', 3)], { absoluteQty: true })!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(res.reason).toBe('no_cart');
    const writes = await runner.page.evaluate('window.__writes') as unknown[];
    expect(writes).toHaveLength(0);
  }, AT_ALDI);
});

// ── ONE ACCOUNT, SEVERAL RETAILERS ──────────────────────────────────────────
//
// Stephen, after Publix reached the rail: "I'm not actually sure if I'm logged
// in though. Do all instacart stores share a login?"
//
// The cookies do not — each banner is its own domain. But ActiveCarts is an
// ACCOUNT-level query: it answers with every cart the signed-in Instacart
// account holds, across retailers, which is why the session probe has always
// matched on retailer.slug.
//
// The cart READ and the cart WRITE did not match. Both took the first entry.
// With ALDI as the only tenant that was invisible — the only cart an ALDI
// account could hold was an ALDI cart. With a second banner it is reading, and
// then writing, somebody else's cart.
describe('a cart belongs to a retailer', () => {
  itWithFixture('storefront.html', 'never borrows another retailer\'s cart', async (runner) => {
    // The account holds an ALDI cart and nothing at Publix.
    await runner.inject(gqlStub({ carts: [{ id: 'cart-aldi-1', itemCount: 4, slug: 'aldi' }] }));
    await runner.inject(buildAldiSessionScript('publix'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.ok).toBe(true);
    // THE PART THAT IS SETTLED: whatever we decide about the login question,
    // Publix must never be handed ALDI's cart.
    expect(msg.cartId ?? null).toBeNull();
    expect(msg.cartId).not.toBe('cart-aldi-1');
  });

  itWithFixture('storefront.html', 'reports whether userCarts was there at all', async (runner) => {
    // THE MEASUREMENT THAT ENDS THE GUESSING, and the reason this is a reported
    // fact rather than an assumption baked into the login decision.
    //
    // `loggedIn` has been derived two ways in two days and both were wrong:
    // from this retailer's cart, which deadlocks a signed-in user who has not
    // shopped here; and from userCarts existing, which waved a SIGNED-OUT user
    // straight through to searching. The second is far worse.
    //
    // Nobody here knows what Instacart returns for an anonymous session. One
    // signed-out run against a real storefront answers it, and until then the
    // cart stays the test because that is the behaviour ALDI has always had.
    await runner.inject(gqlStub({ carts: [{ id: 'c1', itemCount: 1, slug: 'aldi' }] }));
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.hadUserCarts).toBe(true);
    // Names only, never values. Enough to tell whether this response carries a
    // field naming the USER — which is the signal the cart is standing in for
    // and doing badly.
    expect(msg.dataKeys).toEqual(['userCarts']);
    expect(msg.ucKeys).toEqual(['carts']);
    expect(msg.cartCount).toBe(1);
  });

  itWithFixture('storefront.html', 'the cart is a bad proxy, and fails opposite ways per banner', async (runner) => {
    // ONE STUB, TWO BANNERS, OPPOSITE WRONG ANSWERS. The account holds an ALDI
    // cart and no Publix cart — which is exactly Stephen's device after signing
    // out of everything.
    //
    // ALDI reads SIGNED IN off a cart that predates the sign-out. Publix reads
    // SIGNED OUT off never having had one. Neither answer is about the session,
    // and "Publix detected it correctly" is a coincidence: it would say the same
    // thing while signed in, which is the deadlock.
    await runner.inject(gqlStub({ carts: [{ id: 'cart-aldi-1', itemCount: 4, slug: 'aldi' }] }));
    await runner.inject(buildAldiSessionScript('aldi'));
    const aldi = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(aldi.loggedIn).toBe(true);
  });

  itWithFixture('storefront.html', 'reports the slugs it saw, so a mismatch is not a guess', async (runner) => {
    // The URL segment and the GraphQL retailer.slug are not guaranteed to be
    // the same string. On a new banner that is the likeliest reason a signed-in
    // user looks cartless, and without this the only way to find out is to
    // guess and ship again.
    await runner.inject(gqlStub({ carts: [{ id: 'c1', itemCount: 1, slug: 'publix-delivery' }] }));
    await runner.inject(buildAldiSessionScript('publix'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.sawSlugs).toEqual(['publix-delivery']);
    expect(msg.cartId ?? null).toBeNull();
  });

  itWithFixture('storefront.html', 'and takes its own when it is there', async (runner) => {
    await runner.inject(gqlStub({ carts: [
      { id: 'cart-aldi-1', itemCount: 4, slug: 'aldi' },
      { id: 'cart-publix-9', itemCount: 2, slug: 'publix', retailerId: '77' },
    ] }));
    await runner.inject(buildAldiSessionScript('publix'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.loggedIn).toBe(true);
    // The Publix cart, not the first one in the list.
    expect(msg.cartId).toBe('cart-publix-9');
  });

  itWithFixture('storefront.html', 'ALDI is unchanged, which is what makes this safe to ship', async (runner) => {
    await runner.inject(gqlStub());
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.loggedIn).toBe(true);
    expect(msg.cartId).toBe('16636288909');
  });
});

// ── THE RAIL MUST BE TOLD WHICH BANNER IT IS ON ─────────────────────────────
//
// From Stephen's device, 2026-09-06, a Publix run:
//
//   {"cartCount":1,"sawSlugs":["publix"],"cartId":null,"loggedIn":false,...}
//
// It FOUND a Publix cart and reported the user signed out. `sessionScript()`
// took no arguments, so INSTACART_RAIL built the probe with the default store
// id — ALDI — and the probe matched carts against ALDI's slug. On Publix that
// matches nothing, however signed in you are.
//
// Every "login detection" symptom on Publix traces here. Not persisted queries,
// not authentication semantics: a defaulted parameter.
describe('the session probe is built for the store it is running on', () => {
  itWithFixture('storefront.html', 'matches Publix carts on a Publix run', async (runner) => {
    await runner.inject(gqlStub({ carts: [{ id: 'cart-publix-1', itemCount: 0, slug: 'publix', retailerId: '77' }] }));
    await runner.inject(INSTACART_RAIL.sessionScript('publix'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    // The exact line from the device, inverted.
    expect(msg.sawSlugs).toEqual(['publix']);
    expect(msg.loggedIn).toBe(true);
    expect(msg.cartId).toBe('cart-publix-1');
  });

  it('refuses to run at all when told nothing, rather than defaulting to ALDI', () => {
    // This test used to assert the opposite, and its comment argued for it:
    // "the default is what made this invisible for a year with one tenant, so
    // it stays". That reasoning was backwards. The default was not a survival
    // of the single-tenant era that happened to be harmless, it was the
    // mechanism of the regression. sessionScript() took no argument, the id
    // arrived undefined, the fallback turned that into a real-looking tenant,
    // and a Publix run matched Publix carts against ALDI's slug and told
    // Stephen he was signed out while he was signed in.
    //
    // A guess that is right four times in five is worse than a refusal, because
    // the fifth is silent and lands in the wrong basket.
    expect(() => INSTACART_RAIL.sessionScript()).toThrow(/no store id/i);
  });
});

// ── 401 IS AN ANSWER, NOT A FAILURE TO ANSWER ───────────────────────────────
//
// Measured on Stephen's device, 2026-09-07, after signing out of every store
// for real:
//
//   NET_REQUEST {"op":"ActiveCarts","status":401,"why":"http"}
//   detail: {"errors":[{"message":"Not Authenticated"}]}
//   network run: dead end — session_http → assisted
//
// He got "add it yourself", which is the one screen a signed-out user has no
// use for. What he needed was the login page.
//
// This is also the authentication signal three previous attempts went looking
// for in the wrong place. The CART cannot answer it — a signed-in account holds
// carts at retailers it has never shopped, and the earlier "signed out" runs
// that returned carts were a sign-out that had not fully taken. The SERVER
// answers it, in one status code.
describe('a signed-out session', () => {
  itWithFixture('storefront.html', 'forgets the cached shop id, which outlives a cookie clear', async (runner) => {
    // The shop id lives in localStorage; "sign out of all grocery stores"
    // clears cookies only. So a shop learned while signed in survives the
    // session that chose it, and both of Stephen's captures reported
    // shopFrom: "cache" with the same value for that reason — which is exactly
    // why they could not answer whether a guest gets a shop id at all.
    //
    // A 401 is the one moment the session is known to be gone, so it is the
    // right moment to forget what that session knew.
    await runner.inject(gqlStub({ httpStatus: 401 }));
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.shopCacheCleared).toBe(true);
    // WHAT THIS CANNOT CHECK, said rather than implied: localStorage THROWS in
    // the fixture runner, so the removal itself is unverifiable here — a probe
    // reading the key back comes out as "threw" either way. The flag alone
    // would pass on code that reports a clear and performs none, so the emitted
    // script is checked for the removal against the real key name. That catches
    // the two failures that actually happen: the line being dropped, and the
    // key being renamed in one place and not the other.
    //
    // The removal is confirmed for real on a device, by shopFrom flipping from
    // "cache" to a page read on the next run.
    const emitted = buildAldiSessionScript('aldi');
    expect(emitted).toContain("localStorage.removeItem('__mealio_ic_shop_v1')");
  });

  itWithFixture('storefront.html', 'reads 401 as signed OUT, not as unanswerable', async (runner) => {
    await runner.inject(gqlStub({ httpStatus: 401 }));
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    // ok:true means the probe ANSWERED. That is what routes to the login screen
    // instead of the handover.
    expect(msg.ok).toBe(true);
    expect(msg.loggedIn).toBe(false);
    expect(msg.source).toBe('activeCarts_401');
  });

  itWithFixture('storefront.html', 'still refuses to guess at a 500', async (runner) => {
    // The distinction that keeps this safe. A server that broke is not a user
    // who is signed out, and answering "signed out" to a 5xx would wall someone
    // who is signed in — the mistake this project has made three times.
    await runner.inject(gqlStub({ httpStatus: 500 }));
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.ok).toBe(false);
    expect(msg.status).toBe(500);
  });
});

// ── WHAT ActiveCarts CANNOT ANSWER ──────────────────────────────────────────
//
// Measured on Stephen's device, 2026-09-07, SIGNED OUT with a guest cart:
//
//   ucIdPresent: true      ucIdLen: 8
//   ucKeys:          ["id","viewSection","carts","__typename"]
//   viewSectionKeys: ["id","itemCountString","__typename"]
//   loggedIn: true   <-- wrong
//
// A guest gets a userCarts object, an id, a viewSection and a cart. There is no
// user field anywhere in the response. So this query cannot answer the login
// question, and four attempts to derive it from the cart failed because the
// answer was never in there.
//
// 401 is a real signal but a partial one: it only appears on a COLD session.
// Loading any storefront page mints a guest session, after which the same call
// returns 200 with a cart — which is exactly what happened between his 08:59
// and 09:14 runs, the assisted handover having navigated to the search page in
// between. The cart id changed, which is how that is known rather than guessed.
describe('what the session response can and cannot tell us', () => {
  itWithFixture('storefront.html', 'reports cookie NAMES and never values', async (runner) => {
    // The last candidate discriminator. A session cookie's name is enough to
    // tell a signed-in session from a guest; its value IS the session and does
    // not belong in a log file.
    await runner.inject(gqlStub());
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(Array.isArray(msg.cookieNames)).toBe(true);
    // Whatever the fixture's cookies are, no entry may carry a value.
    for (const name of msg.cookieNames as string[]) {
      expect(name).not.toContain('=');
    }
  });
});

// ── A GUEST IS NOT A USER ───────────────────────────────────────────────────
//
// Stephen, 2026-09-07: "you can be a guest in instacart sites but store is
// still required. The problem is we need to make the user be logged in so that
// they can view their cart when they leave mealio."
//
// That reframes what login detection is FOR. It is not a precondition the
// automation needs in order to function -- the automation functions fine as a
// guest, which is the trap. It is a precondition the USER needs, because items
// added to a guest cart are unreachable from their account the moment they
// leave the app. A guest run is a silent no-op wearing a success message.
describe('being signed in, as distinct from having a cart', () => {
  itWithFixture('storefront.html', 'a cart plus a denied account reads SIGNED OUT', async (runner) => {
    // The case the old rule could not express. ActiveCarts is perfectly happy
    // and returns this retailer's cart, so `!!mine` alone says signed in --
    // and the account query says there is nobody there.
    await runner.inject(gqlStub({ opStatus: { CurrentUser: 401 } }));
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.ok).toBe(true);
    expect(msg.acctDenied).toBe(true);
    expect(msg.loggedIn).toBe(false);
  });

  itWithFixture('storefront.html', 'a cart plus a live account still reads signed in', async (runner) => {
    // The other direction, which matters just as much: the new check must not
    // wall the one banner that has always worked. ALDI with a real session is
    // the regression this file exists to prevent.
    await runner.inject(gqlStub());
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.loggedIn).toBe(true);
    expect(msg.acctDenied).toBe(false);
  });

  itWithFixture('storefront.html', 'reports the account SHAPE, and no account values', async (runner) => {
    await runner.inject(gqlStub());
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    const acct = msg.acct as Record<string, unknown>;
    expect(acct.answered).toBe(true);
    expect(acct.cuNull).toBe(false);
    expect(acct.namePresent).toBe(true);
    // The id's LENGTH travels; the id does not, and neither does the name.
    expect(acct.idLen).toBe('usr_00000001'.length);
    expect(acct.cuKeys).toEqual(['id', 'firstName', 'email', 'guest', 'ordersCount']);
    expect(acct.emailPresent).toBe(true);
    // KEY NAMES travel, VALUES do not, and the difference is the whole design:
    // cuKeys is how the guest rule gets settled, so it has to say which fields
    // exist -- while the id, the name and the email behind those fields are
    // exactly what must never reach a log file Stephen mails around.
    const wire = JSON.stringify(msg);
    expect(acct.cuKeys).toContain('email');
    expect(wire).not.toContain('usr_00000001');
    expect(wire).not.toContain('NAMEVALUE');
    expect(wire).not.toContain('EMAILVALUE');
  });

  itWithFixture('storefront.html', 'a 200 with no user does NOT wall the user yet', async (runner) => {
    // Deliberate, and the most important assertion here. This is the shape a
    // polite guest response would have, and the rule Stephen's requirement
    // eventually wants is "no user means guest". It is not switched on: the
    // response shape is unmeasured, the walk that reads it is a heuristic, and
    // a heuristic that merely FAILS TO FIND a user would wall every signed-in
    // user on every banner. That is the same class of mistake as the three
    // regressions before it, so it waits for one guest capture and one
    // signed-in capture rather than shipping on an assumption.
    await runner.inject(gqlStub({ currentUser: { currentUser: null } }));
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    // cuNull is the field that would drive the strict rule, and here it is
    // TRUE -- a guest, plainly. It still does not wall anyone yet.
    expect((msg.acct as Record<string, unknown>).cuNull).toBe(true);
    expect(msg.loggedIn).toBe(true);
  });
});

// ── THE STORE SAYS IT OUTRIGHT ──────────────────────────────────────────────
//
// Stephen, after signing out: "we are still not getting prompted to login for
// aldi". His capture carried the answer in a field nobody had read:
//
//   cuKeys: [firstName, lastName, fullName, email, id, GUEST, admin,
//            ordersCount, businessOrganizationOptional, ...]
//
// currentUser has a boolean named guest. Every signal this project tried to
// derive -- a cart existing, a shop id, an avatar image, a 401 from a cold
// page -- was an attempt to infer something Instacart states plainly.
describe('the guest flag', () => {
  itWithFixture('storefront.html', 'a guest is signed out, cart or no cart', async (runner) => {
    // The case that has been wrong since the beginning: ActiveCarts is happy,
    // a cart for this retailer exists, and the shopper is nobody.
    await runner.inject(gqlStub({ currentUser: { currentUser: {
      id: 'guest_1', guest: true, ordersCount: 0 } } }));
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect((msg.acct as Record<string, unknown>).guest).toBe(true);
    expect(msg.acctGuest).toBe(true);
    expect(msg.loggedIn).toBe(false);
  });

  itWithFixture('storefront.html', 'a real account with a cart is signed in', async (runner) => {
    await runner.inject(gqlStub());
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect((msg.acct as Record<string, unknown>).guest).toBe(false);
    expect((msg.acct as Record<string, unknown>).ordersCount).toBe(3);
    expect(msg.loggedIn).toBe(true);
  });

  itWithFixture('storefront.html', 'a MISSING guest field walls nobody', async (runner) => {
    // The safety direction, and the reason this ships at all. A banner whose
    // currentUser does not carry the field must behave exactly as it does
    // today. Reading a missing field as falsy would be fine here by luck; the
    // danger is the opposite reflex -- treating "did not say" as "guest" --
    // which would wall every user of every tenant that words it differently.
    await runner.inject(gqlStub({ currentUser: { currentUser: { id: 'u1' } } }));
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect((msg.acct as Record<string, unknown>).guest).toBeNull();
    expect(msg.acctGuest).toBe(false);
    expect(msg.loggedIn).toBe(true);
  });

  itWithFixture('storefront.html', 'a non-boolean guest is "did not say", not "no"', async (runner) => {
    // typeof-checked rather than coerced. A string "false" is truthy and would
    // wall a signed-in user; a string "true" is not a boolean and must not be
    // trusted to wall one either.
    await runner.inject(gqlStub({ currentUser: { currentUser: {
      id: 'u1', guest: 'false' } } }));
    await runner.inject(buildAldiSessionScript('aldi'));
    const msg = await runner.waitForMessage('ALDI_SESSION', 15_000) as Record<string, unknown>;
    expect((msg.acct as Record<string, unknown>).guest).toBeNull();
    expect(msg.loggedIn).toBe(true);
  });
});
