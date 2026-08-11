// MEAL-16 — does the probe ladder actually get injected?
//
// The ladder itself is pinned by tests/unit/hebCartProbe.test.ts, which
// evaluates the script directly. That proves the script works; it proves nothing
// about whether anything ever runs it. The whole feature is one `injectJavaScript`
// call behind four conditions, and a diagnostic that never fires is the failure
// mode that costs a live run to discover — so this drives the real component to
// the moment the call is meant to happen and looks for the script on the wire.
//
// It also pins the two things that make it a ONCE-PER-RUN latch rather than a
// per-page one: a second page load in the same run must not re-fire it, and the
// rail's flag must gate it.

import { act, fireEvent, render } from '@testing-library/react-native';

// Mock factories cannot reference outer-scope variables (jest hoists them), so
// the recorder hangs off globalThis and is read back through a typed helper.
jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const g: any = globalThis as any;
  g.__mealioWebViews = { injected: [] as string[], instances: [] as any[] };
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: (s: string) => { g.__mealioWebViews.injected.push(s); },
      stopLoading: () => {},
      reload: () => {},
      goBack: () => {},
    }));
    g.__mealioWebViews.instances.push(props);
    return RealReact.createElement(RealView, { testID: props.testID || 'mock-webview', ...props });
  });
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (props: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...props }) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return { Ionicons: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name) };
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

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import {
  loadAutomationConfig,
  __resetAutomationConfigForTests,
} from '../../src/lib/automation-config';

const bus = () => (globalThis as any).__mealioWebViews as { injected: string[]; instances: any[] };

/** The MAIN WebView, not a pool worker: only it gets onLoadEnd AND
 *  onNavigationStateChange. Last wins — props are re-recorded every render. */
function mainWebView(): any {
  const matches = bus().instances.filter((p) => p.onLoadEnd && p.onNavigationStateChange);
  return matches[matches.length - 1];
}

const probeInjections = () => bus().injected.filter((s) => s.includes('cart_query_probe'));

const meal = {
  id: 'm1',
  name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
};

/** Fire a page load on the main WebView. */
function load(url: string) {
  act(() => { mainWebView().onLoadEnd({ nativeEvent: { url } }); });
}

/** The id the Nth injected ladder was built with — every line it posts carries
 *  it, which is how the sheet tells one ladder's report from another's. */
function probeIdOf(n: number): string {
  const m = probeInjections()[n].match(/var __ID = "([^"]+)"/);
  if (!m) throw new Error('injected ladder carries no id');
  return m[1];
}

/** What the ladder itself posts when it reaches its last line. Without this the
 *  sheet has no evidence a ladder survived the page it ran on. */
function ladderFinished(n = probeInjections().length - 1) {
  act(() => {
    mainWebView().onMessage({
      nativeEvent: {
        data: JSON.stringify({
          type: 'EXTRACT_DEBUG', step: 'cart_query_probe_done', probeId: probeIdOf(n), ran: 5, of: 5,
        }),
      },
    });
  });
}

/** Render the H-E-B sheet and drive it to the first page load after login. */
function runToFirstLoad(url = 'https://www.heb.com/cart') {
  const view = render(
    <WebViewCartSheet visible meals={[meal]} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
  );
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  const wv = mainWebView();
  act(() => {
    wv.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: true }) } });
  });
  load(url);
  return view;
}

beforeEach(async () => {
  __resetAutomationConfigForTests();
  const g = globalThis as any;
  if (g.__mealioWebViews) { g.__mealioWebViews.injected = []; g.__mealioWebViews.instances = []; }
});

afterEach(() => __resetAutomationConfigForTests());

