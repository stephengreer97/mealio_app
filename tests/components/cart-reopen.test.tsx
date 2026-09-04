// THE SECOND TIME YOU OPEN THE CART, THE WEBVIEW DOES NOT MOVE.
//
// This sheet is mounted at app root and outlives every run, so opening it again
// for the same store re-runs the open effect with the SAME landing URL it is
// already showing. Writing that string into state changes nothing React can
// see: no navigation, no onLoadEnd. The open then clears lastLoadEndUrl, so
// onStorePage() answers false — and stays false, because the event it is
// waiting for already happened.
//
// Everything the rail does waits on that event. MEASURED on the Pixel,
// 2026-09-04, on the second Wegmans open of the session:
//
//   10:10:38  prewarm known logged in -> straight to snapshot
//   10:10:53  network before-probe timed out - starting without a baseline
//   10:11:08  network run: handing over to the user, session_timeout
//   10:11:08  assisted: handing 2 searches to the user
//
// Not one onLoadEnd in those thirty seconds. The session was fine — a minute
// earlier the same store had answered cartCapable:true — and the user got
// "Checking your cart" for half a minute and then Add It Yourself.
//
// This is Stephen's "I am immediately being taken to Add it Yourself",
// reproduced. It needs a SECOND open, which is why every first-open test and
// every fixture missed it: the suite always rendered a fresh component.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(), identifyUser: jest.fn(async () => {}), resetUser: jest.fn(async () => {}),
}));

const injected: string[] = [];
jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: (s: string) => { (global as any).__injected.push(s); },
      reload: () => { (global as any).__onReload?.(); },
      stopLoading: () => {}, goBack: () => {},
    }));
    return RealReact.createElement(RealView, { testID: props.testID || 'mock-webview', ...props });
  });
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});
(global as any).__injected = injected;

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (p: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...p }) };
});
jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return { Ionicons: (p: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, p.name) };
});
jest.mock('react-native-keyboard-aware-scroll-view', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardAwareScrollView: ScrollView };
});
jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'run-login-poll'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});
// 'unknown', so the sheet runs its own login check rather than trusting a
// prewarm — which is how a user reaches the login screen at all.
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      checkStore: () => {}, getStatus: () => 'unknown', takePrewarmedCart: () => null,
      statusVersion: 1, setSearchTerms: () => {}, getSearchResults: () => new Map(),
    }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { enableRail } from './helpers/railRun';

const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});
const MEALS = [{ id: 'm1', name: 'Tacos', ingredients: [chosen('sour cream')] }] as never;

beforeEach(() => { jest.useFakeTimers(); injected.length = 0; });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

const uriOf = (view: { getAllByTestId: (id: string) => Array<{ props: any }> }) =>
  String(view.getAllByTestId('mock-webview')[0].props.source?.uri ?? '');

describe('re-opening the cart for the same store', () => {
  it('moves the WebView, so a load event still comes', () => {
    enableRail();
    const view = render(
      <WebViewCartSheet visible={false} meals={MEALS}
        storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    view.rerender(
      <WebViewCartSheet visible meals={MEALS}
        storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    const first = uriOf(view);
    expect(first).toContain('heb.com');

    // Close and open again — the ordinary thing a user does.
    view.rerender(
      <WebViewCartSheet visible={false} meals={MEALS}
        storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    view.rerender(
      <WebViewCartSheet visible meals={MEALS}
        storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    const second = uriOf(view);

    // THE ASSERTION. Same page, different URL — that is what makes the WebView
    // navigate and fire onLoadEnd. Writing the identical string is what left the
    // rail waiting thirty seconds for an event that had already happened.
    expect(second).toContain('heb.com');
    expect(second).not.toBe(first);
  });

  it('lands on the quiet page both times, not the storefront', () => {
    // The fix must not smuggle in a different landing page: robots.txt is where
    // a rail belongs, and the storefront is what was starving it.
    enableRail();
    const view = render(
      <WebViewCartSheet visible meals={MEALS}
        storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    expect(uriOf(view)).toContain('robots.txt');
    view.rerender(
      <WebViewCartSheet visible={false} meals={MEALS}
        storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    view.rerender(
      <WebViewCartSheet visible meals={MEALS}
        storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    expect(uriOf(view)).toContain('robots.txt');
  });

  it('reloads rather than cache-busting where the store refuses one', () => {
    // ALDI's anti-bot flags the synthetic ?_t= query, so navTo reload()s instead
    // — a different mechanism reaching the same guarantee, and the reason this
    // fix goes through navTo rather than appending a timestamp here.
    enableRail();
    const reloads: number[] = [];
    (global as any).__onReload = () => reloads.push(1);
    const view = render(
      <WebViewCartSheet visible meals={MEALS}
        storeId="aldi" storeName="ALDI" onClose={() => {}} />,
    );
    const first = uriOf(view);
    expect(first).not.toContain('_t=');
    view.rerender(
      <WebViewCartSheet visible={false} meals={MEALS}
        storeId="aldi" storeName="ALDI" onClose={() => {}} />,
    );
    view.rerender(
      <WebViewCartSheet visible meals={MEALS}
        storeId="aldi" storeName="ALDI" onClose={() => {}} />,
    );
    // Still no cache-buster, and the URL is unchanged — so the load event has to
    // come from the explicit reload().
    expect(uriOf(view)).toBe(first);
    expect(reloads.length).toBeGreaterThan(0);
  });
});
