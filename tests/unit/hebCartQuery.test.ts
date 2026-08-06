// MEAL-14 — the H-E-B cart-query confirmation rail.
//
// The rail's parse/diff/confirm logic exists ONLY as the injectable JS string
// buildHebCartQueryFn() returns, so that the code on the device is the only copy
// and nothing can drift from it. These tests therefore evaluate that string in a
// sandbox and call its helpers directly — the same technique
// generatedScripts.test.ts uses to prove every script parses.
//
// The cart payloads are not invented. They are projected out of the
// `window.__APOLLO_STATE__` blocks in the committed cart captures, which are
// Apollo's normalized cache of the cart query's own response: the field names
// below are H-E-B's, recorded from a real logged-in session, not a guess at a
// schema. `cartResponseFrom` walks that cache through our document's selection
// set, so what the parser sees is what the gateway would return for
// HEB_CART_QUERY.

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

import {
  loadAutomationConfig,
  __resetAutomationConfigForTests,
} from '../../src/lib/automation-config';
import { getStoreScripts } from '../../src/lib/webview-scripts';
import { buildHebCartQueryFn, HEB_CART_QUERY, HEB_CART_OPERATION } from '../../src/lib/webview-scripts/heb-cart-query';

// ── The rail, instantiated in a sandbox ───────────────────────────────────────

interface Rail {
  parse: (status: number, json: unknown, text?: string) => any;
  find: (lines: any[], target: any) => any;
  confirm: (target: any, before: any, after: any) => any;
  read: (timeoutMs?: number) => Promise<any>;
  confirmAdd: (target: any, before: any, opts?: any) => Promise<any>;
  targetFromCard: (card: any, name: string | null) => any;
  body: () => string;
}

type FetchStub = (url: string, init: any) => Promise<{ status: number; text: () => Promise<string> }>;

function makeRail(fetchStub?: FetchStub): Rail {
  const src = `(function() {
${buildHebCartQueryFn()}
    return {
      parse: __hebCartParse, find: __hebCartFind, confirm: __hebCartConfirm,
      read: __hebCartRead, confirmAdd: __hebCartConfirmAdd,
      targetFromCard: __hebTargetFromCard, body: __hebCartBody
    };
  })()`;
  return vm.runInNewContext(src, {
    fetch: fetchStub,
    setTimeout,
    clearTimeout,
    AbortController,
    isFinite,
    JSON,
    Promise,
    Number,
    String,
    Array,
  });
}

/** A fetch stub that answers every call the same way, counting calls. */
function stubFetch(status: number, body: unknown | string) {
  const calls: { url: string; init: any }[] = [];
  const fn: FetchStub = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  return { fn, calls };
}

// ── Cart payloads projected out of the committed captures ─────────────────────

function fixture(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'heb', name), 'utf8');
}

/** Extract the `window.__APOLLO_STATE__ = {…}` object from a captured page.
 *  Scans braces while respecting string literals — the cache keys themselves
 *  contain braces (`Product:{"id":"6454594",…}`). */
function apolloState(html: string): Record<string, any> {
  const marker = 'window.__APOLLO_STATE__ = ';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error('fixture carries no __APOLLO_STATE__');
  const start = at + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('unterminated __APOLLO_STATE__');
}

/** Project the captured cache through HEB_CART_QUERY's selection set — i.e.
 *  rebuild the response the gateway would have sent for our document. */
function cartResponseFrom(fixtureName: string): any {
  const state = apolloState(fixture(fixtureName));
  const cart = state[state.ROOT_QUERY.cartV2.__ref];
  return {
    data: {
      cartV2: {
        id: cart.id,
        itemCount: { total: cart.itemCount.total },
        items: cart.items.map((ref: any) => {
          const it = state[ref.__ref];
          const prod = state[it.product.__ref];
          const sku = it.sku ? state[it.sku.__ref] : null;
          return {
            id: it.id,
            quantity: it.quantity,
            estimatedWeight: it.estimatedWeight,
            product: { id: prod.id, fullDisplayName: prod.fullDisplayName },
            sku: sku
              ? {
                id: sku.id,
                twelveDigitUPC: sku.twelveDigitUPC,
                weightSelectionIncrements: sku.weightSelectionIncrements,
              }
              : null,
          };
        }),
      },
    },
  };
}

/** The same response with one product's line removed — the "before" snapshot for
 *  an add that then lands, or the "after" for one that never did. */
