// MEAL-28: the choose screen really does show the ranked order.
//
// tests/unit/chooseRanking.test.ts proves rankChoiceCandidates orders correctly
// and tests/unit/match-harness.test.ts holds the corpus numbers, but both would
// keep passing if WebViewCartSheet stopped calling it — which is exactly the
// line a refactor drops. This drives a real SEARCH_RESULT into the sheet and
// reads the order back off the rendered list.

import { act, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  // Reached transitively via LoginPrewarmContext → AuthContext; the real module
  // pulls react-native-purchases' ESM dist, which this transform does not cover.
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

/** The live WebView props, so the test can fire onMessage. */
let mockWebViewProps: any = {};

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, _ref: any) => {
    mockWebViewProps = props;
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

// The parallel worker pool, replaced so the test can drive the completion
// callback directly. `start(items, onAllDone)` is where WebViewCartSheet hands
// over `finishParallelSearch`; capturing it lets a test call that function with
// a real result map instead of choreographing four worker WebViews.
let capturedOnAllDone: ((resultsByIdx: Map<number, any>) => void) | null = null;

jest.mock('../../src/lib/useParallelSearchPool', () => ({
  __esModule: true,
  useParallelSearchPool: () => ({
    workerUris: ['', '', '', ''],
    workerItems: [],
    isActive: false,
    completed: 0,
    total: 0,
    start: (_items: any[], onAllDone: (r: Map<number, any>) => void) => { capturedOnAllDone = onAllDone; },
    reportResult: jest.fn(),
    reset: jest.fn(),
  }),
}));

jest.mock('../../src/lib/api', () => ({
  kroger: { searchProducts: jest.fn(() => new Promise(() => {})) },
  meals: { update: jest.fn(() => new Promise(() => {})) },
  usage: {
    logAutomationStart: jest.fn(() => Promise.resolve(null)),
    logAutomationComplete: jest.fn(() => Promise.resolve(null)),
    logAutomationSteps: jest.fn(() => Promise.resolve(null)),
  },
}));

import WebViewCartSheet from '../../src/components/WebViewCartSheet';

// No searchTerm → "unchosen", which is what puts the sheet in the CHOOSE flow.
const unchosenMeal = {
  id: 'm1',
  name: 'Tacos',
  ingredients: [
    { ingredientName: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
} as any;

// Deliberately worst-first, the way a store returns them: the dip and the chips
// outrank the dairy in the store's own relevance order. This is walmart's and
// albertsons' real "sour cream" failure.
const DIP = 'Daisy Sour Cream Creamy Ranch Dip, 16 oz Tub';
const CHIPS = "Herr's Sour Cream & Onion Chips - 13 OZ";
const REAL = 'Daisy Sour Cream, 16 oz';

const candidate = (productName: string) => ({
  productName, imageUrl: null, outOfStock: false, preferences: null, price: '$3.49',
});

const post = (payload: any) => {
  act(() => {
    mockWebViewProps.onMessage?.({ nativeEvent: { data: JSON.stringify(payload) } });
  });
};

describe('MEAL-28 — the choose screen shows the ranked order', () => {
  /** The three candidate names as rendered, in on-screen (tree) order. */
  const renderChooseScreen = (storeOrder: string[]) => {
    const utils = render(
      <WebViewCartSheet
        visible
        meals={[unchosenMeal]}
        storeId="aldi"
        storeName="ALDI"
        onClose={() => {}}
      />,
    );
    post({ type: 'LOGIN_STATUS', isLoggedIn: true });
    post({ type: 'SEARCH_RESULT', candidates: storeOrder.map(candidate) });

    // queryAllByText returns matches in tree order, which is render order. The
    // broad regex is narrowed to the known names so an incidental match (the
    // "sour cream" heading, a price) cannot be mistaken for a candidate row.
    const known = new Set(storeOrder);
    return utils
      .queryAllByText(/Sour Cream/)
      .map((node) => String(node.props.children))
      .filter((text) => known.has(text));
  };

  it('renders all three candidates', () => {
    // Guards the test itself: if the sheet stopped reaching the choose screen,
    // the order assertions below would pass on an empty list.
    expect(renderChooseScreen([DIP, CHIPS, REAL])).toHaveLength(3);
  });

  it('puts the best match first, not the store-order first', () => {
    expect(renderChooseScreen([DIP, CHIPS, REAL])[0]).toBe(REAL);
  });

  it('ranks regardless of where the store put the best match', () => {
    // Same three products, every rotation of the store's order. The result must
    // not depend on the store's opinion at all.
    expect(renderChooseScreen([CHIPS, REAL, DIP])[0]).toBe(REAL);
    expect(renderChooseScreen([REAL, DIP, CHIPS])[0]).toBe(REAL);
  });
});

// The describe above drives the SEARCH_RESULT handler, which is the SEQUENTIAL
// choose path — and only aldi and wegmans take it. Every store with a worker
// pool (heb, walmart, albertsons, amazon) reaches the choose screen through
// finishParallelSearch instead, and walmart and albertsons are where most of
// the measured win comes from. Shipping the ranking on one path and measuring
// it on the other is exactly the gap this covers.
describe('MEAL-28 — the parallel choose path ranks too', () => {
  const renderParallelChooseScreen = (storeOrder: string[]) => {
    const utils = render(
      <WebViewCartSheet
        visible
        meals={[unchosenMeal]}
        storeId="walmart"
        storeName="Walmart"
        onClose={() => {}}
      />,
    );
    // walmart has getSearchUrl + buildWorkerScript and is not forceSerialSearch,
    // so beginSearchFlow routes an all-choose run to startParallelSearch, which
    // hands finishParallelSearch to the pool. It has a cart URL, so the
    // before-snapshot is gated in front of the search and CART_COUNT is what
    // releases it.
    post({ type: 'LOGIN_STATUS', isLoggedIn: true });
    post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://www.walmart.com/cart' });
    expect(capturedOnAllDone).toBeTruthy();
    act(() => {
      capturedOnAllDone!(new Map([[0, storeOrder.map(candidate)]]));
    });

    const known = new Set(storeOrder);
    return utils
      .queryAllByText(/Sour Cream/)
      .map((node) => String(node.props.children))
      .filter((text) => known.has(text));
  };

  beforeEach(() => { capturedOnAllDone = null; });

  it('reaches the choose screen with all three candidates', () => {
    expect(renderParallelChooseScreen([DIP, CHIPS, REAL])).toHaveLength(3);
  });

  it('puts the best match first', () => {
    expect(renderParallelChooseScreen([DIP, CHIPS, REAL])[0]).toBe(REAL);
    expect(renderParallelChooseScreen([CHIPS, REAL, DIP])[0]).toBe(REAL);
  });
});
