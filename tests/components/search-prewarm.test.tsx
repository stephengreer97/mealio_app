// The search prewarm: look the ingredients up while the user is still deciding
// quantities, so the run does not spend that time on the critical path.
//
// Measured across 34 of Stephen's runs, the search costs 97ms per term — 0.8s at
// eight items, 1.7s at eighteen. It is the one phase that can move, because a
// quantity changes what gets WRITTEN and never what gets looked up.
//
// The claim worth testing is not that it fires. It is that the RUN then does not
// search again: asking twice would double this run's search volume against the
// operation most likely to be shaped, which would make the prewarm a cost rather
// than a saving.

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
      reload: () => {},
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

// A prewarm that already knows the user is signed in — the gate the effect
// checks, because a probe at a signed-out page answers nothing.
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      getStatus: () => 'loggedIn',
      statusVersion: 1,
      checkStore: () => {},
      takePrewarmedCart: () => null,
      noteSignedOut: () => {},
    }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { __applyAutomationConfigForTests, __resetAutomationConfigForTests } from '../../src/lib/automation-config';

afterEach(() => { __resetAutomationConfigForTests(); injected.length = 0; });

const meal = {
  id: 'm1', name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
    { ingredientName: 'Tortillas', searchTerm: 'tortillas', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
};

const candidate = (productName: string) => ({
  productName, imageUrl: null, outOfStock: false, preferences: null, price: '$2',
  productId: 'p' + productName, skuId: 's' + productName,
});

function openSheet() {
  __applyAutomationConfigForTests({
    stores: { heb: { networkSearch: true, networkAdd: true, cartSkuConfirm: true } },
  });
  const view = render(
    <WebViewCartSheet visible meals={[meal] as never} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
  // The prewarm runs when the store page has LOADED — the session probe reads a
  // bootstrap object the page publishes, so there is nothing to ask before then.
  const load = (url = 'https://www.heb.com/') => act(() => {
    // The MAIN cell is the one with an onLoadEnd; the others are pool tiles.
    const wv = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
    wv?.props?.onLoadEnd?.({ nativeEvent: { url } });
  });
  return { view, post, load };
}

const SESSION = {
  type: 'HEB_SESSION', ok: true, loggedIn: true,
  storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY',
};

/** How many search batches have been injected so far. */
const searchBatches = () => injected.filter((s) => s.includes('productSearchPageV2')).length;

describe('the search prewarm', () => {
  it('searches from the qty screen, before the user taps anything', () => {
    const { post, load } = openSheet();
    load();
    post(SESSION);
    expect(searchBatches()).toBe(1);
  });

  it('does NOT search again for a term it already answered', () => {
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('sour cream')] });
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'tortillas', candidates: [candidate('tortillas')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });
    const beforeTap = searchBatches();

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);

    // The run went STRAIGHT to writing. A second batch here is the failure this
    // test exists for: it would double the run's search volume.
    expect(searchBatches()).toBe(beforeTap);
    expect(injected.some((s) => s.includes('cartItemV2'))).toBe(true);
  });

  it('searches only what the prewarm MISSED, not everything again', () => {
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    // One term answered, then the batch ENDS — the store had nothing for the
    // other, or it failed. Either way the prewarm is finished and the run is
    // free to go; an unfinished one is the next case.
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('sour cream')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });
    const beforeTap = searchBatches();

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);

    // One more batch, and it asks for the missing term ONLY.
    expect(searchBatches()).toBe(beforeTap + 1);
    const last = injected.filter((s) => s.includes('productSearchPageV2')).pop()!;
    expect(last).toContain('tortillas');
    expect(last).not.toContain('sour cream');
  });

  it('does not prewarm a store with no rail', () => {
    __resetAutomationConfigForTests();
    render(
      <WebViewCartSheet visible meals={[meal] as never} storeId="walmart" storeName="Walmart" onClose={() => {}} />,
    );
    // Walmart is assisted: there is no rail to ask, and nothing should be
    // injected speculatively into a page the user is about to drive.
    expect(searchBatches()).toBe(0);
  });
});

