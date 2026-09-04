// Signed in is not the same as ready to run.
//
// Albertsons answers the session probe TWICE, on purpose. The first reply goes
// out the instant /userinfo comes back, so no budget of ours can make the sheet
// think a signed-in user is signed out; only then does the script resolve the
// API keys and prove the token by reading the cart, and post again. The first
// answer carries `hasSearchKey: false`.
//
// MEASURED 2026-09-02 on a 31-item run. The engine took the first answer and
// went straight to writing:
//
//   network run: session {"ok":true,"loggedIn":true,"verified":false,"early":true,…}
//   network run: 29 of 31 already chosen — writing those without searching
//   network run: wrote 0 of 29
//   …twenty-seven "nothing found for N chosen products"…
//
// and handed a full basket back to the user to add by hand.
//
// It stayed hidden because the sheet's own prewarm happened to consume the early
// answer first. Once the selection screen started answering the searches the
// prewarm stopped running, and the run met the early answer head-on. That is the
// shape this repo keeps relearning: shared code carrying ONE store's assumption
// — here, "a session probe answers once".

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
      reload: () => {}, stopLoading: () => {}, goBack: () => {},
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
jest.mock('../../src/lib/api', () => ({
  kroger: { searchProducts: jest.fn(() => new Promise(() => {})) },
  meals: { update: jest.fn(() => new Promise(() => {})) },
  usage: {
    logAutomationStart: jest.fn(() => Promise.resolve(null)),
    logAutomationComplete: jest.fn(() => Promise.resolve(null)),
    logAutomationSteps: jest.fn(() => Promise.resolve(null)),
  },
}));

// Signed in, and the selection screen already answered every search — which is
// the state that exposed this. The sheet's prewarm then has nothing to do, so
// nothing absorbs the early session answer before the run sees it.
// 'loggedIn' skips the sheet's own login_check and goes straight to the run;
// 'unknown' is how a user with no prewarm answer reaches login_check, which is
// the branch the measured failure came through.
(global as any).__prewarmStatus = 'loggedIn';
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      getStatus: () => (global as any).__prewarmStatus,
      statusVersion: 1,
      checkStore: () => {},
      takePrewarmedCart: () => null,
      setSearchTerms: () => {},
      getSearchResults: () => new Map(),
    }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { __applyAutomationConfigForTests, __resetAutomationConfigForTests } from '../../src/lib/automation-config';

afterEach(() => {
  __resetAutomationConfigForTests();
  injected.length = 0;
  (global as any).__prewarmStatus = 'loggedIn';
});

// Every row already chosen for Albertsons, so the run writes without searching —
// the exact shape of the measured failure.
const meal = {
  id: 'm1', name: 'Beef Wellington',
  ingredients: [
    {
      ingredientName: 'Puff Pastry', searchTerm: 'Pepperidge Farm Puff Pastry Sheets',
      productQty: 1, qty: 1, unit: 'qty', measure: null,
      storeProducts: { albertsons: { upc: '143100034', name: 'Pepperidge Farm Puff Pastry Sheets' } },
    },
    {
      ingredientName: 'Shallots', searchTerm: 'Signature Farms Shallots',
      productQty: 1, qty: 1, unit: 'qty', measure: null,
      storeProducts: { albertsons: { upc: '960315348', name: 'Signature Farms Shallots' } },
    },
  ],
};

/** What Albertsons posts the moment /userinfo answers. No keys yet. */
const EARLY = {
  type: 'ALB_SESSION', ok: true, loggedIn: true, verified: false, early: true,
  source: 'userinfo', storeId: '161', shoppingContext: 'pickup',
  hasSearchKey: false, cartReadable: null,
};

/** ...and what it posts once the keys are resolved and the cart read worked. */
const REFINED = {
  type: 'ALB_SESSION', ok: true, loggedIn: true, verified: true,
  source: 'userinfo', storeId: '161', shoppingContext: 'pickup',
  hasSearchKey: true, cartReadable: true,
};

