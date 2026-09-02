// The search prewarm: look the ingredients up while the user is still deciding
// quantities, so the run does not spend that time on the critical path.
//
// Measured across 34 of Stephen's runs, the search costs 97ms per term — 0.8s at
// eight items, 1.7s at eighteen. It is the one phase that can move, because a
// quantity changes what gets WRITTEN and never what gets looked up.
//
// The claim worth testing is not that it fires. It is that the RUN then does not
// search again: asking twice would double this run's search volume against the
// operation most likely to be shaped, which would make the prewarm a cost rather
// than a saving.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(), identifyUser: jest.fn(async () => {}), resetUser: jest.fn(async () => {}),
}));

const injected: string[] = [];
jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: (s: string) => { (global as any).__injected.push(s); },
      reload: () => {},
    }));
    return RealReact.createElement(RealView, { testID: props.testID || 'mock-webview', ...props });
  });
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});
(global as any).__injected = injected;

jest.mock('expo-image', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return { Image: (p: any) => RealReact.createElement(RealView, { testID: 'mock-image', ...p }) };
});
jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return { Ionicons: (p: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, p.name) };
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

// A prewarm that already knows the user is signed in — the gate the effect
// checks, because a probe at a signed-out page answers nothing.
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      getStatus: () => 'loggedIn',
      statusVersion: 1,
      checkStore: () => {},
      takePrewarmedCart: () => null,
      noteSignedOut: () => {},
    }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { __applyAutomationConfigForTests, __resetAutomationConfigForTests } from '../../src/lib/automation-config';

afterEach(() => { __resetAutomationConfigForTests(); injected.length = 0; });

const meal = {
  id: 'm1', name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
    { ingredientName: 'Tortillas', searchTerm: 'tortillas', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
};

const candidate = (productName: string) => ({
  productName, imageUrl: null, outOfStock: false, preferences: null, price: '$2',
  productId: 'p' + productName, skuId: 's' + productName,
});

function openSheet() {
  __applyAutomationConfigForTests({
    stores: { heb: { networkSearch: true, networkAdd: true, cartSkuConfirm: true } },
  });
  const view = render(
    <WebViewCartSheet visible meals={[meal] as never} storeId="heb" storeName="H-E-B" onClose={() => {}} />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
  // The prewarm runs when the store page has LOADED — the session probe reads a
  // bootstrap object the page publishes, so there is nothing to ask before then.
  const load = (url = 'https://www.heb.com/') => act(() => {
    // The MAIN cell is the one with an onLoadEnd; the others are pool tiles.
    const wv = view.queryAllByTestId('mock-webview').find((w: any) => !!w.props.onLoadEnd);
    wv?.props?.onLoadEnd?.({ nativeEvent: { url } });
  });
  return { view, post, load };
}

const SESSION = {
  type: 'HEB_SESSION', ok: true, loggedIn: true,
  storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY',
};

/** How many search batches have been injected so far. */
const searchBatches = () => injected.filter((s) => s.includes('productSearchPageV2')).length;

describe('the search prewarm', () => {
  it('searches from the qty screen, before the user taps anything', () => {
    const { post, load } = openSheet();
    load();
    post(SESSION);
    expect(searchBatches()).toBe(1);
  });

  it('does NOT search again for a term it already answered', () => {
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('sour cream')] });
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'tortillas', candidates: [candidate('tortillas')] });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 2 });
    const beforeTap = searchBatches();

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);

    // The run went STRAIGHT to writing. A second batch here is the failure this
    // test exists for: it would double the run's search volume.
    expect(searchBatches()).toBe(beforeTap);
    expect(injected.some((s) => s.includes('cartItemV2'))).toBe(true);
  });

  it('searches only what the prewarm MISSED, not everything again', () => {
    const { view, post, load } = openSheet();
    load();
    post(SESSION);
    // Only one of the two came back before the user tapped.
    post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates: [candidate('sour cream')] });
    const beforeTap = searchBatches();

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post(SESSION);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION);

    // One more batch, and it asks for the missing term ONLY.
    expect(searchBatches()).toBe(beforeTap + 1);
    const last = injected.filter((s) => s.includes('productSearchPageV2')).pop()!;
    expect(last).toContain('tortillas');
    expect(last).not.toContain('sour cream');
  });

  it('does not prewarm a store with no rail', () => {
    __resetAutomationConfigForTests();
    render(
      <WebViewCartSheet visible meals={[meal] as never} storeId="walmart" storeName="Walmart" onClose={() => {}} />,
    );
    // Walmart is assisted: there is no rail to ask, and nothing should be
    // injected speculatively into a page the user is about to drive.
    expect(searchBatches()).toBe(0);
  });
});
