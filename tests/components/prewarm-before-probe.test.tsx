// The before-probe paths, which nothing could reach until now (MEAL-158).
//
// Every component test stubs `takePrewarmedCart: () => null`, so the branch that
// CONSUMES a prewarmed cart had never been executed by a test — and that is the
// branch MEAL-152 fixed blind. Its bug: a prewarm that never managed to count
// still looked like a baseline, so the run consumed it, skipped its own
// before-probe, and ended with no baseline at all. No baseline means
// shouldProbeAfterRun is false, which means the entire cart check is silently
// offline for that run — on exactly the runs where the prewarm was already
// struggling.
//
// The observable here is deliberately the DONE SCREEN, not a ref or a log line.
// "The run could not check your cart" is the thing the user is or is not told,
// and it is what the bug actually cost. A test that asserted on
// cartCountBeforeRef would have passed before the fix and after it.
//
// `__prewarm` is what makes the branch reachable: the mock below reads it, so a
// test can hand the sheet a counted cart, an uncounted one, or nothing.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  // A ref that records WHEN each script is injected. The other cart tests hand
  // back no ref at all, so `injectJavaScript` is a no-op there and nothing sees
  // the scripts — and the pre-search commit's delay is the one flag effect that
  // is only visible here.
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: () => {},
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

jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'run-unverified-reconcile'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});

// Signed in, so the pre-search effect can get past its login gate. Same reason
// and same shape as `webview-cart-selector-health.test.tsx`.
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      checkStore: () => {},
      getStatus: () => 'loggedIn',
      takePrewarmedCart: () => (globalThis as any).__prewarm ?? null,
      statusVersion: 1,
    }),
  };
});

