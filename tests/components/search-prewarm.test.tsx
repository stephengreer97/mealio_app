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
(global as any).__prewarmStatus = 'loggedIn';
// What the SELECTION screen already looked up, before this sheet opened. Empty
// on most tests here, which is the pre-2026-09-02 world; the block at the bottom
// of this file fills it.
(global as any).__earlyAnswers = new Map<string, unknown[]>();
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      getStatus: () => (global as any).__prewarmStatus,
      statusVersion: 1,
      checkStore: () => {},
      takePrewarmedCart: () => null,
      noteSignedOut: () => {},
      setSearchTerms: () => {},
      getSearchResults: (_storeId: string, terms: string[]) => {
        const have = (global as any).__earlyAnswers as Map<string, unknown[]>;
        const out = new Map<string, unknown[]>();
        for (const t of terms) { const got = have.get(t); if (got) out.set(t, got); }
        return out;
      },
    }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { __applyAutomationConfigForTests, __resetAutomationConfigForTests } from '../../src/lib/automation-config';

afterEach(() => {
  __resetAutomationConfigForTests();
  injected.length = 0;
  ((global as any).__earlyAnswers as Map<string, unknown[]>).clear();
});

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
  //
  // On robots.txt, because that is where the sheet actually sits: the rail wants
  // a page with no JavaScript of its own. These said heb.com/ for a while, which
  // was a fiction nothing depended on until the post-login hop to the quiet page
  // started reading the last loaded URL — and then fourteen tests looked like a
  // regression in the hop rather than a wrong URL in the harness.
  const load = (url = 'https://www.heb.com/robots.txt') => act(() => {
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

describe('a store that answers the session probe twice', () => {
  // ALBERTSONS DOES. It replies early off /userinfo and then again about 1.3s
  // later, verified, once the cart read confirms the token. Both are ok and
  // loggedIn. The prewarm had no latch, so both injected the whole batch:
  //
  //   18:52:17.856  search prewarm: searching 2 terms
  //   18:52:19.156  search prewarm: searching 2 terms     <- the same two
  //
  // Four requests where there should have been two, into the one store measured
  // to degrade under exactly that (MEAL-207). Every term in that run came back
  // no_response and the user was handed the store to finish by hand.
  //
  // Driven here through H-E-B because the latch is engine code, not a store
  // rule — any rail that answers twice would have done the same thing.
  it('sends ONE search batch, not one per answer', () => {
    const { post, load } = openSheet();
    load();
    post(SESSION);
    expect(searchBatches()).toBe(1);
    post(SESSION);
    post(SESSION);
    expect(searchBatches()).toBe(1);
  });

  it('and the run still reuses what that one batch answered', () => {
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    post(SESSION);
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('sour cream')] });
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'tortillas', candidates: [candidate('tortillas')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });
    const beforeTap = searchBatches();

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);

    expect(searchBatches()).toBe(beforeTap);
    expect(injected.some((s) => s.includes('cartItemV2'))).toBe(true);
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

describe('a chosen product that no longer exists', () => {
  // Stephen, 2026-09-02: "if we don't find a match and go to reconcile, then the
  // reconcile page shows the search results from the product search. I am
  // considering changing that so that it searches for the ingredient name when
  // there is not a product match."
  //
  // Only when there is NOTHING. A product search that returned near-variants —
  // the 24oz of the thing you picked, the store brand — is offering better
  // options than a fresh ingredient search would, and it keeps them.
  //
  // The second search goes out WITH the writes, so it costs the run nothing and
  // the user never sees a second loading screen.
  // The fallback searches the INGREDIENT name ('Sour Cream'), not the product
  // name the first pass used ('sour cream') — which is the whole point.
  const fallbackBatches = () => injected.filter(
    (s) => s.includes('productSearchPageV2') && s.includes('Sour Cream'),
  ).length;

  it('searches the ingredient name when the chosen product returns nothing', () => {
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    // The chosen product is gone: no candidates at all.
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [] });
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'tortillas', candidates: [candidate('tortillas')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    const beforeCart = fallbackBatches();
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });

    // A second batch went out for the ingredient name, alongside the writes —
    // not after them, and not behind another animation.
    expect(fallbackBatches()).toBe(beforeCart + 1);
    expect(injected.some((s) => s.includes('cartItemV2'))).toBe(true);
  });

  it('searches it even when the store returned near-variants', () => {
    // THE RULE REVERSED, 2026-09-02. Stephen: "We should do a ingredientName
    // search on every reconcilliation run. Not just the ones where there are no
    // suggestions."
    //
    // The old rule reasoned that near-variants were the better offer — "the
    // 24 oz of the thing you picked" over twelve unrelated sour creams. That
    // holds when the product still exists. When it does not, the near-variants
    // are other sizes of a discontinued line, and an item with two poor ones is
    // no better served than an item with none. It only looks better served.
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('Sour Cream 24 oz')] });
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'tortillas', candidates: [candidate('tortillas')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    const beforeCart = fallbackBatches();
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });

    expect(fallbackBatches()).toBe(beforeCart + 1);
  });

  it('keeps the near-variants and adds to them, rather than swapping', () => {
    // Replacing was safe while this only ran for rows that had NOTHING. Now that
    // it runs for every unmatched row, a swap would throw away the one thing the
    // product-name search is good at to make room for results that are broader
    // but not always better.
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('Daisy Sour Cream 24 oz')] });
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'tortillas', candidates: [candidate('tortillas')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    // The ingredient-name batch answers with something the product search missed.
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'Sour Cream',
           candidates: [candidate('H-E-B Sour Cream, 16 oz')] });
    post({ type: 'NET_ADD_RESULT', idx: 1, name: 'tortillas', success: true, productId: 'ptortillas', skuId: 'stortillas' });
    post({ type: 'NET_ADD_DONE', wrote: 1, count: 1, cartBefore: [], cartAfter: [{ name: 'tortillas', qty: 1 }] });
    act(() => { jest.advanceTimersByTime(500); });
    post({ type: 'CART_COUNT', count: 1, items: [{ name: 'tortillas', qty: 1 }], source: 'network' });
    act(() => { jest.advanceTimersByTime(500); });

    act(() => { fireEvent.press(view.getByText(/review 1 ingredient/i)); });
    // BOTH are on the card.
    expect(view.queryByText(/Daisy Sour Cream 24 oz/i)).toBeTruthy();
    expect(view.queryByText(/H-E-B Sour Cream, 16 oz/i)).toBeTruthy();
  });

  it('does not offer the same product twice when both searches return it', () => {
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('Daisy Sour Cream 24 oz')] });
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'tortillas', candidates: [candidate('tortillas')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    // The same product, from the ingredient-name search. Same id.
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'Sour Cream',
           candidates: [candidate('Daisy Sour Cream 24 oz')] });
    post({ type: 'NET_ADD_RESULT', idx: 1, name: 'tortillas', success: true, productId: 'ptortillas', skuId: 'stortillas' });
    post({ type: 'NET_ADD_DONE', wrote: 1, count: 1, cartBefore: [], cartAfter: [{ name: 'tortillas', qty: 1 }] });
    act(() => { jest.advanceTimersByTime(500); });
    post({ type: 'CART_COUNT', count: 1, items: [{ name: 'tortillas', qty: 1 }], source: 'network' });
    act(() => { jest.advanceTimersByTime(500); });

    act(() => { fireEvent.press(view.getByText(/review 1 ingredient/i)); });
    expect(view.queryAllByText(/Daisy Sour Cream 24 oz/i).length).toBe(1);
  });
});

