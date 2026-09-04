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
  customer?: unknown; cartNoId?: boolean;
} = {}) {
  return [
    '(function () {',
    '  window.__algolia = [];',
    '  window.__commerce = [];',
    // Recorded separately: the customer branch answers and returns before the
    // generic recorder below, and other tests count __commerce.length.
    '  window.__customerUrls = [];',
    '  window.__writes = [];',
    '  window.__cart = ' + JSON.stringify(opts.cart ?? []) + ';',
    '  var HITS = ' + JSON.stringify(opts.hits ?? [hit()]) + ';',
    '  window.fetch = function (url, init) {',
    '    var u = String(url);',
    '    if (u.indexOf("algolia.net") > 0) {',
    '      var body = JSON.parse(init.body);',
    '      window.__algolia.push(body);',
    // A sku-filtered lookup answers with THAT sku. The add resolves each item's
    // catalogue row this way, and a stub that returns the same hit whatever is
    // asked makes a batch of N look like a batch of 1.
    '      var reqs = body.requests || [];',
    '      var multi = reqs.length > 1 || (reqs[0] && /objectID:/.test(reqs[0].filters || ""));',
    '      if (multi) {',
    '        var results = reqs.map(function (rq) {',
    '          var m = /objectID:"[0-9]+-([^"]+)"/.exec(rq.filters || "");',
    '          if (!m) return { hits: HITS, nbHits: HITS.length };',
    '          var one = JSON.parse(JSON.stringify(HITS[0] || {}));',
    '          one.skuId = m[1]; one.productId = m[1]; one.objectID = "140-" + m[1];',
    '          return { hits: [one], nbHits: 1 };',
    '        });',
    '        return Promise.resolve({ status: ' + String(opts.algoliaStatus ?? 200) + ',',
    '          text: function () { return Promise.resolve(JSON.stringify({ results: results })); } });',
    '      }',
    '      return Promise.resolve({ status: ' + String(opts.algoliaStatus ?? 200) + ',',
    '        text: function () { return Promise.resolve(JSON.stringify({ hits: HITS, nbHits: HITS.length, processingTimeMS: 13 })); } });',
    '    }',
    // Same-origin, unauthenticated: where the store's "140-CHAPEL-HILL" key
    // comes from, and the one prerequisite of a write that needs no token.
    '    if (u.indexOf("openid-configuration") > 0) {',
    '      window.__oidc = (window.__oidc || 0) + 1;',
    '      return Promise.resolve({ status: 200, text: function () { return Promise.resolve(',
    '        JSON.stringify({ token_endpoint: "https://myaccount.wegmans.test/tok" })); } });',
    '    }',
    '    if (u.indexOf("/tok") > 0) {',
    '      window.__refreshBody = init && init.body ? String(init.body) : null;',
    '      return Promise.resolve({ status: 200, text: function () { return Promise.resolve(',
    '        JSON.stringify({ access_token: "fresh-access-token", refresh_token: "rotated-rt", expires_in: 3600 })); } });',
    '    }',
    '    if (u.indexOf("/api/stores") >= 0) {',
    '      return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve(',
    '        JSON.stringify([{ storeNumber: "140", key: "140-CHAPEL-HILL", name: "Chapel Hill" }])); } });',
    '    }',
    '    if (u.indexOf("/commerce/account/customer") > 0) {',
    '      window.__customerUrls.push(u);',
    '      return Promise.resolve({ status: 200, text: function () { return Promise.resolve(',
    '        ' + JSON.stringify(JSON.stringify(opts.customer ?? { customer: { id: 'cust-1', email: 'x@example.test' } })) + '); } });',
    '    }',
    '    if (u.indexOf("wegmans.cloud") > 0) {',
    '      var m = (init && init.method) || "GET";',
    '      window.__commerce.push({ url: u, method: m, body: init && init.body ? JSON.parse(init.body) : null });',
    '      if (m === "POST" && u.indexOf("/lineitems") > 0) {',
    '        var payload = JSON.parse(init.body);',
    '        window.__writes.push(payload);',
    '        var st2 = ' + String(opts.writeStatus ?? 200) + ';',
    '        if (st2 === 200) {',
    '          var lis = (payload.cartData && payload.cartData[0] && payload.cartData[0].lineItems) || [];',
    '          for (var q = 0; q < lis.length; q++) {',
    '            var hit = false;',
    '            for (var w = 0; w < window.__cart.length; w++) {',
    '              if (String(window.__cart[w].productId) === String(lis[q].sku)) {',
    // MEASURED: with the LINE ID the quantity is SET; without it the endpoint
    // only creates lines and does nothing at all to one that exists. A stub
    // that updates either way hides the whole reason the id is sent.
    '                if (lis[q].id) window.__cart[w].quantity = lis[q].quantity;',
    '                hit = true;',
    '              }',
    '            }',
    '            if (!hit) window.__cart.push({ productId: lis[q].sku, quantity: lis[q].quantity, productName: "Item" });',
    '          }',
    '        }',
    '        return Promise.resolve({ status: st2, text: function () { return Promise.resolve("{}"); } });',
    '      }',
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
    // THE MEASURED ENVELOPE, 2026-09-03. This used to answer a flat
    // { cartId, items: [{ productId, quantity }] } — the shape the old parser
    // happened to read, and not the shape the store sends. A commercetools cart
    // nests its lines and carries THREE ids per line, only one of which
    // (variant.sku) is the one search speaks. The store number rides in the
    // cart's custom fields, which is the only place it exists at all.
    '      var lines = window.__cart.map(function (it, i) {',
    '        return { id: "line-" + i + "-4e178fbf", productId: "prod-" + i + "-47b86662",',
    '                 productKey: String(it.productId), variant: { sku: String(it.productId), id: "1" },',
    '                 name: { "en-US": it.productName || "Item" }, quantity: it.quantity };',
    '      });',
    '      return Promise.resolve({ status: ' + String(opts.cartStatus ?? 200) + ',',
    '        text: function () { return Promise.resolve(JSON.stringify({ grocery: {',
    '          id: ' + (opts.cartNoId ? 'null' : '"cart-1"') + ', version: ' + (opts.cartNoId ? 'null' : '13172') + ', lineItems: lines,',
    '          custom: { customFieldsRaw: [{ name: "loyaltyNumber", value: "x" },',
    '                                      { name: "storeNumber", value: "140" }] } } })); } });',
    '    }',
    '    return Promise.resolve({ status: 404, text: function () { return Promise.resolve(""); } });',
    '  };',
    '})(); true;',
  ].join('\n');
}

