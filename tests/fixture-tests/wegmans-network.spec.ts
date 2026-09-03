// Wegmans over the network.
//
// Three parts with three different certainties, and the tests are written to
// hold that difference rather than smooth it over.
//
//   login   free and MEASURED — a localStorage read, no network at all
//   search  free and MEASURED — Algolia, no session, 13ms filtered
//   cart    needs a BEARER that MSAL keeps encrypted, so it has a provider with
//           fallbacks, and the tests below pin what happens when it has none
//
// The thing most worth protecting is that the first two do not depend on the
// third. A Wegmans run whose token has expired must still search at full speed.

import {
  buildWegmansSessionScript,
  buildWegmansNetworkSearchBatchScript,
  buildWegmansCartReadScript,
  buildWegmansNetworkAddBatchScript,
} from '../../src/lib/webview-scripts/wegmans-network';
import { storeFixtures } from './_helpers';

const { itWithFixture } = storeFixtures('wegmans');

/** The rail caches in localStorage, which about:blank denies outright. */
const AT_WEGMANS = { url: 'https://www.wegmans.com/robots.txt' };

/** MSAL's own storage, as it really looks: an account list in the clear and a
 *  credential cache that is NOT ({id, nonce, data} — see the research). */
function msal(accounts: number) {
  const keys = Array.from({ length: accounts }, (_, i) => `acct-${i}-myaccount.wegmans.com`);
  return [
    '(function () {',
    '  localStorage.setItem("msal.1.account.keys", ' + JSON.stringify(JSON.stringify(keys)) + ');',
    '  localStorage.setItem("msal.1-x-b2c.acct-0-accesstoken-x",',
    '    JSON.stringify({ id: "1", nonce: "n", data: "ciphertext", lastUpdatedAt: "0" }));',
    '})(); true;',
  ].join('\n');
}

/** A bearer already captured, with a real-looking JWT expiry. */
function cachedToken(expiresInSec = 3600) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expiresInSec }))
    .toString('base64').replace(/=+$/, '');
  const jwt = `hdr.${payload}.sig`;
  return `(function () {
    localStorage.setItem('__mealio_weg_tok_v1', JSON.stringify({ t: ${JSON.stringify(jwt)}, exp: ${Math.floor(Date.now() / 1000) + expiresInSec} }));
  })(); true;`;
}

/** One Algolia hit, in the shape MEASURED off the real index. */
function hit(over: Record<string, unknown> = {}) {
  return {
    productName: 'Daisy Sour Cream, Pure & Natural',
    productId: '608294', skuId: '608294', objectID: '140-608294',
    storeNumber: '140', isAvailable: true, isSoldAtStore: true, isSoldByWeight: false,
    maxQuantity: 99, upc: ['00073420016142'],
    images: ['https://images.wegmans.com/608294'],
    price_inStore: { amount: 2.99 }, price_delivery: { amount: 3.49 },
    ...over,
  };
}