describe('the MEAL-16 probe ladder reaches the WebView', () => {
  const armRail = () => loadAutomationConfig(async () => ({
    version: 31,
    config: { stores: { heb: { cartSkuConfirm: true } } },
  }));

  it('injects once the run is past the login gate', async () => {
    await armRail();
    runToFirstLoad();
    expect(probeInjections()).toHaveLength(1);
    // The real script, not a stub of it: every rung's name has to be in there.
    const script = probeInjections()[0];
    for (const rung of ['control', 'minimal', 'discriminator', 'renamed', 'anonymous']) {
      expect(script).toContain(rung);
    }
    expect(script).toContain('zzzNotAField');
  });

  it('does not re-fire on every page once a ladder has run end to end', async () => {
    await armRail();
    runToFirstLoad();
    ladderFinished();
    load('https://www.heb.com/product-detail/tortillas/1234');
    load('https://www.heb.com/');
    // The whole reason the latch is native: #110's in-page one reset on every
    // navigation and printed its line once per add.
    expect(probeInjections()).toHaveLength(1);
  });

  it('runs once more on the first SEARCH page, and only once', async () => {
    await armRail();
    runToFirstLoad(); // /cart
    ladderFinished();
    load('https://www.heb.com/search?q=sour+cream');
    // Where the rail's own reads actually happen. Candidate A includes a
    // page-level fetch wrapper, which is per-document, so /cart answering
    // differently from /search is that candidate with a mechanism attached.
    expect(probeInjections()).toHaveLength(2);
    ladderFinished();
    load('https://www.heb.com/search?q=tortillas');
    expect(probeInjections()).toHaveLength(2);
  });

  it('does not stack a second ladder on the same page as one still in flight', async () => {
    await armRail();
    runToFirstLoad(); // /cart, ladder injected, nothing back yet
    // H-E-B re-renders /cart a beat after load and the dedup above deliberately
    // lets those same-URL loads through while the count probe is pending. Two
    // ladders in one JS context would put concurrent CartLinesAlt requests on the
    // wire — the shape the ladder is sequential to avoid.
    load('https://www.heb.com/cart');
    load('https://www.heb.com/cart');
    expect(probeInjections()).toHaveLength(1);
  });

  it('retries a killed SEARCH-page ladder — completion retires the clause, not injection', async () => {
    await armRail();
    runToFirstLoad(); // /cart
    ladderFinished();
    load('https://www.heb.com/search?q=a'); // injected, then killed by the next nav
    load('https://www.heb.com/search?q=b');
    expect(probeInjections()).toHaveLength(3);
    // …and once one of them answers, the clause is spent.
    ladderFinished();
    expect(probeInjections()).toHaveLength(3);
  });

  it('does not spend the run\'s only shot on a page that killed the ladder', async () => {
    await armRail();
    runToFirstLoad(); // injected, but no cart_query_probe_done ever comes back
    load('https://www.heb.com/product-detail/tortillas/1234');
    expect(probeInjections()).toHaveLength(2);
  });

  it('stops retrying after three ladders, however many pages load', async () => {
    await armRail();
    runToFirstLoad();
    for (const u of ['/a', '/b', '/c', '/d', '/e']) load('https://www.heb.com' + u);
    // Nothing ever reports done, so every load is a retry candidate — and the
    // bound is what keeps a page that reloads in a loop from turning a
    // diagnostic into a request flood.
    expect(probeInjections()).toHaveLength(3);
  });

  it('does not probe the login host — a same-origin POST there hits the wrong gateway', async () => {
    await armRail();
    const view = render(
      <WebViewCartSheet visible meals={[meal]} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    act(() => {
      mainWebView().onMessage({ nativeEvent: { data: JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: true }) } });
    });
    // The store gate above this is a substring test, so accounts.heb.com passes
    // it — and the ladder POSTs to a same-origin path.
    load('https://accounts.heb.com/authorize?client_id=x');
    expect(probeInjections()).toHaveLength(0);
  });

  it('does not inject before the login gate', async () => {
    await armRail();
    const view = render(
      <WebViewCartSheet visible meals={[meal]} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    // A page load during login_check — the session may not exist yet, so a read
    // here would measure a logged-out gateway and read as a finding.
    act(() => { mainWebView().onLoadEnd({ nativeEvent: { url: 'https://www.heb.com/' } }); });
    expect(probeInjections()).toHaveLength(0);
  });

  it('does not inject with the rail flag off — the bundled default', async () => {
    // No config push at all: cartSkuConfirm ships false, and a device with no
    // rail has nothing to diagnose and should send no GraphQL at all.
    runToFirstLoad();
    expect(probeInjections()).toHaveLength(0);
  });

  it('does not inject for another store', async () => {
    await armRail();
    const view = render(
      <WebViewCartSheet visible meals={[meal]} storeId="aldi" storeName="ALDI" onClose={() => {}} />,
    );
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    act(() => {
      mainWebView().onMessage({ nativeEvent: { data: JSON.stringify({ type: 'LOGIN_STATUS', isLoggedIn: true }) } });
    });
    act(() => { mainWebView().onLoadEnd({ nativeEvent: { url: 'https://www.aldi.us/' } }); });
    expect(probeInjections()).toHaveLength(0);
  });
});
