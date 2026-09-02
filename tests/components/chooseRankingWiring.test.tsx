// MEAL-28: the choose screen really does show the ranked order.
//
// tests/unit/chooseRanking.test.ts proves rankChoiceCandidates orders correctly
// and tests/unit/match-harness.test.ts holds the corpus numbers, but both would
// keep passing if WebViewCartSheet stopped calling it — which is exactly the
// line a refactor drops. This drives a real SEARCH_RESULT into the sheet and
// reads the order back off the rendered list.

import { act, fireEvent, render } from '@testing-library/react-native';

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

// The pool mock lived here. It captured the pool's `onAllDone` so a test could
// call finishParallelSearch with a real result map instead of choreographing
// four worker WebViews. There is no pool; the rail's search batch feeds that same
// function, and the run below drives it end to end.


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
import { enableRail, SESSION_OK } from './helpers/railRun';

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
        storeId="heb"
        storeName="H-E-B"
        onClose={() => {}}
      />,
    );
    // A RAIL store, where it used to be ALDI. The Choose Products screen is fed
    // by a search, and after DOM automation was removed a store without a rail
    // has no search of its own to feed it — an assisted run hands the user the
    // store's search page and they pick there. So the screen still exists, on
    // the stores that can fill it. What is under test is the RANKING, which is
    // the same function whichever store asked.
    enableRail();
    post(SESSION_OK);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION_OK);
    post({
      type: 'SEARCH_RESULT', source: 'network', term: 'sour cream',
      candidates: storeOrder.map(candidate),
    });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });

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
// "MEAL-28 — the parallel choose path ranks too" lived here. It existed because
// there were TWO ways to reach the Choose screen — the sequential page walk and
// the parallel search pool — and only one of them ranked. Both are gone. The
// rail's search is the only path there is now, and the describe above is that
// path, so this one was asserting the same function twice.
