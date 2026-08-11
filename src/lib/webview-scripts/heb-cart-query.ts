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
//    cart query is authenticated). Nor was ABP's behaviour under this rail's
//    request rate: it is a baseline read plus 1–5 polled after-reads PER ADD, so
//    an 8-item run issues AT LEAST 16 authenticated `/graphql` POSTs and up to
//    48, and in the parallel/presearch pools ~4 baselines fire within a few
//    hundred ms of each other. MEAL-12 calls ABP under sustained programmatic
//    load its largest open unknown. Both gaps are why this ships behind
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
// A READABLE WRONG CART IS THE OTHER WAY TO REPORT MASS FAILURE, and it is not a
// read failure, so the `unknown` plumbing above cannot catch it. MEAL-12's own
// probes were all logged-out and still got 200s, so a worker WebView that loses
// its H-E-B session mid-run gets a perfectly valid answer about SOMEBODY ELSE'S
// (or a guest's) cart — every line absent, every item `missing`. The defence is
// `Cart.id`, which the query already selects: the before and after snapshots
// carry it, and any disagreement between them is `unknown`/`cart_changed`, not a
// verdict. It follows that a `missing` verdict now REQUIRES a readable baseline —
// with no `before` there is no id to compare, so absence is reported as
// `no_baseline` and the DOM rail decides, exactly as it did before this rail.
//
// IDENTITY IS THE PRODUCT ID TODAY, and the ticket's "diff by skuId" was not
// achievable from the card — but that is a narrower statement than the one this
// file used to make, and the difference is worth writing down.
//
// The card MARKUP carries no sku; the PAGE does. All 220 distinct Products across
// the committed `search-results-*.html` fixtures that have a `__NEXT_DATA__` carry
// `SKUs:[{id}]`, immediately beside the `productPageURL` this rail already parses,
// and for the three products appearing in both a search and a cart capture the two
// agree exactly (1627072→4122093426, 3454081→25607700000, 894630→61342). So a sku
// IS obtainable, and the earlier claim that H-E-B's cards carry none anywhere was
// wrong about the page.
//
// It is not wired yet, deliberately. MEAL-13's `__NEXT_DATA__` extractor lives in
// heb.ts rather than here, the payload is the INITIAL server render and is not
// rewritten by SPA search (MEAL-13's own staleness gate exists for that), and two
// of the ten committed search fixtures carry no `__NEXT_DATA__` at all. Reaching
// across for it is a real change with a real staleness question, not a one-liner.
//
// The consequence, stated plainly rather than left to be discovered: because
// `__hebTargetFromCard` always returns `skuId: null`, the sku half of
// `__hebCartLineIs` and all of `__hebCartSkuKey`'s zero-padding are DEAD in
// production, and the `missing` report names items with a null sku. The product-id
// fallback carries the whole rail, and it is verified to: the card's
// /product-detail/<slug>/<id> id equals `Product.id` for all 220 products, and all
// 297 cards across the ten fixtures hold exactly one distinct product-detail id —
// the pairings-carousel fixture included, its tiles correctly excluded by
// [data-qe-id="productCard"]. Matching is "sku OR product id" so that wiring the
// sku later widens the match set without changing any existing verdict.
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

/** The bundled default, and what a rejected override falls back to. */
export const HEB_CART_ENDPOINT_DEFAULT = '/graphql';

/**
 * Where to POST the cart query. Same-origin path, remote-overridable via
 * `stores.heb.cartEndpoint` — `network-confirmation-findings.md` §Recommendation
 * 2 asks for cart-endpoint URLs to live in the remote config precisely because
 * they drift like selectors do, and a hardcoded path would need an app release to
 * change even though the flag that turns the rail on is remote.
 *
 * Read through a FUNCTION for the same reason as the flag (remote config lands
 * after import), and re-validated HERE rather than trusted from the merge: this
 * string is interpolated into an injected script, so the shape gate applies at
 * both ends. Anything that is not a plain same-origin path — an absolute URL, a
 * protocol-relative `//host`, quotes, whitespace — is refused and the default
 * stands, because the safe failure is "we query the endpoint we shipped with".
 */
