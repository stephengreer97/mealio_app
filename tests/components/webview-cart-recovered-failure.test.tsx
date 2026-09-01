// The done screen must not tell the user an item failed while its own cart read
// says the item is there (MEAL-177).
//
// "Could not add: X" is the ONLY place a user is ever told an item failed. There
// is no live per-item failure rail, and the mid-run "Items Not Added" gate
// carries search failures, which are held out of the intended set and can never
// come back as a recovery. So the old cart-check sentence — "N items we reported
// as not added are in your cart already" — was either a rebuttal of the line
// printed directly above it, or a correction to a claim that named nothing at
// all (the nothing-added branch, which is the LIKELIER one for a recovery: a
// stale badge tends to fail the whole run).
//
// The fix is to correct the claim, not to print a correction under it. What is
// asserted here is therefore what the SCREEN says at the end of a real run — a
// test against auditCartAfterRun would have passed before this change too, since
// the finding was already correct and only the rendering lied.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: () => {}, stopLoading: () => {}, goBack: () => {}, reload: () => {},
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

// The run posts its own telemetry. Unstubbed this file would POST a real
// automation run to mealio.co on every jest run — a row of production usage data
// per test, and a suite that fails when the box is offline.
jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'run-recovered-failure'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});

// Serial route, so the run is driven by the messages this test posts rather than
// by a worker pool — and, more to the point, so it finishes WITHOUT setting
// reconcileFinalizedRef. The after-probe (the only probe that produces a
// `recovered` finding) is skipped on any run the parallel reconcile finalized.
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
import { enableRail, SESSION_OK } from './helpers/railRun';

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

// The title as it appears in BOTH the search result and the cart row.
//
// It used to differ between the two — search term 'tortillas', cart row
// 'H-E-B Bakery Corn Tortillas, 30 ct' — which only made sense while the audit
// matched on 60% token overlap. The add path finds a product card by EXACT
// name, so the title that reaches the cart is the term we searched for, and the
// audit compares them as equals (MEAL-199). A cart row bearing a different
// title is a different product, and is now reported as one.
const TORTILLAS = 'tortillas';

/**
 * Drive a two-item serial run — one add confirmed, one reported failed — to the
 * done screen, then answer the after-probe with `cartRows`.
 *
 * Every message is one the store's own scripts really post. `cartRows` is the
 * variable under test: the cart either holds the failed item (a worker false
 * negative) or it does not (a real failure).
 */
async function runToDoneScreen(cartRows: Array<{ name: string; qty: number }>) {
  const view = render(sheet(chosen('sour cream'), chosen('tortillas')));
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });

  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  // logAutomationStart is a round trip and no timer advance delivers it; the run
  // holds a null runId until the microtask queue is flushed.
  await act(async () => {});
  enableRail();
  post(SESSION_OK);
  // The before-snapshot. It has to succeed: with no baseline there is no
  // after-probe at all (shouldProbeAfterRun), and the test would prove nothing.
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post(SESSION_OK);

  // Both items are searched before either is written. Exact matches, so each is
  // written rather than routed to review.
  for (const productName of ['sour cream', 'tortillas']) {
    post({
      type: 'SEARCH_RESULT', source: 'network', term: productName,
      candidates: [{
        productName, imageUrl: null, outOfStock: false, preferences: null, price: '$2',
        productId: 'p' + productName, skuId: 's' + productName,
      }],
    });
  }
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });
  // The sour cream lands. The tortillas report a failure — and are in the cart
  // anyway, if the caller says so. That contradiction is the whole subject.
  post({ type: 'NET_ADD_RESULT', idx: 0, name: 'sour cream', success: true, productId: 'psour cream', skuId: 'ssour cream', reason: null });
  post({ type: 'NET_ADD_RESULT', idx: 1, name: 'tortillas', success: false, productId: 'ptortillas', skuId: 'stortillas', reason: 'cart_not_incremented' });
  post({ type: 'NET_ADD_DONE', wrote: 2, count: 2, cartBefore: [], cartAfter: [{ name: 'sour cream', qty: 1 }] });
  act(() => { jest.advanceTimersByTime(5_000); });

  // THE RECONCILE STILL BELIEVES THE RUN. Its cart read shows only the item that
  // reported success, so the tortillas are short — it tops them up, and that is
  // refused too. The run therefore reaches the done screen calling them failed,
  // which is the state this whole file is about. The after-probe below is what
  // disproves it.
  post({ type: 'CART_COUNT', count: 1, items: [{ name: 'sour cream', qty: 1 }], source: 'network' });
  post({ type: 'NET_ADD_RESULT', idx: 1, name: 'tortillas', success: false, productId: 'ptortillas', skuId: 'stortillas', reason: 'cart_not_incremented' });
  post({ type: 'NET_ADD_DONE', wrote: 1, count: 1, cartBefore: [{ name: 'sour cream', qty: 1 }], cartAfter: [{ name: 'sour cream', qty: 1 }] });
  act(() => { jest.advanceTimersByTime(5_000); });

  // The after-probe's reading of the real cart.
  post({
    type: 'CART_COUNT',
    count: cartRows.reduce((n, r) => n + r.qty, 0),
    items: cartRows,
    source: 'network',
  });
  act(() => { jest.advanceTimersByTime(2_000); });
  return view;
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

