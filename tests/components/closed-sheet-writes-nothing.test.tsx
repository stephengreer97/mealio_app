// A closed cart sheet must never write to the user's cart.

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
import { __setNativeRunForTests, __resetNativeRunForTests } from '../../src/lib/native-rail';
import { NativeRunDriver, PostToSheet, __resetNativeRunForTests as resetGen } from '../../src/lib/native-rail/run';


const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => {
  (globalThis as any).__flags = { presearchAdd: false, parallelAdd: true };
  (globalThis as any).__prewarm = null;
});

/** What the fake driver was asked for, in order. */
let asked: string[] = [];
/** Lets the test decide when the search answers: the Pixel's close came mid-search. */
let releaseSearch: (() => void) | null = null;

function fakeDriver(): NativeRunDriver {
  return {
    id: 'fake',
    session: () => (post: PostToSheet) => { asked.push('session'); post(SESSION_OK); return Promise.resolve(); },
    cartRead: () => (post: PostToSheet) => {
      asked.push('cartRead');
      post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
      return Promise.resolve();
    },
    searchBatch: (terms) => async (post: PostToSheet) => {
      asked.push('search');
      await new Promise<void>((r) => { releaseSearch = r; });
      terms.forEach((term, i) => post({ type: 'SEARCH_RESULT', source: 'network', term, candidates: [{
        productName: term, imageUrl: null, outOfStock: false, preferences: null,
        price: '$2', productId: `p${i}`, skuId: `s${i}`,
      }] }));
      post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: terms.length });
    },
    addBatch: () => (post: PostToSheet) => {
      asked.push('add');
      post({ type: 'NET_ADD_DONE', count: 0, wrote: 0 });
      return Promise.resolve();
    },
  };
}

async function runWithSearchHeld(closeBeforeAnswer: boolean) {
  asked = [];
  releaseSearch = null;
  resetGen();
  __setNativeRunForTests(() => fakeDriver());
  enableRail();
  const meals = [{ id: 'm1', name: 'Tacos', ingredients: ['Sour cream', 'Limes'].map(chosen) }] as never;
  const view = render(
    <WebViewCartSheet visible meals={meals} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
  );
  await act(async () => {});
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  for (let i = 0; i < 10; i++) { act(() => { jest.advanceTimersByTime(300); }); await act(async () => {}); }
  expect(asked).toContain('search');

  // The user taps the X. The inline mount closes by going invisible.
  if (closeBeforeAnswer) {
    view.rerender(<WebViewCartSheet visible={false} meals={meals} storeId="heb" storeName="H-E-B" onClose={() => {}} />);
  }
  // The store answers anyway: the request was already on the wire.
  await act(async () => { releaseSearch?.(); });
  for (let i = 0; i < 20; i++) { act(() => { jest.advanceTimersByTime(300); }); await act(async () => {}); }
  view.unmount();
  __resetNativeRunForTests();
  return asked.filter((a) => a === 'add').length;
}

describe('closing the sheet mid-run', () => {
  it('writes nothing once the sheet is closed, even when the search answers after', async () => {
    expect(await runWithSearchHeld(true)).toBe(0);
  });

  it('the control: the same run left open does write', async () => {
    // Without this the test above would pass on a harness that never reached
    // the add step at all.
    expect(await runWithSearchHeld(false)).toBeGreaterThan(0);
  });
});
