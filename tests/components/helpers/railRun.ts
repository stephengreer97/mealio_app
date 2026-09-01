import { act } from '@testing-library/react-native';
import {
  __applyAutomationConfigForTests, __resetAutomationConfigForTests,
} from '../../../src/lib/automation-config';

/**
 * Drive a cart run over the NETWORK RAIL, the way every component test used to
 * drive one over the DOM worker pools.
 *
 * The pools were deleted on 2026-09-01 and with them the message protocol these
 * tests spoke: WORKER_RESULT, SEARCH_AND_ADD_RESULT, and the page-scraped
 * SEARCH_RESULT. The behaviour they were testing — the reconcile, the review
 * routing, the done screen, the funnel — is all still there and still reached
 * the same way; only the transport underneath changed. So this posts what the
 * rail posts, and the assertions above it are untouched.
 *
 * Every message here is one the rail really sends. If a shape drifts, the
 * fixture tests in tests/fixture-tests/heb-network-search.spec.ts are what
 * notices — they run the real script against a real payload.
 */

/** Config overlay that turns the H-E-B rail on. Read by each suite's
 *  automation-config mock via `globalThis.__stores`. */
export const RAIL_ON = {
  heb: { networkSearch: true, networkAdd: true, cartSkuConfirm: true },
};

export function enableRail(): void {
  // Through the real merge, not a mock of it. A suite that mocks
  // getAutomationConfig is asserting against its own answer; this sets the value
  // and lets the module decide, so a shape the real push would reject fails here
  // too. `globalThis.__stores` is still set for the handful of suites whose own
  // mock reads it.
  (globalThis as any).__stores = RAIL_ON;
  __applyAutomationConfigForTests({ stores: RAIL_ON });
}

export function disableRail(): void {
  (globalThis as any).__stores = undefined;
  __resetAutomationConfigForTests();
}

type View = { queryAllByTestId: (id: string) => Array<{ props: any }> };

/** Post a message to the sheet's WebView, as its injected script would. */
export function postToSheet(view: View, payload: Record<string, unknown>): void {
  act(() => {
    view.queryAllByTestId('mock-webview')[0]?.props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
}

/** The session probe. Also answers the login check — the same message serves
 *  both, which is why a rail store never runs the DOM login script. */
export const SESSION_OK = {
  type: 'HEB_SESSION', ok: true, loggedIn: true,
  storeId: '476', storeName: 'Test H-E-B', shoppingContext: 'CURBSIDE_DELIVERY',
};

export const SESSION_LOGGED_OUT = { type: 'HEB_SESSION', ok: true, loggedIn: false };

export interface RailCandidate {
  productName: string;
  productId?: string;
  skuId?: string;
  outOfStock?: boolean;
  price?: string | null;
  imageUrl?: string | null;
  preferences?: null;
}

export function candidate(productName: string, over: Partial<RailCandidate> = {}): RailCandidate {
  return {
    productName,
    productId: 'p' + productName.replace(/\W+/g, ''),
    skuId: 's' + productName.replace(/\W+/g, ''),
    outOfStock: false, price: '$1.00', imageUrl: null, preferences: null,
    ...over,
  };
}

/** One term's search answer, as the rail's search batch posts it. */
export function searchResult(term: string, candidates: RailCandidate[]) {
  return { type: 'SEARCH_RESULT', source: 'network', term, candidates };
}

export function searchDone(count: number) {
  return { type: 'SEARCH_BATCH_DONE', source: 'network', count };
}

/** One write's outcome, as the rail's add batch posts it. */
export function addResult(idx: number, name: string, success = true, over: Record<string, unknown> = {}) {
  return {
    type: 'NET_ADD_RESULT', idx, name, success,
    productId: 'p' + name.replace(/\W+/g, ''), skuId: 's' + name.replace(/\W+/g, ''),
    asked: 1, base: 0, sent: 1, reason: success ? null : 'not_found', detail: null,
    preferenceId: null, ...over,
  };
}

/** The end of a write pass, carrying the cart it read on both sides of itself. */
export function addDone(
  wrote: number,
  cartBefore: Array<{ name: string; qty: number }> = [],
  cartAfter: Array<{ name: string; qty: number }> = [],
) {
  return { type: 'NET_ADD_DONE', wrote, count: wrote, cartLines: cartAfter.length, cartBefore, cartAfter };
}

/** A cart read, as rail.cartRead() posts it — the same shape the cart PAGE used
 *  to post, which is the whole point of that method. */
export function cartCount(count: number | null, items?: Array<{ name: string; qty: number }>) {
  return items
    ? { type: 'CART_COUNT', count, items, source: 'network' }
    : { type: 'CART_COUNT', count, source: 'network' };
}

/**
 * Drive a run to the REVIEW gate over the rail.
 *
 * The candidates deliberately do not match the term exactly: an exact match is
 * written straight to the cart, and anything less routes to review, which is
 * what these suites are about. That routing used to happen inside the sequential
 * SEARCH_RESULT handler; on the rail it happens when the add pass finds nothing
 * it can write ("nothing matched exactly — straight to review").
 *
 * Timer-agnostic on purpose: some suites run fake timers and some do not, and
 * every transition this touches is synchronous on the message.
 */
export function railRunToReview(
  view: View,
  term: string,
  candidates: Array<Record<string, unknown>>,
): void {
  // Twice: the first answers the login check, the second the run's own session
  // read. Whichever the prewarm makes unnecessary is simply ignored.
  postToSheet(view, SESSION_OK);
  postToSheet(view, cartCount(0, []));
  postToSheet(view, SESSION_OK);
  postToSheet(view, { type: 'SEARCH_RESULT', source: 'network', term, candidates });
  postToSheet(view, searchDone(1));
}