describe('a failure the cart disproves', () => {
  const recoveredRun = () => runToDoneScreen([
    { name: 'sour cream', qty: 1 },
    { name: TORTILLAS, qty: 1 },
  ]);

  it('stops naming the item under "Could not add"', async () => {
    const view = await recoveredRun();
    expect(view.queryByText(/could not add.*tortillas/i)).toBeNull();
  });

  it('drops the failure count with it, rather than falling back to a bare tally', async () => {
    // `totalFailed` alone gates the line, and the line falls back to
    // "N items could not be added" when there are no names. Correcting the names
    // and not the count would re-print exactly the claim this ticket removes,
    // with the item's name taken off it.
    const view = await recoveredRun();
    expect(view.queryByText(/could not (add|be added)/i)).toBeNull();
  });

  it('says the cart has it, in the cart’s own voice', async () => {
    // Reworded by MEAL-199 rather than removed.
    //
    // The old sentence — "Tortillas is already in your cart — don't add it
    // again" — was a rebuttal: the item had been called failed by the RUN, so
    // the cart had to talk the user out of re-adding it. The failed list is read
    // off the cart now, so nothing calls it failed and there is no claim to
    // take back. But silence would be wrong too: the headline is still the run's
    // confirmed count, and on a fully-recovered run it says nothing was added.
    // So the cart states the positive finding instead of rebutting a negative.
    const view = await recoveredRun();
    expect(view.queryByText(/everything you asked for is there/i)).toBeTruthy();
    // queryAllByText, not queryByText: the item is legitimately on this screen
    // twice — once in this sentence and once in the per-line breakdown below it.
    expect(view.queryAllByText(new RegExp(TORTILLAS, 'i')).length).toBeGreaterThan(0);
    // Not "we added it": a recovery is a name match against a row (MEAL-177).
    expect(view.queryByText(/we added|mealio added/i)).toBeNull();
  });

  it('no longer cites a report the user was never shown', async () => {
    // The wording Stephen stopped on: it referred to somewhere the user had been
    // told the item failed, and there is no such place other than the line this
    // change now corrects.
    const view = await recoveredRun();
    expect(view.queryByText(/we reported as not added/i)).toBeNull();
  });

  it('does not credit the recovery as an add', async () => {
    // The headline is the RUN's claim about what it put in the cart. A recovery
    // is a name match against a cart row — enough to stop calling the item
    // failed, not enough to claim this run added it (see RecoveredAdd's
    // matchQuality). One add was confirmed, so the headline stays at one.
    const view = await recoveredRun();
    expect(view.queryByText(/1 item added to your H-E-B cart/i)).toBeTruthy();
  });
});

describe('a failure the cart confirms', () => {
  // The other side of the rule. If the correction fired on a cart that has
  // nothing for the item, the user is never told it failed and goes to checkout
  // without it — the same silence in the opposite direction.
  const genuineRun = () => runToDoneScreen([{ name: 'sour cream', qty: 1 }]);

  it('still names the item to the user', async () => {
    // The safety property this describe block exists for, unchanged: an item the
    // cart genuinely does not have MUST be named, or the user checks out without
    // it and never learns why.
    //
    // Where it is named moved (MEAL-199). It used to be the "Could not add" line,
    // sourced from the run; it is now the cart-check message, sourced from the
    // cart read that is the only thing entitled to call an item absent. The
    // assertion follows the guarantee rather than the sentence that used to
    // carry it.
    const view = await genuineRun();
    expect(view.queryByText(/could not add.*tortillas/i)).toBeTruthy();
  });

  it('claims nothing about it being in the cart', async () => {
    const view = await genuineRun();
    expect(view.queryByText(/already in your cart/i)).toBeNull();
  });
});