describe('the page is loaded before the run needs it', () => {
  // The other half of what mounting the WebView through the qty screen buys, and
  // the more valuable half.
  //
  // The session probe is two GraphQL calls, not a read of anything the page
  // publishes — so it does not need the page to be "ready", it needs the page to
  // still BE THERE. Before this, the WebView mounted when the run started, so
  // the probe was injected into a document that was still navigating and died
  // with it. The run then waited for the next onLoadEnd to ask again:
  //
  //   09:23:40.086  network run: reading the session
  //   09:23:41.542  re-reading the session on https://www.heb.com/
  //   09:23:42.516  re-reading the session on https://www.heb.com/
  //   09:23:42.575  HEB_SESSION   (2.5s after the first ask)
  //
  // Measured across 34 runs: 0.42s when the page was ready, 2.68s when it was
  // not, and nothing in between.
  it('mounts the store WebView while the user is still on qty', () => {
    const { view } = openSheet();
    const main = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
    expect(main).toBeTruthy();
    // ...and it is pointed at the store, not left blank.
    expect(String((main as any).props.source?.uri || '')).toContain('heb.com');
  });

  it('keeps it mounted after the prewarm has finished', () => {
    // Unmounting on completion would send the page away again and put the run
    // back to loading it from scratch — the exact cost this removes.
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('sour cream')] });
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'tortillas', candidates: [candidate('tortillas')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });

    const main = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
    expect(main).toBeTruthy();
  });

  it('does NOT mount it on a store with no rail', () => {
    // An assisted store's WebView is the user's. Loading it behind a screen they
    // have not finished with buys nothing and starts a session they may not use.
    __resetAutomationConfigForTests();
    const view = render(
      <WebViewCartSheet visible meals={[meal] as never} storeId="walmart" storeName="Walmart" onClose={() => {}} />,
    );
    const main = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
    expect(main).toBeFalsy();
  });
});

describe('a prewarm still in flight when the user taps', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('waits for it rather than opening a second burst', () => {
    // Measured on a 19-item run: the user tapped 0.2s after the prewarm's batch
    // went out, so TWO batches were in the same page at once — the burst shape a
    // store is most likely to challenge, and pure waste, since the answers were
    // already on their way.
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    const duringPrewarm = searchBatches();

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);

    // Nothing new went out: the run is standing back.
    expect(searchBatches()).toBe(duringPrewarm);

    // The prewarm finishes, having answered one of the two.
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('sour cream')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });
    act(() => { jest.advanceTimersByTime(500); });

    // NOW it searches, and only for what it is missing.
    expect(searchBatches()).toBe(duringPrewarm + 1);
    const last = injected.filter((x) => x.includes('productSearchPageV2')).pop()!;
    expect(last).toContain('tortillas');
    expect(last).not.toContain('sour cream');
  });

  it('does not wait for ever on a prewarm that never answers', () => {
    // Bounded, or a prewarm that never speaks holds the run open for good. The
    // ceiling scales with the batch now — standing back is cheaper than
    // duplicating it — so this waits out the whole ceiling, not three seconds.
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    const duringPrewarm = searchBatches();

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);
    // Two terms: 60 ticks of 300ms, the floor.
    act(() => { jest.advanceTimersByTime(30_000); });

    expect(searchBatches()).toBe(duringPrewarm + 1);
  });
});

describe('the run reuses the session the login check already got', () => {
  // Stephen, 2026-09-01: "this time its not even saying I'm signed out. Its just
  // stuck on the animation screen saying taking a slower route."
  //
  // The login check and the run's own session phase inject the IDENTICAL probe
  // and get the identical reply. The run threw the first answer away and asked
  // again — and on Albertsons the second ask landed on a store homepage still
  // busy with its own bootstrap:
  //
  //   21:47:49.737  login answered over the network  (storeId 161, pickup)
  //   21:47:59.767  network run: reading the session       <- asks again
  //   21:48:24.781  falling back to the pool — session_timeout
  //   21:48:26.177  ALB_SESSION                            <- 1.4s too late
  //
  // Twenty items then went to the page-driven pool, which is the screen he sat
  // in front of. The second ask can tell us nothing new — one store is locked
  // for the life of the sheet — and it can fail, which the answer already in
  // hand cannot.
  const sessionProbes = () => injected.filter((s) => s.includes('myPreferredStore')).length;

  it('does not ask a second time once the login check has answered', () => {
    const { view, post, load } = openSheet();
    load();
    post(SESSION);   // the prewarm's
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('sour cream')] });
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'tortillas', candidates: [candidate('tortillas')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);   // the login check's
    const afterLogin = sessionProbes();
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });

    // The run took the answer it had and went to work.
    expect(sessionProbes()).toBe(afterLogin);
    expect(injected.some((s) => s.includes('cartItemV2'))).toBe(true);
  });

  it('still runs when the login check answered without a usable store', () => {
    // The reuse must not swallow the case it cannot serve: an answer that named
    // no store is not a session, so the run asks for one rather than starting
    // without it.
    const { view, post, load } = openSheet();
    load();
    // Store-less from the start, so nothing is ever cached — not by the prewarm
    // and not by the login check.
    post({ type: 'HEB_SESSION', ok: true, loggedIn: true });
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post({ type: 'HEB_SESSION', ok: true, loggedIn: true });   // no storeId
    const afterLogin = sessionProbes();
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });

    expect(sessionProbes()).toBe(afterLogin + 1);
  });
});