function openSheet() {
  __applyAutomationConfigForTests({
    stores: { albertsons: { networkSearch: true, networkAdd: true } },
  });
  const view = render(
    <WebViewCartSheet visible meals={[meal] as never} storeId="albertsons" storeName="Albertsons" onClose={() => {}} />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
  const load = (url = 'https://www.albertsons.com/robots.txt') => act(() => {
    const wv = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
    wv?.props?.onLoadEnd?.({ nativeEvent: { url } });
  });
  return { view, post, load };
}

/**
 * Writes are the observable: a write built on the early answer is the bug.
 *
 * Keyed on NET_ADD_RESULT, the message only the add script posts. The obvious
 * markers do not work — the read and the write both live under `cartservice`,
 * and the read script carries the write PATH as a constant even though it never
 * calls it, so both `cartservice` and `cart/items` count the run's own cart read
 * as a write. Both did, first time round, and the test passed for the wrong
 * reason.
 */
const writes = () => injected.filter((s) => s.includes('NET_ADD_RESULT')).length;

describe('the run and the early session answer', () => {
  /**
   * Tap, and get the run as far as WAITING FOR ITS SESSION.
   *
   * The cart read has to land first: the run snapshots the cart before it asks
   * for a session, so a session message posted before that is simply dropped —
   * the phase is not 'session' yet. A first version of these tests posted the
   * early answer first and watched the run write nothing, which is the right
   * result reached by never delivering the message at all.
   */
  const runToSessionPhase = () => {
    const h = openSheet();
    h.load();
    act(() => { fireEvent.press(h.view.getByText(/add ingredients to/i)); });
    h.post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    return h;
  };

  it('does not write on the early answer', () => {
    const { post } = runToSessionPhase();
    post(EARLY);
    expect(writes()).toBe(0);
  });

  it('writes once the store says it is ready', () => {
    const { post } = runToSessionPhase();
    post(EARLY);
    post(REFINED);
    expect(writes()).toBe(1);
  });

  it('takes the refined answer even after the early one was ignored', () => {
    // The deadline stays armed while the run waits, so the refined answer has to
    // be accepted by the SAME branch that just declined one. A latch set on the
    // way past would strand the run on its own session timeout.
    const { post } = runToSessionPhase();
    post(EARLY);
    post(EARLY);
    post(REFINED);
    expect(writes()).toBe(1);
  });

  it('still surfaces the login screen off the early answer', () => {
    // The whole reason the early answer exists. A signed-OUT user must not wait
    // on our key resolution to be told to sign in.
    const { view, post } = runToSessionPhase();
    post({ type: 'ALB_SESSION', ok: true, loggedIn: false, early: true, source: 'userinfo' });
    // The caption over the store's own login page — what the signed-out user
    // actually gets, rather than a ref nobody can see.
    expect(view.queryByText(/log into your Albertsons account once/i)).toBeTruthy();
  });
});

describe('the login check and the early session answer', () => {
  // THE THIRD PLACE THE SAME ASSUMPTION LIVED, and the one that produced the
  // measured failure. This branch does two jobs: it answers the login gate and
  // then starts the run. Starting on the early answer wrote nothing at all —
  // every add came back `status 401`, because the subscription key the write
  // reads is a page global set by the cart read the REFINED answer performs, and
  // a run using the prewarmed cart baseline never does a read of its own to set
  // it.
  //
  //   [Cart 18:59:04.629] snapshotBefore: using PREWARMED baseline count= 68
  //   [Cart 18:59:05.386] NET_ADD_RESULT {"detail":"status 401","success":false…}
  //   [Cart 18:59:06.351] network run: wrote 0 of 29
  const openOnLoginCheck = () => {
    // No prewarm answer, so the sheet runs its OWN login check — which is the
    // branch that both answers the login gate and starts the run.
    (global as any).__prewarmStatus = 'unknown';
    __applyAutomationConfigForTests({ stores: { albertsons: { networkSearch: true, networkAdd: true } } });
    const view = render(
      <WebViewCartSheet visible meals={[meal] as never} storeId="albertsons" storeName="Albertsons" onClose={() => {}} />,
    );
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
    });
    const load = () => act(() => {
      const wv = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
      wv?.props?.onLoadEnd?.({ nativeEvent: { url: 'https://www.albertsons.com/robots.txt' } });
    });
    load();
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    return { view, post };
  };

  it('does not start the run on the early answer', () => {
    const { post } = openOnLoginCheck();
    post(EARLY);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    expect(writes()).toBe(0);
  });

  it('starts it on the refined one', () => {
    const { post } = openOnLoginCheck();
    post(EARLY);
    post(REFINED);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    expect(writes()).toBe(1);
  });

  it('a signed-out early answer gives the STOREFRONT a chance first', () => {
    // CHANGED 2026-09-04, and this reverses a deliberate decision, so here is
    // the measurement that reversed it.
    //
    // The early answer exists so that no budget of ours makes a signed-out user
    // wait to be told to sign in, and acting on it immediately was right on that
    // reasoning. It is wrong when the answer is wrong — and from the QUIET PAGE
    // this store's answer is wrong for a signed-in user, because /userinfo
    // cannot resolve the session there until the site's own code has run once.
    //
    //   12:53:08.8  signed out, from robots.txt   -> sign-in screen
    //   12:53:09.7  the storefront loads
    //   12:53:10.0  ask #1 -> signed out
    //   12:53:14.2  ask #5 -> SIGNED IN
    //   12:53:15.0  verified
    //
    // Stephen: "I am already signed in, but it took me to the sign into
    // albertsons page for few seconds before realizing I am logged in. That
    // should not happen."
    //
    // So: one storefront load, then believe the answer. A genuinely signed-out
    // user reaches the same screen about a second later; a signed-in one never
    // sees it at all.
    const { view, post } = openOnLoginCheck();
    post({ type: 'ALB_SESSION', ok: true, loggedIn: false, early: true, source: 'userinfo' });
    expect(view.queryByText(/log into your Albertsons account once/i)).toBeNull();
  });

  it('and takes the second answer at its word', () => {
    // The other half. Once the site has had its load, a signed-out answer IS
    // final and the user is not left waiting for a session that is not coming.
    const { view, post } = openOnLoginCheck();
    post({ type: 'ALB_SESSION', ok: true, loggedIn: false, early: true, source: 'userinfo' });
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onLoadEnd({
        nativeEvent: { url: 'https://www.albertsons.com/?_t=2' },
      });
    });
    post({ type: 'ALB_SESSION', ok: true, loggedIn: false, source: 'userinfo' });
    expect(view.queryByText(/log into your Albertsons account once/i)).toBeTruthy();
  });
});

