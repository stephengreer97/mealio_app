// The prewarm probe's cart injection is one-shot, so it must not be spent on a
// page that was never the cart (MEAL-152).
//
// SilentLoginProbe.onLoadEnd injects the cart-count script and retries on each
// load until something posts, bounded by a cap (MEAL-189 — it used to latch on
// the first injection). MEAL-152 made the count scripts refuse to answer off the
// cart page — and on an auth/SSO interstitial they refuse SILENTLY, because a
// verdict there would burn the probe's one pending slot.
//
// Those two facts are only safe together if the probe never injects on an
// interstitial in the first place. Without the skip: cart URL → interstitial →
// inject → latch set → the script returns silently → the real cart page that
// loads next never gets the script → the probe sits out its 15s cart timeout and
// reports logged-in with no baseline. The guard would have converted a wrong
// answer into no answer AND no retry.
//
// This test drives the real component through that exact load sequence. It
// deliberately overlaps PR #81's prewarm-cart-auth-redirect.test.tsx, which
// covers the same wiring for MEAL-136; the file names differ so the two can
// coexist through any merge order.

import { act, render } from '@testing-library/react-native';
import React from 'react';

// ── Module mocks ─────────────────────────────────────────────────────────────

/** Every script the component injects, in order. */
const mockInjected: string[] = [];
/** The live WebView props, so the test can fire onLoadEnd / onMessage. */
let mockWebViewProps: any = null;

// THE MOCK STORE, because it is the only one left on this path.
//
// Amazon Fresh carried this test and left the catalogue on 2026-09-04; every
// real store has a rail and is answered by it without loading a page at all.
// The behaviour is still shipped — the mock store uses it for the Maestro e2e —
// so the guard moves rather than goes.
//
// jest.mock is hoisted above the imports, which is what lets MOCK_STORE_ENABLED
// be true before the registry reads it. Setting the env var in the file body
// would run too late.
jest.mock('../../src/lib/webview-scripts/mockstore', () => ({
  ...jest.requireActual('../../src/lib/webview-scripts/mockstore'),
  MOCK_STORE_ENABLED: true,
}));

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    mockWebViewProps = props;
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: (script: string) => { mockInjected.push(script); },
    }));
    return RealReact.createElement(RealView, { testID: 'mock-webview' });
  });
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import SilentLoginProbe from '../../src/components/SilentLoginProbe';

// HEB: a URL-cart store, so startCartCapture takes the 'url' path and the count
// script is injected from onLoadEnd — the branch under test. Its cart page is
// /cart, which is what the MEAL-152 guard checks.
// STORE is WALMART, and it used to be H-E-B.
//
// The behaviour under test -- the cart PAGE capture, its auth-redirect guard and
// its injection latch -- only applies to a store that NAVIGATES to read its
// cart. H-E-B stopped doing that on 2026-09-01: it has a rail, so the prewarm
// asks for the cart by request from the page it is already on. Walmart has no
// rail and still navigates, so it is where this guard still earns its keep.
// AMAZON, not Walmart. This exercises the PAGE cart path — the injection into a
// rendered cart — and Walmart stopped having one on 2026-09-03 when its rail
// landed: a store with a rail reads its cart over the network and injects
// nothing. Amazon Fresh is the last store without a rail, and the reason is
// written down: its search returns a rendered grid and no structured payload.
const STORE = 'mockstore';
const HOME_URL = 'https://www.heb.com/';
const CART_URL = 'https://www.amazon.com/cart?_t=1754500000000';
// Shape from auth-urls.ts (AUTH_REDIRECT_URL_PATTERN matches '/sso/').
const INTERSTITIAL_URL = 'https://www.heb.com/bin/sso/authorize?code=test';

/** True once the script the probe injected is a cart-count script rather than
 *  the login check. Keyed on a string only the count script contains. */
function isCartCountScript(script: string): boolean {
  return script.includes("type: 'CART_COUNT'") || script.includes("type:'CART_COUNT'");
}

function fireLoadEnd(url: string) {
  act(() => { mockWebViewProps.onLoadEnd({ nativeEvent: { url } }); });
}

function fireMessage(payload: unknown) {
  act(() => { mockWebViewProps.onMessage({ nativeEvent: { data: JSON.stringify(payload) } }); });
}