describe('a product already chosen is not searched again', () => {
  // Choose Product once, add to cart forever. Until now the only thing kept was
  // the product's DISPLAY NAME, so every run re-derived the product by searching
  // that string — the store's relevance ranking got a vote on a decision the
  // user had already made.
  const chosenMeal = {
    id: 'm2', name: 'Tacos',
    ingredients: [
      { ingredientName: 'Sour Cream', searchTerm: 'Daisy Sour Cream Light - 16 Oz',
        productQty: 1, qty: 1, unit: 'qty', measure: null,
        // H-E-B addresses a cart line by SKU, so a saved product for it carries
        // one. Albertsons entries have no sku and do not need one.
        storeProducts: { heb: { upc: 'p-sour-cream', sku: 's-sour-cream',
                                name: 'Daisy Sour Cream Light - 16 Oz' } } },
      { ingredientName: 'Tortillas', searchTerm: 'tortillas',
        productQty: 1, qty: 1, unit: 'qty', measure: null },
    ],
  };

  function openChosen() {
    __applyAutomationConfigForTests({
      stores: { heb: { networkSearch: true, networkAdd: true, cartSkuConfirm: true } },
    });
    const view = render(
      <WebViewCartSheet visible meals={[chosenMeal] as never} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });
    const load = (url = 'https://www.heb.com/robots.txt') => act(() => {
      const wv = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
      wv?.props?.onLoadEnd?.({ nativeEvent: { url } });
    });
    return { view, post, load };
  }

  it('searches only the row that has no saved id', () => {
    const { view, post, load } = openChosen();
    load();
    post(SESSION);
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'tortillas', candidates: [candidate('tortillas')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });

    // The already-chosen row never appears in a search — its identifier IS the
    // choice, so there is nothing to look up.
    const searches = injected.filter((s) => s.includes('productSearchPageV2'));
    expect(searches.some((s) => s.includes('Daisy Sour Cream Light'))).toBe(false);
    // ...and it still reaches the cart.
    const write = injected.find((s) => s.includes('cartItemV2'))!;
    expect(write).toContain('p-sour-cream');
  });
});