describe('signing in leaves you on the storefront', () => {
  // MEASURED across four Albertsons runs on 2026-09-02, and the split is clean.
  //
  // The rail lives on robots.txt: a page with no JavaScript of its own, so our
  // requests get the renderer to themselves. A run that needed the LOGIN screen
  // does not start there — signing in means navigating to the real storefront —
  // and it was still sitting on it when the run began.
  //
  //   skipped the login screen   robots.txt    worstTick ~1000ms (a 1s interval)
  //   signed in                  storefront    17.8s lost in the cart read (20:44)
  //   signed in                  storefront    12.0s lost inside ONE search (21:19)
  //
  //   [Cart 21:19:51.354] net search PERDUE ms= 15945 worstTick= 12027
  //   [Cart 21:19:51.922] net search Set2   ms=   576   <- same document, after
  //
  // Sixteen seconds for a request the store answered in half of one. That is the
  // store's own post-login bootstrap running in the renderer we are borrowing.
  /**
   * The RUN's first act is reading the cart, so that script landing is the run
   * having started.
   *
   * Keyed on CART_COUNT, which only the cart-read script posts. `cartservice`
   * does not work: the session probe reads the cart too, so it matches before
   * the run has begun and the test passed for the wrong reason.
   */
  const railScript = () => injected.filter((s) => s.includes('CART_COUNT')).length;

  it('moves to the quiet page before running', () => {
    (global as any).__prewarmStatus = 'unknown';
    __applyAutomationConfigForTests({ stores: { albertsons: { networkSearch: true, networkAdd: true } } });
    const view = render(
      <WebViewCartSheet visible meals={[meal] as never} storeId="albertsons" storeName="Albertsons" onClose={() => {}} />,
    );
    const wv = () => view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
    const load = (url: string) => act(() => { wv()?.props?.onLoadEnd?.({ nativeEvent: { url } }); });
    const post = (p: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({ nativeEvent: { data: JSON.stringify(p) } });
    });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    // Signing in takes the WebView to the storefront.
    load('https://www.albertsons.com/?_t=123');
    post(REFINED);

    // The run does NOT start here — it hops first.
    expect(railScript()).toBe(0);
    expect(String(wv()?.props?.source?.uri || '')).toContain('robots.txt');

    // ...and starts when the quiet page lands.
    load('https://www.albertsons.com/robots.txt?_t=456');
    expect(railScript()).toBeGreaterThan(0);
  });

  it('does not hop when the run never left the quiet page', () => {
    // The ordinary run: the prewarm already knew, so there was no login screen
    // and no navigation. A round trip here would be pure cost.
    (global as any).__prewarmStatus = 'loggedIn';
    __applyAutomationConfigForTests({ stores: { albertsons: { networkSearch: true, networkAdd: true } } });
    const view = render(
      <WebViewCartSheet visible meals={[meal] as never} storeId="albertsons" storeName="Albertsons" onClose={() => {}} />,
    );
    const post = (p: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({ nativeEvent: { data: JSON.stringify(p) } });
    });
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(REFINED);
    // Straight to the writes, no hop.
    expect(writes()).toBe(1);
  });

  it('runs where it is if the quiet page never loads', () => {
    // A hop that never lands must not strand the run.
    jest.useFakeTimers();
    try {
      (global as any).__prewarmStatus = 'unknown';
      __applyAutomationConfigForTests({ stores: { albertsons: { networkSearch: true, networkAdd: true } } });
      const view = render(
        <WebViewCartSheet visible meals={[meal] as never} storeId="albertsons" storeName="Albertsons" onClose={() => {}} />,
      );
      const wv = () => view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
      act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
      act(() => { wv()?.props?.onLoadEnd?.({ nativeEvent: { url: 'https://www.albertsons.com/?_t=123' } }); });
      act(() => {
        view.getAllByTestId('mock-webview')[0].props.onMessage({
          nativeEvent: { data: JSON.stringify(REFINED) },
        });
      });
      expect(railScript()).toBe(0);
      act(() => { jest.advanceTimersByTime(7_000); });
      expect(railScript()).toBeGreaterThan(0);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});

describe('the prewarm and the early session answer', () => {
  const searches = () => injected.filter((s) => s.includes('pgmsearch') || s.includes('xapi/search')).length;

  const unchosen = {
    id: 'm2', name: 'Tikka',
    ingredients: [
      { ingredientName: 'Garam Masala', searchTerm: 'O Organics Garam Masala', productQty: 1, qty: 1, unit: 'qty', measure: null },
    ],
  };

  function openUnchosen() {
    __applyAutomationConfigForTests({ stores: { albertsons: { networkSearch: true, networkAdd: true } } });
    const view = render(
      <WebViewCartSheet visible meals={[unchosen] as never} storeId="albertsons" storeName="Albertsons" onClose={() => {}} />,
    );
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
    });
    const load = () => act(() => {
      const wv = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
      wv?.props?.onLoadEnd?.({ nativeEvent: { url: 'https://www.albertsons.com/robots.txt' } });
    });
    return { view, post, load };
  }

  it('does not search on the early answer either', () => {
    const { post, load } = openUnchosen();
    load();
    post(EARLY);
    expect(searches()).toBe(0);
  });

  it('searches ONCE when both answers arrive', () => {
    // Two answers used to mean two identical batches, into the one store
    // measured to degrade under exactly that.
    const { post, load } = openUnchosen();
    load();
    post(EARLY);
    post(REFINED);
    post(REFINED);
    expect(searches()).toBe(1);
  });
});
