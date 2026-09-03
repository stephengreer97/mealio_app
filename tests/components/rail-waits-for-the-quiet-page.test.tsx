// TWO BUGS A DEVICE FOUND AND NO TEST HAD, both on the same ALDI run
// (2026-09-03). Stephen: "first test out the gate and login detection is not
// working for ALDI even though I am logged in".
//
// 1. A CHOOSE RUN WAS DENIED THE RAIL OVER THE ADD SWITCH. Capability was one
//    flag meaning "can search AND add", and a choose run writes to no cart. So
//    ALDI and Wegmans — search measured and on, write deliberately still off —
//    fell through to assisted and handed the user six manual searches each.
//
// 2. THE SESSION WAS ASKED OF about:blank. The run injects its session script
//    at start; everything that script does is same-origin, and the sheet had
//    only just set the WebView going at the quiet page. It answered
//    `no_response` 30ms later and the run handed over on the strength of it.
//    It was the login check — six seconds on a storefront nobody needed — that
//    had been hiding this, so fixing the first bug is what exposed the second.
//
// Both are asserted against the RAIL SEAM rather than ALDI's script, because
// neither cause was ALDI's: one is the strategy chooser, one is the run's
// start.

import { act, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

/** Records what is injected, which the plain view mock cannot: it drops the ref,
 *  so `webviewRef.current?.injectJavaScript` silently no-ops and a test asking
 *  "was the session script injected too early" would pass on a run that
 *  injected it every time. */
const injected: string[] = [];
jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: (js: string) => { injected.push(js); },
      reload: () => {},
      stopLoading: () => {},
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

beforeEach(() => { injected.length = 0; });
afterEach(() => __resetAutomationConfigForTests());

const unchosen = { id: 'm1', name: 'Quesadilla', ingredients: [
  { ingredientName: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
] };

/** ALDI as it actually ships: search on, add off while the write is unproven. */
function openAldi() {
  __applyAutomationConfigForTests({
    stores: { aldi: { networkSearch: true, networkAdd: false } },
  });
  const view = render(
    <WebViewCartSheet
      visible
      meals={[unchosen] as never}
      storeId="aldi"
      storeName="ALDI"
      onClose={() => {}}
    />,
  );
  const webview = () => view.getAllByTestId('mock-webview')[0];
  const post = (payload: Record<string, unknown>) => act(() => {
    webview().props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
  });
  const loadEnd = (url: string) => act(() => {
    webview().props.onLoadEnd({ nativeEvent: { url } });
  });
  return { ...view, post, loadEnd };
}

/** The Instacart session probe, by something only it carries. */
const isSession = (js: string) => js.includes('__mealioIC');

describe('a store whose search is on and whose add is off', () => {
  it('runs a choose on the rail instead of handing the user its search page', () => {
    const { post, loadEnd, queryByText } = openAldi();
    loadEnd('https://www.aldi.us/robots.txt');
    post({
      type: 'ALDI_SESSION', ok: true, loggedIn: true,
      cartId: '1', storeId: '8583', retailerId: '12', shoppingContext: 'delivery',
    });
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post({
      type: 'SEARCH_RESULT', source: 'network', term: 'sour cream',
      candidates: [{
        productName: 'Friendly Farms Sour Cream, 16 oz', imageUrl: null, outOfStock: false,
        preferences: null, price: '$1.65', productId: 'items_23898-1', skuId: null,
      }],
    });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
    expect(queryByText('Friendly Farms Sour Cream, 16 oz')).toBeTruthy();
  });
});

describe('the session is asked of the store, never of about:blank', () => {
  it('injects nothing until a store page has actually loaded', () => {
    openAldi();
    // The sheet has opened and the run has started; the WebView is on its way to
    // the quiet page and has arrived nowhere. Asking here is what produced the
    // `no_response` that ended the run.
    expect(injected.filter(isSession)).toHaveLength(0);
  });

  it('asks as soon as the quiet page lands', () => {
    const { loadEnd } = openAldi();
    loadEnd('https://www.aldi.us/robots.txt');
    expect(injected.filter(isSession).length).toBeGreaterThan(0);
  });

  it('still ignores a page that is not the store', () => {
    const { loadEnd } = openAldi();
    loadEnd('about:blank');
    expect(injected.filter(isSession)).toHaveLength(0);
  });
});
