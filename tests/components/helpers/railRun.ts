import { act } from '@testing-library/react-native';

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
  (globalThis as any).__stores = RAIL_ON;
}

export function disableRail(): void {
  (globalThis as any).__stores = undefined;
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
