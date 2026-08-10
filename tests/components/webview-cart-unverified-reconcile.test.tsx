// MEAL-190 — a reconcile that could not read the cart must SAY SO.
//
// There are two ways the reconcile fails to get a cart reading, and until this
// change they were reported asymmetrically:
//
//   • The probe never answers. triggerCartProbe's timeout fires and sets
//     "Couldn't verify your <store> cart".
//   • The probe answers "I cannot prove this page is the cart" — `count: null`
//     with NO `items`, which is exactly what the MEAL-152 page-identity guard
//     posts on a cart URL that redirected. That landed in the `!rows` branch,
//     which reconciles from the workers' own reports and went to the done screen
//     SILENTLY.
//
// The silent one is the likely one: the code's own comment calls that branch the
// EXPECTED outcome rather than a rarity, because MEAL-152 made a redirected cart
// page post no items by design. Stephen's 21:31 run hit the timeout half and was
// warned; the same run's prewarm hit the other half.
//
// Why it is worth a test rather than a glance. This is the state in which NOTHING
// can contradict the run: MEAL-185's multi-qty under-add, MEAL-187's unhydrated
// zero and MEAL-188's over-adding retry all report success on their own internal
// checks, and the cart diff is the only thing that ever disagreed with them. A
// run with no diff and no warning presents a guess as a verified result, which is
// the reporting half of "never over or under add".
//
// The observable is what the DONE SCREEN says, driven through a real parallel add
// pass — not the helper that formats the string. A test that asserted on the
// reconcile function would have passed before this change too.

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
      injectJavaScript: () => { ((globalThis as any).__injectedAt ||= []).push(Date.now()); },
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
      logAutomationStart: jest.fn(async () => 'run-flag-wiring'),
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
      takePrewarmedCart: () => null,
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

type Ing = { ingredientName: string; searchTerm?: string; productQty: number; qty: number; unit: string; measure: string | null };


const chosen = (name: string): Ing => ({
  ingredientName: name, searchTerm: name.toLowerCase(), productQty: 1, qty: 1, unit: 'qty', measure: null,
});

const sheet = (...ingredients: Ing[]) => (
  <WebViewCartSheet
    visible
    meals={[{ id: 'm1', name: 'Tacos', ingredients }] as never}
    storeId="heb"
    storeName="H-E-B"
    onClose={() => {}}
  />
);

beforeEach(() => {
  // Pre-search off so the run takes the parallel ADD pool, which is the path that
  // ends in finishParallelAdd -> triggerCartProbe('reconcile'). Pre-search commits
  // through the same reconcile, but parking adds a phase this test does not need.
  (globalThis as any).__flags = { presearchAdd: false, parallelAdd: true };
});

/**
 * Drive a parallel add pass to the reconcile, then answer the reconcile probe
 * with `answer`.
 *
 * Everything posted here is a message the store's own scripts really post. The
 * reconcile answer is the variable under test: one with `items` gives the diff a
 * cart to compare, one without is the MEAL-152 refusal.
 */
function runToReconcile(answer: Record<string, unknown>) {
  // ONE item on purpose. With two, the pool hands one to the cold slot (the main
  // WebView enlisted as an extra add surface) and only a single worker WebView
  // ever mounts, so the pool cannot settle without waiting out a 35s worker
  // timeout — which lands the reconcile after the test has finished. One item is
  // one worker, one report, and a pool that settles inside the test.
  const view = render(sheet(chosen('Sour Cream')));
  const postTo = (i: number, payload: Record<string, unknown>) => act(() => {
    view.queryAllByTestId('mock-webview')[i]?.props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });

  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  act(() => { jest.advanceTimersByTime(2_000); });
  postTo(0, { type: 'LOGIN_STATUS', isLoggedIn: true });
  // The before-snapshot: a real cart page with a real (empty) reading. This has
  // to succeed, or the run would be unverified for a different reason and the
  // test would prove nothing about the reconcile.
  postTo(0, { type: 'CART_COUNT', count: 0, items: [], url: 'https://www.heb.com/cart' });
  act(() => { jest.advanceTimersByTime(2_000); });

  // Every add worker reports back, which settles the pool and arms the reconcile.
  postTo(1, { type: 'WORKER_RESULT', phase: 'add', success: true, productName: 'Sour Cream' });
  act(() => { jest.advanceTimersByTime(5_000); });

  postTo(0, answer);
  act(() => { jest.advanceTimersByTime(2_000); });
  return view;
}

describe('reconcile that cannot read the cart (MEAL-190)', () => {
  it('warns when the cart page refuses to identify itself', () => {
    // `count: null` and NO `items` — verbatim what cartPathGuardJs posts when the
    // cart URL landed somewhere that is not the cart. Before this change the run
    // reconciled from its own worker reports and said nothing.
    const view = runToReconcile({
      type: 'CART_COUNT', count: null, reason: 'not_cart_page', url: 'https://www.heb.com/',
    });
    expect(view.queryByText(/couldn't verify your h-e-b cart/i)).toBeTruthy();
  });

  it('does not warn when the cart answered with rows', () => {
    // The other side of the rule: a reconcile that really did read the cart must
    // not carry an unverified warning, or the message means nothing.
    const view = runToReconcile({
      type: 'CART_COUNT', count: 1,
      items: [{ name: 'Sour Cream', qty: 1 }],
      url: 'https://www.heb.com/cart',
    });
    expect(view.queryByText(/couldn't verify your h-e-b cart/i)).toBeNull();
  });
});