describe('SilentLoginProbe cart injection (MEAL-152, MEAL-189)', () => {
  beforeEach(() => {
    mockInjected.length = 0;
    mockWebViewProps = null;
  });

  it('spends its one cart injection on the cart page, not the interstitial in front of it', () => {
    const onResult = jest.fn();
    const view = render(
      <SilentLoginProbe storeId={STORE} onLogin={jest.fn()} onResult={onResult} onError={jest.fn()} />,
    );

    // Login phase: the homepage load injects the login check, and a logged-in
    // verdict moves the probe into cart capture.
    fireLoadEnd(HOME_URL);
    fireMessage({ type: 'LOGIN_STATUS', isLoggedIn: true });
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(0);

    // The cart navigation bounces through an auth interstitial. Nothing may be
    // injected here — this is the assertion the missing skip breaks.
    fireLoadEnd(INTERSTITIAL_URL);
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(0);

    // The interstitial resolves to the real cart page, which must still get the
    // one injection. Without the skip above, the latch is already spent and this
    // is 0 — the 15s stall with no baseline.
    fireLoadEnd(CART_URL);
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(1);

    // This used to assert one-shot — that a later load never injects again.
    // MEAL-189 deliberately reversed that, because a page can re-render under a
    // good injection and silence was terminal. What MEAL-152 actually needs is
    // preserved and asserted instead: the interstitial consumed NO budget, so the
    // real cart page still got the first injection above. A later load now
    // retries, and that is its own test below.
    fireMessage({ type: 'CART_COUNT', count: 0, items: [], url: CART_URL });
    fireLoadEnd(CART_URL);
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(1);

    // Unmount clears the probe's armed 15s cart timeout so it can't outlive the
    // test.
    view.unmount();
  });
  it('retries a same-URL re-render that killed the injected script (MEAL-189)', () => {
    // THE case, and the one a per-URL key excludes. WebViewCartSheet already
    // records it for this same script: "HEB re-renders the cart page (same URL) a
    // beat after load, which kills the injected count script before it
    // polls/posts". Same symptom as the 21:31 log — inject, then silence.
    //
    // Nothing is posted between the loads, which is what makes it a retry rather
    // than a second opinion: the injection said nothing at all.
    const view = render(
      <SilentLoginProbe storeId={STORE} onLogin={jest.fn()} onResult={jest.fn()} onError={jest.fn()} />,
    );
    fireLoadEnd(HOME_URL);
    fireMessage({ type: 'LOGIN_STATUS', isLoggedIn: true });

    fireLoadEnd(CART_URL);
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(1);
    // Same URL, re-rendered. Before MEAL-189 this stayed 1 and the probe stalled.
    fireLoadEnd(CART_URL);
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(2);
    view.unmount();
  });

  it('stops retrying the moment a count actually posts', () => {
    // The bound that matters more than the cap. An answer resolves the capture,
    // so no later load may inject — otherwise a resolved probe keeps poking the
    // page for the rest of the run.
    //
    // This also fixes what the first version of this test got wrong: it asserted
    // a second injection WITHOUT firing the message the injected script really
    // sends. cartPathGuardJs posts not_cart_page synchronously, before its first
    // await, so an injection on a non-cart page answers immediately — and that
    // answer is terminal. Withholding it modelled a sequence production cannot
    // produce.
    const onResult = jest.fn();
    const view = render(
      <SilentLoginProbe storeId={STORE} onLogin={jest.fn()} onResult={onResult} onError={jest.fn()} />,
    );
    fireLoadEnd(HOME_URL);
    fireMessage({ type: 'LOGIN_STATUS', isLoggedIn: true });

    fireLoadEnd(CART_URL);
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(1);
    // What the guard posts when the page it landed on is not the cart.
    fireMessage({ type: 'CART_COUNT', count: null, reason: 'not_cart_page', url: HOME_URL });
    expect(onResult).toHaveBeenCalled();

    fireLoadEnd(CART_URL);
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(1);
    view.unmount();
  });

  it('stops after the cap so a redirect loop cannot inject forever', () => {
    // The runaway the original one-shot was really protecting against. Nothing
    // posts, so every load is a retry.
    const view = render(
      <SilentLoginProbe storeId={STORE} onLogin={jest.fn()} onResult={jest.fn()} onError={jest.fn()} />,
    );
    fireLoadEnd(HOME_URL);
    fireMessage({ type: 'LOGIN_STATUS', isLoggedIn: true });
    for (let i = 0; i < 12; i++) fireLoadEnd(`https://www.heb.com/cart?hop=${i}`);
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(5);
    view.unmount();
  });

  it('reads the cart ONCE when the rail answers the session twice', () => {
    // ALBERTSONS ANSWERS TWICE: an early reply the instant /userinfo returns,
    // then a refined one about 1.3s later once its API keys are resolved.
    // reportLogin latches so the LOGIN answer was right; startCartCapture did
    // not, so the probe fired the cart read twice:
    //
    //   probe albertsons cart capture: over the network, no page load
    //   probe albertsons ALB_SESSION {"verified":true,…}
    //   probe albertsons cart capture: over the network, no page load
    //
    // Two requests into the store measured to degrade under exactly that, and a
    // re-armed 15s deadline on top. Note this is the RAIL branch only — the DOM
    // branch above stays unlatched on purpose, because there a second answer is
    // a retry after silence rather than the same answer twice.
    const onLogin = jest.fn();
    const view = render(
      <SilentLoginProbe storeId="albertsons" onLogin={onLogin} onResult={jest.fn()} onError={jest.fn()} />,
    );
    fireLoadEnd('https://www.albertsons.com/robots.txt');
    const before = mockInjected.length;
    fireMessage({ type: 'ALB_SESSION', ok: true, loggedIn: true, early: true, storeId: '161', shoppingContext: 'pickup' });
    const afterFirst = mockInjected.length;
    expect(afterFirst).toBeGreaterThan(before);          // the read went out

    fireMessage({ type: 'ALB_SESSION', ok: true, loggedIn: true, verified: true, storeId: '161', shoppingContext: 'pickup' });
    expect(mockInjected.length).toBe(afterFirst);         // ...and not again

    // The login answer is still published off the early one, which is the whole
    // reason that reply exists.
    expect(onLogin).toHaveBeenCalledWith('albertsons', true);
    expect(onLogin).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('gives a second capture in the same mount a fresh budget', () => {
    // startCartCapture is not latched — it runs on every LOGIN_STATUS:true, and
    // the login check is deliberately re-injected on each load — so one mounted
    // probe can start two captures. Without the counter reset the second one
    // inherits a spent budget and cannot inject at all.
    const view = render(
      <SilentLoginProbe storeId={STORE} onLogin={jest.fn()} onResult={jest.fn()} onError={jest.fn()} />,
    );
    fireLoadEnd(HOME_URL);
    fireMessage({ type: 'LOGIN_STATUS', isLoggedIn: true });
    for (let i = 0; i < 6; i++) fireLoadEnd(`https://www.heb.com/cart?hop=${i}`);
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(5);

    fireMessage({ type: 'LOGIN_STATUS', isLoggedIn: true });
    fireLoadEnd(CART_URL);
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(6);
    view.unmount();
  });
});
