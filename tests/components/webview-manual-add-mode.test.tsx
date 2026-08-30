// MEAL-197 / MEAL-9 rung 3: a failed add must not be a dead end.
//
// Before this, the done screen named the items it could not add and then offered
// the user nothing to do about them — "Could not add: tortillas" above a Done
// button. The user's only recourse was to leave Mealio and shop by hand with no
// list, which is the outcome MEAL-9 (p0) exists to remove.
//
// What is asserted here is the whole hand-over: that the offer appears only when
// there is something to hand over, that it puts the user on the store's own
// search results for each item in turn, that Skip is remembered rather than
// re-offered, and — the safety property — that Mealio injects NOTHING while the
// user is driving. That last one is not cosmetic: the button being pressed is
// the store's, so a script of ours running alongside would add a second copy
// behind the user's back.

import { act, fireEvent, render } from '@testing-library/react-native';

const mockInjectSpy = jest.fn();

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: (js: string) => mockInjectSpy(js),
      stopLoading: () => {}, goBack: () => {}, reload: () => {},
    }));
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

// Unstubbed, every run of this file would POST a real automation run to
// mealio.co and fail whenever the box is offline.
jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'run-manual-mode'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});

// Serial route, so the run is driven by the messages this test posts rather than
// by a worker pool.
jest.mock('../../src/lib/automation-config', () => {
  const actual = jest.requireActual('../../src/lib/automation-config');
  return {
    ...actual,
    getAutomationConfig: () => {
      const base = actual.getAutomationConfig();
      return { ...base, flags: { ...base.flags, parallelAdd: false, presearchAdd: false } };
    },
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';

const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

const sheet = (...ingredients: unknown[]) => (
  <WebViewCartSheet
    visible
    meals={[{ id: 'm1', name: 'Tacos', ingredients }] as never}
    storeId="heb"
    storeName="H-E-B"
    onClose={() => {}}
  />
);

/**
 * Drive a serial run to the done screen. `landed` names the products the cart
 * read comes back holding; everything asked for and missing from it stays on the
 * failed list, which is what manual mode is offered for.
 */
async function runToDone(asked: string[], landed: string[]) {
  const view = render(sheet(...asked.map(chosen)));
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });

  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  await act(async () => {});
  post({ type: 'LOGIN_STATUS', isLoggedIn: true });
  // Without a baseline there is no after-probe, and the cart read that corrects
  // the failed list never happens.
  post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://heb.test/cart' });

  for (const productName of asked) {
    post({
      type: 'SEARCH_RESULT',
      candidates: [{ productName, imageUrl: null, outOfStock: false, preferences: null, price: '$2' }],
    });
  }
  for (const name of asked) {
    post({ type: 'ADD_RESULT', success: landed.includes(name), reason: 'add button not found' });
  }
  act(() => { jest.advanceTimersByTime(30_000); });

  post({
    type: 'CART_COUNT',
    count: landed.length,
    items: landed.map((name) => ({ name, qty: 1 })),
    url: 'https://heb.test/cart',
  });
  act(() => { jest.advanceTimersByTime(2_000); });
  return view;
}

beforeEach(() => { jest.useFakeTimers(); mockInjectSpy.mockClear(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('the offer', () => {
  it('appears on a run that left items unadded', async () => {
    const view = await runToDone(['sour cream', 'tortillas'], ['sour cream']);
    expect(view.queryByTestId('manual-start')).toBeTruthy();
  });

  it('is absent when everything landed', async () => {
    // Nothing to hand over. Offering anyway would invite the user to re-add
    // items they already have — the over-add the cart principles forbid.
    const view = await runToDone(['sour cream', 'tortillas'], ['sour cream', 'tortillas']);
    expect(view.queryByTestId('manual-start')).toBeNull();
  });

  it('counts only the items still missing', async () => {
    const view = await runToDone(['sour cream', 'tortillas', 'limes'], ['sour cream']);
    expect(view.queryByText(/add the 2 remaining items myself/i)).toBeTruthy();
  });
});

describe('walking the list', () => {
  const enter = async () => {
    const view = await runToDone(['sour cream', 'tortillas', 'limes'], ['sour cream']);
    act(() => { fireEvent.press(view.getByTestId('manual-start')); });
    return view;
  };

  it('names the first item and titles the position', async () => {
    const view = await enter();
    expect(view.queryByTestId('manual-bar')).toBeTruthy();
    expect(view.queryByText(/tortillas/i)).toBeTruthy();
    expect(view.queryByText(/add it yourself \(1 of 2\)/i)).toBeTruthy();
  });

  it('advances to the next item on Next', async () => {
    const view = await enter();
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });
    expect(view.queryByText(/add it yourself \(2 of 2\)/i)).toBeTruthy();
    expect(view.queryByText(/limes/i)).toBeTruthy();
  });

  it('offers Finish rather than Next on the last item', async () => {
    const view = await enter();
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });
    expect(view.queryByText(/^Finish$/)).toBeTruthy();
  });

  it('returns to the done screen at the end', async () => {
    const view = await enter();
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });
    expect(view.queryByTestId('manual-bar')).toBeNull();
    expect(view.queryByText(/^Done$/)).toBeTruthy();
  });
});