describe('a prewarm that says signed out is checked, not obeyed', () => {
  // Stephen, 2026-09-02: "tell me why I saw the you are not logged in webview in
  // albertsons. I was logged in and eventually mealio noticed. I should not be
  // shown this webview until the login check is done."
  //
  //     positive signal we are NOT logged in -> show the webview
  //     positive signal we ARE logged in     -> continue with the add
  //     no signal                            -> show the webview
  //
  // A prewarm verdict is not the first line. On the device its probe ran 378ms
  // after a cold WebView loaded, got a 200 with no token and published
  // loggedOut; the sheet's own probe eight seconds later got the token. The
  // sign-in screen had already been shown on the prewarm's word.
  afterEach(() => { (global as any).__prewarmStatus = 'loggedIn'; });

  const sessionProbes = () => injected.filter((s) => s.includes('myPreferredStore')).length;

  it('asks for itself instead of surfacing the sign-in screen', () => {
    (global as any).__prewarmStatus = 'loggedOut';
    const { view, load } = openSheet();
    load();
    const before = sessionProbes();
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    // The check is injected on the next page settle, as it always has been.
    load();

    // It ran its own check rather than believing the prewarm...
    expect(sessionProbes()).toBe(before + 1);
    // ...so the user is not looking at a sign-in page yet.
    expect(view.queryByText(/sign in|log in/i)).toBeNull();
  });

  it('and a signed-in prewarm still skips the check', () => {
    // The half that is safe to trust: being wrong here costs a run that fails at
    // the first write and is surfaced by the reconcile. Being wrong the other
    // way blocks a signed-in user from their own groceries.
    const { view, load } = openSheet();
    load();
    const before = sessionProbes();
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    load();
    expect(sessionProbes()).toBe(before);
  });
});

describe('a Choose Products run fills the bag with its search', () => {
  // The two-phase split — search 0..0.5, add 0.5..1 — describes an ADD run,
  // where the search really is the first half of the work. A choose run searches
  // and then hands the results to the user: there is no add phase to fill the
  // second half, so the bag stopped half full and sat there while the run was in
  // fact finished.
  const unchosen = {
    id: 'm3', name: 'Tacos',
    ingredients: [
      { ingredientName: 'Sour Cream', searchTerm: null, productQty: 1, qty: 1, unit: 'qty', measure: null },
      { ingredientName: 'Tortillas', searchTerm: null, productQty: 1, qty: 1, unit: 'qty', measure: null },
    ],
  };

  it('reaches the end of the bag, not the middle', () => {
    jest.useFakeTimers();
    __applyAutomationConfigForTests({
      stores: { heb: { networkSearch: true, networkAdd: true, cartSkuConfirm: true } },
    });
    const view = render(
      <WebViewCartSheet visible meals={[unchosen] as never} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });
    const load = () => act(() => {
      const wv = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
      wv?.props?.onLoadEnd?.({ nativeEvent: { url: 'https://www.heb.com/robots.txt' } });
    });

    // Nothing is chosen, so the sheet goes straight to the choose flow.
    load();
    post(SESSION);
    // The before-snapshot has to answer before the search phase starts.
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'Sour Cream', candidates: [candidate('Sour Cream')] });
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'Tortillas', candidates: [candidate('Tortillas')] });

    // The bag walks THROUGH the frames rather than cutting, so let it arrive.
    for (let i = 0; i < 40; i++) act(() => { jest.advanceTimersByTime(60); });
    jest.useRealTimers();

    // Both terms answered. On an add run that is halfway; here it is the whole
    // job, and the animation has to say so. Read off the sprite frame the way
    // the animation's own suite does — the LAST frame is a full bag.
    const meta = require('../../assets/anim/bag-fill.json');
    const win = view.getByTestId('bag-frame-window').children[0] as unknown as
      { props: { style: Record<string, unknown> } };
    const t = (win.props.style.transform ?? []) as Array<Record<string, number>>;
    const dispH = 232;
    const dispW = Math.round(meta.frameWidth * (dispH / meta.frameHeight));
    const col = Math.round(Math.abs(t.find((x) => 'translateX' in x)?.translateX ?? 0) / dispW);
    const row = Math.round(Math.abs(t.find((x) => 'translateY' in x)?.translateY ?? 0) / dispH);
    const frame = row * meta.cols + col;
    // Half full would be frame 2 or 3 of 6. A finished choose run is the last.
    expect(frame).toBe(meta.frames - 1);
  });
});

