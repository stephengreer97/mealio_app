// MEAL-14 — H-E-B add confirmation from the CART itself, not from the header badge.
//
// The badge rail infers: "the shared counter went up, so my add landed". It
// cannot say WHICH item landed, it moves when a sibling worker adds something
// else, and when the badge is unreadable the fallback is a fixed settle — a
// guess. This module replaces the inference with the store's own answer: POST
// H-E-B's cart query from page context, before and after the add, and compare
// the line for the product we targeted.
//
// WHY IN-PAGE. MEAL-12 (docs/heb-graphql-persisted-queries.md) measured that
// `https://www.heb.com/graphql` accepts full query strings — no persisted-hash
// safelist — but that Imperva ABP, not the gateway, is the binding constraint: a
// plain HTTP client from React Native gets a 401 with an `incidentId`. The only
// client that gets through is one that has already passed the ABP challenge and
// holds a live `reese84` token, i.e. the WebView we are already driving. So this
// runs as `fetch('/graphql')` from the page, same-origin, cookies implicit.
// Calling `fetch` is NOT patching `fetch` — the tamper-detection finding in
// docs/network-confirmation-findings.md forbids the latter and permits this.
//
// WHAT IS AND IS NOT VERIFIED (read this before flipping the flag on):
//
//  • The RESPONSE SHAPE below is verified, from committed captures. Both
//    `tests/fixtures/heb/cart-with-items.html` and `cart-with-weight-item.html`
//    carry `window.__APOLLO_STATE__`, which is Apollo's normalized cache of the
//    cart query's own response. Every field this module reads appears there:
//    ROOT_QUERY.cartV2 → Cart { id, itemCount { total }, items } and
//    CartItem { id, quantity, estimatedWeight, product, sku },
//    SKU { id, twelveDigitUPC, weightSelectionIncrements },
//    Product { id, fullDisplayName }.
//  • The bare `cartV2` cache key (contrast `Product:{"id":…,"storeId":476,…}`,
//    where Apollo encodes the field arguments into the key) is good evidence the
//    cart field takes NO arguments. That is an inference from how Apollo keys
//    fields, not a measurement.
//  • The OPERATION NAME and the document text are NOT verified. MEAL-14's ticket
//    names an operation `cartEstimated`; that string appears nowhere in this
//    repo, in any fixture, or in either findings doc, so it is not used here — a
//    guessed persisted-query hash or operation is exactly what MEAL-12 said not
//    to ship. We send our own document as text, which is the path MEAL-12
//    measured as accepted. Swapping to a hash is a one-line change in
//    `__hebCartBody` if H-E-B ever enables safelisting.
//  • AUTHENTICATED operations were never measured (MEAL-12's open gap 1, and the
//    cart query is authenticated). Nor was ABP's behaviour under a rail issuing
//    ~10 cart reads per run. Both are why this ships behind
//    `stores.heb.cartSkuConfirm`, DEFAULT FALSE, exactly as MEAL-13 shipped
//    `nextDataSearch`.
//
// FALLBACK IS THE POINT, NOT A COURTESY. Every failure to read the cart resolves
// to `state: 'unknown'`, never to "the item is missing" — a blocked cart query
// that reported mass failure would be worse than the guess it replaces. Callers
// must fall back to the badge/DOM rail on `unknown`. The three states are
// distinct all the way up: 'landed' (the cart shows our units), 'missing' (the
// cart answered and our line is absent or unchanged), 'unknown' (we could not
// read the cart).
//
// ONE IMPLEMENTATION, NOT TWO. The parse/diff/confirm logic lives only in the
// injectable JS string below — it is what actually runs on the device. Nothing
// re-implements it in TypeScript, so nothing can drift from it. The unit tests
// (tests/unit/hebCartQuery.test.ts) evaluate this same string in a sandbox and
// call the helpers directly, with payloads denormalized out of the committed
// cart fixtures' `__APOLLO_STATE__`.

import { storeConfig } from '../automation-config';