// The config the sheet reads, overridable per test. The REAL merge and bundled
// defaults underneath — only the flags block is swapped, so a test cannot
// accidentally assert against a config shape that could never ship.
jest.mock('../../src/lib/automation-config', () => {
  const actual = jest.requireActual('../../src/lib/automation-config');
  return {
    ...actual,
    getAutomationConfig: () => {
      const base = actual.getAutomationConfig();
      return { ...base, flags: { ...base.flags, ...((globalThis as any).__flags ?? {}) } };
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

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => {
  (globalThis as any).__flags = { presearchAdd: false, parallelAdd: true };
  (globalThis as any).__prewarm = null;
});
afterEach(() => { (globalThis as any).__prewarm = null; });

/**
 * Drive a run from mount through snapshotBeforeAndBeginSearch to the done
 * screen, with the prewarm cache under the test's control.
 *
 * @param prewarm what takePrewarmedCart hands back — a counted cart, an
 *        uncounted one, or null.
 * @param beforeAnswer a CART_COUNT to answer the run's OWN before-probe with,
 *        or null to leave the probe unanswered. Passing one when the prewarm was
 *        consumed is harmless: nothing asked, so nothing is listening.
 */
async function runWithPrewarm(
  prewarm: Record<string, unknown> | null,
  beforeAnswer: Record<string, unknown> | null,
) {
  (globalThis as any).__prewarm = prewarm;
  const view = render(sheet(chosen('Sour Cream')));
  await act(async () => {});
  const postTo = (i: number, payload: Record<string, unknown>) => act(() => {
    view.queryAllByTestId('mock-webview')[i]?.props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });

  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  act(() => { jest.advanceTimersByTime(2_000); });
  enableRail();
  postTo(0, SESSION_OK);
  if (beforeAnswer) {
    postTo(0, beforeAnswer);
    act(() => { jest.advanceTimersByTime(2_000); });
  } else {
    // Let the before-probe actually TIME OUT (cartProbeMs is 10s) rather than
    // leaving it pending. A pending probe is not the same state as a failed one:
    // it would swallow the after-probe's answer as its own and hand the run a
    // baseline it never earned — which is how the first version of this test
    // fooled itself. Kept under the 20s worker budget so the pool still settles.
    act(() => { jest.advanceTimersByTime(11_000); });
  }

  // The run's own session read, then the search and the write — all on the one
  // WebView, because a rail run has no workers.
  postTo(0, SESSION_OK);
  postTo(0, {
    type: 'SEARCH_RESULT', source: 'network', term: 'Sour Cream',
    candidates: [{
      productName: 'Sour Cream', imageUrl: null, outOfStock: false, preferences: null,
      price: '$2', productId: 'p1', skuId: 's1',
    }],
  });
  postTo(0, { type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
  postTo(0, {
    type: 'NET_ADD_RESULT', idx: 0, name: 'Sour Cream', success: true,
    productId: 'p1', skuId: 's1', reason: null,
  });
  postTo(0, {
    type: 'NET_ADD_DONE', wrote: 1, count: 1,
    cartBefore: [], cartAfter: [{ name: 'Sour Cream', qty: 1 }],
  });
  act(() => { jest.advanceTimersByTime(5_000); });
  // The after/reconcile probe. Answering it with rows is what lets the cart
  // check succeed — IF the run kept a baseline to diff against.
  postTo(0, {
    type: 'CART_COUNT', count: 1,
    items: [{ name: 'Sour Cream', qty: 1 }],
    url: 'https://www.heb.com/cart',
  });
  act(() => { jest.advanceTimersByTime(2_000); });
  return view;
}

// Both carry the SAME cart contents. Only `count` differs, which is the whole
// of MEAL-152: `isCountedCartSnapshot` is what tells a real baseline from a
// prewarm that never managed to count one.
const CART = [{ name: 'Sour Cream', qty: 1 }];
const COUNTED = { count: 1, items: CART, url: 'https://www.heb.com/cart' };
const UNCOUNTED = { count: null, items: CART, url: 'https://www.heb.com/cart' };

/**
 * What the run believes it ADDED, which is the only observable that separates a
 * consumed prewarm from a refused one.
 *
 * The after-probe reports the cart holding one Sour Cream either way. Whether
 * that reads as "we added it" depends entirely on what the baseline said was
 * there BEFORE — so this number is the baseline, seen from the outside.
 */
const addedHeadline = (view: any) =>
  view.queryByText(/1 item added to your h-e-b cart/i) ? 1 : 0;

describe('the before-probe, with a prewarmed cart (MEAL-158)', () => {
  it('consumes a counted prewarm as the baseline', async () => {
    // The prewarm says the Sour Cream was ALREADY in the cart. Nothing answers a
    // before-probe, because a consumed prewarm means the run never asks for one.
    // The after-probe then finds one Sour Cream — the same one — so the run
    // added nothing, and must not claim otherwise.
    const view = await runWithPrewarm(COUNTED, null);
    expect(addedHeadline(view)).toBe(0);
  });

  it('refuses an UNCOUNTED prewarm and falls back to its own probe', async () => {
    // MEAL-152's bug, seen from the outside, and the reason this harness exists.
    //
    // The prewarm carries the same cart but no count, so it is NOT a baseline.
    // The run must ask for its own — answered here with an EMPTY cart — and the
    // after-probe then finds one Sour Cream, which really was added by this run.
    //
    // Consume the uncounted prewarm instead (the pre-MEAL-152 behaviour) and the
    // baseline says the Sour Cream was always there, so the run reports adding
    // nothing. That is the discriminator: same messages in, different headline.
    const view = await runWithPrewarm(UNCOUNTED, {
      type: 'CART_COUNT', count: 0, items: [], url: 'https://www.heb.com/cart',
    });
    expect(addedHeadline(view)).toBe(1);
  });

  // NOT COVERED HERE, deliberately: the case where the prewarm is refused AND
  // the run's own probe also times out, leaving no baseline at all. The run
  // still reconciles — WebViewCartSheet:3045 is explicit that this is safe for
  // the cart, since re-adding is what a missing baseline would cause and
  // reconcile does not do that — and marks the metric `worker_reports` rather
  // than claiming to be cart-backed. That flag rides on the funnel rows, which
  // this harness does not flush, so asserting it here would have meant faking
  // the observable. I first wrote this case expecting a "couldn't verify"
  // banner on screen and was wrong; the user is not warned, by design.
  it('takes its own baseline when there is no prewarm at all', async () => {
    const view = await runWithPrewarm(null, {
      type: 'CART_COUNT', count: 0, items: [], url: 'https://www.heb.com/cart',
    });
    expect(addedHeadline(view)).toBe(1);
  });
});
