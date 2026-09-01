// Choose Products, on the two stores that can serve it.
//
// The screen is FED by a search: it shows the candidates a store returned and
// asks the user which one they meant. After DOM automation was removed
// (2026-09-01) a store without a rail has no search of its own — an assisted run
// hands the user the store's own search page and they pick there — so the screen
// exists exactly where a rail does, and Stephen's call is that this means H-E-B
// and the Albertsons family.
//
// Both are covered here rather than only H-E-B, because they are different
// protocols behind one interface: H-E-B answers in GraphQL, Albertsons in REST
// behind Azure API Management. The route that fills this screen has to be the
// rail's, not one store's.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, _ref: any) =>
    RealReact.createElement(RealView, { testID: props.testID || 'mock-webview', ...props }));
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
import { __applyAutomationConfigForTests, __resetAutomationConfigForTests } from '../../src/lib/automation-config';

afterEach(() => __resetAutomationConfigForTests());

/** No searchTerm — that is what makes an ingredient "unchosen", and a run of
 *  nothing but unchosen ingredients a CHOOSE run. */
const unchosen = { id: 'm1', name: 'Tacos', ingredients: [
  { ingredientName: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
] };

const candidate = (productName: string) => ({
  productName, imageUrl: null, outOfStock: false, preferences: null, price: '$2',
  productId: 'p' + productName, skuId: 's' + productName,
});

/** Both rails answer the SAME message type for a session, and the sheet routes
 *  on it — which is the point of NETWORK_SESSION_MESSAGE_TYPES. */
const SESSIONS: Record<string, Record<string, unknown>> = {
  heb: { type: 'HEB_SESSION', ok: true, loggedIn: true, storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY' },
  safeway: { type: 'ALB_SESSION', ok: true, loggedIn: true, storeId: '1234', shoppingContext: 'DELIVERY' },
};

function chooseRun(storeId: string, storeName: string, names: string[]) {
  // Both rails on. H-E-B additionally needs cartSkuConfirm, which is what makes
  // its write verifiable; Albertsons verifies from the write's own response.
  __applyAutomationConfigForTests({
    stores: {
      heb: { networkSearch: true, networkAdd: true, cartSkuConfirm: true },
      albertsons: { networkSearch: true, networkAdd: true },
    },
  });
  const view = render(
    <WebViewCartSheet
      visible
      meals={[unchosen] as never}
      storeId={storeId}
      storeName={storeName}
      onClose={() => {}}
    />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });

  // No "Add ingredients" tap: a run whose ingredients are all unchosen SKIPS the
  // qty step and starts itself, because there is nothing to set a quantity on
  // until a product is picked.
  post(SESSIONS[storeId]);
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post(SESSIONS[storeId]);
  // A choose run searches by INGREDIENT NAME — there is no searchTerm yet, which
  // is the whole reason it is a choose.
  post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: names.map(candidate) });
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
  return view;
}

describe('Choose Products runs on the rail', () => {
  it.each([['heb', 'H-E-B'], ['safeway', 'Safeway']])(
    '%s fills the choose screen from its own rail, adding nothing',
    (storeId, storeName) => {
      const view = chooseRun(storeId, storeName, ['Daisy Sour Cream', 'Store Brand Sour Cream']);
      // Every candidate the rail returned is offered...
      expect(view.queryByText('Daisy Sour Cream')).toBeTruthy();
      expect(view.queryByText('Store Brand Sour Cream')).toBeTruthy();
      // ...and NOTHING was added on the way. A choose run asks; it does not buy.
      expect(view.queryByText(/added to your/i)).toBeNull();
    },
  );

  it('asks Albertsons in its OWN protocol, not H-E-B\'s', () => {
    // The guard against the rail seam collapsing to one store: an ALB_SESSION is
    // what Albertsons answers with, and a run that only understood HEB_SESSION
    // would sit on the login check forever.
    const view = chooseRun('safeway', 'Safeway', ['Lucerne Sour Cream']);
    expect(view.queryByText('Lucerne Sour Cream')).toBeTruthy();
  });

  it('does NOT reach the choose screen on a store with no rail', () => {
    // Walmart is assisted. There is no search of ours to fill this screen, so the
    // run hands the user the store's own search page instead — which is a
    // different screen, and the point of the split.
    const view = render(
      <WebViewCartSheet
        visible
        meals={[unchosen] as never}
        storeId="walmart"
        storeName="Walmart"
        onClose={() => {}}
      />,
    );
    expect(view.queryByText('Daisy Sour Cream')).toBeNull();
  });
});
