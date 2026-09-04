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
import { enableRail, disableRail, SESSION_OK } from './helpers/railRun';

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
  enableRail();
  // Over the rail: one session probe answers the login check, another the
  // run's own read after the baseline.
  post(SESSION_OK);
  // Without a baseline there is no after-probe, and the cart read that corrects
  // the failed list never happens.
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post(SESSION_OK);

  // One answer per term, each an EXACT match so the rail writes it. `chosen()`
  // makes the searchTerm the product name, so term and productName are the same
  // string — anything less than exact would route to review instead.
  for (const productName of asked) {
    post({
      type: 'SEARCH_RESULT', source: 'network', term: productName,
      candidates: [{
        productName, imageUrl: null, outOfStock: false, preferences: null, price: '$2',
        productId: 'p' + productName, skuId: 's' + productName,
      }],
    });
  }
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: asked.length });
  // Then the writes. `landed` is what the cart actually ends up holding; a write
  // this reports as failed is what manual mode is offered for.
  asked.forEach((name, idx) => {
    post({
      type: 'NET_ADD_RESULT', idx, name, success: landed.includes(name),
      productId: 'p' + name, skuId: 's' + name,
      reason: landed.includes(name) ? null : 'not_found',
    });
  });
  post({
    type: 'NET_ADD_DONE', wrote: asked.length, count: asked.length,
    cartBefore: [], cartAfter: landed.map((name) => ({ name, qty: 1 })),
  });
  // Answered BEFORE the long advance. The reconcile probe gives up after
  // cartProbeResultMs (14s); the old 30s jump was harmless on the page path
  // because the probe was armed by a navigation that had not happened yet.
  post({
    type: 'CART_COUNT',
    count: landed.length,
    items: landed.map((name) => ({ name, qty: 1 })),
    source: 'network',
  });
  // The reconcile finds the shortfall and tops it up over the rail — it still
  // holds the match from the search, so it re-writes rather than re-searching.
  // Answer that too, still short, which is what leaves the item on the failed
  // list that manual mode is offered for.
  const missing = asked.filter((n) => !landed.includes(n));
  missing.forEach((name, i) => {
    post({
      type: 'NET_ADD_RESULT', idx: asked.indexOf(name), name, success: false,
      productId: 'p' + name, skuId: 's' + name, reason: 'not_found',
    });
    if (i === missing.length - 1) {
      post({
        type: 'NET_ADD_DONE', wrote: missing.length, count: missing.length,
        cartBefore: landed.map((n) => ({ name: n, qty: 1 })),
        cartAfter: landed.map((n) => ({ name: n, qty: 1 })),
      });
    }
  });
  act(() => { jest.advanceTimersByTime(30_000); });
  return view;
}

/**
 * Enter manual mode the way it is still reached.
 *
 * The done screen's "Add the remaining items myself" button was removed on
 * 2026-09-02 — see the describe below. Manual mode itself is not going anywhere:
 * it is what a store with NO RAIL gets for the whole run, and what a run hands
 * over to when it can neither add an item nor offer anything to review. That is
 * the route these tests take now, and it exercises the same screen.
 */
