// The prewarm probe's cart injection is one-shot, so it must not be spent on a
// page that was never the cart (MEAL-152).
//
// SilentLoginProbe.onLoadEnd injects the cart-count script exactly once per
// capture and latches (cartCountInjectedRef). MEAL-152 made the count scripts
// refuse to answer off the cart page — and on an auth/SSO interstitial they
// refuse SILENTLY, because a verdict there would burn the probe's one pending
// slot.
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
const STORE = 'heb';
const HOME_URL = 'https://www.heb.com/';
const CART_URL = 'https://www.heb.com/cart?_t=1754500000000';
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

describe('SilentLoginProbe cart injection (MEAL-152)', () => {
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

    // And it stays one-shot: a later load does not inject a second time.
    fireLoadEnd(CART_URL);
    expect(mockInjected.filter(isCartCountScript)).toHaveLength(1);

    // Unmount clears the probe's armed 15s cart timeout so it can't outlive the
    // test.
    view.unmount();
  });
});