function withoutProduct(response: any, productId: string): any {
  const clone = JSON.parse(JSON.stringify(response));
  clone.data.cartV2.items = clone.data.cartV2.items.filter(
    (it: any) => it.product.id !== productId,
  );
  return clone;
}

const CART = 'cart-with-items.html';
const WEIGHT_CART = 'cart-with-weight-item.html';

// Products read off the captures, by id → the identity a result card can also see.
const LAVASH = '6454594';           // countable, qty 1
const COFFEE = '894630';            // sold by weight, estimatedWeight 1 lb
const ROAST_BEEF = '3454081';       // sold by weight + a purchase preference
const TORTILLAS = '124989';         // countable, qty 2
const LAVASH_SKU = '70741503985';

describe('MEAL-14 cart response parsing (against the committed captures)', () => {
  it('reads every line of a real cart, with the ids the diff needs', () => {
    const rail = makeRail();
    const snap = rail.parse(200, cartResponseFrom(CART));
    expect(snap.ok).toBe(true);
    expect(snap.itemCount).toBe(2);
    expect(snap.lines).toHaveLength(2);
    expect(snap.lines[0]).toMatchObject({
      lineId: 'item#6454594#',
      skuId: LAVASH_SKU,
      productId: LAVASH,
      qty: 1,
      isWeight: false,
      weight: null,
    });
    expect(snap.lines[0].name).toContain('Lavash');
  });

  it('marks exactly the sold-by-weight lines as weight lines', () => {
    const rail = makeRail();
    const snap = rail.parse(200, cartResponseFrom(WEIGHT_CART));
    expect(snap.ok).toBe(true);
    expect(snap.lines).toHaveLength(16);
    // The three lines H-E-B priced per lb in this capture, and only those.
    const weight = snap.lines.filter((l: any) => l.isWeight).map((l: any) => l.productId).sort();
    expect(weight).toEqual([ROAST_BEEF, '373297', COFFEE].sort());
    // A weight line contributes 1 by PRESENCE, never a unit count — the rule in
    // cart-reconcile's isWeightPriced, which a SKU diff must not regress.
    const coffee = snap.lines.find((l: any) => l.productId === COFFEE);
    expect(coffee).toMatchObject({ qty: 1, isWeight: true, weight: 1 });
    // "1 lb bag" and "Avg. 0.6 lb" items are countable despite their names.
    const bag = snap.lines.find((l: any) => l.productId === '11439511');
    expect(bag).toMatchObject({ isWeight: false, qty: 2 });
  });

  it("keeps a multi-unit line's count", () => {
    const rail = makeRail();
    const snap = rail.parse(200, cartResponseFrom(WEIGHT_CART));
    expect(snap.lines.find((l: any) => l.productId === TORTILLAS).qty).toBe(2);
  });

  it('recovers the product id from the line id when product{} is absent', () => {
    const rail = makeRail();
    const response = {
      data: { cartV2: { id: 'c', itemCount: { total: 1 }, items: [{ id: 'item#314026#abc', quantity: 1, estimatedWeight: null, product: null, sku: null }] } },
    };
    expect(rail.parse(200, response).lines[0].productId).toBe('314026');
  });

  it('reads an empty cart as an empty cart, not as a failure', () => {
    const rail = makeRail();
    const snap = rail.parse(200, { data: { cartV2: { id: 'c', itemCount: { total: 0 }, items: [] } } });
    expect(snap).toMatchObject({ ok: true, lines: [], itemCount: 0 });
  });
});