describe('Skip is remembered', () => {
  it('does not re-offer an item the user passed on by hand', async () => {
    // The user declining an item in manual mode is a decision, not a failure.
    // Re-offering it on the next pass would ask them the same question again.
    const view = await runToDone(['sour cream', 'tortillas', 'limes'], ['sour cream']);
    act(() => { fireEvent.press(view.getByTestId('manual-start')); });
    act(() => { fireEvent.press(view.getByTestId('manual-skip')); });   // skip tortillas
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });   // finish on limes
    expect(view.queryByText(/add it myself/i)).toBeTruthy();            // one left, not two
    expect(view.queryByText(/add the 2 remaining items myself/i)).toBeNull();
  });
});

describe('the safety property', () => {
  it('injects nothing into a page the user is driving', async () => {
    // The store's own add button is the one being pressed. Any script of ours
    // running on this page could add a second copy behind the user's back.
    const view = await runToDone(['sour cream', 'tortillas'], ['sour cream']);
    act(() => { fireEvent.press(view.getByTestId('manual-start')); });
    mockInjectSpy.mockClear();
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onLoadEnd({
        nativeEvent: { url: 'https://www.heb.com/search?q=tortillas' },
      });
    });
    expect(mockInjectSpy).not.toHaveBeenCalled();
  });
});

describe('the run that actually needs it', () => {
  // Measured on a device, and the reason this population is what it is.
  //
  // A 12-ingredient meal ran against H-E-B. Two items had no exact match, so
  // they reached the mid-run "Items Not Added" gate and the Pick a Substitute
  // screen — which offered herbal TEA BAGS for fresh mint. The user skips. Both
  // land in `skippedNames`; `failedNames` comes back EMPTY; the done screen read
  // "12 items added" / "2 items you skipped" and offered no hand-over at all.
  //
  // The offer was unreachable on precisely the run it exists for, and every unit
  // test above passed while that was true. So this one drives the real path —
  // gate, review screen, Skip — rather than posting a failure directly.
  it('offers the hand-over for an ingredient skipped at review', () => {
    const view = render(sheet(chosen('fresh mint')));
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post({ type: 'LOGIN_STATUS', isLoggedIn: true });
    post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://www.heb.com/cart' });
    // What H-E-B really offered for fresh mint. Not an exact match, so it cannot
    // auto-pick and the item lands on the review screen.
    post({
      type: 'SEARCH_RESULT',
      candidates: [{ productName: 'Tazo Organic Refresh Mint Herbal Tea Bags, 16 ct', imageUrl: null, outOfStock: false, preferences: null, price: '$4.61' }],
    });
    act(() => { fireEvent.press(view.getByText(/review 1 ingredient/i)); });
    act(() => { fireEvent.press(view.getByText(/skip this ingredient/i)); });

    // The device stopped here: "1 item you skipped", and nothing to do about it.
    expect(view.queryByText(/1 item you skipped/i)).toBeTruthy();
    expect(view.queryByTestId('manual-start')).toBeTruthy();
  });
});

describe('coming back from a manual pass', () => {
  // The product the user picks by hand is titled by the STORE, and the cart
  // audit matches intended names exactly. Left alone, a SUCCESSFUL manual add
  // reads as a failure and gets offered a second time.
  async function manualPassThen(cartRows: Array<{ name: string; qty: number }>) {
    const view = await runToDone(['sour cream', 'fresh mint'], ['sour cream']);
    act(() => { fireEvent.press(view.getByTestId('manual-start')); });
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });   // Finish
    // Short, deliberately: the re-probe arms a result timeout on the way out of
    // manual mode, and advancing past it would clear the pending phase so the
    // cart read below arrives untagged and is never audited.
    act(() => { jest.advanceTimersByTime(1_000); });
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify({
          type: 'CART_COUNT',
          count: cartRows.reduce((n, r) => n + r.qty, 0),
          items: cartRows, url: 'https://heb.test/cart',
        }) },
      });
    });
    act(() => { jest.advanceTimersByTime(2_000); });
    return view;
  }

  const ADDED_BY_HAND = [
    { name: 'sour cream', qty: 1 },
    { name: 'Goodness Gardens Fresh Mint, 0.5 oz', qty: 1 },
  ];

  it('does not re-offer an item the user added under a different title', async () => {
    const view = await manualPassThen(ADDED_BY_HAND);
    expect(view.queryByTestId('manual-start')).toBeNull();
  });

  it('does not call it a failure', async () => {
    const view = await manualPassThen(ADDED_BY_HAND);
    expect(view.queryByText(/could not add.*fresh mint/i)).toBeNull();
  });

  it('does not call the user\u2019s own choice an item Mealio did not add', async () => {
    const view = await manualPassThen(ADDED_BY_HAND);
    // queryAllByText, not queryByText: the copy appears in both the banner
    // summary and its expandable detail, so a single-element query throws
    // "found multiple elements" instead of failing on the claim.
    expect(view.queryAllByText(/did not add|didn.t intend/i).length).toBe(0);
  });
});