export function hebCartEndpoint(): string {
  const v = storeConfig(SELECTOR_KEY).cartEndpoint;
  if (typeof v !== 'string') return HEB_CART_ENDPOINT_DEFAULT;
  if (!/^\/[A-Za-z0-9._~\-/]{0,120}$/.test(v) || v.startsWith('//')) {
    return HEB_CART_ENDPOINT_DEFAULT;
  }
  return v;
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
  /** A wall, of one of three kinds — see `HebCartBlockCause`, which is carried
   *  BESIDE this rather than folded into it. */
  | 'blocked'
  | 'http_error'
  | 'graphql_error'
  /** 200 with JSON that is not a cart — including `data.cartV2: null`. */
  | 'shape'
  | 'network'
  | 'timeout';

/**
 * Which of the three walls a `blocked` read hit. Reported as its own field and
 * NOT as three separate `reason` values, because `reason` is the rail's verdict
 * vocabulary — callers and the funnel read it, and MEAL-16 is a diagnostic that
 * must leave every verdict exactly as it found it.
 *
 * They are genuinely different findings and the log cannot tell them apart:
 *
 *  • `incident` — an `incidentId` in the JSON body at any status, an incident id
 *    printed into an HTML refusal page on a 401/403, or an `errorCode` body on a
 *    status that is not 401/403. ABP, measured: MEAL-12 got exactly this shape
 *    from a plain React Native HTTP client. The HTML form is read only where the
 *    read was already `blocked`, so that it labels a wall rather than promoting a
 *    500 error page that happens to print a reference id into one.
 *  • `interstitial` — "Pardon Our Interruption" served as a page, at any status.
 *    Also ABP, but a challenge the user could in principle clear rather than a
 *    refusal.
 *  • `unauthorized` — a 401/403 with no `incidentId` and no interstitial text.
 *    Consistent with **the H-E-B session having died mid-run**, which would
 *    explain failing adds and a dead reconcile probe with no anti-bot involvement
 *    whatsoever — but it does NOT prove that, because ABP can also refuse with a
 *    bare 401/403. It is named for what was observed rather than for the
 *    conclusion we would like to draw from it.
 *
 * The one deliberate asymmetry, spelled out because the boundary is otherwise
 * invisible: a 401/403 whose body carries an `errorCode` but no `incidentId`
 * reads as `unauthorized`, not `incident`. `incidentId` is Imperva-specific and
 * outranks any status; a bare `errorCode` is a generic key that H-E-B's own auth
 * layer may well send with a 401, so there the status is the better evidence.
 * Neither call is free, which is why both labels ship beside `status` and a slice
 * of the body rather than instead of them.
 *
 * HTTP `status` alone does not separate the three, which is why this field exists
 * at all: the incident body arrives on a 200 as readily as on a 401, and the
 * interstitial can be served on a 403.
 */
export type HebCartBlockCause = 'unauthorized' | 'incident' | 'interstitial';

export type HebCartSnapshot =
  | {
    ok: true;
    /** `Cart.id`. The only thing that says the after-read looked at the SAME cart
     *  the before-read did — see the module header. Null only if H-E-B stops
     *  returning the field, in which case before and after agree on null and
     *  there is nothing to compare. */
    cartId: string | null;
    lines: HebCartLine[];
    itemCount: number | null;
    status: number | null;
  }
  | {
    ok: false;
    reason: HebCartReadFailure;
    status: number | null;
    detail?: string | null;
    /** Only on `blocked`. Which wall — see HebCartBlockCause. */
    block?: HebCartBlockCause | null;
    /** Only on `graphql_error`: `errors[0].extensions.code`. A gateway that
     *  resolves our `operationName` against a safelist instead of executing the
     *  document we sent says so here and nowhere else. */
    code?: string | null;
    /** Only on `graphql_error`: `errors[0].locations[0]` as `line:col`. Says
     *  WHERE in the document the gateway's complaint lands, which is what
     *  separates "they validated the text we sent" from "they validated
     *  something else". */
    loc?: string | null;
  };

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
  /** Units across EVERY cart line for this product after the add (a weight line
   *  contributes 1). Null when unread. */
  qtyAfter?: number | null;
  /** Pounds after the add, summed over this product's weight lines. */
  weightAfter?: number | null;
  /** The failing read's own words, ≤120 chars — H-E-B's `errors[0].message` for
   *  a `graphql_error`, the exception message for `network`. Null when both
   *  reads succeeded. `reason` says the request failed; this says what the
   *  gateway objected to, which is the difference between "safelisting is on,
   *  we need persisted hashes", "our selection set has drifted from their
   *  schema" and "the session is not what they expect" — three findings that
   *  send MEAL-16 in three different directions and are otherwise
   *  indistinguishable from outside the WebView. */
  detail?: string | null;
  /**
   * MEAL-16. HTTP status of the read this verdict is about, and the first of four
   * diagnostics taken off the SAME read `detail` came from — the one the verdict's
   * own `reason` names. They are set together, from one snapshot, precisely so no
   * verdict can pair one read's status with another read's message (see the note
   * in `__hebCartConfirm`).
   *
   * WHICH READ THAT IS depends on the reason, and it is worth saying out loud
   * because nothing in these four names says it: on `no_baseline` — the one verdict
   * whose reason is about the BEFORE read — a `status: 401` describes the baseline,
   * while `qtyAfter`/`weightAfter` in the same object are the after-read's, because
   * on `no_baseline` the after read is the one that SUCCEEDED. That is the pairing
   * the verdict is reporting, not a mix-up: the baseline hit a wall, so the cart we
   * can see cannot be vouched for. Everywhere else the four describe the after read.
   *
   * Null when there was no read to have a status — and null is not 0: a
   * `no_read`/`no_target` verdict never had a response at all.
   *
   * Diagnostic only, all four: `confirmDetail` (pool-add-funnel) picks its
   * telemetry fields by name and forwards none of these, so they reach a human
   * on a debug log line and nowhere else.
   */
  status?: number | null;
  /** `errors[0].extensions.code`, on a `graphql_error`. */
  code?: string | null;
  /** `errors[0].locations[0]` as `line:col`, on a `graphql_error`. */
  loc?: string | null;
  /** Which wall a `blocked` read hit — see HebCartBlockCause. */
  block?: HebCartBlockCause | null;
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
/**
 * Our operation name — neutral and descriptive, and deliberately NOT H-E-B's own.
 *
 * No evidence exists in this repo for the name their storefront uses for this
 * query (the ticket's `cartEstimated` appears nowhere), and inventing a
 * plausible-looking one would be a guess dressed as a fact. But it was
 * `MealioCartLines`, which is the opposite mistake: the single most
 * self-identifying string in a request to a store that runs behavioural
 * profiling, sitting next to an `apollographql-client-name` header that says we
 * are the storefront. One request cannot coherently claim both, and the field
 * that gets logged and grepped is the operation name. `CartLines` says what the
 * document does and advertises nothing.
 *
 * This is a reduction, not concealment, and the difference matters: the document
 * still carries no `__typename` fields, which is exactly the fingerprint MEAL-12
 * used to prove the gateway executed OUR text rather than a cached persisted
 * operation. We cannot remove that without schema knowledge we do not have, so
 * the request remains distinguishable from the site's own by anyone looking.
 */
export const HEB_CART_OPERATION = 'CartLines';

/**
 * The selection set on its own, WITHOUT the `query <name>` that precedes it.
 *
 * Split out for MEAL-16's probe ladder, whose last two rungs re-send this exact
 * document under a different operation name and under none — a test that only
 * means anything if the two documents are byte-identical to the production one
 * apart from that name. Deriving them from one constant makes that structural;
 * two hand-written copies would let a future edit to the selection set change
 * the production document and leave the probes testing something else.
 *
 * `HEB_CART_QUERY` below is unchanged by the split, character for character —
 * pinned in hebCartQuery.test.ts, because `loc: 2:3` (the gateway's own
 * complaint) is a statement about where `cartV2` sits in THIS text.
 */
const HEB_CART_SELECTION = `{
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

/** Interpolated from HEB_CART_OPERATION so the document text and the
 *  `operationName` field cannot drift apart — a mismatch is a 400. */
export const HEB_CART_QUERY = `query ${HEB_CART_OPERATION} ${HEB_CART_SELECTION}`;

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
 *   __hebCartMatch(lines, target)             → merged line | null  (pure)
 *   __hebCartConfirm(target, before, after)   → confirmation        (pure)
 *   __hebCartContradicted(conf, why)          → confirmation        (pure)
 *   __hebCartConfirmAdd(target, before, opts) → Promise<confirmation>
 *   __hebTargetFromCard(card, name)           → target | null
 *
 * Interpolate it into a script BEFORE the code that calls it. Safe to include
 * when the flag is off — nothing runs until called.
 */
export function buildHebCartQueryFn(): string {
  return `
  var __HEB_CART_ENDPOINT = ${JSON.stringify(hebCartEndpoint())};
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

  // MEAL-16 — log the body we ACTUALLY send, exactly once per injected script.
  //
  // The 2026-08-10 run came back "Field \\"cartV2\\" of type \\"Query\\" must have a
  // selection of subfields" on every read. HEB_CART_QUERY has a selection set, so
  // a validator that received our text cannot have written that sentence: either
  // the text is mangled between here and the wire, or the gateway validated
  // something other than what we sent. This line is what kills the first half of
  // that — it prints the string handed to fetch, after both JSON.stringify hops.
  //
  // ONCE, not once per read: __hebCartConfirmAdd polls up to five times per add,
  // and 30 adds would bury the run in a repeated ~350-char line that says the
  // same thing every time. The latch is a plain var in this script's own IIFE, so
  // it leaves NOTHING on H-E-B's origin — not a sessionStorage key and not a
  // window global, either of which would be a self-identifying Mealio artifact
  // their own scripts could read, the same fingerprint argument that renamed the
  // operation. Every add is its own injection, so the grain is one line per add
  // and the poll retries share it. That is the noise we accept; per-poll is not.
  //
  // Guarded on every side because this module is also evaluated in a sandbox with
  // no window and no bridge (tests/unit/hebCartQuery.test.ts), and a diagnostic
  // that can throw inside the read path would take the rail down with it.
  var __hebCartBodyLogged = false;
  function __hebCartLogBody(body) {
    try {
      if (__hebCartBodyLogged) return;
      if (typeof window === 'undefined' || !window || !window.ReactNativeWebView) return;
      __hebCartBodyLogged = true;
      // EXTRACT_DEBUG: the only debug type the worker wrappers forward (they
      // re-tag it WORKER_DEBUG and swallow ADD_DEBUG), and the main WebView logs
      // it too — so this one type is visible from every surface that adds. The
      // 'cart_query' step prefix is what exempts it from the add worker's
      // 200-char WORKER_DEBUG cap and what the pre-search handler logs on.
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'EXTRACT_DEBUG', step: 'cart_query_body',
        endpoint: __HEB_CART_ENDPOINT, op: __HEB_CART_OP, body: body
      }));
    } catch (e) {}
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
  //
  // MEAL-16: each of those now records WHICH wall it was in \`block\`, while
  // \`reason\` stays the single word 'blocked' it has always been. Splitting the
  // reason instead would have been a verdict change — 'blocked' is vocabulary the
  // callers and the funnel read — and this ticket is diagnostic only. The
  // distinction is not cosmetic: a wall that is really the H-E-B SESSION dying
  // mid-run explains a run's failing adds all by itself, with no anti-bot
  // involvement, and \`status\` cannot stand in for the difference because the
  // incident body arrives on a 200 as readily as on a 401.
  //
  // The block tests were reordered to label them, and ONLY to label them: every
  // input that produced 'blocked' before produces 'blocked' now, with the same
  // precedence over the non-block classifications below. What changed is that the
  // two responses we have actually MEASURED Imperva producing — an incidentId
  // body, and the interstitial page — are consulted BEFORE the status, because
  // MEAL-12 measured the wall as a 401 CARRYING an incidentId and the
  // interstitial can be served on a 403. Calling either of those a session
  // problem would point the investigation away from the wall itself.
  //
  // Strongest evidence first, which is why a bare errorCode is the exception and
  // sits BELOW the status: incidentId and the interstitial string are
  // Imperva-specific, while \`errorCode\` is a generic key that any gateway might
  // send. On a 401/403 the status is the better evidence of the two.
  //
  // A blocked read was the only failure that kept NONE of its body, so two of the
  // three now carry a whitespace-collapsed 120-char slice of it in \`detail\`. On
  // an incident that slice holds the incidentId itself — the one string that
  // names a specific Imperva refusal, and the one you would quote to anybody
  // asking about it. The interstitial is the exception: its label already says
  // everything the slice would.
  //
  // The markup comes off first when the body IS a page. 'unauthorized' is the one
  // label that cannot stand on its own — a dead H-E-B session and a bare ABP
  // refusal are the same 401 — so its body is the whole evidence, and the first
  // 120 characters of an HTML refusal are a doctype and a <head> that name
  // neither. Stripped, the same 120 characters hold what a human would have read
  // off the screen. Script and style bodies go with the tags: a refusal page
  // carries far more of those than prose, and one inline script would spend the
  // budget by itself.
  //
  // Only when the body actually opens as markup, so a JSON body that happens to
  // contain a '<' is never run through a tag stripper that would eat what follows
  // it. Imperva's pages open with a doctype or an <html>; a JSON body cannot.
  //
  // Uncapped, because the incident-id scan below reads this too and needs the
  // whole page: \`__hebCartBlockText\` is where the 120-char budget is spent.
  function __hebCartPlain(text) {
    if (typeof text !== 'string') return null;
    var t = text;
    if (/^\\s*</.test(t)) {
      t = t.replace(/<(script|style)\\b[\\s\\S]*?<\\/\\1>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        // Numeric entities go with the named one, because a page is as likely to
        // write its non-breaking space as \`&#160;\` — and the digits inside that
        // would sit between the incident label and the id, where the scan below
        // reads the first number it finds as the id. Anything else numeric-encoded
        // is spacing too, at the only place this text is read.
        .replace(/&nbsp;|&#x?[0-9a-f]+;/gi, ' ');
    }
    t = t.replace(/\\s+/g, ' ').trim();
    return t || null;
  }

  function __hebCartBlockText(text) {
    var t = __hebCartPlain(text);
    return t ? t.slice(0, 120) : null;
  }

  function __hebCartParse(status, json, text) {
    if (json && json.incidentId) {
      // Named, not sliced. A blind 120-char prefix of the body would truncate the
      // id away the moment Imperva puts a description or a hostName in front of
      // it, and the id is the whole reason this branch keeps anything.
      return {
        ok: false, reason: 'blocked', status: status, block: 'incident',
        detail: ('incident id ' + String(json.incidentId)
          + (json.errorCode ? (' errorCode ' + String(json.errorCode)) : '')).slice(0, 120)
      };
    }
    if (typeof text === 'string' && text.indexOf('Pardon Our Interruption') !== -1) {
      return { ok: false, reason: 'blocked', status: status, block: 'interstitial' };
    }
    // Everything from here down reads the page as words rather than as markup;
    // \`__plain\` is computed once and shared by the two scans below. Gated to
    // 401/403 for the reason each of them repeats: those two statuses were walls
    // before MEAL-16 and still are, so a scan that only runs there can pick the
    // LABEL without ever inventing a verdict. At any other status a page reads
    // exactly as it did before this ticket.
    var __plain = (status === 401 || status === 403) ? __hebCartPlain(text) : null;
    // The interstitial again, with tags through the middle of the phrase —
    // \`Pardon <b>Our</b> Interruption\` defeats the indexOf above. Left where it
    // is rather than replacing that check, because moving the whole test onto the
    // stripped text WOULD be a verdict change: a split phrase on a 200 is 'shape'
    // today, and promoting it to 'blocked' is not this ticket's to do.
    //
    // Worth the four lines even so. Without it a 403 interstitial that splits the
    // phrase is labelled 'unauthorized' — "the session died" — while carrying
    // "Pardon Our Interruption" in its own \`detail\`, a verdict arguing with its
    // own evidence, which is worse for a reader than either answer alone.
    if (__plain && __plain.indexOf('Pardon Our Interruption') !== -1) {
      return { ok: false, reason: 'blocked', status: status, block: 'interstitial' };
    }
    // The same wall wearing an HTML page instead of a JSON body: Imperva's
    // "Access Denied" variants print the incident id into the markup and carry no
    // interruption text, so JSON.parse gives null, neither check above fires, and
    // the 401/403 below would call an ABP refusal a dead session — the exact
    // misdiagnosis this field exists to prevent. Read after the interstitial
    // check, not before: a "Pardon Our Interruption" page usually carries an
    // incident id too, and 'interstitial' is the more specific answer for it.
    //
    // ONLY on a 401/403, which is what keeps this a label and not a verdict
    // change: those two statuses already read as 'blocked' before MEAL-16 and
    // still do, so all this branch decides is which wall to call them. At any
    // other status the same page is 'http_error' or 'shape' exactly as it was —
    // and it has to be, because "incident id" in a body is not proof of Imperva:
    // a 500 origin error page printing its own reference id under that label
    // would otherwise be promoted to a measured ABP refusal, which is the
    // opposite misdiagnosis and a reason no caller asked for.
    //
    // The id goes into \`detail\` on its own rather than as the leading slice of
    // the page, whose first 120 characters are a doctype.
    //
    // Scanned over the STRIPPED text, not the markup, because the id is wrapped in
    // tags as often as not (\`Incident ID:</b>&nbsp;1318…\`) and reading the raw
    // page gets that wrong in both directions. A number inside an attribute
    // between the label and the id — \`<span data-ts="1755301234">\` — would be
    // captured AS the incident id, printing a timestamp as the one string you
    // would quote to Imperva and dropping the real one. And a gap of any fixed
    // length is too short for a tag carrying a class and a data attribute, so the
    // page falls through to 'unauthorized': the "session died" reading this field
    // exists to prevent. With the tags gone, what separates the label from the id
    // is punctuation and spaces.
    //
    // Which is also why the gap holds NO digits: after stripping, the first number
    // following the label is the id, and anything that made us skip past a number
    // to find a later one would be guessing.
    var __inc = __plain
      ? __plain.match(/incident\\s*id\\b[^0-9]{0,40}([0-9][0-9a-z-]{5,})/i) : null;
    if (__inc) {
      return {
        ok: false, reason: 'blocked', status: status, block: 'incident',
        detail: ('incident id ' + __inc[1]).slice(0, 120)
      };
    }
    // A 401/403 carrying neither Imperva fingerprint. Named for what was
    // OBSERVED, not for the conclusion: this is what a dead H-E-B session looks
    // like, but ABP can refuse with a bare 401/403 too, and a label that asserted
    // "the session died, no wall involved" would point the investigation the
    // wrong way exactly as often as it pointed it the right one. So the refusal
    // brings its own words along — the one thing that can still separate the two.
    //
    // This is also the branch a 401/403 with a bare \`errorCode\` lands on rather
    // than the one below; see the note on HebCartBlockCause for why the status
    // outranks that key and the incidentId outranks the status.
    if (status === 401 || status === 403) {
      return {
        ok: false, reason: 'blocked', status: status, block: 'unauthorized',
        // \`__plain\` rather than __hebCartBlockText(text): reaching here means the
        // status was 401/403, so the page has already been stripped once just
        // above, and this is that same string with the budget taken off it.
        detail: __plain ? __plain.slice(0, 120) : null
      };
    }
    // errorCode without an incidentId — the incident body shape minus the id, and
    // blocked exactly as it has always been.
    if (json && json.errorCode) {
      return {
        ok: false, reason: 'blocked', status: status, block: 'incident',
        detail: __hebCartBlockText(text)
      };
    }
    if (!json || typeof json !== 'object') {
      return { ok: false, reason: (status >= 400 ? 'http_error' : 'shape'), status: status };
    }
    if (json.errors && json.errors.length > 0) {
      // MEAL-16 keeps three fields off errors[0], not one. The message alone
      // could not tell us whether the gateway EXECUTED our document or resolved
      // our operationName against a registry — a safelist wearing a different
      // error message — and could not say where in the document it was looking.
      // extensions.code answers the first; locations answers the second (our own
      // cartV2 sits at line 2, column 3).
      var e0 = json.errors[0] || null;
      var m = (e0 && e0.message) ? String(e0.message) : '';
      var ext = (e0 && e0.extensions) || null;
      var loc0 = (e0 && e0.locations && e0.locations.length > 0) ? e0.locations[0] : null;
      return {
        ok: false, reason: 'graphql_error', status: status, detail: m.slice(0, 120),
        code: (ext && ext.code != null && ext.code !== '') ? String(ext.code).slice(0, 60) : null,
        loc: (loc0 && loc0.line != null)
          ? (String(loc0.line) + ':' + (loc0.column == null ? '?' : String(loc0.column)))
          : null
      };
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
    // cartId is carried, not merely selected: a VALID answer about a DIFFERENT
    // cart is the one failure mode that looks like success, and this is the only
    // field that exposes it. See the module header.
    return {
      ok: true,
      cartId: (cart.id != null && cart.id !== '') ? String(cart.id) : null,
      lines: lines, itemCount: total, status: status
    };
  }

  // Does one cart line belong to the target? Sku OR product id — a union, not a
  // priority order, because the sum below has to be over the same set of lines on
  // both sides of the diff and either id can be the one a given line carries.
  function __hebCartLineIs(line, sk, pid) {
    if (!line) return false;
    if (sk && __hebCartSkuKey(line.skuId) === sk) return true;
    if (pid && line.productId === pid) return true;
    return false;
  }

  // Every line for the target, MERGED — not the first one.
  //
  // One product can hold more than one cart line: CartItem.id is
  // "item#<productId>#<preferenceId>", and the committed weight capture has
  // "item#3454081#b58dbfed-…". So an add that creates a SECOND line under a
  // different preference leaves the first line untouched, and a
  // first-match-wins lookup reads the same pre-existing line in both snapshots,
  // sees no change, and calls a successful add missing. Summing over the whole
  // set is the only reading of "how many of this product does the cart hold" that
  // survives that, and it is also correct for the ordinary single-line case.
  //
  // qty sums (a weight line contributes 1, per __hebCartLine); weight sums, so a
  // second deli line at 0.5 lb reads as heavier and not as unchanged; isWeight is
  // true if ANY matching line is one, which routes a mixed set through the
  // presence rule rather than a unit comparison — the conservative direction.
  function __hebCartMatch(lines, target) {
    if (!lines || !target) return null;
    var sk = __hebCartSkuKey(target.skuId);
    var pid = (target.productId != null && String(target.productId).trim() !== '')
      ? String(target.productId).trim() : null;
    if (!sk && !pid) return null;
    var out = null;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!__hebCartLineIs(l, sk, pid)) continue;
      if (!out) {
        out = {
          lineId: l.lineId, skuId: l.skuId, productId: l.productId, name: l.name,
          qty: l.qty, isWeight: l.isWeight, weight: l.weight, lineCount: 1
        };
        continue;
      }
      out.qty += l.qty;
      out.isWeight = out.isWeight || l.isWeight;
      if (l.weight != null) out.weight = (out.weight == null) ? l.weight : out.weight + l.weight;
      if (!out.skuId && l.skuId) out.skuId = l.skuId;
      if (!out.productId && l.productId) out.productId = l.productId;
      if (!out.name && l.name) out.name = l.name;
      out.lineCount++;
    }
    return out;
  }

  // The decision. Pure: two snapshots in, one confirmation out.
  function __hebCartConfirm(target, before, after) {
    var idsku = target ? target.skuId : null;
    var idprod = target ? target.productId : null;
    // ONE READ'S DIAGNOSTICS, and it must be the read whose failure the verdict's
    // own reason names, or they are worse than nothing: a baseline that failed
    // with a graphql_error, paired with a confirm read that failed as 'blocked'
    // (which carries no message of its own), would print
    // "unknown/blocked … PersistedQueryNotFound" and send the investigation after
    // safelisting when the real answer was a wall. The same trap is open one
    // field wider now that status/code/loc/block travel too — a 200 from the
    // baseline printed beside a 401 verdict would be a lie about which wall we
    // hit — so they are adopted TOGETHER, from one snapshot, by __hebCartTake.
    //
    // The parse captures errors[0].message and the catch captures the exception
    // message, both already sliced to 120; before MEAL-16's first half every one
    // of them died here, so a run could only ever report a bare 'graphql_error'
    // with no way to tell WHICH contract with the gateway had broken.
    var diag = { detail: null, status: null, code: null, loc: null, block: null };
    function __hebCartTake(snap) {
      if (!snap) return;
      diag.status = (snap.status == null) ? null : snap.status;
      if (snap.ok === false) {
        diag.detail = snap.detail ? String(snap.detail) : null;
        diag.code = snap.code ? String(snap.code) : null;
        diag.loc = snap.loc ? String(snap.loc) : null;
        diag.block = snap.block ? String(snap.block) : null;
      }
    }
    function out(state, reason, line) {
      return {
        state: state, via: 'cart_query', reason: reason,
        skuId: (line && line.skuId) || idsku || null,
        productId: (line && line.productId) || idprod || null,
        qtyAfter: line ? line.qty : null,
        weightAfter: line ? line.weight : null,
        detail: diag.detail, status: diag.status,
        code: diag.code, loc: diag.loc, block: diag.block
      };
    }
    // No target: nothing was compared and neither read is what went wrong, so
    // this verdict borrows from neither, even if a read did fail. Same for
    // no_read, where there is no response to have had a status.
    if (!target || (!idsku && !idprod)) return out('unknown', 'no_target', null);
    if (!after) return out('unknown', 'no_read', null);
    if (!after.ok) {
      __hebCartTake(after);
      return out('unknown', after.reason || 'no_read', null);
    }
    var a = __hebCartMatch(after.lines, target);
    // No baseline: we can neither tell our units from units that were already
    // there NOR check that this is the same cart the before-read saw, and the
    // second is why this gate is above the absence check rather than below it. An
    // unreadable baseline plus a cart we cannot vouch for is not evidence that
    // the item is missing — it is the DOM rail's turn.
    // The one verdict whose reason is about the BEFORE read, so the one place
    // its message — and its status, and its block cause — are the right ones to
    // carry. Which means this is also the one verdict where the diagnostics and
    // the line fields come from DIFFERENT reads: \`status\` is the baseline's,
    // \`qtyAfter\` is the after-read's, and both are right, because on
    // 'no_baseline' the after read is the one that succeeded. Called out here and
    // on HebAddConfirmation.status because nothing in the field names says it.
    if (!before || !before.ok) {
      __hebCartTake(before);
      return out('unknown', 'no_baseline', a);
    }
    // Past here both reads succeeded and the verdict is about the AFTER read, so
    // that is the one whose status the verdict reports. It carries no detail,
    // code, loc or block: __hebCartTake reads those only off a failure, and this
    // snapshot is not one.
    __hebCartTake(after);
    // SAME CART? A valid answer about a different cart reads as "every item
    // failed" — the one outcome this rail must never produce, and not a read
    // failure, so nothing else catches it. MEAL-12's probes prove an anonymous
    // /graphql call still gets a 200, so a worker that loses its session mid-run
    // lands here. Any disagreement, including one side having an id and the other
    // not, is 'unknown'. (Both null — H-E-B dropping Cart.id — compares equal and
    // passes; the parse already rejects a response without an items array, so a
    // wholesale shape change is caught upstream.)
    var bid = (before.cartId == null) ? null : String(before.cartId);
    var aid = (after.cartId == null) ? null : String(after.cartId);
    if (bid !== aid) return out('unknown', 'cart_changed', a);
    // The cart answered, about the cart we baselined, and our line is not in it.
    // This is the one claim the badge rail could never make, and the reason
    // MEAL-14 exists.
    if (!a) return out('missing', 'absent_from_cart', null);
    var b = __hebCartMatch(before.lines, target);
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
      // Built once and both SENT and LOGGED, so the line on Metro is the string
      // that went to fetch rather than a second call that could differ from it.
      var body = __hebCartBody();
      __hebCartLogBody(body);
      var init = {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'accept': '*/*',
          'apollographql-client-name': __HEB_CART_CLIENT
        },
        body: body
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

  // Withdraw a 'missing' verdict that a second, independent signal contradicts.
  //
  // The caller in heb.ts holds the other product-specific signal: the per-card
  // "N added" label, which that file calls the reliable success one precisely
  // because a sibling worker's add cannot nudge it. When the cart says absent and
  // the label says added, the honest state is that we do not know — one of the two
  // reads is wrong, and this rail is not entitled to assume it is the label.
  //
  // Deliberately downgrades to 'unknown' rather than to 'landed': the DOM signal
  // may be good enough for the CALLER to commit the add, but nothing here has
  // confirmed the item from the cart, so no cart-backed metric may count it.
  // Keeps the identity and quantity fields, which are what make the disagreement
  // diagnosable later.
  function __hebCartContradicted(conf, why) {
    if (!conf) return conf;
    return {
      state: 'unknown',
      // 'via' was omitted here, and confirmDetail reads an absent confirmVia as
      // "the DOM decided, no rail ran" — so a cart-vs-label disagreement, the one
      // signal that should make us turn this flag back off, was telemetered as
      // though the rail had never spoken. The rail DID speak; it was overruled.
      via: 'cart_query',
      reason: why || 'contradicted',
      skuId: conf.skuId, productId: conf.productId,
      qtyAfter: conf.qtyAfter, weightAfter: conf.weightAfter,
      // Every diagnostic the withdrawn verdict carried survives the withdrawal:
      // a contradiction is the signal that should make us turn this flag off, so
      // it is the last verdict that can afford to arrive without its evidence.
      detail: (conf.detail == null) ? null : conf.detail,
      status: (conf.status == null) ? null : conf.status,
      code: (conf.code == null) ? null : conf.code,
      loc: (conf.loc == null) ? null : conf.loc,
      block: (conf.block == null) ? null : conf.block
    };
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
    return last || {
      state: 'unknown', via: 'cart_query', reason: 'no_read', skuId: null, productId: null,
      detail: null, status: null, code: null, loc: null, block: null
    };
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

// ── MEAL-16 probe ladder ─────────────────────────────────────────────────────
//
// WHAT IT IS FOR. Every cart read of the 2026-08-10 run came back
//
//   400 GRAPHQL_VALIDATION_FAILED, loc 2:3,
//   "Field \"cartV2\" of type \"Query\" must have a selection of subfields."
//
// while the body line printed our document with its selection set intact. Two of
// the three candidates died on that reading: the text is NOT mangled in transit
// (the body handed to `fetch` is byte-correct), and this is NOT safelisting
// wearing a different error (a plain validation failure is neither
// `PersistedQueryNotFound` nor a safelist rejection). What is left is a
// contradiction with exactly two live readings, and they are distinguishable by
// experiment rather than by argument:
//
//   A — the sub-selection never reaches the validator. Something between `fetch`
//       and validation re-parses, strips or substitutes the document: a
//       page-level fetch wrapper (the storefront's own, or the ABP script's), an
//       edge normaliser, or a canned/cached 400 keyed on the operation name.
//   B — it is validated against a schema that is not the storefront's. The
//       message calls `cartV2`'s type `Query`; the page's own __APOLLO_STATE__
//       (tests/fixtures/heb/cart-with-items.html) has ROOT_QUERY.cartV2 → Cart.
//
// THE RUNGS, and what each one is worth:
//
//   1 control        `query { __typename }` — endpoint, session and transport,
//                    with nothing of ours in it. If this fails too, nothing below
//                    it means anything. Its `data` also NAMES their root type,
//                    which is the other half of reading B.
//   2 minimal        `query … { cartV2 { id } }` — a one-field selection
//                    set. Same complaint here means the size of ours is not it.
//   3 discriminator  `query … { cartV2 { zzzNotAField } }` — THE rung. A
//                    reply naming a type ("Cannot query field \"zzzNotAField\" on
//                    type \"Cart\"") proves the validator does read our
//                    sub-selection and tells us their real type for `cartV2`,
//                    killing A and settling B. The same missing-sub-selection
//                    error instead means our sub-selection never reaches it.
//   4 renamed        the production document verbatim under a different
//                    operation name.
//   5 anonymous      the production document verbatim with no name at all, and
//                    no `operationName` field on the request.
//
//                    If the error follows the NAME across 4, 5 and the run's own
//                    reads under `CartLines`, the response is keyed by operation
//                    name — a registry or a cache — and not by our text, which is
//                    reading A with a mechanism attached.
//
// Rungs 2-4 hold the name at `CartLinesAlt` and vary the selection set; rungs 4,
// 5 and the run's own cart reads hold the document and vary the name. Nothing in
// the ladder is sent under `CartLines` itself — see HEB_CART_PROBES for why that
// matters and why it costs nothing.
//
// Plus, on every rung, the response HEADERS and the first 400 characters of the
// RAW body. An edge-generated or cached 400 shows itself there and nowhere else:
// a `via`/`x-cache`/`age` on a 400 that our own gateway would have had no reason
// to cache is the whole of reading A's third mechanism.
//
// PER RUN, NOT PER ADD, AND THE LATCH IS NATIVE. #110 logged the request body
// "once per injection", which was literally true and operationally wrong — the
// script is re-injected for every add navigation, so it printed 18 times in an
// 18-item cart. There is no in-page latch that survives a navigation without
// leaving a Mealio artifact on H-E-B's origin (a sessionStorage key or a window
// global their own scripts could read — the same fingerprint argument that
// renamed the operation), so this script is not part of the add path at all. It
// is a standalone script that WebViewCartSheet injects into the main WebView,
// latched on a log of ladders there: the first page of the run, once more on the
// first SEARCH page (where the rail's own reads happen, and a page-level fetch
// wrapper would differ), and a retry if a ladder never reached its `..._done`
// line. Hard-bounded at three, and every line a ladder posts carries the id it
// was injected with, so a done retires the ladder that sent it and no other.
//
// The one in-page thing it does keep is a per-DOCUMENT interlock, because the
// native side genuinely cannot know whether the last ladder is still alive — see
// HEB_CART_PROBE_GUARD for why, and for why one neutral boolean is not the
// fingerprint the paragraph above is about.
//
// SEQUENTIAL, NOT CONCURRENT, and it costs a truncation risk worth naming: the
// page can navigate out from under the ladder and take the remaining rungs with
// it. Firing all five at once would remove that, but rungs 2 and 3 share an
// operation name, and if the answer really is keyed or cached on that name then
// two concurrent requests carrying it are the one shape that could make the
// discriminator report rung 2's answer. A diagnostic that can lie about the
// thing it exists to measure is worse than one that can come back short, so the
// rungs go one at a time and each posts as it lands — a partial ladder is
// readable, and `cart_query_probe_done` says how much of it ran.
//
// DIAGNOSTIC ONLY. Nothing here touches a verdict: no caller reads these
// messages, `confirmDetail` picks its telemetry fields by name and forwards none
// of them, and the whole script is gated behind `hebCartQueryEnabled()` at the
// injection site, so it cannot run in a build where the rail itself is off.

/** The alternate operation name for rung 4. Neutral and non-identifying, for the
 *  same reason `CartLines` is — see HEB_CART_OPERATION. */
export const HEB_CART_OPERATION_ALT = 'CartLinesAlt';

/** Rung 4: the production document, name changed and nothing else. */
export const HEB_CART_QUERY_ALT = `query ${HEB_CART_OPERATION_ALT} ${HEB_CART_SELECTION}`;

/** Rung 5: the production document as an anonymous operation. */
export const HEB_CART_QUERY_ANON = `query ${HEB_CART_SELECTION}`;

/**
 * Rung 3's deliberately absent field. Named so that H-E-B's own answer quotes it
 * back — a reply that does NOT mention this string is not about our document.
 */
export const HEB_CART_PROBE_FIELD = 'zzzNotAField';

/** One rung: the name it reports under, and the request body it sends. */
interface HebCartProbe {
  name: string;
  body: Record<string, unknown>;
}

/**
 * The ladder, in the order it is sent. Exported for the tests, which assert the
 * two variant rungs differ from the production document ONLY in the operation
 * name — the entire point of rungs 4 and 5.
 *
 * NO RUNG CARRIES THE PRODUCTION OPERATION NAME, and rungs 2 and 3 gave it up
 * for a reason worth stating. Rung 3 sends a document that is invalid ON PURPOSE.
 * If the name-keyed response this whole ladder exists to test for is real, then
 * sending that under `CartLines` could install a 400 against the very operation
 * the run's own cart reads use — a diagnostic corrupting the run it is measuring.
 *
 * Nothing is lost by moving them. The answer under the production name is
 * already in the log 18 times a run, on every `cart_query_confirm` line, so the
 * ladder does not need to re-send under it: rungs 2, 3 and 4 vary the SELECTION
 * SET with the name held at `CartLinesAlt`, while rung 4, rung 5 and the run's
 * own reads are the same document under three different names. Both axes are
 * covered and neither rung has to touch `CartLines`.
 */
export const HEB_CART_PROBES: HebCartProbe[] = [
  // No operationName and no variables: the control carries as little of ours as
  // a GraphQL request can and still be one.
  { name: 'control', body: { query: 'query { __typename }' } },
  {
    name: 'minimal',
    body: {
      operationName: HEB_CART_OPERATION_ALT,
      variables: {},
      query: `query ${HEB_CART_OPERATION_ALT} { cartV2 { id } }`,
    },
  },
  {
    name: 'discriminator',
    body: {
      operationName: HEB_CART_OPERATION_ALT,
      variables: {},
      query: `query ${HEB_CART_OPERATION_ALT} { cartV2 { ${HEB_CART_PROBE_FIELD} } }`,
    },
  },
  {
    name: 'renamed',
    body: {
      operationName: HEB_CART_OPERATION_ALT,
      variables: {},
      query: HEB_CART_QUERY_ALT,
    },
  },
  // No `operationName` KEY at all, not an empty one — an anonymous operation
  // named in the envelope is a different request from an unnamed one, and rung 5
  // is only worth sending as the latter.
  { name: 'anonymous', body: { variables: {}, query: HEB_CART_QUERY_ANON } },
];

/**
 * Response headers worth carrying. Short list on purpose: these are the ones
 * that distinguish an answer our gateway composed from one an edge composed or
 * replayed, and a header dump would bury them.
 */
const HEB_CART_PROBE_HEADERS = ['server', 'via', 'x-cache', 'age', 'content-type', 'x-served-by'];

/**
 * The in-page one-per-document guard.
 *
 * The native latch cannot do this job on its own: `onLoadEnd` fires for H-E-B's
 * same-URL cart re-render AND for SPA route changes that never replace the
 * document (`stores.heb.spaSearch` is true, and the search path injects in-page
 * without navigating), so "a different URL" does not mean "a different JS
 * context". Two ladders alive in one context would put concurrent
 * `CartLinesAlt` requests on the wire — the shape the rungs are sequential to
 * avoid, and the one that could make the discriminator report rung 2's answer.
 *
 * So the document itself holds the flag. That is a global on H-E-B's origin, and
 * the module header argues against leaving one — but that argument is about the
 * RAIL, which runs on every add and carries our operation name. This is one
 * neutral boolean, named exactly like `window.__hebLoginCheckActive`, which
 * `CHECK_LOGIN_SCRIPT` has been setting on heb.com since long before this ticket.
 * Nothing about it says Mealio.
 *
 * RELEASED when the ladder finishes, like that precedent and unlike a latch. It
 * means "a ladder is running here", not "a ladder has run here": with
 * `spaSearch: true` the homepage → /search → /search transitions all stay in one
 * document, so a flag that stuck would make every ladder after the first inert
 * for the rest of the run — burning the retry budget on injections that send
 * nothing and post nothing. The native side owns how MANY ladders run; this owns
 * only that no two overlap.
 */
const HEB_CART_PROBE_GUARD = '__hebCartProbeActive';

/**
 * The ladder, as a complete injectable script.
 *
 * Self-contained — it shares no helper with `buildHebCartQueryFn`, because it is
 * injected on its own into a page that does not have that script on it. Posts
 * one `EXTRACT_DEBUG` per rung (`step: 'cart_query_probe'`) and one
 * `cart_query_probe_done` at the end; `cart_query_*` is the step prefix the
 * debug handlers already log in full.
 *
 * `id` rides on every line this ladder posts, INCLUDING the done line. Without
 * it the native side cannot tell which ladder just reported — and it has more
 * than one to account for, since it retries a ladder that never finished. A done
 * line from an earlier ladder would otherwise retire the record of a later one
 * that is still running.
 */
export function buildHebCartProbeScript(id: string): string {
  return `(async function() {
  // Set OUTSIDE the try whose finally releases it, so an injection that lands
  // while a ladder is running returns without ever reaching that finally — a
  // release from the second script would unlock the document under the first.
  if (typeof window === 'undefined' || !window || !window.ReactNativeWebView) return;
  // One ladder per document — see HEB_CART_PROBE_GUARD.
  if (window.${HEB_CART_PROBE_GUARD}) return;
  window.${HEB_CART_PROBE_GUARD} = true;
  try {
    var __ID = ${JSON.stringify(id)};
    var __post = function(o) {
      o.probeId = __ID;
      try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
    };
    var __EP = ${JSON.stringify(hebCartEndpoint())};
    var __CLIENT = ${JSON.stringify(HEB_APOLLO_CLIENT)};
    var __PROBES = ${JSON.stringify(HEB_CART_PROBES)};
    var __HDRS = ${JSON.stringify(HEB_CART_PROBE_HEADERS)};

    // Named headers only, and every one of them optional — a fetch polyfill that
    // has no Headers.get must not take the ladder down with it.
    function __probeHeaders(res) {
      var out = {};
      for (var h = 0; h < __HDRS.length; h++) {
        var v = null;
        try { v = (res && res.headers && res.headers.get) ? res.headers.get(__HDRS[h]) : null; } catch (e) { v = null; }
        if (v) out[__HDRS[h]] = String(v).slice(0, 80);
      }
      return out;
    }

    // What came back in \`data\`, one line. The control's answer is the useful
    // case: \`__typename=Query\` names their root type, which is the field the
    // gateway's complaint claims \`cartV2\` has as its OWN type.
    function __probeData(json) {
      if (!json || typeof json !== 'object') return 'no_json';
      if (!('data' in json)) return 'no_data';
      if (json.data == null) return 'data_null';
      var ks = [];
      try { ks = Object.keys(json.data); } catch (e) { ks = []; }
      if (ks.length === 0) return 'data_empty';
      var parts = [];
      for (var i = 0; i < ks.length && i < 4; i++) {
        var v = json.data[ks[i]];
        parts.push(ks[i] + '=' + (v == null ? 'null' : (typeof v === 'object' ? 'obj' : String(v).slice(0, 40))));
      }
      return parts.join(',');
    }

    for (var i = 0; i < __PROBES.length; i++) {
      var p = __PROBES[i];
      var line = {
        type: 'EXTRACT_DEBUG', step: 'cart_query_probe', probe: p.name,
        // The document as sent, not as declared — #110's lesson was that the two
        // are worth checking against each other.
        q: String(p.body.query).replace(/\\s+/g, ' ').slice(0, 300),
        op: (p.body.operationName == null) ? null : String(p.body.operationName),
        status: null, code: null, loc: null, errN: null, msg: null,
        data: null, hdr: null, raw: null, err: null
      };
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
            'apollographql-client-name': __CLIENT
          },
          body: JSON.stringify(p.body)
        };
        if (ctl) init.signal = ctl.signal;
        var pr = fetch(__EP, init);
        if (ctl) timer = setTimeout(function() { try { ctl.abort(); } catch (e) {} }, 6000);
        var res = await pr;
        line.status = res.status;
        line.hdr = __probeHeaders(res);
        var text = '';
        try { text = await res.text(); } catch (e) { text = ''; }
        // Whitespace-collapsed so 400 characters are 400 characters of evidence
        // rather than a pretty-printed error object's indentation.
        line.raw = text ? String(text).replace(/\\s+/g, ' ').slice(0, 400) : null;
        var json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        if (json && json.errors && json.errors.length > 0) {
          var e0 = json.errors[0] || {};
          line.errN = json.errors.length;
          line.msg = e0.message ? String(e0.message).slice(0, 200) : null;
          var ext = e0.extensions || null;
          line.code = (ext && ext.code != null && ext.code !== '') ? String(ext.code).slice(0, 60) : null;
          var l0 = (e0.locations && e0.locations.length > 0) ? e0.locations[0] : null;
          line.loc = (l0 && l0.line != null)
            ? (String(l0.line) + ':' + (l0.column == null ? '?' : String(l0.column)))
            : null;
        }
        line.data = __probeData(json);
      } catch (e) {
        // A rung that threw still posts. An AbortError here is the 6 s timeout
        // and is itself a reading — the production reads come back in well under
        // a second, so a rung that hangs is not the same gateway answering.
        line.err = (String((e && e.name) || 'Error') + ' ' + String((e && e.message) || '')).slice(0, 160);
      } finally {
        if (timer) clearTimeout(timer);
      }
      __post(line);
    }
    // The done line says ONE thing: this ladder reached its own last statement.
    // It cannot report a partial run — every rung posts from inside the loop, so
    // reaching here means all of them did. A truncated ladder is diagnosed by
    // this line's ABSENCE next to however many rung lines carry its probeId,
    // which is exactly how the native side reads it.
    __post({ type: 'EXTRACT_DEBUG', step: 'cart_query_probe_done', rungs: __PROBES.length });
  } catch (e) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'EXTRACT_DEBUG', step: 'cart_query_probe_error', probeId: ${JSON.stringify(id)},
        detail: String((e && e.message) || e || '').slice(0, 200)
      }));
    } catch (e2) {}
  } finally {
    // Released so a later injection into this SAME document can run a fresh
    // ladder — with spaSearch the whole run can happen in one document.
    try { window.${HEB_CART_PROBE_GUARD} = false; } catch (e3) {}
  }
})(); true;`;
}