/** Algolia and the commerce API, both stubbed, both recording what was asked. */
function netStub(opts: {
  hits?: unknown[]; algoliaStatus?: number;
  cart?: Array<Record<string, unknown>>; cartStatus?: number; writeStatus?: number;
  customer?: unknown;
} = {}) {
  return [
    '(function () {',
    '  window.__algolia = [];',
    '  window.__commerce = [];',
    '  window.__cart = ' + JSON.stringify(opts.cart ?? []) + ';',
    '  var HITS = ' + JSON.stringify(opts.hits ?? [hit()]) + ';',
    '  window.fetch = function (url, init) {',
    '    var u = String(url);',
    '    if (u.indexOf("algolia.net") > 0) {',
    '      window.__algolia.push(JSON.parse(init.body));',
    '      return Promise.resolve({ status: ' + String(opts.algoliaStatus ?? 200) + ',',
    '        text: function () { return Promise.resolve(JSON.stringify({ hits: HITS, nbHits: HITS.length, processingTimeMS: 13 })); } });',
    '    }',
    '    if (u.indexOf("/commerce/account/customer") > 0) {',
    '      return Promise.resolve({ status: 200, text: function () { return Promise.resolve(',
    '        ' + JSON.stringify(JSON.stringify(opts.customer ?? { id: 'c1' })) + '); } });',
    '    }',
    '    if (u.indexOf("wegmans.cloud") > 0) {',
    '      var m = (init && init.method) || "GET";',
    '      window.__commerce.push({ url: u, method: m, body: init && init.body ? JSON.parse(init.body) : null });',
    '      if (m === "POST") {',
    '        var st = ' + String(opts.writeStatus ?? 200) + ';',
    '        if (st === 200) {',
    '          var items = JSON.parse(init.body).items || [];',
    '          for (var i = 0; i < items.length; i++) {',
    '            var found = false;',
    '            for (var j = 0; j < window.__cart.length; j++) {',
    '              if (String(window.__cart[j].productId) === String(items[i].productId)) {',
    // SET, which is what every other store here does. The script must not
    // depend on that being true, which is what the refusal test is about.
    '                window.__cart[j].quantity = items[i].quantity; found = true;',
    '              }',
    '            }',
    '            if (!found) window.__cart.push({ productId: items[i].productId, quantity: items[i].quantity, productName: "Item" });',
    '          }',
    '        }',
    '        return Promise.resolve({ status: st, text: function () { return Promise.resolve("{}"); } });',
    '      }',
    '      return Promise.resolve({ status: ' + String(opts.cartStatus ?? 200) + ',',
    '        text: function () { return Promise.resolve(JSON.stringify({ cartId: "cart-1", items: window.__cart })); } });',
    '    }',
    '    return Promise.resolve({ status: 404, text: function () { return Promise.resolve(""); } });',
    '  };',
    '})(); true;',
  ].join('\n');
}