const SELECTOR_KEY = 'heb';

/**
 * MEAL-14 flag: confirm H-E-B adds against the cart query instead of the header
 * badge. Read through a FUNCTION, not a module const — the remote config lands
 * after this module is imported, so a const would freeze the bundled default and
 * a config push could never turn it on (same reason as MEAL-13's
 * `nextDataEnabled`). Default false; see the header for what is unverified.
 */
export function hebCartQueryEnabled(): boolean {
  return storeConfig(SELECTOR_KEY).cartSkuConfirm === true;
}

/** One cart line, as the rail reports it. */
export interface HebCartLine {
  /** `CartItem.id` — "item#<productId>#" or "item#<productId>#<preferenceId>". */
  lineId: string | null;
  /** `SKU.id` — the 11-digit UPC-A without its check digit, as H-E-B writes it. */
  skuId: string | null;
  /** `Product.id` — the trailing segment of a card's /product-detail/<slug>/<id>
   *  href, which is the only cart identifier the DOM add rail can also see. */
  productId: string | null;
  name: string | null;
  /** Countable units. A weight line reports 1 — see `isWeight`. */
  qty: number;
  /**
   * Sold-by-weight line: one line at N lb, no unit count to compare.
   *
   * Keyed on `estimatedWeight != null`, which across the 16 lines of
   * `cart-with-weight-item.html` holds for exactly the three lines H-E-B prices
   * per `lb` and for none of the 13 priced per `each` — including the "1 lb bag"
   * and "Avg. 0.6 lb" items, which are countable despite their names. The SKU's
   * `weightSelectionIncrements` describes the SKU, not the line, so it is
   * deliberately NOT the signal.
   */
  isWeight: boolean;
  /** Pounds on a weight line, else null. */
  weight: number | null;
}

/** Why a cart read produced no cart. Never means "the item is absent". */
export type HebCartReadFailure =
  /** Imperva ABP: 401/403, or an `incidentId` body, or the interstitial. */
  | 'blocked'
  | 'http_error'
  | 'graphql_error'
  /** 200 with JSON that is not a cart — including `data.cartV2: null`. */
  | 'shape'
  | 'network'
  | 'timeout';

export type HebCartSnapshot =
  | { ok: true; lines: HebCartLine[]; itemCount: number | null; status: number | null }
  | { ok: false; reason: HebCartReadFailure; status: number | null; detail?: string | null };

/** The product an add targeted, as far as the cart can identify it. */
export interface HebCartTarget {
  skuId: string | null;
  productId: string | null;
  name: string | null;
}

/**
 * What the cart said about one add. `state` is the decision; `reason` is why,
 * and it is what separates "the cart says this SKU is absent"
 * (`absent_from_cart`) from "we could not read the cart" (`blocked`, `timeout`,
 * `shape`, …).
 */
export interface HebAddConfirmation {
  state: 'landed' | 'missing' | 'unknown';
  /** 'cart_query' — this rail. 'dom' is what the fallback path reports. */
  via: 'cart_query' | 'dom';
  reason: string | null;
  skuId?: string | null;
  productId?: string | null;
  /** Units on the line after the add (weight lines: 1). Null when unread. */
  qtyAfter?: number | null;
  /** Pounds after the add, weight lines only. */
  weightAfter?: number | null;
}

/**
 * The cart query, as text.
 *
 * Field-for-field what the committed `__APOLLO_STATE__` captures prove the
 * server returns (see the module header). Intentionally minimal: no price, no
 * fulfillment, no `__typename` — a smaller selection set is less to break when
 * H-E-B changes its schema, and everything here is load-bearing for the diff.
 * `product.fullDisplayName` earns its place by naming the item in the report the
 * user eventually sees.
 */
export const HEB_CART_QUERY = `query MealioCartLines {
  cartV2 {
    id
    itemCount { total }
    items {
      id
      quantity
      estimatedWeight
      product { id fullDisplayName }
      sku { id twelveDigitUPC weightSelectionIncrements }
    }
  }
}`;