describe('MEAL-14 unreadable carts never look like absent items', () => {
  const rail = makeRail();

  it.each([
    ['an Imperva 401 with an incident body', 'blocked', 401, { incidentId: '1318000700134302733-80225616898953604', errorCode: '15' }],
    ['a bare 403', 'blocked', 403, {}],
    ['the ABP interstitial served as 200 HTML', 'blocked', 200, '<html>Pardon Our Interruption…</html>'],
    ['a 500', 'http_error', 500, { data: null }],
    ['a GraphQL error', 'graphql_error', 200, { data: null, errors: [{ message: 'Cannot query field "cartV3"' }] }],
    ['JSON that is not a cart', 'shape', 200, { data: { somethingElse: true } }],
    ['a null cart', 'shape', 200, { data: { cartV2: null } }],
    ['a body that is not JSON at all', 'shape', 200, 'not json'],
  ])('classifies %s as %s', (_label, reason, status, body) => {
    const json = typeof body === 'string' ? null : body;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const snap = rail.parse(status as number, json, text);
    expect(snap.ok).toBe(false);
    expect(snap.reason).toBe(reason);
  });

  it('turns every read failure into `unknown`, never `missing`', () => {
    const target = { skuId: null, productId: LAVASH, name: 'Lavash' };
    for (const reason of ['blocked', 'http_error', 'graphql_error', 'shape', 'network', 'timeout']) {
      const conf = rail.confirm(target, null, { ok: false, reason, status: null });
      expect(conf.state).toBe('unknown');
      expect(conf.reason).toBe(reason);
    }
  });

  it('is `unknown`, not `landed`, when the item is present but the baseline is unreadable', () => {
    const after = rail.parse(200, cartResponseFrom(CART));
    const conf = rail.confirm({ skuId: null, productId: LAVASH, name: null }, { ok: false, reason: 'timeout', status: null }, after);
    expect(conf).toMatchObject({ state: 'unknown', reason: 'no_baseline', productId: LAVASH });
  });
});

describe('MEAL-14 confirming one add against the cart', () => {
  const rail = makeRail();
  const full = cartResponseFrom(CART);

  it('names the item the cart says is absent', () => {
    const before = rail.parse(200, withoutProduct(full, LAVASH));
    const after = rail.parse(200, withoutProduct(full, LAVASH));
    const conf = rail.confirm({ skuId: LAVASH_SKU, productId: LAVASH, name: 'Lavash Flatbread' }, before, after);
    expect(conf).toMatchObject({
      state: 'missing',
      via: 'cart_query',
      reason: 'absent_from_cart',
      skuId: LAVASH_SKU,
      productId: LAVASH,
    });
  });

  it('confirms an add that landed', () => {
    const before = rail.parse(200, withoutProduct(full, LAVASH));
    const after = rail.parse(200, full);
    const conf = rail.confirm({ skuId: null, productId: LAVASH, name: null }, before, after);
    expect(conf).toMatchObject({ state: 'landed', reason: 'qty_increased', qtyAfter: 1 });
    // The cart's own sku comes back even though the card could not supply one.
    expect(conf.skuId).toBe(LAVASH_SKU);
  });

  it('calls a line that is present but unchanged a miss, and says why', () => {
    const before = rail.parse(200, full);
    const after = rail.parse(200, full);
    const conf = rail.confirm({ skuId: null, productId: LAVASH, name: null }, before, after);
    expect(conf).toMatchObject({ state: 'missing', reason: 'qty_unchanged' });
  });

  it('matches on sku regardless of leading-zero padding', () => {
    const before = rail.parse(200, withoutProduct(full, LAVASH));
    const after = rail.parse(200, full);
    const conf = rail.confirm({ skuId: `000${LAVASH_SKU}`, productId: null, name: null }, before, after);
    expect(conf.state).toBe('landed');
  });

  it('is `unknown` when nothing identifies the target', () => {
    expect(rail.confirm({ skuId: null, productId: null, name: 'x' }, null, null))
      .toMatchObject({ state: 'unknown', reason: 'no_target' });
  });

  // The acceptance criterion: for an 8-line meal, say WHICH one failed.
  it('names the one failed line out of eight, and confirms the other seven', () => {
    const cart = cartResponseFrom(WEIGHT_CART);
    const ids = [COFFEE, TORTILLAS, '374854', '442356', '2229625', '125577', '318939', '8506006'];
    const FAILED = '442356';
    const targets = ids.map((productId) => ({ skuId: null, productId, name: `product ${productId}` }));
    // Before the run none of the eight were in the cart; afterwards seven are.
    let beforeBody = cart;
    for (const id of ids) beforeBody = withoutProduct(beforeBody, id);
    const before = rail.parse(200, beforeBody);
    const after = rail.parse(200, withoutProduct(cart, FAILED));

    const verdicts = targets.map((t) => ({ productId: t.productId, ...rail.confirm(t, before, after) }));
    expect(verdicts.filter((v) => v.state === 'missing').map((v) => v.productId)).toEqual([FAILED]);
    expect(verdicts.filter((v) => v.state === 'landed')).toHaveLength(7);
    expect(verdicts.filter((v) => v.state === 'unknown')).toHaveLength(0);
    const failed = verdicts.find((v) => v.productId === FAILED)!;
    expect(failed.reason).toBe('absent_from_cart');
    // Named, not counted: the report carries the identity, not just a tally.
    expect(failed.productId).toBe(FAILED);
    // The weight line among the eight is confirmed by presence, as the shared
    // sold-by-weight rule requires — not by comparing poundage.
    expect(verdicts.find((v) => v.productId === COFFEE)).toMatchObject({
      state: 'landed', reason: 'weight_line_new',
    });
  });
});