function assistedRun(...names: string[]) {
  disableRail();
  const view = render(
    <WebViewCartSheet
      visible
      meals={[{ id: 'm1', name: 'Tacos', ingredients: names.map(chosen) }] as never}
      storeId="heb"
      storeName="H-E-B"
      onClose={() => {}}
    />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  post({ type: 'LOGIN_STATUS', isLoggedIn: true });
  // The before-snapshot, which every run waits on before it decides anything.
  post({ type: 'CART_COUNT', count: 0, items: [] });
  act(() => { jest.advanceTimersByTime(2_000); });
  return view;
}

beforeEach(() => { jest.useFakeTimers(); mockInjectSpy.mockClear(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('the done screen never offers to hand over the store', () => {
  // Stephen, 2026-09-02: "get rid of the add it myself button from the end cart
  // page entirely under all circumstances."
  //
  // It was MEAL-197's third rung and it made sense when the mid-run gate could
  // only show what the CHOSEN product name returned: an ingredient offered wrong
  // substitutes got skipped, and the done screen was the last chance to do
  // anything about it. That gate now searches the ingredient name too, so the
  // alternatives are offered where the question is actually being asked — one
  // screen earlier, without leaving the app.
  //
  // "Under all circumstances" is why these are three cases and not one: the
  // button was conditional, so a single negative assertion could pass merely by
  // picking a state that never showed it.
  it('not when items were left unadded', async () => {
    const view = await runToDone(['sour cream', 'tortillas'], ['sour cream']);
    expect(view.queryByTestId('manual-start')).toBeNull();
  });

  it('not when several were left unadded', async () => {
    const view = await runToDone(['sour cream', 'tortillas', 'limes'], ['sour cream']);
    expect(view.queryByTestId('manual-start')).toBeNull();
    expect(view.queryByText(/myself/i)).toBeNull();
  });

  it('not when everything landed either', async () => {
    const view = await runToDone(['sour cream', 'tortillas'], ['sour cream', 'tortillas']);
    expect(view.queryByTestId('manual-start')).toBeNull();
  });

  it('and neither does it offer to copy the list', async () => {
    // Removed on the same call. The done screen already NAMES what was not
    // added, so a link that copies those same names to a clipboard was a second
    // way of saying one thing.
    const view = await runToDone(['sour cream', 'tortillas'], ['sour cream']);
    expect(view.queryByTestId('manual-copy')).toBeNull();
    // ...but the screen still says WHICH item, which is the part that mattered.
    expect(view.queryByText(/tortillas/i)).toBeTruthy();
  });
});

describe('walking the list', () => {
  // Entered through an assisted run now — a store with no rail, where handing
  // the user the searches IS the run. Same screen, same queue, and the only
  // route left into it.
  const enter = () => assistedRun('tortillas', 'limes');

  it('names the first item and titles the position', () => {
    const view = enter();
    expect(view.queryByTestId('manual-bar')).toBeTruthy();
    expect(view.queryByText(/tortillas/i)).toBeTruthy();
    expect(view.queryByText(/add it yourself \(1 of 2\)/i)).toBeTruthy();
  });

  it('advances to the next item on Next', () => {
    const view = enter();
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });
    expect(view.queryByText(/add it yourself \(2 of 2\)/i)).toBeTruthy();
    expect(view.queryByText(/limes/i)).toBeTruthy();
  });

  it('offers Finish rather than Next on the last item', () => {
    const view = enter();
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });
    expect(view.queryByText(/^Finish$/)).toBeTruthy();
  });

  it('returns to the done screen at the end', () => {
    const view = enter();
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });
    expect(view.queryByTestId('manual-bar')).toBeNull();
    expect(view.queryByText(/^Done$/)).toBeTruthy();
  });
});

describe('skipping an item', () => {
  // The "not offered again" half of this went with the done-screen offer: there
  // is no second offer left to re-present a walked item on. What still matters —
  // and is what a user actually does — is that Skip moves on rather than ending
  // the pass.
  it('carries on to the next item rather than ending the pass', () => {
    const view = assistedRun('tortillas', 'limes');
    act(() => { fireEvent.press(view.getByTestId('manual-skip')); });
    expect(view.queryByTestId('manual-bar')).toBeTruthy();
    expect(view.queryByText(/add it yourself \(2 of 2\)/i)).toBeTruthy();
  });

  it('reaches the done screen after the last one', () => {
    const view = assistedRun('tortillas', 'limes');
    act(() => { fireEvent.press(view.getByTestId('manual-skip')); });
    act(() => { fireEvent.press(view.getByTestId('manual-skip')); });
    expect(view.queryByTestId('manual-bar')).toBeNull();
  });
});