describe('the session probe', () => {
  itWithFixture('shop.html', 'answers the login question before it reads a cart', async (runner) => {
    // The best login signal of any store here: MSAL keeps a PLAINTEXT account
    // list even when the credential cache is encrypted. The early answer is
    // posted off that list, so no budget of ours can make a signed-in user wait
    // to be told they are signed in.
    await runner.inject(msal(1));
    await runner.inject(cachedToken());
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const early = await runner.waitForMessage('WEGMANS_SESSION', 15_000,
      (m) => (m as Record<string, unknown>).early === true) as Record<string, unknown>;
    expect(early.loggedIn).toBe(true);
    expect(early.accounts).toBe(1);
    // A TOKEN IS PART OF THE PREMISE NOW, and that is the 2026-09-04 change.
    // This test used to run with no token at all and assert signed-in anyway;
    // an account list proves an account, not a session, and the run built on
    // that answer failed every call it made. The no-token case has its own test
    // below and its own answer: ok:false.
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'no account is a definitive signed-out', async (runner) => {
    await runner.inject(msal(0));
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const msg = await runner.waitForMessage('WEGMANS_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.ok).toBe(true);
    expect(msg.loggedIn).toBe(false);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'an account with no token answers COULD NOT ANSWER', async (runner) => {
    // An account existing and a token working are different facts, and a run
    // built on the first one wrote nothing at all on Albertsons.
    //
    // CHANGED 2026-09-04: this used to answer loggedIn TRUE with cartCapable
    // false, which is the worst of the three available answers. The access token
    // lasts an hour and the refresh token about six; when both age out there is
    // nothing left to mint with, and "signed in" lets the run proceed to fail
    // every call — cart read no_token, write no_token, "nothing was added".
    // Measured that morning: the refresh token had expired 6771 seconds earlier
    // and the session still said signed in.
    //
    // "Signed out" would be the opposite mistake — a sign-in wall for a user
    // whose cookies are fine. ok:false says what is true, COULD NOT ANSWER, and
    // the engine's repair pass loads the real storefront so MSAL can mint a
    // fresh pair and the question can be asked again.
    await runner.inject(msal(1));
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const msg = await runner.waitForMessage('WEGMANS_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.ok).toBe(false);
    expect(msg.why).toBe('token_expired');
    // It does NOT claim a verdict either way. Both would be wrong, and each is
    // wrong in a way that costs the user their run.
    expect(msg.loggedIn).toBeUndefined();
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'and never claims signed-in first', async (runner) => {
    // The early answer exists so no budget of ours can make a signed-in user
    // wait to be told they are signed in. It must not be posted here: the
    // engine's login gate takes the early answer, so an early loggedIn:true
    // would let the run start on a session that has just said it cannot answer.
    await runner.inject(msal(1));
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    await runner.waitForMessage('WEGMANS_SESSION', 15_000);
    const all = runner.messagesOfType('WEGMANS_SESSION') as Array<Record<string, unknown>>;
    expect(all.filter((m) => m.loggedIn === true)).toEqual([]);
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
    // Same outcome as above and for the same reason: an expired cache with
    // nothing mintable behind it is a question this cannot answer.
    const msg = await runner.waitForMessage('WEGMANS_SESSION', 15_000) as Record<string, unknown>;
    expect(msg.ok).toBe(false);
    expect(msg.why).toBe('token_expired');
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
    const done = await runner.waitForMessage('NET_ADD_DONE', 25_000) as Record<string, unknown>;
    // ONE request for the whole meal, in the envelope the site itself sends.
    const writes = await runner.page.evaluate('window.__writes') as Array<Record<string, any>>;
    expect(JSON.stringify({ why: done.why ?? null, wrote: done.wrote })).toContain('"wrote":2');
    expect(writes).toHaveLength(1);
    expect(writes[0].cartData[0].lineItems).toHaveLength(2);
    expect(writes[0].StoreKey).toBe('140-CHAPEL-HILL');
    expect(writes[0].customerID).toBe('cust-1');
    expect(writes[0].cartData[0].cartVersion).toBe(13172);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'ADDS ON TOP of an item the cart already holds', async (runner) => {
    // Stephen: "are preventing adding things that are already in the cart?
    // Where did you get that idea?? No other store does that and that has never
    // been the behavior."
    //
    // He is right and this file briefly did exactly that, having copied the
    // Instacart rail's guard — which exists there only because that store's
    // write SETS a line and nobody had measured it. Cart writes add on top;
    // that is the rule, and re-running a meal doubling the cart is the point.
    //
    // Here that needs the LINE's id: without it the endpoint creates lines and
    // does nothing to one that exists. With it, quantity is absolute, so
    // held + wanted is what goes out.
    await runner.inject(cachedToken());
    await runner.inject(netStub({ cart: [{ productId: '608294', quantity: 2, productName: 'Daisy' }] }));
    await runner.inject(buildWegmansNetworkAddBatchScript([item(0, '608294', 3)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    const writes = await runner.page.evaluate('window.__writes') as Array<Record<string, any>>;
    expect(JSON.stringify({ reason: res.reason ?? null, detail: res.detail ?? null,
      sent: writes[0] && writes[0].cartData[0].lineItems[0] })).toContain('"quantity":5');
    expect(res.success).toBe(true);
    const li = writes[0].cartData[0].lineItems[0];
    expect(li.id).toBe('line-0-4e178fbf');
    expect(li.quantity).toBe(5);
    const cart = await runner.page.evaluate('window.__cart') as Array<Record<string, unknown>>;
    expect(cart[0].quantity).toBe(5);
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

/**
 * A REAL MSAL ENCRYPTED CACHE, built with MSAL's own scheme.
 *
 * Read out of their bundle and confirmed against Stephen's phone:
 *   salt = base64(entry.nonce)   -- the field is called nonce; it is the SALT
 *   info = the clientId, but only when the entry key contains it
 *   key  = HKDF-SHA256(cookie.key, salt, info) -> AES-GCM 256
 *   iv   = TWELVE ZERO BYTES     -- not the stored nonce
 *
 * The rail believed this cache was unreadable and waited for the site's own
 * code to make a request it could observe. On robots.txt nothing runs, so that
 * never happened and Wegmans never had a session at all.
 */
function encryptedMsalCache(opts: { secondsLeft?: number; audience?: string; withRefresh?: boolean } = {}) {
  const clientId = 'dc83fc43-b665-438e-ac2f-1b4080bb5cdf';
  const secondsLeft = opts.secondsLeft ?? 3600;
  const audience = opts.audience ?? 'https://wegmansonline.onmicrosoft.com/api.digitaldevelopment.wegmans.cloud/Users.Profile.Read';
  const entry = {
    credentialType: 'AccessToken',
    secret: 'hdr.payload.sig',
    target: audience,
    clientId: '38c78f8d-d124-4796-8430-1cd476d9a982',
    environment: 'myaccount.wegmans.test',
    realm: '14892770-9ffd-4a38-807e-36292b99339e',
    expiresOn: String(Math.floor(Date.now() / 1000) + secondsLeft),
  };
  const refresh = {
    credentialType: 'RefreshToken',
    secret: 'refresh-token-value',
    clientId: '38c78f8d-d124-4796-8430-1cd476d9a982',
    environment: 'myaccount.wegmans.test',
  };
  return [
    '(async function () {',
    '  window.__cryptoInfo = typeof crypto + "/" + typeof (crypto && crypto.subtle) + "/secure=" + window.isSecureContext;',
    '  var enc = new TextEncoder();',
    '  var rawKey = crypto.getRandomValues(new Uint8Array(32));',
    '  var b64 = function (u) { return btoa(String.fromCharCode.apply(null, Array.from(u))); };',
    '  var salt = crypto.getRandomValues(new Uint8Array(16));',
    '  var base = await crypto.subtle.importKey("raw", rawKey, "HKDF", false, ["deriveKey"]);',
    '  var dk = await crypto.subtle.deriveKey(',
    '    { name: "HKDF", salt: salt, hash: "SHA-256", info: enc.encode(' + JSON.stringify(clientId) + ') },',
    '    base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);',
    '  var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, dk,',
    '    enc.encode(' + JSON.stringify(JSON.stringify(entry)) + '));',
    '  document.cookie = "msal.cache.encryption=" + encodeURIComponent(JSON.stringify(',
    '    { id: "cache-1", key: b64(rawKey) })) + "; path=/";',
    '  localStorage.setItem("msal.1.account.keys", JSON.stringify(["acct-0-myaccount.wegmans.com"]));',
    '  localStorage.setItem("msal.1-' + clientId + '-b2c_1a_wegmanssignupsignin.acct-0-accesstoken-x",',
    '    JSON.stringify({ id: "cache-1", nonce: b64(salt), data: b64(new Uint8Array(ct)), lastUpdatedAt: "0" }));',
    ...(opts.withRefresh ? [
      '  var salt2 = crypto.getRandomValues(new Uint8Array(16));',
      '  var dk2 = await crypto.subtle.deriveKey(',
      '    { name: "HKDF", salt: salt2, hash: "SHA-256", info: enc.encode(' + JSON.stringify(clientId) + ') },',
      '    base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);',
      '  var ct2 = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, dk2,',
      '    enc.encode(' + JSON.stringify(JSON.stringify(refresh)) + '));',
      '  localStorage.setItem("msal.1-' + clientId + '-b2c_1a_wegmanssignupsignin.acct-0-refreshtoken-x",',
      '    JSON.stringify({ id: "cache-1", nonce: b64(salt2), data: b64(new Uint8Array(ct2)), lastUpdatedAt: "0" }));',
    ] : []),
    '  window.__seeded = true;',
    '})().catch(function (e) { window.__seedErr = String(e && e.message || e); }); true;',
  ].join('\n');
}

// SubtleCrypto only exists in a SECURE CONTEXT. A fixture with no url option
// runs at origin `null`, where crypto.subtle is undefined — so these three pass
// AT_WEGMANS, naming the https origin the rail actually runs on.
describe('the bearer, read straight out of the MSAL cache', () => {
  itWithFixture('shop.html', 'decrypts it with no network and no page of our own', async (runner) => {
    await runner.inject(encryptedMsalCache());
    try {
      await runner.page.waitForFunction('window.__seeded === true', undefined, { timeout: 5000 });
    } catch (e) {
      const info = await runner.page.evaluate('[window.__cryptoInfo, window.__seedErr, location.origin]');
      throw new Error('seed failed: ' + JSON.stringify(info));
    }
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const msg = await runner.waitForMessage('WEGMANS_SESSION', 20_000) as Record<string, unknown>;
    // The proof: the store lookup was ATTEMPTED. Before this it could not be —
    // there was no token to attempt it with, and it reported 'no_token'.
    const tries = (msg.storeTries ?? []) as Array<Record<string, unknown>>;
    expect(tries.length).toBeGreaterThan(0);
    expect(tries.some((t) => t.why === 'no_token')).toBe(false);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'sends the api-version the gateway demands', async (runner) => {
    // WITHOUT IT THERE IS NO ERROR TO READ. The gateway rejects the request
    // before it adds CORS headers, so the browser reports a bare "Failed to
    // fetch" with no status — indistinguishable from an unreachable host, which
    // is exactly what made this API look unusable from the page.
    await runner.inject(encryptedMsalCache());
    await runner.page.waitForFunction('window.__seeded === true', undefined, { timeout: 5000 });
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    await runner.waitForMessage('WEGMANS_SESSION', 20_000);
    // The EARLY session answer is posted before the store lookup finishes, so
    // waiting on the message alone reads window.__commerce too soon.
    // The CART is the first commerce call a session makes now — it is where the
    // store number lives — so that is the URL to inspect.
    await runner.page.waitForFunction('window.__commerce.length > 0', undefined, { timeout: 10000 });
    const calls = await runner.page.evaluate('window.__commerce') as Array<{ url: string }>;
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.url).toContain('api-version=');
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'ignores a token for a DIFFERENT audience', async (runner) => {
    // The cache holds tokens for several APIs. Only the commerce one is ours;
    // sending another API's token would 401 and drop a good session.
    await runner.inject(encryptedMsalCache({ audience: 'https://graph.microsoft.com/User.Read' }));
    await runner.page.waitForFunction('window.__seeded === true', undefined, { timeout: 5000 });
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const msg = await runner.waitForMessage('WEGMANS_SESSION', 20_000) as Record<string, unknown>;
    const tries = (msg.storeTries ?? []) as Array<Record<string, unknown>>;
    expect(tries.some((t) => t.why === 'no_token')).toBe(true);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'ignores one that has already expired', async (runner) => {
    await runner.inject(encryptedMsalCache({ secondsLeft: 10 }));
    await runner.page.waitForFunction('window.__seeded === true', undefined, { timeout: 5000 });
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const msg = await runner.waitForMessage('WEGMANS_SESSION', 20_000) as Record<string, unknown>;
    const tries = (msg.storeTries ?? []) as Array<Record<string, unknown>>;
    expect(tries.some((t) => t.why === 'no_token')).toBe(true);
  }, AT_WEGMANS);
});

describe('a cart line carries three ids and only one of them is the product', () => {
  // MEASURED against Stephen's cart, 2026-09-03:
  //
  //   li.id           f2cc4dd6-…    the LINE
  //   li.productId    47b86662-…    the commercetools PRODUCT
  //   li.variant.sku  45407         the SKU, and what SEARCH returns
  //
  // Reading either UUID keys the held-quantity map by ids no search result can
  // match: every item looks like have = 0, the refusal of an item already in
  // the cart cannot fire, and the after-write check cannot confirm a line. That
  // exact bug shipped on the Instacart rail and was only caught against a live
  // cart, because the stub there described the shape the broken parser read.
  itWithFixture('shop.html', 'keys the cart by the SKU, not by either UUID', async (runner) => {
    await runner.inject(cachedToken());
    await runner.inject(netStub({ cart: [{ productId: '608294', quantity: 2, productName: 'Daisy Sour Cream' }] }));
    await runner.inject(buildWegmansCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 20_000) as Record<string, unknown>;
    const items = msg.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0].itemId).toBe('608294');
    // Not the line id and not the product UUID, both of which the stub emits.
    expect(String(items[0].itemId)).not.toContain('line-');
    expect(String(items[0].itemId)).not.toContain('prod-');
    // The name is a localised object on a commercetools line.
    expect(items[0].name).toBe('Daisy Sour Cream');
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'carries the cart id and version a write would need', async (runner) => {
    await runner.inject(cachedToken());
    await runner.inject(netStub({ cart: [{ productId: '608294', quantity: 1, productName: 'x' }] }));
    await runner.inject(buildWegmansCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 20_000) as Record<string, unknown>;
    expect(msg.cartId).toBe('cart-1');
    expect(msg.version).toBe(13172);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'finds the store number in the cart custom fields', async (runner) => {
    // BY NAME, never by index — it sat behind loyalty and coupon fields that
    // have no reason to keep their order. And this is the ONLY place it exists:
    // not the customer profile, not storage, not a cookie, not the HTML.
    await runner.inject(encryptedMsalCache());
    await runner.page.waitForFunction('window.__seeded === true', undefined, { timeout: 5000 });
    await runner.inject(netStub());
    await runner.inject(buildWegmansSessionScript());
    const msgs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 2; i += 1) {
      msgs.push(await runner.waitForMessage('WEGMANS_SESSION', 20_000) as Record<string, unknown>);
      if (msgs[msgs.length - 1].storeId) break;
    }
    expect(msgs.some((m) => m.storeId === '140')).toBe(true);
  }, AT_WEGMANS);
});

describe('a write always names the cart it is writing to', () => {
  const item = (idx: number, id: string, qty: number) =>
    ({ idx, productId: id, skuId: id, quantity: qty, name: 'Item ' + id });

  // THE COSTLIEST BUG OF THE DAY, and it cost a real basket.
  //
  // The write names cartID and cartVersion. Sent without them the API does not
  // fail — it CREATES A NEW CART, and the user's existing basket stops being
  // the active one. Stephen's 20-item Wegmans cart was replaced by a one-item
  // cart that way on 2026-09-03.
  //
  // The path in: the app passes `knownLines`, the prewarmed baseline, so the add
  // could skip reading the cart. That baseline carries held quantities and no
  // ids — and the write went out with cartID null.
  itWithFixture('shop.html', 'reads the cart even when the baseline was handed to it', async (runner) => {
    await runner.inject(cachedToken());
    await runner.inject(netStub({ cart: [{ productId: '999', quantity: 1, productName: 'held' }] }));
    await runner.inject(buildWegmansNetworkAddBatchScript(
      [item(0, '608294', 1)],
      // The shape the app actually passes.
      { knownLines: { '999': 1 } },
    )!);
    await runner.waitForMessage('NET_ADD_DONE', 25_000);
    const writes = await runner.page.evaluate('window.__writes') as Array<Record<string, any>>;
    expect(writes).toHaveLength(1);
    expect(writes[0].cartData[0].cartID).toBe('cart-1');
    expect(writes[0].cartData[0].cartVersion).toBe(13172);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'refuses when the cart reads back with no id', async (runner) => {
    // The cart ANSWERED — it simply carried no identity. That is the shape the
    // guard exists for: a readable cart with nothing to address, where writing
    // anyway creates a second basket.
    await runner.inject(cachedToken());
    await runner.inject(netStub({ cartNoId: true, cart: [{ productId: '999', quantity: 1, productName: 'held' }] }));
    await runner.inject(buildWegmansNetworkAddBatchScript([item(0, '608294', 1)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(res.reason).toBe('no_cart');
    const writes = await runner.page.evaluate('window.__writes') as unknown[];
    expect(writes).toHaveLength(0);
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'refuses rather than write to a cart it cannot name', async (runner) => {
    // An envelope with no id is not a write, it is a new basket. Refusing sends
    // the items to review, where the user sees them.
    await runner.inject(cachedToken());
    await runner.inject(netStub({ cartStatus: 500 }));
    await runner.inject(buildWegmansNetworkAddBatchScript([item(0, '608294', 1)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.success).toBe(false);
    expect(res.reason).toBe('no_cart');
    const writes = await runner.page.evaluate('window.__writes') as unknown[];
    expect(writes).toHaveLength(0);
  }, AT_WEGMANS);
});

describe('every script finds the bearer the same way', () => {
  const item = (idx: number, id: string, qty: number) =>
    ({ idx, productId: id, skuId: id, quantity: qty, name: 'Item ' + id });

  // The session script had the MSAL fallback; the cart read and the add did
  // not. So the moment the cached token aged out they reported no_token on a
  // device that could read one in 40ms. Stephen's run, 2026-09-03: session
  // fine, then "wrote 0 of 5, why: no_token" — "just tested wegmans and it
  // immedietly failed".
  //
  // No cachedToken() is seeded in either test below. The MSAL cache is the ONLY
  // source, which is what a real second run looks like once the hour is up.
  itWithFixture('shop.html', 'the cart read falls back to the MSAL cache', async (runner) => {
    await runner.inject(encryptedMsalCache());
    await runner.page.waitForFunction('window.__seeded === true', undefined, { timeout: 5000 });
    await runner.inject(netStub({ cart: [{ productId: '608294', quantity: 2, productName: 'Daisy Sour Cream' }] }));
    await runner.inject(buildWegmansCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 20_000) as Record<string, unknown>;
    expect(msg.count).toBe(2);
    expect(msg.reason).toBeUndefined();
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'the add falls back to the MSAL cache', async (runner) => {
    await runner.inject(encryptedMsalCache());
    await runner.page.waitForFunction('window.__seeded === true', undefined, { timeout: 5000 });
    await runner.inject(netStub());
    await runner.inject(buildWegmansNetworkAddBatchScript([item(0, '608294', 1)])!);
    const res = await runner.waitForMessage('NET_ADD_RESULT', 25_000) as Record<string, unknown>;
    expect(res.reason).not.toBe('no_token');
    expect(res.success).toBe(true);
  }, AT_WEGMANS);
});

describe('an expired token is refreshed, not surrendered to', () => {
  // The access token lasts an hour. MSAL renews it with the refresh token
  // beside it — but only where the site's own code runs, and the rail runs on
  // robots.txt where it never does. So an hour after the user last opened
  // Wegmans, every script reported no_token and the run died at the gate, on a
  // device holding a refresh token good for another six hours.
  //
  // Stephen, on exactly that: "just tested wegmans and it immedietly failed".
  itWithFixture('shop.html', 'trades the refresh token for a new access token', async (runner) => {
    // EXPIRED, with a refresh token beside it — the real second-run state.
    await runner.inject(encryptedMsalCache({ secondsLeft: -300, withRefresh: true }));
    await runner.page.waitForFunction('window.__seeded === true', undefined, { timeout: 5000 });
    await runner.inject(netStub({ cart: [{ productId: '608294', quantity: 2, productName: 'Daisy' }] }));
    await runner.inject(buildWegmansCartReadScript());
    const msg = await runner.waitForMessage('CART_COUNT', 20_000) as Record<string, unknown>;
    expect(msg.count).toBe(2);

    const body = await runner.page.evaluate('window.__refreshBody') as string;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh-token-value');
    // The scope comes off the EXPIRED token — it is the only record of what to
    // ask for, which is why the walk keeps it even when the token is stale.
    expect(decodeURIComponent(body)).toContain('wegmans.cloud');
  }, AT_WEGMANS);

  itWithFixture('shop.html', 'does not refresh when the token is still good', async (runner) => {
    await runner.inject(encryptedMsalCache({ withRefresh: true }));
    await runner.page.waitForFunction('window.__seeded === true', undefined, { timeout: 5000 });
    await runner.inject(netStub({ cart: [{ productId: '608294', quantity: 1, productName: 'Daisy' }] }));
    await runner.inject(buildWegmansCartReadScript());
    await runner.waitForMessage('CART_COUNT', 20_000);
    expect(await runner.page.evaluate('window.__refreshBody || null')).toBeNull();
  }, AT_WEGMANS);
});

describe('priced by weight is not sold by weight', () => {
  // Stephen, 2026-09-03: "Mealio says its because it is sold by weight and we
  // need to choose a weight. That is not true. Wegmans gives an average weight,
  // but it is sold by the unit qty."
  //
  // MEASURED against store 140, and isSoldByWeight is true for BOTH of these,
  // so it cannot be the discriminator:
  //
  //   Butter Boy French Butter   onlineSellByUnit "Each", approx 0.25lb, $6.48 a unit
  //   Fresh Sea Scallops         onlineSellByUnit "lb",   approx 0,      $32.99 a pound
  //
  // The unit of SALE is the answer. Asking someone to pick a weight for a thing
  // you buy one of sends it to review for nothing.
  const check = (label: string, over: Record<string, unknown>, expected: boolean) => {
    itWithFixture('shop.html', label, async (runner) => {
      await runner.inject(cachedToken());
      await runner.inject(netStub({ hits: [hit(over)] }));
      await runner.inject(buildWegmansNetworkSearchBatchScript(['butter'], { storeNumber: '140' })!);
      const msg = await runner.waitForMessage('SEARCH_RESULT', 20_000) as Record<string, unknown>;
      const cands = msg.candidates as Array<Record<string, unknown>>;
      expect(cands[0].isWeightItem).toBe(expected);
    }, AT_WEGMANS);
  };

  check('sold Each with an average weight is NOT a weight item',
    { isSoldByWeight: true, onlineSellByUnit: 'Each', onlineApproxUnitWeight: 0.25 }, false);
  check('sold by the pound IS a weight item',
    { isSoldByWeight: true, onlineSellByUnit: 'lb', onlineApproxUnitWeight: 0 }, true);
  check('sold "ea", lower case, is not',
    { isSoldByWeight: true, onlineSellByUnit: 'ea' }, false);
  check('sold by the ounce is',
    { isSoldByWeight: true, onlineSellByUnit: 'oz' }, true);
  // With no unit named the flag is the only signal left, so it is used.
  check('no unit named falls back to the flag (true)',
    { isSoldByWeight: true, onlineSellByUnit: null }, true);
  check('no unit named falls back to the flag (false)',
    { isSoldByWeight: false, onlineSellByUnit: null }, false);
});