describe('a run records what it learned, so the next one need not search', () => {
  // The id is only written when a product is PICKED, and a meal that is already
  // chosen is never picked again — so every existing meal searched its own saved
  // product name on every run, for ever.
  //
  // A run that searched that name, matched it exactly, wrote it, and had the
  // store ACCEPT it has proven what the name means. Recording that is not a new
  // decision.
  it('reports the id after the store accepts the write', () => {
    const identified: Array<[string, string[], Record<string, unknown>]> = [];
    __applyAutomationConfigForTests({
      stores: { heb: { networkSearch: true, networkAdd: true, cartSkuConfirm: true } },
    });
    const view = render(
      <WebViewCartSheet
        visible meals={[meal] as never} storeId="heb" storeName="H-E-B" onClose={() => {}}
        onIngredientIdentified={(name, mealIds, sp) => identified.push([name, mealIds, sp])}
      />,
    );
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });
    const load = () => act(() => {
      const wv = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
      wv?.props?.onLoadEnd?.({ nativeEvent: { url: 'https://www.heb.com/robots.txt' } });
    });

    load();
    post(SESSION);
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('sour cream')] });
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'tortillas', candidates: [candidate('tortillas')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });

    // Nothing recorded yet — the store has not accepted anything.
    expect(identified).toHaveLength(0);

    post({ type: 'NET_ADD_RESULT', idx: 0, name: 'sour cream', success: true });
    expect(identified).toHaveLength(1);
    const [, , sp] = identified[0];
    expect(sp.upc).toBe('psour cream');
    // H-E-B addresses a cart line by sku, so the saved product carries one.
    expect(sp.sku).toBe('ssour cream');
  });

  it('says nothing for a write the store refused', () => {
    // A rejected write is not evidence about what the name means.
    const identified: unknown[] = [];
    __applyAutomationConfigForTests({
      stores: { heb: { networkSearch: true, networkAdd: true, cartSkuConfirm: true } },
    });
    const view = render(
      <WebViewCartSheet
        visible meals={[meal] as never} storeId="heb" storeName="H-E-B" onClose={() => {}}
        onIngredientIdentified={() => identified.push(1)}
      />,
    );
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });
    const load = () => act(() => {
      const wv = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
      wv?.props?.onLoadEnd?.({ nativeEvent: { url: 'https://www.heb.com/robots.txt' } });
    });
    load();
    post(SESSION);
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('sour cream')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post({ type: 'NET_ADD_RESULT', idx: 0, name: 'sour cream', success: false, reason: 'error_arm' });
    expect(identified).toHaveLength(0);
  });
});

describe('a saved id this store cannot write is not a shortcut', () => {
  // Measured on the device: the backfill recorded ids, the next run correctly
  // said "11 of 11 already chosen — writing those without searching", and then
  // ended 'add_script_unbuildable' having written nothing.
  //
  // H-E-B addresses a cart line by SKU and refuses to build a write without one,
  // so an entry carrying only a product id is not a shortcut, it is a dead end:
  // the row skips the search, reaches the write batch, is filtered out, and the
  // run has nothing left to do. The rail is asked the same question about a
  // saved id that it is asked about a fresh candidate.
  const skulessMeal = {
    id: 'm4', name: 'Tacos',
    ingredients: [
      { ingredientName: 'Sour Cream', searchTerm: 'sour cream',
        productQty: 1, qty: 1, unit: 'qty', measure: null,
        // An id with no sku — unusable at H-E-B.
        storeProducts: { heb: { upc: 'p-sour-cream', name: 'sour cream' } } },
      { ingredientName: 'Tortillas', searchTerm: 'tortillas',
        productQty: 1, qty: 1, unit: 'qty', measure: null },
    ],
  };

  it('searches it instead of stranding the run', () => {
    __applyAutomationConfigForTests({
      stores: { heb: { networkSearch: true, networkAdd: true, cartSkuConfirm: true } },
    });
    const view = render(
      <WebViewCartSheet visible meals={[skulessMeal] as never} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });
    const load = () => act(() => {
      const wv = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
      wv?.props?.onLoadEnd?.({ nativeEvent: { url: 'https://www.heb.com/robots.txt' } });
    });

    load();
    post(SESSION);
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });

    // The sku-less row is in the batch rather than skipped, so the run has
    // something to do.
    const batch = injected.filter((s) => s.includes('productSearchPageV2')).pop() ?? '';
    expect(batch).toContain('sour cream');
  });
});

