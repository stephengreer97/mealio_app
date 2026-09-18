// The run screen's "N of M added" counts CONFIRMED adds, never failures.

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
 * Stop a rail run mid-add and read the counter on the run screen.
 */
async function runAdding(adds: string[], results: boolean[]) {
  const view = render(
    <WebViewCartSheet visible
      meals={[{ id: 'm1', name: 'Fish Tacos', ingredients: adds.map(chosen) }] as never}
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
  post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://www.heb.com/cart' });
  act(() => { jest.advanceTimersByTime(2_000); });

  post(SESSION_OK);
  adds.forEach((name, i) => {
    post({ type: 'SEARCH_RESULT', source: 'network', term: name, candidates: [{
      productName: name, imageUrl: null, outOfStock: false, preferences: null,
      price: '$2', productId: `p${i}`, skuId: `s${i}`,
    }] });
  });
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: adds.length });
  results.forEach((ok, i) => {
    post({ type: 'NET_ADD_RESULT', idx: i, name: adds[i], success: ok,
           productId: `p${i}`, skuId: `s${i}`, reason: ok ? null : 'status 500' });
  });
  // The count ticks up to what was confirmed; each tick schedules the next from
  // its own re-render, so the clock is walked in beats rather than jumped.
  for (let i = 0; i < 30; i++) act(() => { jest.advanceTimersByTime(150); });
  return { view, post };
}

const countText = (view: ReturnType<typeof render>) =>
  (view.getByTestId('cart-run-count').props.children as unknown[]).join('');

describe('the count on the run screen', () => {
  it('counts only adds the store confirmed', async () => {
    const { view } = await runAdding(['Sour cream', 'Limes', 'Cabbage'], [true, false, true]);
    // Three decided, two added: the failure is not in the count, and no green
    // "All 3 in your cart" claims otherwise.
    expect(countText(view)).toBe('2 of 3 added');
    expect(view.queryByTestId('cart-run-done')).toBeNull();
  });

  it('does not count an item twice when it is written again', async () => {
    const { view, post } = await runAdding(['Sour cream', 'Limes'], [true, true]);
    post({ type: 'NET_ADD_RESULT', idx: 0, name: 'Sour cream', success: true });
    for (let i = 0; i < 30; i++) act(() => { jest.advanceTimersByTime(150); });
    expect(countText(view)).toBe('2 of 2 added');
  });

  it('says it is finding ingredients before any search has answered', async () => {
    // The heading used to follow netProgress, which is empty until the first
    // search answers, so a run still finding products said "Adding to your
    // cart" (seen on the Pixel, 2026-09-18).
    const view = render(
      <WebViewCartSheet visible
        meals={[{ id: 'm1', name: 'Fish Tacos', ingredients: ['Sour cream'].map(chosen) }] as never}
        storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    await act(async () => {});
    const post = (payload: Record<string, unknown>) => act(() => {
      view.queryAllByTestId('mock-webview')[0]?.props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
    });
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    act(() => { jest.advanceTimersByTime(2_000); });
    enableRail();
    const t = () => view.queryByTestId('cart-run-title')?.props.children ?? '(none)';
    const seen: string[] = [t()];
    post(SESSION_OK); seen.push(t());
    post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://www.heb.com/cart' }); seen.push(t());
    act(() => { jest.advanceTimersByTime(2_000); }); seen.push(t());
    post(SESSION_OK); seen.push(t());
    // Every point from the tap to the first search: none of it is adding yet.
    expect(seen).toEqual(Array(seen.length).fill('Finding your ingredients'));
  });

  it('names the meal under the heading', async () => {
    const { view } = await runAdding(['Sour cream'], []);
    expect(view.getByTestId('cart-run-subtitle').props.children).toBe('Fish Tacos');
    expect(view.getByTestId('cart-run-title').props.children).toBe('Adding to your cart');
  });
});