describe('state does not leak into the next run', () => {
  it('forgets a Skip when the sheet re-opens', async () => {
    // This component survives between runs in the shipping configuration, so a
    // `manualSkipped` left behind silently withholds the same ingredient from
    // the next meal.
    const view = await runToDone(['sour cream', 'fresh mint'], ['sour cream']);
    act(() => { fireEvent.press(view.getByTestId('manual-start')); });
    act(() => { fireEvent.press(view.getByTestId('manual-skip')); });   // skip + finish
    act(() => { jest.advanceTimersByTime(2_000); });

    view.rerender(<WebViewCartSheet visible={false} meals={[] as never} storeId="heb" storeName="H-E-B" onClose={() => {}} />);
    act(() => { jest.advanceTimersByTime(500); });
    const second = await runToDone(['sour cream', 'fresh mint'], ['sour cream']);
    expect(second.queryByTestId('manual-start')).toBeTruthy();
  });
});

describe('the hand-over survives what the store throws at it', () => {
  it('does not abandon the queue on an anti-bot status', () => {
    // The blocker screen offers exactly one button — "Try again" — and it
    // restarts the whole add pass over `activeItemsRef`, re-adding every item
    // that already landed on this run. Reachable only because 'manual' was
    // missing from handleHttpBlock's ignore list, which every other post-run
    // step is on.
    const view = render(sheet(chosen('sour cream'), chosen('fresh mint')));
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post({ type: 'LOGIN_STATUS', isLoggedIn: true });
    post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://heb.test/cart' });
    for (const productName of ['sour cream', 'fresh mint']) {
      post({ type: 'SEARCH_RESULT', candidates: [{ productName, imageUrl: null, outOfStock: false, preferences: null, price: '$2' }] });
    }
    post({ type: 'ADD_RESULT', success: true });
    post({ type: 'ADD_RESULT', success: false, reason: 'add button not found' });
    act(() => { jest.advanceTimersByTime(30_000); });
    post({ type: 'CART_COUNT', count: 1, items: [{ name: 'sour cream', qty: 1 }], url: 'https://heb.test/cart' });
    act(() => { jest.advanceTimersByTime(2_000); });

    act(() => { fireEvent.press(view.getByTestId('manual-start')); });
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onHttpError({
        nativeEvent: { statusCode: 403, url: 'https://www.heb.com/search?q=fresh%20mint' },
      });
    });
    expect(view.queryByTestId('manual-bar')).toBeTruthy();
    expect(view.queryByText(/try again/i)).toBeNull();
  });

  it('does not carry the pre-manual verdict onto the post-manual screen', () => {
    // The rows are cleared on the way in because they are about to be stale. The
    // sentence built from those same rows has to go with them, or the user lands
    // on a screen with no breakdown and a banner still asserting what their cart
    // holds — under a screen they reached by changing it.
    const view = render(sheet(chosen('sour cream'), chosen('fresh mint')));
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post({ type: 'LOGIN_STATUS', isLoggedIn: true });
    post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://heb.test/cart' });
    for (const productName of ['sour cream', 'fresh mint']) {
      post({ type: 'SEARCH_RESULT', candidates: [{ productName, imageUrl: null, outOfStock: false, preferences: null, price: '$2' }] });
    }
    post({ type: 'ADD_RESULT', success: true });
    post({ type: 'ADD_RESULT', success: false, reason: 'add button not found' });
    act(() => { jest.advanceTimersByTime(30_000); });
    post({ type: 'CART_COUNT', count: 1, items: [{ name: 'sour cream', qty: 1 }], url: 'https://heb.test/cart' });
    act(() => { jest.advanceTimersByTime(2_000); });
    expect(view.queryAllByText(/we checked your/i).length).toBeGreaterThan(0);

    act(() => { fireEvent.press(view.getByTestId('manual-start')); });
    expect(view.queryAllByText(/we checked your/i).length).toBe(0);
  });
});
