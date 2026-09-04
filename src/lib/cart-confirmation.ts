// WHAT THE CART SAID ABOUT ONE ADD.
//
// Store-neutral on purpose. This type and its telemetry flattener lived in
// heb-cart-query.ts and were called HebAddConfirmation, because H-E-B's cart
// query was the first thing to produce one — but every rail produces them now
// (`via: 'network'`), and the shared engine and the shared reconcile both read
// them. A shared contract living inside one store's file is how that store's
// data model becomes everybody's rule, which is the thing this refactor is
// about: see tests/unit/storeIsolation.test.ts.

/**
 * What the cart said about one add. `state` is the decision; `reason` is why,
 * and it is what separates "the cart says this SKU is absent"
 * (`absent_from_cart`) from "we could not read the cart" (`blocked`, `timeout`,
 * `shape`, …).
 */
export interface AddConfirmation {
  state: 'landed' | 'missing' | 'unknown';
  /** Where the verdict came from.
   *
   *  'cart_query' — this rail, read back from the cart after the add.
   *  'network'    — the search-and-add rail, verified from the write's own
   *                 response (which returns the cart). Added when DOM automation
   *                 was removed and the rail became the only way anything is
   *                 added: without it a rail write carried no verdict at all, and
   *                 MEAL-16's guard against believing a contradictory empty cart
   *                 read had nothing to weigh.
   *  'dom'        — the fallback path. Nothing reports this any more. */
  via: 'cart_query' | 'network' | 'dom';
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
   * MEAL-16. HTTP status of the read this verdict is about, and the first of five
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
   * Diagnostic only, all five: `confirmDetail` (pool-add-funnel) picks its
   * telemetry fields by name and forwards none of these, so they reach a human
   * on a debug log line and nowhere else.
   */
  status?: number | null;
  /** `errors[0].extensions.code` on a `graphql_error`, `CartError.code` on a
   *  `cart_error`. */
  code?: string | null;
  /** `errors[0].locations[0]` as `line:col`, on a `graphql_error`. */
  loc?: string | null;
  /** How many errors the `graphql_error` response carried — i.e. how many
   *  `detail` is one of. See the field of the same name on HebCartSnapshot for
   *  why a count earns its place on a verdict line. */
  errN?: number | null;
  /** Which wall a `blocked` read hit.
   *
   *  A plain string, not one store's union. H-E-B's cart query narrows it to
   *  'unauthorized' | 'incident' | 'interstitial' (HebCartBlockCause) and every
   *  value on the wire today is one of those — but this type is what all five
   *  rails post and what the shared reconcile reads, and importing one store's
   *  enum into it is how that store's data model quietly becomes the rule for
   *  the other four. The narrow type still applies where the narrow claim is
   *  made. */
  block?: string | null;
}

/**
 * The cart query, as text.
 *
 * Field-for-field what the committed `__APOLLO_STATE__` captures prove the
 * server returns (see the module header). Intentionally minimal: no price, no
 * fulfillment — a smaller selection set is less to break when H-E-B changes its
 * schema, and everything here is load-bearing for the diff.
 * `product.fullDisplayName` earns its place by naming the item in the report the
 * user eventually sees.
 *
 * The one field that is NOT load-bearing for the diff is `__typename` on
 * `cartV2` itself, and it is there because `cartV2` returns a UNION — see
 * HEB_CART_SELECTION.
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
 * carries ONE `__typename`, on `cartV2` and nowhere else, where Apollo's own
 * client injects one at every level. That asymmetry is the fingerprint MEAL-12
 * used to prove the gateway executed OUR text rather than a cached persisted
 * operation, and the union wrapper does not spend it — a response whose
 * `items[]` carry no `__typename` is still not one Apollo composed. We cannot
 * remove the difference without schema knowledge we do not have, so the request
 * remains distinguishable from the site's own by anyone looking.
 */

/**
 * A cart verdict flattened into telemetry `detail` scalars (sanitizeDetail drops
 * nested objects, so a nested confirm would vanish silently). Empty when no rail
 * ran.
 *
 * Lived in lib/pool-add-funnel until 2026-09-01. Everything else in that module
 * described the DOM worker pools and went with them; this took a
 * AddConfirmation and always belonged beside the type it flattens.
 */
export function confirmDetail(confirm: AddConfirmation | null | undefined): Record<string, unknown> {
  if (!confirm) return {};
  return {
    confirmVia: confirm.via,
    confirmState: confirm.state,
    confirmWhy: confirm.reason ?? undefined,
    confirmSku: confirm.skuId ?? confirm.productId ?? undefined,
  };
}