describe('MEAL-14 sold-by-weight lines', () => {
  const rail = makeRail();
  const cart = cartResponseFrom(WEIGHT_CART);

  it('confirms a weight line that is new to the cart, by presence', () => {
    const before = rail.parse(200, withoutProduct(cart, COFFEE));
    const after = rail.parse(200, cart);
    expect(rail.confirm({ skuId: null, productId: COFFEE, name: null }, before, after))
      .toMatchObject({ state: 'landed', reason: 'weight_line_new', weightAfter: 1, qtyAfter: 1 });
  });

  it('confirms a weight line that got heavier', () => {
    const lighter = JSON.parse(JSON.stringify(cart));
    lighter.data.cartV2.items.find((i: any) => i.product.id === COFFEE).estimatedWeight = 0.5;
    const before = rail.parse(200, lighter);
    const after = rail.parse(200, cart);
    expect(rail.confirm({ skuId: null, productId: COFFEE, name: null }, before, after))
      .toMatchObject({ state: 'landed', reason: 'weight_increased' });
  });

  it('will not call an unchanged weight line missing — the add rounds, so presence is the tolerance', () => {
    const before = rail.parse(200, cart);
    const after = rail.parse(200, cart);
    expect(rail.confirm({ skuId: null, productId: ROAST_BEEF, name: null }, before, after))
      .toMatchObject({ state: 'unknown', reason: 'weight_unchanged' });
  });
});