describe('a prewarm that never comes back', () => {
  // netStartSearch stands back for a prewarm that is still answering, and the
  // note on netPrewarmMaxWaits CLAIMED "a prewarm that dies still releases the
  // run immediately -- netPrewarmDoneRef is set on its failure paths too".
  //
  // True of the failures the prewarm is TOLD about. False of the two silences
  // that matter: a session probe that never answers, and a batch whose
  // SEARCH_BATCH_DONE never arrives because the store went quiet or the document
  // was torn down. Neither posts anything, so nothing set the flag.
  //
  // MEASURED 2026-09-02, Albertsons, 31 items: the run waited 19.6s -- 60 waits
  // of 300ms, the FLOOR of that ceiling -- and then searched anyway. On a bigger
  // batch the ceiling is 300 waits, which is 90 seconds of standing still.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('gives up when the session never answers, instead of holding the run', () => {
    const { view, post, load } = openSheet();
    load();
    // ...and nothing comes back. No session, no failure message, silence.
    act(() => { jest.advanceTimersByTime(20_000); });   // H-E-B's sessionMs is 15s

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);

    // The run searched rather than standing back for a prewarm that is gone.
    expect(searchBatches()).toBeGreaterThan(0);
    expect(injected.filter((s) => s.includes('productSearchPageV2')).pop()).toContain('sour cream');
  });

  it('gives up when the batch goes out and nothing comes back', () => {
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    const duringPrewarm = searchBatches();
    expect(duringPrewarm).toBe(1);
    // The batch is out. No SEARCH_RESULT, no SEARCH_BATCH_DONE, nothing.
    act(() => { jest.advanceTimersByTime(95_000); });   // past H-E-B's searchMs

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);

    expect(searchBatches()).toBe(duringPrewarm + 1);
  });

  it('does NOT give up on one that is still answering', () => {
    // The deadline must not undo the wait itself, which is what stops two
    // identical batches hitting the store at once.
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    const duringPrewarm = searchBatches();
    act(() => { jest.advanceTimersByTime(2_000); });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);

    expect(searchBatches()).toBe(duringPrewarm);
  });
});

describe('what the selection screen already looked up', () => {
  // The prewarm now starts when meals are TICKED, one screen earlier, so by the
  // time this sheet opens the answers are often already in hand. What matters is
  // that the sheet then does not ask for them a second time — the same claim the
  // top of this file makes about its own prewarm, one step further back.
  const early = (term: string, ...names: string[]) => {
    ((global as any).__earlyAnswers as Map<string, unknown[]>).set(term, names.map(candidate));
  };

  it('does not prewarm at all when the selection screen got everything', () => {
    early('sour cream', 'sour cream');
    early('tortillas', 'tortillas');
    const { post, load } = openSheet();
    load();
    post(SESSION);
    expect(searchBatches()).toBe(0);
  });

  it('goes straight to writing when the user taps', () => {
    early('sour cream', 'sour cream');
    early('tortillas', 'tortillas');
    const { view, post, load } = openSheet();
    load();
    post(SESSION);

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);

    expect(searchBatches()).toBe(0);
    expect(injected.some((s) => s.includes('cartItemV2'))).toBe(true);
  });

  it('prewarms only what the selection screen MISSED', () => {
    early('sour cream', 'sour cream');
    const { post, load } = openSheet();
    load();
    post(SESSION);
    expect(searchBatches()).toBe(1);
    const batch = injected.filter((s) => s.includes('productSearchPageV2')).pop()!;
    expect(batch).toContain('tortillas');
    expect(batch).not.toContain('sour cream');
  });

  it('is still used by a user who taps before the store page has loaded', () => {
    // The sheet\'s own prewarm fires on the page\'s load and this user beat it,
    // so nothing here has consulted the early answers yet. They must not be lost:
    // this is the tap-fast case the early start exists for.
    early('sour cream', 'sour cream');
    early('tortillas', 'tortillas');
    const { view, post } = openSheet();

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);

    expect(searchBatches()).toBe(0);
    expect(injected.some((s) => s.includes('cartItemV2'))).toBe(true);
  });
});
