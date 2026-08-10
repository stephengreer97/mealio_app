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
  match: (lines: any[], target: any) => any;
  confirm: (target: any, before: any, after: any) => any;
  contradicted: (conf: any, why?: string) => any;
  read: (timeoutMs?: number) => Promise<any>;
  confirmAdd: (target: any, before: any, opts?: any) => Promise<any>;
  targetFromCard: (card: any, name: string | null) => any;
  body: () => string;
}

type FetchStub = (url: string, init: any) => Promise<{ status: number; text: () => Promise<string> }>;

/**
 * `posted`, when supplied, gives the sandbox a `window.ReactNativeWebView` and
 * collects everything the rail puts on the bridge. Omitted, there is no `window`
 * at all — which is also the case this rail's own diagnostics have to survive,
 * since every other test here evaluates it in exactly that sandbox.
 */
function makeRail(fetchStub?: FetchStub, posted?: any[]): Rail {
  const src = `(function() {
${buildHebCartQueryFn()}
    return {
      parse: __hebCartParse, match: __hebCartMatch, confirm: __hebCartConfirm,
      contradicted: __hebCartContradicted,
      read: __hebCartRead, confirmAdd: __hebCartConfirmAdd,
      targetFromCard: __hebTargetFromCard, body: __hebCartBody
    };
  })()`;
  const sandbox: Record<string, unknown> = {
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
  };
  if (posted) {
    sandbox.window = {
      ReactNativeWebView: { postMessage: (s: string) => posted.push(JSON.parse(s)) },
    };
  }
  return vm.runInNewContext(src, sandbox);
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

/** The `Cart.id` a capture carries — the field the identity gate compares. */
function cartId(fixtureName: string): string {
  return cartResponseFrom(fixtureName).data.cartV2.id;
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

// ── MEAL-16: the failing read's own words ─────────────────────────────────────
//
// The 2026-08-10 live run returned `unknown/graphql_error` on all 20 adds: the
// POST cleared Imperva and H-E-B's gateway answered with a structured GraphQL
// error. `reason` alone cannot say which contract broke — a persisted-query
// safelist, a drifted selection set and a session problem are all one bare
// `graphql_error` — and the message that names it was captured by the parse and
// then dropped by the confirm. These tests hold it on the confirmation.

describe('MEAL-16 the gateway’s own error message survives to the confirmation', () => {
  const rail = makeRail();
  const target = { skuId: null, productId: LAVASH, name: 'Lavash' };

  it('carries the GraphQL message off the after-read', () => {
    const after = rail.parse(200, { data: null, errors: [{ message: 'PersistedQueryNotFound' }] });
    const conf = rail.confirm(target, null, after);
    expect(conf).toMatchObject({ state: 'unknown', reason: 'graphql_error', detail: 'PersistedQueryNotFound' });
  });

  it('carries the network exception message too', () => {
    const conf = rail.confirm(target, null, { ok: false, reason: 'network', status: null, detail: 'Load failed' });
    expect(conf.detail).toBe('Load failed');
  });

  it('carries the BEFORE-read’s message on `no_baseline`, where the after-read is the one that succeeded', () => {
    const after = rail.parse(200, cartResponseFrom(CART));
    const before = rail.parse(200, { data: null, errors: [{ message: 'Cannot query field "cartV2" on type "Query"' }] });
    const conf = rail.confirm(target, before, after);
    expect(conf).toMatchObject({ state: 'unknown', reason: 'no_baseline' });
    expect(conf.detail).toBe('Cannot query field "cartV2" on type "Query"');
  });

  it('never pairs the baseline’s message with a different failure’s reason', () => {
    // A message attached to the wrong reason is worse than no message: this one
    // would read `unknown/blocked … PersistedQueryNotFound` and send the whole
    // investigation after safelisting when the answer was an anti-bot wall.
    const before = rail.parse(200, { data: null, errors: [{ message: 'PersistedQueryNotFound' }] });
    const after = rail.parse(403, {});
    const conf = rail.confirm(target, before, after);
    expect(conf).toMatchObject({ state: 'unknown', reason: 'blocked' });
    expect(conf.detail).toBeNull();
  });

  it('says nothing on `no_target`, a verdict about us rather than about a read', () => {
    const after = rail.parse(200, { data: null, errors: [{ message: 'PersistedQueryNotFound' }] });
    const conf = rail.confirm({ skuId: null, productId: null, name: 'Lavash' }, null, after);
    expect(conf).toMatchObject({ state: 'unknown', reason: 'no_target' });
    expect(conf.detail).toBeNull();
  });

  it('is null on every verdict where both reads succeeded', () => {
    const full = cartResponseFrom(CART);
    const before = rail.parse(200, withoutProduct(full, LAVASH));
    const after = rail.parse(200, full);
    expect(rail.confirm(target, before, after)).toMatchObject({ state: 'landed', detail: null });
    expect(rail.confirm(target, after, after)).toMatchObject({ state: 'missing', detail: null });
  });

  it('stays inside the parse’s 120-char cap — a log line, not a page of HTML', async () => {
    const long = 'x'.repeat(500);
    const rail2 = makeRail(async () => ({
      status: 200,
      text: async () => JSON.stringify({ data: null, errors: [{ message: long }] }),
    }));
    const conf = await rail2.confirmAdd(target, null, { firstDelayMs: 0, gapMs: 0 });
    expect(conf.detail).toHaveLength(120);
  });

  it('reaches the caller through the polling wrapper, which is how the device sees it', async () => {
    const rail2 = makeRail(async () => ({
      status: 200,
      text: async () => JSON.stringify({ data: null, errors: [{ message: 'query not allowed' }] }),
    }));
    const conf = await rail2.confirmAdd(target, null, { firstDelayMs: 0, gapMs: 0 });
    expect(conf).toMatchObject({ state: 'unknown', reason: 'graphql_error', detail: 'query not allowed' });
  });
});

// ── MEAL-16 second half: the four fields the message alone could not supply ────
//
// The message came back `Field "cartV2" of type "Query" must have a selection of
// subfields` on all 23 reads of the 2026-08-10 21:31 run. HEB_CART_QUERY HAS a
// selection set, so a validator that received our text cannot have written that
// sentence — and nothing in the log could say whether the text was mangled in
// transit, whether the gateway resolved our operationName against a registry
// instead of executing the document, or whether cartV2 simply moved. The same run
// then walled 16 s in, and `blocked` collapsed three causes into one word.
//
// Five things settle both, every one of them already in hand and thrown away at
// the verdict boundary: HTTP status, errors[0].extensions.code,
// errors[0].locations, the body actually sent, and which wall `blocked` was.

describe('MEAL-16 which wall a `blocked` read hit', () => {
  const rail = makeRail();

  it.each([
    // MEAL-12 measured the ABP wall as a 401 carrying an incidentId. The id is
    // read BEFORE the status for exactly this row: called 'auth' it would report
    // "the session died, ABP was not involved" about a measured ABP response.
    ['an Imperva 401 with an incident body', 'incident', 401, { incidentId: '1318000700134302733-80225616898953604', errorCode: '15' }],
    ['an incident body served as 200', 'incident', 200, { incidentId: 'abc' }],
    ['a bare 401 — the H-E-B session died mid-run', 'auth', 401, {}],
    ['a bare 403', 'auth', 403, {}],
    ['the ABP interstitial served as 200 HTML', 'interstitial', 200, '<html>Pardon Our Interruption…</html>'],
  ])('reports %s as %s', (_label, block, status, body) => {
    const json = typeof body === 'string' ? null : body;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const snap = rail.parse(status as number, json, text);
    // The VERDICT vocabulary is untouched — this ticket is diagnostic only, and
    // 'blocked' is what the callers and the funnel read.
    expect(snap).toMatchObject({ ok: false, reason: 'blocked', block });
    expect(snap.status).toBe(status);
  });

  it('carries the cause and the status onto the verdict, where a human can read them', () => {
    const target = { skuId: null, productId: LAVASH, name: null };
    const conf = rail.confirm(target, null, rail.parse(401, {}));
    expect(conf).toMatchObject({ state: 'unknown', reason: 'blocked', block: 'auth', status: 401 });
  });

  it('leaves `block` null on every failure that is not a wall', () => {
    for (const snap of [
      rail.parse(500, { data: null }),
      rail.parse(200, { data: null, errors: [{ message: 'nope' }] }),
      rail.parse(200, { data: { somethingElse: true } }),
    ]) {
      expect(snap.block == null).toBe(true);
    }
  });
});

describe('MEAL-16 the GraphQL error’s code and location', () => {
  const rail = makeRail();
  const target = { skuId: null, productId: LAVASH, name: null };

  // The live shape, verbatim from the 21:31 run. If the gateway had been
  // resolving our operationName against a safelist, `code` is where it would say
  // so; `locations` is what says whether it was looking at the document we sent —
  // our own cartV2 is at line 2, column 3.
  const LIVE = {
    data: null,
    errors: [{
      message: 'Field "cartV2" of type "Query" must have a selection of subfields. Did you mean "cartV2 { ... }"?',
      locations: [{ line: 2, column: 3 }],
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
    }],
  };

  it('keeps the code and the first location off errors[0]', () => {
    expect(rail.parse(400, LIVE)).toMatchObject({
      ok: false, reason: 'graphql_error', status: 400,
      code: 'GRAPHQL_VALIDATION_FAILED', loc: '2:3',
    });
  });

  it('carries both onto the verdict, beside the message', () => {
    const conf = rail.confirm(target, null, rail.parse(200, LIVE));
    expect(conf).toMatchObject({
      state: 'unknown', reason: 'graphql_error',
      code: 'GRAPHQL_VALIDATION_FAILED', loc: '2:3', status: 200,
    });
    expect(conf.detail).toContain('must have a selection of subfields');
  });

  it('is null, not undefined-shaped, when the gateway sends neither', () => {
    const snap = rail.parse(200, { data: null, errors: [{ message: 'bare' }] });
    expect(snap.code).toBeNull();
    expect(snap.loc).toBeNull();
  });

  it('survives a location with no column rather than printing "2:undefined"', () => {
    const snap = rail.parse(200, { data: null, errors: [{ message: 'x', locations: [{ line: 2 }] }] });
    expect(snap.loc).toBe('2:?');
  });
});

describe('MEAL-16 every verdict reports the status of the read its reason names', () => {
  const rail = makeRail();
  const target = { skuId: null, productId: LAVASH, name: null };
  const full = cartResponseFrom(CART);

  it('reports the after-read’s status when both reads succeeded', () => {
    const before = rail.parse(200, withoutProduct(full, LAVASH));
    const after = rail.parse(200, full);
    expect(rail.confirm(target, before, after)).toMatchObject({ state: 'landed', status: 200 });
  });

  it('reports the BEFORE-read’s status on `no_baseline`, the one verdict about that read', () => {
    const after = rail.parse(200, full);
    const before = rail.parse(503, { data: null });
    const conf = rail.confirm(target, before, after);
    expect(conf).toMatchObject({ state: 'unknown', reason: 'no_baseline', status: 503 });
  });

  it('never pairs one read’s status with another read’s verdict', () => {
    // The trap #107 closed for `detail`, one field wider: a 200 baseline printed
    // beside a 401 verdict would say the session was fine at the moment we walled.
    const before = rail.parse(200, full);
    const after = rail.parse(401, {});
    const conf = rail.confirm(target, before, after);
    expect(conf).toMatchObject({ state: 'unknown', reason: 'blocked', status: 401, block: 'auth' });
    expect(conf.detail).toBeNull();
  });

  it('is null — never 0 — when there was no response to have a status', () => {
    expect(rail.confirm(target, null, null).status).toBeNull();
    expect(rail.confirm({ skuId: null, productId: null, name: null }, null, rail.parse(500, {})).status).toBeNull();
  });

  it('holds the whole diagnostic through a withdrawn verdict', () => {
    // A contradiction is the signal that should make us turn the flag off, so it
    // is the last verdict that can afford to arrive without its evidence.
    const conf = rail.confirm(target, rail.parse(500, { data: null }), rail.parse(200, full));
    const out = rail.contradicted(conf, 'contradicted_by_card');
    expect(out).toMatchObject({ state: 'unknown', reason: 'contradicted_by_card', status: 500 });
  });
});

describe('MEAL-16 the request body we actually send', () => {
  const target = { skuId: null, productId: LAVASH, name: null };

  it('logs the body handed to fetch, byte for byte, with the endpoint it went to', async () => {
    const posted: any[] = [];
    const { fn, calls } = stubFetch(200, cartResponseFrom(CART));
    const rail = makeRail(fn, posted);
    await rail.read(1000);
    const line = posted.find((m) => m.step === 'cart_query_body');
    expect(line).toMatchObject({ type: 'EXTRACT_DEBUG', endpoint: '/graphql', op: HEB_CART_OPERATION });
    // The point of the line: not a second call to __hebCartBody that could differ,
    // but the string fetch was given.
    expect(line.body).toBe(calls[0].init.body);
    expect(JSON.parse(line.body).query).toBe(HEB_CART_QUERY);
  });

  it('logs it ONCE per page, not once per poll — five reads, one line', async () => {
    const posted: any[] = [];
    const { fn } = stubFetch(200, withoutProduct(cartResponseFrom(CART), LAVASH));
    const rail = makeRail(fn, posted);
    const before = { ok: true, cartId: cartId(CART), lines: [], itemCount: 0, status: 200 };
    await rail.confirmAdd(target, before, { firstDelayMs: 0, gapMs: 0, tries: 5 });
    expect(posted.filter((m) => m.step === 'cart_query_body')).toHaveLength(1);
  });

  it('reads the cart normally on a surface with no bridge at all', async () => {
    // Every other test in this file runs in a sandbox with no `window`. A
    // diagnostic that threw there would take the whole rail down with it.
    const { fn } = stubFetch(200, cartResponseFrom(CART));
    const rail = makeRail(fn);
    expect(await rail.read(1000)).toMatchObject({ ok: true });
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
    // The baseline carries the same cartId the polled responses do — a real
    // before-read of the same cart always does, and a mismatch is now its own
    // verdict (see the cart-identity tests below).
    const before = { ok: true, cartId: cartId(CART), lines: [], itemCount: 0, status: 200 };
    const conf = await rail.confirmAdd({ skuId: null, productId: LAVASH, name: null }, before, { firstDelayMs: 0, gapMs: 0, tries: 5 });
    expect(conf).toMatchObject({ state: 'landed' });
    expect(i).toBe(3);
  });

  it('reports missing once the cart has answered every time and the line is not there', async () => {
    const full = cartResponseFrom(CART);
    const { fn, calls } = stubFetch(200, withoutProduct(full, LAVASH));
    const rail = makeRail(fn);
    const before = { ok: true, cartId: cartId(CART), lines: [], itemCount: 0, status: 200 };
    const conf = await rail.confirmAdd({ skuId: LAVASH_SKU, productId: LAVASH, name: 'Lavash' }, before, { firstDelayMs: 0, gapMs: 0, tries: 3 });
    expect(calls).toHaveLength(3);
    expect(conf).toMatchObject({ state: 'missing', reason: 'absent_from_cart', skuId: LAVASH_SKU });
  });
});

// The failure this rail must never produce: a VALID answer about a DIFFERENT cart.
// It is not a read failure, so none of the 'unknown' plumbing above catches it —
// every line is absent, so every item would report missing. MEAL-12's probes were
// all logged-out and still got 200s, so a worker that loses its H-E-B session
// mid-run lands exactly here.
describe('MEAL-14 the cart we baselined is the cart we read', () => {
  it('refuses to call an item missing when the cart id changed under us', () => {
    const rail = makeRail();
    const after = rail.parse(200, cartResponseFrom(CART));
    const before = { ok: true, cartId: 'someone-elses-cart', lines: [], itemCount: 0, status: 200 };
    // LAVASH is genuinely absent from `before` and present in `after` — on cart
    // identity alone this would read as a clean landing. It must not.
    const conf = rail.confirm({ skuId: null, productId: LAVASH, name: null }, before, after);
    expect(conf).toMatchObject({ state: 'unknown', reason: 'cart_changed' });
  });

  it('does not report a mass miss when the session drops and a guest cart answers', () => {
    const rail = makeRail();
    const mine = rail.parse(200, cartResponseFrom(CART));
    const guest = rail.parse(200, { data: { cartV2: { id: 'guest-cart', itemCount: { total: 0 }, items: [] } } });
    // Every product we could ask about is absent from the guest cart. Without the
    // identity gate each one returns missing/absent_from_cart, and a whole meal
    // lands in the review queue for the user to re-add.
    for (const pid of [LAVASH, COFFEE, TORTILLAS]) {
      const conf = rail.confirm({ skuId: null, productId: pid, name: null }, mine, guest);
      expect(conf.state).toBe('unknown');
      expect(conf.state).not.toBe('missing');
    }
  });

  it('compares equal when neither read carried an id, so a dropped field does not disable the rail', () => {
    const rail = makeRail();
    const full = cartResponseFrom(CART);
    const noId = JSON.parse(JSON.stringify(full));
    noId.data.cartV2.id = null;
    const after = rail.parse(200, noId);
    const before = { ok: true, cartId: null, lines: [], itemCount: 0, status: 200 };
    expect(rail.confirm({ skuId: null, productId: LAVASH, name: null }, before, after))
      .toMatchObject({ state: 'landed' });
  });

  // KNOWN LIMITATION, pinned so it is visible rather than discovered. If H-E-B
  // returns no Cart.id for an EMPTY cart, the baseline for the first add of a run
  // carries none while the after-read does, and the rail degrades to the DOM path
  // for that item. That is the safe direction — never a false miss — but it would
  // quietly halve the rail's coverage, and no committed capture shows an empty
  // H-E-B cart, so it is unresolved. The authenticated probe on the checklist
  // should capture one.
  it('degrades to unknown, never missing, when only one side carried an id', () => {
    const rail = makeRail();
    const after = rail.parse(200, cartResponseFrom(CART));
    const before = { ok: true, cartId: null, lines: [], itemCount: 0, status: 200 };
    const conf = rail.confirm({ skuId: null, productId: LAVASH, name: null }, before, after);
    expect(conf).toMatchObject({ state: 'unknown', reason: 'cart_changed' });
  });
});

// One product can hold more than one cart line: CartItem.id is
// "item#<productId>#<preferenceId>", and the committed weight capture carries
// "item#3454081#b58dbfed-…". A first-match-wins lookup reads the same pre-existing
// line in both snapshots, sees no change, and calls a successful add missing.
describe('MEAL-14 a product with more than one cart line', () => {
  function twoLines(qtyA: number, qtyB: number): any {
    const full = cartResponseFrom(CART);
    const line = full.data.cartV2.items.find((i: any) => i.product.id === LAVASH);
    const second = JSON.parse(JSON.stringify(line));
    line.quantity = qtyA;
    second.id = `item#${LAVASH}#a-second-preference`;
    second.quantity = qtyB;
    full.data.cartV2.items.push(second);
    return full;
  }

  it('sums every line for the product instead of taking the first', () => {
    const rail = makeRail();
    const snap = rail.parse(200, twoLines(1, 2));
    const m = rail.match(snap.lines, { skuId: null, productId: LAVASH, name: null });
    expect(m.qty).toBe(3);
    expect(m.lineCount).toBe(2);
  });

  it('confirms an add that landed on a NEW line while the old one stood still', () => {
    const rail = makeRail();
    // Before: one line at 1. After: that line untouched, plus a second at 1.
    const before = rail.parse(200, twoLines(1, 0));
    before.lines = before.lines.filter((l: any) => l.lineId !== `item#${LAVASH}#a-second-preference`);
    const after = rail.parse(200, twoLines(1, 1));
    expect(rail.confirm({ skuId: null, productId: LAVASH, name: null }, before, after))
      .toMatchObject({ state: 'landed' });
  });
});

// A 'missing' verdict used to end the matter, discarding __waitCardAdded — the
// per-card label heb.ts calls the reliable success signal because a sibling
// worker's add cannot nudge it.
describe('MEAL-14 withdrawing a verdict a second signal contradicts', () => {
  it('downgrades to unknown, never up to landed, and keeps the identity', () => {
    const rail = makeRail();
    const missing = { state: 'missing', reason: 'absent_from_cart', skuId: LAVASH_SKU, productId: LAVASH, qtyAfter: 0, weightAfter: null };
    const out = rail.contradicted(missing, 'contradicted_by_card');
    expect(out).toMatchObject({ state: 'unknown', reason: 'contradicted_by_card', skuId: LAVASH_SKU, productId: LAVASH });
    expect(out.state).not.toBe('landed');
  });

  it('still says the rail spoke, so the disagreement is not telemetered as a DOM-only add', () => {
    // confirmDetail (pool-add-funnel) reads an absent confirmVia as "no rail
    // ran". A contradiction is the signal that should make us turn the flag off;
    // it must not arrive looking like a row where the cart was never asked.
    const rail = makeRail();
    const out = rail.contradicted({ state: 'missing', reason: 'absent_from_cart', skuId: null, productId: LAVASH }, 'contradicted_by_card');
    expect(out.via).toBe('cart_query');
  });

  it('names the disagreement even without a reason, so it is never silently confirmed', () => {
    const rail = makeRail();
    const out = rail.contradicted({ state: 'missing', reason: 'qty_unchanged', skuId: null, productId: LAVASH }, undefined);
    expect(out.state).toBe('unknown');
    expect(out.reason).toBe('contradicted');
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

  // MEAL-16. The confirmation is diagnostic only on the device — nothing renders
  // it — so the debug postMessage is the ONLY way `detail` reaches a human, and
  // the whole point of carrying it is to read it off Metro after a live run.
  it('puts the message on the debug line, on every path that asks the cart', async () => {
    await loadAutomationConfig(async () => ({
      version: 15,
      config: { stores: { heb: { cartSkuConfirm: true } } },
    }));
    const { add, fused } = hebAddScripts();
    expect(fused).toContain(`step: 'cart_query_confirm'`);
    expect(fused).toContain('detail: __cartConf.detail');
    expect(add).toContain(`step: 'cart_query_confirm'`);
    expect(add).toContain(`step: 'cart_query_crosscheck'`);
    expect(add.match(/detail: __cartConf\.detail/g)).toHaveLength(2);
    // MEAL-16's four: a field carried on the confirmation but left off the
    // postMessage reaches nobody — the confirmation itself is never rendered.
    for (const field of ['status', 'code', 'loc', 'block']) {
      expect(fused).toContain(`__cartConf.${field}`);
      expect(add.match(new RegExp(`__cartConf\\.${field}`, 'g'))!.length).toBeGreaterThanOrEqual(2);
    }
    // …and the one line that says what we actually put on the wire.
    expect(fused).toContain(`step: 'cart_query_body'`);
    expect(add).toContain(`step: 'cart_query_body'`);
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