/** Our operation name. Deliberately ours: no evidence exists in this repo for
 *  the name H-E-B's own storefront uses for this query, and inventing a
 *  plausible-looking one would be a guess dressed as a fact. */
export const HEB_CART_OPERATION = 'MealioCartLines';

/**
 * The client name header the storefront itself sends, which MEAL-12's verified
 * probes also sent when they got real data back. Kept identical to the measured
 * request rather than omitted, so the request differs from the site's own by as
 * little as possible.
 */
const HEB_APOLLO_CLIENT = 'WebPlatform-Solar (Production)';

/**
 * The in-page rail. Defines, on `window`'s scope inside the injected IIFE:
 *
 *   __hebCartRead(timeoutMs)                  → Promise<snapshot>
 *   __hebCartParse(status, json, text)        → snapshot            (pure)
 *   __hebCartFind(lines, target)              → line | null         (pure)
 *   __hebCartConfirm(target, before, after)   → confirmation        (pure)
 *   __hebCartConfirmAdd(target, before, opts) → Promise<confirmation>
 *   __hebTargetFromCard(card, name)           → target | null
 *
 * Interpolate it into a script BEFORE the code that calls it. Safe to include
 * when the flag is off — nothing runs until called.
 */
export function buildHebCartQueryFn(): string {
  return `
  var __HEB_CART_ENDPOINT = '/graphql';
  var __HEB_CART_QUERY = ${JSON.stringify(HEB_CART_QUERY)};
  var __HEB_CART_OP = ${JSON.stringify(HEB_CART_OPERATION)};
  var __HEB_CART_CLIENT = ${JSON.stringify(HEB_APOLLO_CLIENT)};

  function __hebCartWait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  // Full query text, no extensions.persistedQuery — MEAL-12 measured that the
  // gateway executes our own document (its response carried none of the
  // __typename fields Apollo injects, so it was not pattern-matched onto a
  // cached persisted operation). If H-E-B ever enables safelisting, this is the
  // one function that changes: send { operationName, variables, extensions:
  // { persistedQuery: { version: 1, sha256Hash } } } instead.
  function __hebCartBody() {
    return JSON.stringify({ operationName: __HEB_CART_OP, variables: {}, query: __HEB_CART_QUERY });
  }

  // "item#6454594#" / "item#3454081#<prefId>" → "6454594". A fallback for the
  // product id when the selection set's product{id} is absent; verified against
  // both committed cart fixtures, where the segment always equals Product.id.
  function __hebCartProductIdFromLineId(id) {
    if (!id) return null;
    var parts = String(id).split('#');
    return (parts.length >= 2 && parts[1]) ? parts[1] : null;
  }

  // SKU ids are compared with leading zeros stripped: the cart writes "4068"
  // while a twelve-digit UPC for the same item reads "000000040686", and a
  // future producer of a target id may not agree about padding.
  function __hebCartSkuKey(v) {
    if (v == null) return null;
    var s = String(v).trim().replace(/^0+/, '');
    return s || null;
  }

  function __hebCartLine(it) {
    var sku = (it && it.sku) || null;
    var prod = (it && it.product) || null;
    var w = (it && it.estimatedWeight != null && isFinite(Number(it.estimatedWeight)))
      ? Number(it.estimatedWeight) : null;
    var q = (it && typeof it.quantity === 'number' && it.quantity > 0) ? it.quantity : 1;
    var pid = (prod && prod.id != null) ? String(prod.id) : __hebCartProductIdFromLineId(it && it.id);
    return {
      lineId: (it && it.id != null) ? String(it.id) : null,
      skuId: (sku && sku.id != null) ? String(sku.id) : null,
      productId: pid,
      name: (prod && prod.fullDisplayName) ? String(prod.fullDisplayName) : null,
      qty: (w != null) ? 1 : q,
      isWeight: w != null,
      weight: w
    };
  }

  // Classify one HTTP answer. The ordering matters: an ABP block can arrive as a
  // 401 with a JSON incident body OR as a 200 serving the interstitial, and
  // either must read as 'blocked' rather than as an empty/odd cart.
  function __hebCartParse(status, json, text) {
    if (status === 401 || status === 403) return { ok: false, reason: 'blocked', status: status };
    if (json && (json.incidentId || json.errorCode)) return { ok: false, reason: 'blocked', status: status };
    if (typeof text === 'string' && text.indexOf('Pardon Our Interruption') !== -1) {
      return { ok: false, reason: 'blocked', status: status };
    }
    if (!json || typeof json !== 'object') {
      return { ok: false, reason: (status >= 400 ? 'http_error' : 'shape'), status: status };
    }
    if (json.errors && json.errors.length > 0) {
      var m = (json.errors[0] && json.errors[0].message) ? String(json.errors[0].message) : '';
      return { ok: false, reason: 'graphql_error', status: status, detail: m.slice(0, 120) };
    }
    if (status >= 400) return { ok: false, reason: 'http_error', status: status };
    var cart = json.data && json.data.cartV2;
    // An EMPTY cart is { items: [] } and reads fine. A null cart is treated as
    // unreadable, not as empty: we have never captured what a logged-out or
    // cartless session answers, and guessing "empty" there would turn a session
    // problem into "every item failed" — the one outcome this rail must never
    // produce. Being wrong the other way only costs a fallback to the badge.
    if (!cart || !Array.isArray(cart.items)) return { ok: false, reason: 'shape', status: status };
    var lines = [];
    for (var i = 0; i < cart.items.length; i++) lines.push(__hebCartLine(cart.items[i]));
    var total = (cart.itemCount && typeof cart.itemCount.total === 'number') ? cart.itemCount.total : null;
    return { ok: true, lines: lines, itemCount: total, status: status };
  }

  // Match a target to a cart line: SKU first (the cart's own primary id), then
  // product id (the only one a DOM-driven add can read off a result card).
  function __hebCartFind(lines, target) {
    if (!lines || !target) return null;
    var sk = __hebCartSkuKey(target.skuId);
    var i;
    if (sk) {
      for (i = 0; i < lines.length; i++) if (__hebCartSkuKey(lines[i].skuId) === sk) return lines[i];
    }
    var pid = (target.productId != null && String(target.productId).trim() !== '')
      ? String(target.productId).trim() : null;
    if (pid) {
      for (i = 0; i < lines.length; i++) if (lines[i].productId === pid) return lines[i];
    }
    return null;
  }

  // The decision. Pure: two snapshots in, one confirmation out.
  function __hebCartConfirm(target, before, after) {
    var idsku = target ? target.skuId : null;
    var idprod = target ? target.productId : null;
    function out(state, reason, line) {
      return {
        state: state, via: 'cart_query', reason: reason,
        skuId: (line && line.skuId) || idsku || null,
        productId: (line && line.productId) || idprod || null,
        qtyAfter: line ? line.qty : null,
        weightAfter: line ? line.weight : null
      };
    }
    if (!target || (!idsku && !idprod)) return out('unknown', 'no_target', null);
    if (!after) return out('unknown', 'no_read', null);
    if (!after.ok) return out('unknown', after.reason || 'no_read', null);
    var a = __hebCartFind(after.lines, target);
    // The cart answered and our line is not in it. This is the one claim the
    // badge rail could never make, and the reason MEAL-14 exists.
    if (!a) return out('missing', 'absent_from_cart', null);
    // Present, but with no baseline we cannot tell our units from units that were
    // already there. Unknown, so the caller falls back — never 'landed'.
    if (!before || !before.ok) return out('unknown', 'no_baseline', a);
    var b = __hebCartFind(before.lines, target);
    if (a.isWeight) {
      // A weight line is confirmed by PRESENCE, per the single definition of
      // sold-by-weight in lib/cart-reconcile (isWeightPriced): one line at N lb
      // carries no unit count, and the add rounds to a poundage the store sells,
      // so no numeric comparison is meaningful. New line, or heavier than before
      // → this run put it there (the same rule diffCartItems uses). Same weight
      // is genuinely ambiguous — the add may have been a no-op or may have
      // re-selected the same poundage — so it is 'unknown' and falls back,
      // NOT 'missing'. Calling it missing would report a shortfall on nearly
      // every weight item, which is the regression this rail must not cause.
      if (!b) return out('landed', 'weight_line_new', a);
      var bw = (b.weight == null) ? 0 : b.weight;
      var aw = (a.weight == null) ? 0 : a.weight;
      if (aw > bw) return out('landed', 'weight_increased', a);
      return out('unknown', 'weight_unchanged', a);
    }
    var bq = b ? b.qty : 0;
    if (a.qty > bq) return out('landed', 'qty_increased', a);
    // Present at the same count as before the click: the add did not take. The
    // cart answered, so this is evidence, not an unreadable signal.
    return out('missing', 'qty_unchanged', a);
  }

  async function __hebCartRead(timeoutMs) {
    var ctl = null;
    try { ctl = new AbortController(); } catch (e) { ctl = null; }
    var timer = null;
    try {
      var init = {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'accept': '*/*',
          'apollographql-client-name': __HEB_CART_CLIENT
        },
        body: __hebCartBody()
      };
      if (ctl) init.signal = ctl.signal;
      var p = fetch(__HEB_CART_ENDPOINT, init);
      if (ctl) timer = setTimeout(function() { try { ctl.abort(); } catch (e) {} }, timeoutMs || 6000);
      var res = await p;
      var text = '';
      try { text = await res.text(); } catch (e) { text = ''; }
      var json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      return __hebCartParse(res.status, json, text);
    } catch (e) {
      var nm = String((e && e.name) || '');
      return {
        ok: false,
        reason: (nm === 'AbortError' ? 'timeout' : 'network'),
        status: null,
        detail: String((e && e.message) || '').slice(0, 120)
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Poll the cart until it shows our units. The store commits the add
  // asynchronously, so the first read can legitimately be too early — but a read
  // that FAILED is not evidence of anything, so a blocked/malformed answer stops
  // the loop immediately instead of hammering ABP (MEAL-12's largest open
  // unknown is ABP's behaviour under sustained programmatic load); only a
  // transient network/timeout is retried.
  async function __hebCartConfirmAdd(target, before, opts) {
    var o = opts || {};
    var tries = o.tries || 5;
    var gap = (o.gapMs == null) ? 500 : o.gapMs;
    var first = (o.firstDelayMs == null) ? 300 : o.firstDelayMs;
    var tmo = o.timeoutMs || 6000;
    if (first > 0) await __hebCartWait(first);
    var last = null;
    for (var i = 0; i < tries; i++) {
      var after = await __hebCartRead(tmo);
      last = __hebCartConfirm(target, before, after);
      if (last.state === 'landed') return last;
      if (!after.ok && after.reason !== 'network' && after.reason !== 'timeout') return last;
      if (i < tries - 1) await __hebCartWait(gap);
    }
    return last || { state: 'unknown', via: 'cart_query', reason: 'no_read', skuId: null, productId: null };
  }

  // The identity a result card can give us. H-E-B's cards carry NO sku anywhere
  // in their markup — verified across the committed search fixtures — but every
  // card links to /product-detail/<slug>/<productId>, and the cart's own
  // CartItem.id embeds that same product id. So product id is the join key on
  // the DOM rail; skuId stays null and the cart's value is reported back up.
  function __hebTargetFromCard(card, name) {
    if (!card) return null;
    var pid = null;
    try {
      var a = card.querySelector('a[href*="/product-detail/"]');
      var href = a ? (a.getAttribute('href') || '') : '';
      var m = href.match(/\\/product-detail\\/[^\\/?#]+\\/([0-9]+)/);
      if (m) pid = m[1];
    } catch (e) {}
    if (!pid) return null;
    return { skuId: null, productId: pid, name: name || null };
  }
`;
}