describe('the session probe', () => {
  itWithFixture('shop.html', 'answers the login question with no network at all', async (runner) => {
    // The best login signal of any store here: MSAL keeps a PLAINTEXT account
    // list even when the credential cache is encrypted.
    await runner.inject(msal(1));
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const early = await runner.waitForMessage('WEGMANS_SESSION', 15_000,
      (m) => (m as Record<string, unknown>).early === true) as Record<string, unknown>;
    expect(early.loggedIn).toBe(true);
    // No request was needed to say so.
    const calls = await runner.page.evaluate('window.__commerce.length');
    expect(calls).toBe(0);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'no account is a definitive signed-out', async (runner) => {
    await runner.inject(msal(0));
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const msg = await runner.waitForMessage('WEGMANS_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.ok).toBe(true);
    expect(msg.loggedIn).toBe(false);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'signed in but no token is NOT usable for a run', async (runner) => {
    // The Albertsons shape, for a different reason: an account existing and a
    // token working are different facts, and a run built on the first one wrote
    // nothing at all on that store.
    await runner.inject(msal(1));
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const refined = await runner.waitForMessage('WEGMANS_SESSION', 15_000,
      (m) => (m as Record<string, unknown>).early === undefined
        && (m as Record<string, unknown>).loggedIn === true) as Record<string, unknown>;
    expect(refined.verified).toBe(false);
    expect(refined.cartCapable).toBe(false);
    expect(refined.why).toBe('no_token');
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'with a cached token it proves it before saying so', async (runner) => {
    await runner.inject(msal(1));
    await runner.inject(cachedToken());
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const refined = await runner.waitForMessage('WEGMANS_SESSION', 20_000,
      (m) => (m as Record<string, unknown>).cartCapable !== undefined) as Record<string, unknown>;
    expect(refined.verified).toBe(true);
    expect(refined.cartCapable).toBe(true);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'an expired cached token is not offered to a write', async (runner) => {
    // Read out of the JWT rather than trusted from when we stored it, with a
    // minute of slack so a token about to expire is not handed to a write that
    // will outlive it.
    await runner.inject(msal(1));
    await runner.inject(cachedToken(-10));
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const refined = await runner.waitForMessage('WEGMANS_SESSION', 15_000,
      (m) => (m as Record<string, unknown>).cartCapable !== undefined) as Record<string, unknown>;
    expect(refined.cartCapable).toBe(false);
    expect(refined.why).toBe('no_token');
  }, AT_WEGMANS);
});

describe('search', () => {
  itWithFixture('shop.html', 'needs no session — the whole point of this store', async (runner) => {
    // No MSAL, no token, nothing signed in. Algolia answers anyway.
    await runner.inject(netStub());
    await runner.inject(buildWegmansNetworkSearchBatchScript(['sour cream'], { storeNumber: '140' })!);
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000) as Record<string, unknown>;
    const cands = msg.candidates as Array<Record<string, unknown>>;
    expect(cands.length).toBe(1);
    expect(cands[0].productName).toContain('Daisy Sour Cream');
    expect(cands[0].productId).toBe('608294');
    // The cap arrives WITH the product. H-E-B only discovers its cap when a
    // write is refused.
    expect(cands[0].maxOrderQuantity).toBe(99);
    expect(cands[0].price).toBe('$2.99');
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'filters by store, because the product id is per store', async (runner) => {
    // The same Daisy sour cream is 626485 at store 50 and 608294 at store 140,
    // and unfiltered "sour cream" returns 32,223 hits — every store at once.
    await runner.inject(netStub());
    await runner.inject(buildWegmansNetworkSearchBatchScript(['sour cream'], { storeNumber: '140' })!);
    await runner.waitForMessage('SEARCH_BATCH_DONE', 15_000);
    const asked = await runner.page.evaluate('window.__algolia') as Array<Record<string, unknown>>;
    expect(asked[0].filters).toBe('storeNumber:140');
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'carries the UPC, so a store change need not lose the choice', async (runner) => {
    // The id is per store; the barcode is not. Saving only the id would make a
    // store change resolve to the wrong product or to nothing.
    await runner.inject(netStub());
    await runner.inject(buildWegmansNetworkSearchBatchScript(['sour cream'], { storeNumber: '140' })!);
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000) as Record<string, unknown>;
    const cands = msg.candidates as Array<Record<string, unknown>>;
    expect(cands[0].upc).toBe('00073420016142');
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'an item the store does not sell here is out of stock, not a match', async (runner) => {
    await runner.inject(netStub({ hits: [hit({ isSoldAtStore: false })] }));
    await runner.inject(buildWegmansNetworkSearchBatchScript(['sour cream'], { storeNumber: '140' })!);
    const msg = await runner.waitForMessage('SEARCH_RESULT', 15_000) as Record<string, unknown>;
    expect((msg.candidates as Array<Record<string, unknown>>)[0].outOfStock).toBe(true);
  }, AT_WEGMANS);
});

describe('which store', () => {
  it('refuses to search without one, rather than offering another store\'s products', () => {
    // The SAME Daisy sour cream is 626485 at store 50 and 608294 at store 140,
    // and unfiltered "sour cream" returns 32,223 hits — every store at once. An
    // unfiltered search offers real products under real names carrying ids that
    // are not valid where this user shops, and saving one as their choice would
    // add the wrong product next run.
    expect(buildWegmansNetworkSearchBatchScript(['sour cream'], { storeNumber: null })).toBeNull();
    expect(buildWegmansNetworkSearchBatchScript(['sour cream'], {})).toBeNull();
    expect(buildWegmansNetworkSearchBatchScript(['sour cream'], { storeNumber: '140' })).toBeTruthy();
  });

  itWithFixture('shop.html', 'says it could not find one, and why', async (runner) => {
    // MEASURED 2026-09-03: the store number is nowhere a page can be asked for
    // it — not a cookie, not localStorage, not the server HTML of / or /shop,
    // and four plausible /api paths are all 404. It comes with the customer
    // profile, behind the bearer. So a session with no token has no store, and
    // the probe says so rather than guessing.
    await runner.inject(msal(1));
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const msg = await runner.waitForMessage('WEGMANS_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.storeId).toBeNull();
    const tries = msg.storeTries as Array<Record<string, unknown>>;
    expect(tries[0].why).toBe('no_token');
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'finds it from the customer profile once there is a token', async (runner) => {
    await runner.inject(msal(1));
    await runner.inject(cachedToken());
    await runner.inject(netStub({ customer: { profile: { preferredStoreNumber: 140 } } }));
    await runner.inject(buildWegmansSessionScript());
    const msg = await runner.waitForMessage('WEGMANS_SESSION', 15_000,
      (m) => (m as Record<string, unknown>).early === true) as Record<string, unknown>;
    expect(msg.storeId).toBe('140');
  }, AT_WEGMANS);
});

describe('the cart', () => {
  itWithFixture('shop.html', 'says so plainly when it has no token', async (runner) => {
    // NOT an empty cart. Calling "nobody could read it" an empty one makes
    // everything the user already owned look like this run's doing.
    await runner.inject(netStub());
    await runner.inject(buildWegmansCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 15_000) as Record<string, unknown>;
    expect(msg.count).toBeNull();
    expect(msg.why).toBe('no_token');
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'reads the lines when it has one', async (runner) => {
    await runner.inject(cachedToken());
    await runner.inject(netStub({ cart: [{ productId: '608294', quantity: 2, productName: 'Sour Cream' }] }));
    await runner.inject(buildWegmansCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 15_000) as Record<string, unknown>;
    expect(msg.count).toBe(2);
    const items = msg.items as Array<Record<string, unknown>>;
    expect(items[0].itemId).toBe('608294');
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'a 401 drops the cached token so the next run looks again', async (runner) => {
    await runner.inject(cachedToken());
    await runner.inject(netStub({ cartStatus: 401 }));
    await runner.inject(buildWegmansCartReadScript());
    await runner.waitForMessage('CART_COUNT', 15_000);
    const still = await runner.page.evaluate('localStorage.getItem("__mealio_weg_tok_v1")');
    expect(still).toBeNull();
  }, AT_WEGMANS);
});

describe('the add', () => {
  const item = (idx: number, id: string, qty: number) =>
    ({ idx, productId: id, skuId: id, quantity: qty, name: 'Item ' + id });

  itWithFixture('shop.html', 'refuses without a token rather than pretending', async (runner) => {
    await runner.inject(netStub());
    await runner.inject(buildWegmansNetworkAddBatchScript([item(0, '608294', 2)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 20_000) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(res.reason).toBe('no_token');
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'writes every item in one call', async (runner) => {
    await runner.inject(cachedToken());
    await runner.inject(netStub());
    await runner.inject(buildWegmansNetworkAddBatchScript(
      [item(0, '608294', 2), item(1, '111', 1)],
    )!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    const calls = await runner.page.evaluate('window.__commerce') as Array<{ method: string; body: { items?: unknown[] } }>;
    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes.length).toBe(1);
    expect(writes[0].body.items!.length).toBe(2);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'REFUSES an item the cart already holds', async (runner) => {
    // Nobody has measured whether this store SETS a line or ADDS to it, and
    // that is the one case where the two readings disagree. Declined, named,
    // and sent to review rather than guessed at.
    await runner.inject(cachedToken());
    await runner.inject(netStub({ cart: [{ productId: '608294', quantity: 2, productName: 'Sour Cream' }] }));
    await runner.inject(buildWegmansNetworkAddBatchScript([item(0, '608294', 1)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(res.reason).toBe('qty_semantics_unproven');
    const calls = await runner.page.evaluate('window.__commerce') as Array<{ method: string }>;
    expect(calls.filter((c) => c.method === 'POST').length).toBe(0);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'the CART decides, not the write', async (runner) => {
    // A write that reports success and does not land is the failure mode every
    // silent add defect in this project has had.
    await runner.inject(cachedToken());
    await runner.inject(netStub());
    await runner.inject([
      '(function () {',
      '  var real = window.fetch;',
      '  window.fetch = function (url, init) {',
      '    if (String(url).indexOf("wegmans.cloud") > 0 && init && init.method === "POST") {',
      '      return Promise.resolve({ status: 200, text: function () { return Promise.resolve("{}"); } });',
      '    }',
      '    return real(url, init);',
      '  };',
      '})(); true;',
    ].join('\n'));
    await runner.inject(buildWegmansNetworkAddBatchScript([item(0, '608294', 2)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(res.reason).toBe('not_in_cart_after_write');
  }, AT_WEGMANS);
});
