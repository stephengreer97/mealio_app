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

/**
 * A PREWARM THAT HAS ALREADY PROVEN THE LOGIN, which is the state the bug needs
 * and the state a real phone is almost always in: the probe runs when the store
 * tab is tapped, long before the sheet opens.
 *
 * Without this the sheet falls to its own login check, that check injects the
 * SAME session script one load later, and a test watching for "was the session
 * asked too early" sees that injection and passes no matter what the run did.
 * The first version of this file did exactly that and survived the mutant.
 */
let mockPrewarmedCart: { count: number | null; items: unknown[] } | null = null;
/** Candidates the SEARCH prewarm already has, keyed by term. */
let mockPrewarmedSearch: Map<string, unknown[]> = new Map();
jest.mock('../../src/context/LoginPrewarmContext', () => ({
  useLoginPrewarm: () => ({
    getStatus: () => 'loggedIn',
    takePrewarmedCart: () => mockPrewarmedCart,
    getSearchResults: () => mockPrewarmedSearch,
    setSearchTerms: () => {},
    checkStore: () => {},
    statusVersion: 0,
  }),
  LoginPrewarmProvider: ({ children }: any) => children,
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
import { __applyAutomationConfigForTests, __resetAutomationConfigForTests } from '../../src/lib/automation-config';

beforeEach(() => {
  injected.length = 0;
  mockPrewarmedCart = null;
  mockPrewarmedSearch = new Map();
});
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

// EVERY Instacart rail script shares a prelude, so `__mealioIC` matches all
// three of them. The first version of this file keyed on it and could not tell
// the session ask from the cart read that precedes it — which is the difference
// the tests below are entirely about. Key on what each script POSTS instead.
const isSession = (js: string) => js.includes('ALDI_SESSION');
const isCartRead = (js: string) => js.includes('CART_COUNT');

describe('a store whose search is on and whose add is off', () => {
  it('runs a choose on the rail instead of handing the user its search page', () => {
    const { post, loadEnd, queryByText } = openAldi();
    // The real order, as the device log has it: the baseline is read first, and
    // the run asks for the session only once it has one.
    loadEnd('https://www.aldi.us/robots.txt');
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    loadEnd('https://www.aldi.us/robots.txt');
    post({
      type: 'ALDI_SESSION', ok: true, loggedIn: true,
      cartId: '1', storeId: '8583', retailerId: '12', shoppingContext: 'delivery',
    });
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

describe('a rail script is asked of the store, never of about:blank', () => {
  // The cart read comes FIRST in a run — the baseline is taken, then the search
  // flow begins — so on a cold open it is the script that meets about:blank.
  // The session ask is a few milliseconds behind it. Both are same-origin and
  // both were ungated.
  it('reads no cart until a store page has actually loaded', () => {
    openAldi();
    expect(injected.filter(isCartRead)).toHaveLength(0);
  });

  it('asks no session until a store page has actually loaded', () => {
    openAldi();
    expect(injected.filter(isSession)).toHaveLength(0);
  });

  it('reads the cart as soon as the quiet page lands', () => {
    const { loadEnd } = openAldi();
    loadEnd('https://www.aldi.us/robots.txt');
    expect(injected.filter(isCartRead).length).toBeGreaterThan(0);
  });

  it('gets to the session on ONE page load, not two', () => {
    // The quiet page loads ONCE. The first version of this test fired a second
    // load after the cart answered and passed on the strength of it — while the
    // real run, with only the one load it actually gets, waited out its whole
    // 20s session budget and handed the user six manual searches.
    //
    // What made it possible: `lastLoadEndUrlRef` is written per-branch in
    // onLoadEnd rather than once at the top, and the branch that ran the
    // deferred cart read returned without writing it. So the store had landed,
    // and nothing that ran afterwards could tell.
    const { loadEnd, post } = openAldi();
    loadEnd('https://www.aldi.us/robots.txt');
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    expect(injected.filter(isSession).length).toBeGreaterThan(0);
  });

  // THE PATH THE DEVICE ACTUALLY TOOK, and the only one that reaches the
  // session ask cold. With a prewarmed baseline there is no cart read to wait
  // on: the run skips straight from the baseline to the search flow, and the
  // session ask is the first script it injects — three milliseconds after the
  // sheet opened, with the quiet page still 2.5s away.
  //
  // Without this case the session's own gate is unreachable from a test, because
  // the gated cart read in front of it has already forced a load to land.
  describe('when the prewarm already has the baseline', () => {
    it('still asks no session until a store page has loaded', () => {
      mockPrewarmedCart = { count: 0, items: [] };
      openAldi();
      expect(injected.filter(isCartRead)).toHaveLength(0);
      expect(injected.filter(isSession)).toHaveLength(0);
    });

    it('asks as soon as the quiet page lands', () => {
      mockPrewarmedCart = { count: 0, items: [] };
      const { loadEnd } = openAldi();
      loadEnd('https://www.aldi.us/robots.txt');
      expect(injected.filter(isSession).length).toBeGreaterThan(0);
    });
  });

  it('ignores a page that is not the store', () => {
    const { loadEnd } = openAldi();
    loadEnd('about:blank');
    expect(injected.filter(isCartRead)).toHaveLength(0);
    expect(injected.filter(isSession)).toHaveLength(0);
  });
});


describe('a choose run stops at the choose screen', () => {
  // The rail's job on a choose run ends with the candidates: the user picks, so
  // nothing is written. That fork lived only at the end of a search batch, and a
  // run whose terms were ALL answered by the prewarm sends no batch — it took
  // the shortcut straight into the add path instead.
  //
  // On ALDI, whose write is off, that surfaced as "Items Not Added — 6 items
  // could not be added to cart" on a run that had never intended to add
  // anything. On a store whose write is on it would have gone to the adds with
  // products the user had not chosen.
  const CANDIDATE = {
    productName: 'Friendly Farms Sour Cream, 16 oz', imageUrl: null, outOfStock: false,
    preferences: null, price: '$1.65', productId: 'items_23898-1', skuId: null,
  };

  it('offers the candidates rather than reporting a failed add', () => {
    mockPrewarmedCart = { count: 0, items: [] };
    mockPrewarmedSearch = new Map([['sour cream', [CANDIDATE]]]);
    const { loadEnd, post, queryByText } = openAldi();
    loadEnd('https://www.aldi.us/robots.txt');
    post({
      type: 'ALDI_SESSION', ok: true, loggedIn: true,
      cartId: '1', storeId: '8583', retailerId: '12', shoppingContext: 'delivery',
    });
    // No SEARCH_RESULT and no SEARCH_BATCH_DONE: the whole point is that this
    // run never sends a search batch.
    expect(queryByText('Friendly Farms Sour Cream, 16 oz')).toBeTruthy();
    expect(queryByText(/could not be added/i)).toBeNull();
  });
});