describe('MEAL-14 reading the cart over the wire', () => {
  it('POSTs the full query document, same-origin, with no persisted-query hash', async () => {
    const { fn, calls } = stubFetch(200, cartResponseFrom(CART));
    const rail = makeRail(fn);
    const snap = await rail.read(1000);
    expect(snap.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/graphql');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.credentials).toBe('include');
    expect(calls[0].init.headers['content-type']).toBe('application/json');
    const body = JSON.parse(calls[0].init.body);
    expect(body.query).toBe(HEB_CART_QUERY);
    expect(body.operationName).toBe(HEB_CART_OPERATION);
    // MEAL-12: never send a hash we cannot verify.
    expect(body.extensions).toBeUndefined();
  });

  it('reports a thrown fetch as `network`, not as an empty cart', async () => {
    const rail = makeRail(async () => { throw new Error('Load failed'); });
    expect(await rail.read(1000)).toMatchObject({ ok: false, reason: 'network' });
  });

  it('reports an aborted fetch as `timeout`', async () => {
    const rail = makeRail(async () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    expect(await rail.read(1000)).toMatchObject({ ok: false, reason: 'timeout' });
  });
});

describe('MEAL-14 polling for the add to land', () => {
  it('stops after ONE read when the cart is blocked, and reports unknown', async () => {
    const { fn, calls } = stubFetch(401, { incidentId: 'x', errorCode: '15' });
    const rail = makeRail(fn);
    const conf = await rail.confirmAdd({ skuId: null, productId: LAVASH, name: null }, null, { firstDelayMs: 0, gapMs: 0, tries: 5 });
    // Not five: hammering a blocked endpoint is how a rail gets a session banned,
    // and MEAL-12 flagged ABP behaviour under load as its largest unknown.
    expect(calls).toHaveLength(1);
    expect(conf).toMatchObject({ state: 'unknown', reason: 'blocked' });
  });

  it('retries a transient network failure', async () => {
    let n = 0;
    const rail = makeRail(async () => {
      n++;
      throw new Error('connection reset');
    });
    const conf = await rail.confirmAdd({ skuId: null, productId: LAVASH, name: null }, null, { firstDelayMs: 0, gapMs: 0, tries: 3 });
    expect(n).toBe(3);
    expect(conf).toMatchObject({ state: 'unknown', reason: 'network' });
  });

  it('polls until the store has recorded the add, then stops', async () => {
    const full = cartResponseFrom(CART);
    const empty = withoutProduct(full, LAVASH);
    const bodies = [empty, empty, full, full];
    let i = 0;
    const rail = makeRail(async () => ({
      status: 200,
      text: async () => JSON.stringify(bodies[Math.min(i++, bodies.length - 1)]),
    }));
    const before = { ok: true, lines: [], itemCount: 0, status: 200 };
    const conf = await rail.confirmAdd({ skuId: null, productId: LAVASH, name: null }, before, { firstDelayMs: 0, gapMs: 0, tries: 5 });
    expect(conf).toMatchObject({ state: 'landed' });
    expect(i).toBe(3);
  });

  it('reports missing once the cart has answered every time and the line is not there', async () => {
    const full = cartResponseFrom(CART);
    const { fn, calls } = stubFetch(200, withoutProduct(full, LAVASH));
    const rail = makeRail(fn);
    const before = { ok: true, lines: [], itemCount: 0, status: 200 };
    const conf = await rail.confirmAdd({ skuId: LAVASH_SKU, productId: LAVASH, name: 'Lavash' }, before, { firstDelayMs: 0, gapMs: 0, tries: 3 });
    expect(calls).toHaveLength(3);
    expect(conf).toMatchObject({ state: 'missing', reason: 'absent_from_cart', skuId: LAVASH_SKU });
  });
});

// ── The flag ──────────────────────────────────────────────────────────────────
//
// Same shape as MEAL-13's `nextDataSearch`: bundled OFF, reachable by a config
// push, and the DOM rail still in the binary either way. A build that shipped
// with this on by default would be shipping an unverified authenticated GraphQL
// operation to every H-E-B user, which is what these two tests exist to prevent.

describe('MEAL-14 flag gating', () => {
  afterEach(() => __resetAutomationConfigForTests());

  function hebAddScripts() {
    const s = getStoreScripts('heb')!;
    return {
      add: s.buildAddToCartScript('H-E-B Regular Sour Cream, 16 oz', null, 1, null),
      fused: s.buildSearchAndAddScript('sour cream', 1, null),
    };
  }

  it('bakes the rail OFF by default', () => {
    const { add, fused } = hebAddScripts();
    expect(add).toContain('__HEB_CART_RAIL = false');
    expect(fused).toContain('__HEB_CART_RAIL = false');
    // The badge/DOM confirmation it falls back to is still there.
    expect(fused).toContain('__waitForCartIncrease');
    expect(add).toContain('__waitCardAdded');
  });

  it('turns on from a config push, and the rail reaches the script', async () => {
    await loadAutomationConfig(async () => ({
      version: 14,
      config: { stores: { heb: { cartSkuConfirm: true } } },
    }));
    const { add, fused } = hebAddScripts();
    expect(add).toContain('__HEB_CART_RAIL = true');
    expect(fused).toContain('__HEB_CART_RAIL = true');
    expect(fused).toContain('__hebCartConfirmAdd');
    // …and the fallback is NOT removed by turning the rail on.
    expect(fused).toContain('__waitForCartIncrease');
  });

  it('parses as valid JS in both states', async () => {
    for (const on of [false, true]) {
      __resetAutomationConfigForTests();
      if (on) {
        await loadAutomationConfig(async () => ({
          version: 14, config: { stores: { heb: { cartSkuConfirm: true } } },
        }));
      }
      const { add, fused } = hebAddScripts();
      // A botched interpolation is a syntax error that silently kills the whole
      // injected script — the WebView reports nothing and the run just times out.
      expect(() => new vm.Script(add)).not.toThrow();
      expect(() => new vm.Script(fused)).not.toThrow();
    }
  });
});

describe('MEAL-14 target identity from a result card', () => {
  const rail = makeRail();

  it('reads the product id out of a card link', () => {
    const card = {
      querySelector: () => ({ getAttribute: () => '/product-detail/h-e-b-regular-sour-cream-16-oz/314026' }),
    };
    expect(rail.targetFromCard(card, 'H-E-B Regular Sour Cream, 16 oz')).toEqual({
      skuId: null, productId: '314026', name: 'H-E-B Regular Sour Cream, 16 oz',
    });
  });

  it('gives up rather than guessing when the card has no product link', () => {
    expect(rail.targetFromCard({ querySelector: () => null }, 'x')).toBeNull();
    expect(rail.targetFromCard(null, 'x')).toBeNull();
  });
});
