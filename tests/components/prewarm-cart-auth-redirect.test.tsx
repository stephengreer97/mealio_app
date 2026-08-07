// The prewarm probe's cart branch must skip auth/SSO interstitials too (MEAL-136).
//
// The login branch has skipped them since MEAL-42. The cart branch never did, and
// it is the branch where skipping matters MORE, because it LATCHES:
// cartCountInjectedRef is set on the first injection and never cleared for the
// rest of the probe's life. So an Albertsons SSO bounce landing while the probe
// is in its cart phase used to mean:
//
//   1. onLoadEnd fires for …/sso/authorize, injects the count script, latches.
//   2. The script's own guard (correctly) posts no verdict on an interstitial —
//      a verdict there would burn the probe's single pending slot.
//   3. The real /erums/cart loads a moment later, and the latch means it is
//      never injected at all.
//   4. The probe sits out its full CART_TIMEOUT_MS and reports logged-in with no
//      baseline.
//
// Nothing hangs and nothing is miscounted — every silence path is bounded, and no
// count is invented — so this is a lost baseline, not a wrong cart. But a lost
// baseline on every SSO bounce is worth not losing.
//
// This test drives onLoadEnd directly. jsdom has no WebView, so the mock below
// records what would have been injected into the page; the URL each load carries
// is the only variable.

import { act, render } from '@testing-library/react-native';
import React from 'react';

// Mock factories are hoisted, so they cannot close over outer variables — the
// injected-script log lives on globalThis and is read back through it.
jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: (js: string) => {
        (globalThis as any).__injected.push(js);
      },
    }));
    (globalThis as any).__webviewProps = props;
    return RealReact.createElement(RealView, { testID: 'mock-webview' });
  });
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

import SilentLoginProbe from '../../src/components/SilentLoginProbe';
import { buildCartPageCountScript, getCartPageUrl } from '../../src/lib/webview-scripts/cart-count';

/** Albertsons-family banner: the family that actually does the SSO bounce. */
const STORE = 'acme';
const CART_URL = getCartPageUrl(STORE)!;
const SSO_URL = 'https://www.acmemarkets.com/bin/safeway/unified/sso/authorize?code=abc123';

const injected = (): string[] => (globalThis as any).__injected;
const webviewProps = (): any => (globalThis as any).__webviewProps;

/** True when `js` is the Albertsons cart-page COUNT script, not the login check. */
function isCountScript(js: string): boolean {
  return js === buildCartPageCountScript(STORE);
}

beforeEach(() => {
  (globalThis as any).__injected = [];
  (globalThis as any).__webviewProps = undefined;
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Mount the probe and walk it into its cart phase, the way the real flow does:
 *  a login-phase load, then a logged-in LOGIN_STATUS. Returns once the probe is
 *  waiting for a cart page to load. */
function renderProbeInCartPhase() {
  const onLogin = jest.fn();
  const onResult = jest.fn();
  const onError = jest.fn();

  render(
    <SilentLoginProbe storeId={STORE} onLogin={onLogin} onResult={onResult} onError={onError} />,
  );

  // Login phase: the store home page loads and gets the check script.
  act(() => {
    webviewProps().onLoadEnd({ nativeEvent: { url: 'https://www.acmemarkets.com/' } });
  });
  // Logged in → the probe flips to the cart phase and navigates to the cart URL.
  act(() => {
    webviewProps().onMessage({
      nativeEvent: { data: JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: true }) },
    });
  });
  expect(onLogin).toHaveBeenCalledWith(STORE, true);

  // Everything up to here is setup; only cart-phase injections are the subject.
  (globalThis as any).__injected = [];
  return { onLogin, onResult, onError };
}

describe('SilentLoginProbe cart phase on an auth redirect (MEAL-136)', () => {
  it('does not inject the count script on an SSO interstitial', () => {
    renderProbeInCartPhase();

    act(() => {
      webviewProps().onLoadEnd({ nativeEvent: { url: SSO_URL } });
    });

    expect(injected().filter(isCountScript)).toHaveLength(0);
  });

  it('still injects on the real cart page that loads after the interstitial', () => {
    // The regression this pins. Without the skip, the interstitial latches
    // cartCountInjectedRef and the cart page below is never injected — the probe
    // then times out with no baseline. The skip has to happen BEFORE the latch.
    //
    // The WHICH-load assertion is the whole test. An earlier version only checked
    // the total was 1 at the end, which passes either way: the broken path also
    // injects exactly once, just on the wrong page. So assert the interstitial
    // injected nothing, and that the injection arrived with the cart load.
    renderProbeInCartPhase();

    act(() => {
      webviewProps().onLoadEnd({ nativeEvent: { url: SSO_URL } });
    });
    expect(injected().filter(isCountScript)).toHaveLength(0);

    act(() => {
      webviewProps().onLoadEnd({ nativeEvent: { url: `${CART_URL}?_t=1754500000000` } });
    });
    expect(injected().filter(isCountScript)).toHaveLength(1);
  });

  it('still injects exactly once when the cart page loads twice', () => {
    // The latch itself is not what changed: a real cart page is still counted
    // once, no matter how many loads it reports.
    renderProbeInCartPhase();

    act(() => {
      webviewProps().onLoadEnd({ nativeEvent: { url: CART_URL } });
    });
    act(() => {
      webviewProps().onLoadEnd({ nativeEvent: { url: CART_URL } });
    });

    expect(injected().filter(isCountScript)).toHaveLength(1);
  });

  it('logs the reason and URL that came with a CART_COUNT verdict', () => {
    // The other half of MEAL-136's follow-up: `count: null` alone is
    // indistinguishable from a selector miss. finish() drops reason entirely, so
    // this log line is the only place a wrong host is legible as a wrong host.
    const { onResult } = renderProbeInCartPhase();
    act(() => {
      webviewProps().onLoadEnd({ nativeEvent: { url: CART_URL } });
    });
    act(() => {
      webviewProps().onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'CART_COUNT',
            count: null,
            reason: 'not_cart_page',
            url: 'https://www.shopunitedsupermarkets.com/',
          }),
        },
      });
    });

    // Join each call's args: the log passes them as separate arguments, so the
    // assertion has to read the line the way a person reading the console does.
    const lines = (console.log as jest.Mock).mock.calls.map((c) => c.join(' '));
    const line = lines.find((l) => l.includes('CART_COUNT'));
    expect(line).toBeDefined();
    expect(line).toContain('not_cart_page');
    expect(line).toContain('https://www.shopunitedsupermarkets.com/');
    // And the verdict still lands as an honest unknown, not a zero.
    expect(onResult).toHaveBeenCalledWith(STORE, true, expect.objectContaining({ count: null }));
  });
});
