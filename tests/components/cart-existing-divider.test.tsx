// WHERE THE RUN'S WORK ENDS AND THE CART'S OWN CONTENTS BEGIN.
//
// Stephen, 2026-09-14: "For all stores, I want to see some text between the
// green and grey on the cart snapshot ending screen. It should be subtle, but
// it should simply inform the user that everything below (in grey) was already
// existing in the cart... There should be a horizontal line going out from
// either side of the text indicating a new section."
//
// diffCartItems returns green rows then grey ones, so the handover is the first
// row that is not `added`. Before this, the two halves ran together as one list
// and the grey half read as things Mealio had TRIED to add and failed.
//
// Kroger is not in scope and cannot be: its API has no cart read, so that sheet
// renders the green half only and has no boundary to mark. See
// kroger-done-screen.test.tsx, which holds that line.
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

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => {
  (globalThis as any).__flags = { presearchAdd: false, parallelAdd: true };
  (globalThis as any).__prewarm = null;
});

/**
 * Drive a rail run to the done screen against a cart that already held
 * `alreadyThere`, adding `adds`.
 */
async function runEnding(
  adds: string[],
  alreadyThere: Array<{ name: string; qty: number }>,
  /** The cart as it reads AFTER the run. Defaults to before plus every add. */
  afterOverride: Array<{ name: string; qty: number }> | null = null,
) {
  const view = render(
    <WebViewCartSheet visible
      meals={[{ id: 'm1', name: 'Tacos', ingredients: adds.map(chosen) }] as never}
      storeId="heb" storeName="H-E-B" onClose={() => {}} />,
  );
  await act(async () => {});
  const post = (payload: Record<string, unknown>) => act(() => {
    view.queryAllByTestId('mock-webview')[0]?.props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });

  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  act(() => { jest.advanceTimersByTime(2_000); });
  enableRail();
  post(SESSION_OK);
  // The before-baseline: what was in the cart when the run started.
  post({ type: 'CART_COUNT', count: alreadyThere.reduce((s, r) => s + r.qty, 0),
         items: alreadyThere, url: 'https://www.heb.com/cart' });
  act(() => { jest.advanceTimersByTime(2_000); });

  post(SESSION_OK);
  adds.forEach((name, i) => {
    post({ type: 'SEARCH_RESULT', source: 'network', term: name, candidates: [{
      productName: name, imageUrl: null, outOfStock: false, preferences: null,
      price: '$2', productId: `p${i}`, skuId: `s${i}`,
    }] });
  });
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: adds.length });
  adds.forEach((name, i) => {
    post({ type: 'NET_ADD_RESULT', idx: i, name, success: true,
           productId: `p${i}`, skuId: `s${i}`, reason: null });
  });
  const after = afterOverride ?? [...adds.map((name) => ({ name, qty: 1 })), ...alreadyThere];
  post({ type: 'NET_ADD_DONE', wrote: adds.length, count: adds.length,
         cartBefore: alreadyThere, cartAfter: after });
  act(() => { jest.advanceTimersByTime(5_000); });
  post({ type: 'CART_COUNT', count: after.reduce((s, r) => s + r.qty, 0),
         items: after, url: 'https://www.heb.com/cart' });
  act(() => { jest.advanceTimersByTime(2_000); });
  return view;
}

const HAD = [{ name: 'Milk', qty: 1 }, { name: 'Eggs', qty: 2 }];

describe('the line between what this run added and what was already there', () => {
  it('says the grey rows below it were already in the cart', async () => {
    const view = await runEnding(['Sour Cream'], HAD);
    expect(view.queryByText('Already in your cart')).toBeTruthy();
  });

  it('draws a rule out to either side of that text', async () => {
    const view = await runEnding(['Sour Cream'], HAD);
    const rule = view.getByTestId('cart-existing-divider');
    // One line each side of the label, and they share the row with it.
    const lines = rule.props.children.filter((c: any) => c?.props?.style?.height === 1);
    expect(lines).toHaveLength(2);
    expect(rule.props.style.flexDirection).toBe('row');
  });

  it('carries the grey rows own font and colour, not a heading of its own', async () => {
    // "Subtle" is the requirement. The label is the same family and colour the
    // grey rows use, so it reads as a label ON them rather than a new section
    // shouting for attention.
    const view = await runEnding(['Sour Cream'], HAD);
    const label = view.getByText('Already in your cart');
    expect(label.props.style.fontFamily).toBe('Inter_400Regular');
    const grey = view.getAllByTestId('cart-row-existing')[0];
    const greyText = grey.props.children.find((c: any) => c?.props?.numberOfLines === 2);
    expect(label.props.style.color).toBe(greyText.props.style.color);
  });

  it('sits exactly once, between the last green row and the first grey one', async () => {
    const view = await runEnding(['Sour Cream', 'Tortillas'], HAD);
    expect(view.getAllByTestId('cart-existing-divider')).toHaveLength(1);
    expect(view.getAllByTestId('cart-row-added')).toHaveLength(2);
    expect(view.getAllByTestId('cart-row-existing')).toHaveLength(2);
  });

  it('is absent when the run added everything in the cart', async () => {
    // Nothing was there before, so there is no second section to announce.
    const view = await runEnding(['Sour Cream'], []);
    expect(view.queryByTestId('cart-existing-divider')).toBeNull();
    expect(view.queryByText('Already in your cart')).toBeNull();
  });

  it('is absent when the run added nothing at all', async () => {
    // Every row is grey. A rule above the first one would be a boundary with
    // nothing on the other side of it.
    // A write the store refused because the line was already there
    // (`line_already_present`): the run reports success, and the cart reads
    // exactly as it did before. Every row the screen draws is grey.
    const view = await runEnding(['Milk'], HAD, HAD);
    // The screen must actually be drawing those grey rows, or this asserts on a
    // screen that was never rendered -- which is what the first version did.
    expect(view.getAllByTestId('cart-row-existing')).toHaveLength(2);
    expect(view.queryByTestId('cart-row-added')).toBeNull();
    expect(view.queryByTestId('cart-existing-divider')).toBeNull();
  });
});