describe('the safety property', () => {
  it('injects nothing into a page the user is driving', () => {
    // The store's own add button is the one being pressed. Any script of ours
    // running on this page could add a second copy behind the user's back.
    const view = assistedRun('tortillas', 'limes');
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
  it('offers alternatives on the review screen, so the done screen need not', () => {
    const view = render(sheet(chosen('fresh mint')));
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    enableRail();
    // Over the rail: one session probe answers the login check, another the
    // run's own read after the baseline.
    post(SESSION_OK);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION_OK);
    // What H-E-B really offered for fresh mint. Not an exact match, so it cannot
    // auto-pick and the item lands on the review screen.
    post({
      type: 'SEARCH_RESULT', source: 'network', term: 'fresh mint',
      candidates: [{ productName: 'Tazo Organic Refresh Mint Herbal Tea Bags, 16 ct', imageUrl: null, outOfStock: false, preferences: null, price: '$4.61' }],
    });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    act(() => { fireEvent.press(view.getByText(/review 1 ingredient/i)); });
    act(() => { fireEvent.press(view.getByText(/skip this ingredient/i)); });

    // The device stopped here: "1 item you skipped", and nothing to do about it.
    // The answer used to be a hand-over button on THIS screen. It is now one
    // screen earlier: the gate above showed what the store offered, and when the
    // chosen product name returns nothing the run asks again by ingredient name
    // so there is something real to pick from. A user who skips that has
    // declined the alternatives, not been denied them.
    expect(view.queryByText(/1 item you skipped/i)).toBeTruthy();
    expect(view.queryByTestId('manual-start')).toBeNull();
    expect(view.queryByTestId('manual-copy')).toBeNull();
    // ...and the screen still names it, which is what the user needs from it.
    expect(view.queryByText(/fresh mint/i)).toBeTruthy();
  });
});

describe('coming back from a manual pass', () => {
  // The product the user picks by hand is titled by the STORE, and the cart
  // audit matches intended names exactly. Left alone, a SUCCESSFUL manual add
  // reads as a failure and gets offered a second time.
  function manualPassThen(cartRows: Array<{ name: string; qty: number }>) {
    // Entered the way manual mode is still entered: an assisted run, which hands
    // the user every search because the store has no rail.
    const view = assistedRun('sour cream', 'fresh mint');
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });
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

  it('does not call it a failure', () => {
    const view = manualPassThen(ADDED_BY_HAND);
    expect(view.queryByText(/could not add.*fresh mint/i)).toBeNull();
  });

  it('does not call the user\u2019s own choice an item Mealio did not add', () => {
    const view = manualPassThen(ADDED_BY_HAND);
    // queryAllByText, not queryByText: the copy appears in both the banner
    // summary and its expandable detail, so a single-element query throws
    // "found multiple elements" instead of failing on the claim.
    expect(view.queryAllByText(/did not add|didn.t intend/i).length).toBe(0);
  });
});

describe('state does not leak into the next run', () => {
  it('forgets a Skip when the sheet re-opens', () => {
    // Under the shipping !FEATURE_BACKGROUND_CART mount this component is not
    // remounted between runs — it is hidden and shown. So this drives ONE
    // instance through two runs via the `visible` prop. Rendering a second
    // component instead (the obvious way to write it) starts run 2 from a fresh
    // mount, where the leak cannot show.
    //
    // The observable was the done screen's hand-over button, which is gone. It
    // is the manual QUEUE itself now, which is the thing `manualHandled` was
    // ever able to withhold from.
    const meals = [{ id: 'm1', name: 'Tacos', ingredients: [chosen('sour cream'), chosen('fresh mint')] }];
    disableRail();
    const view = render(
      <WebViewCartSheet visible meals={meals as never} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });
    const drive = () => {
      act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
      post({ type: 'LOGIN_STATUS', isLoggedIn: true });
      post({ type: 'CART_COUNT', count: 0, items: [] });
      act(() => { jest.advanceTimersByTime(2_000); });
    };

    drive();
    // Both items are handed over; skip the first and finish on the second.
    expect(view.queryByText(/add it yourself \(1 of 2\)/i)).toBeTruthy();
    act(() => { fireEvent.press(view.getByTestId('manual-skip')); });
    act(() => { fireEvent.press(view.getByTestId('manual-skip')); });
    act(() => { jest.advanceTimersByTime(2_000); });
    expect(view.queryByTestId('manual-bar')).toBeNull();

    // Close and re-open the SAME sheet on the same ingredients.
    view.rerender(
      <WebViewCartSheet visible={false} meals={meals as never} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    act(() => { jest.advanceTimersByTime(500); });
    view.rerender(
      <WebViewCartSheet visible meals={meals as never} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    act(() => { jest.advanceTimersByTime(500); });
    drive();

    // Run 2 must hand over BOTH again. A `manualHandled` carried over from run 1
    // would silently withhold them.
    expect(view.queryByText(/add it yourself \(1 of 2\)/i)).toBeTruthy();
  });
});

describe('the hand-over survives what the store throws at it', () => {
  it('does not abandon the queue on an anti-bot status', () => {
    // The blocker screen offers exactly one button — "Try again" — and it
    // restarts the whole add pass over `activeItemsRef`, re-adding every item
    // that already landed on this run. Reachable only because 'manual' was
    // missing from handleHttpBlock's ignore list, which every other post-run
    // step is on.
    const view = assistedRun('sour cream', 'fresh mint');
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onHttpError({
        nativeEvent: { statusCode: 403, url: 'https://www.amazon.com/s?k=fresh%20mint' },
      });
    });
    expect(view.queryByTestId('manual-bar')).toBeTruthy();
    expect(view.queryByText(/try again/i)).toBeNull();
  });
});

describe('a probe still in flight when the user takes over', () => {
  it('does not let it write results for the screen they just left', () => {
    // A cart read can be mid-flight when manual mode starts. Its CART_COUNT then
    // lands DURING the pass, describing a cart from before the user touched it —
    // and, left alone, writes rows and a verdict from it.
    //
    // startManualMode drops the pending probe and its timeouts on the way in for
    // exactly this. That guard is what is under test; the route in has changed
    // (the done screen's offer is gone) but the hazard has not.
    const view = assistedRun('sour cream', 'fresh mint');
    expect(view.queryByTestId('manual-bar')).toBeTruthy();

    // A stale read arrives mid-pass.
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify({
          type: 'CART_COUNT', count: 1,
          items: [{ name: 'sour cream', qty: 1 }], url: 'https://amazon.test/cart',
        }) },
      });
    });
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });
    act(() => { fireEvent.press(view.getByTestId('manual-next')); });   // Finish

    // Nothing from that read may be on the screen: it is a snapshot of a cart
    // taken before the user added to it.
    expect(view.queryAllByText(/we checked your/i).length).toBe(0);
  });
});

describe('handing over when the rail cannot finish', () => {
  // The page-driven pool used to catch a failed rail and go on to add the items,
  // which is what "Taking a slower route / still working" described. That pool
  // is gone. What happens now is the user is handed the store's own search page
  // to add them by hand — so the copy has to say that, and the hand-over has to
  // land somewhere real.

  it('every rail store has a search page to hand over to', () => {
    // startManualMode returns false without one, and a hand-over that returns
    // false must route to the done screen rather than leaving the user on a
    // loading screen with nothing behind it.
    const { getStoreScripts } = require('../../src/lib/webview-scripts');
    const { ALBERTSONS_FAMILY_IDS } = require('../../src/lib/webview-scripts/albertsons');
    for (const id of ['heb', ...ALBERTSONS_FAMILY_IDS]) {
      const url = getStoreScripts(id)?.getSearchUrl?.('ginger root');
      expect(typeof url).toBe('string');
      expect(url).toContain('ginger');
    }
  });

});
