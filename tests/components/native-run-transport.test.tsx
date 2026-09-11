// THE RUN, WITH NO RENDERER UNDER IT.
//
// Stephen, 2026-09-11: "I want the same general logic, I just want it to be done
// without a webview and just 100% over network instead."
//
// So the claim this file exists to pin is not that the native path WORKS -- the
// drivers' own requests are measured on the device, not here. It is that the
// ENGINE cannot tell the difference. Same messages, same phases, same decisions,
// same screen at the end, with nothing injected and no page waited for.
//
// Its sibling rail-waits-for-the-quiet-page.test.tsx pins the identical
// decisions on the page transport. Neither suite inherits its transport from
// whatever store-capabilities.ts happens to say this week: both install one.

import { act, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

/** Anything injected here is a native run reaching for a page it should not need. */
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

// A prewarm that already proved the login, which is what a real phone is almost
// always in: the probe runs when the store tab is tapped, long before this opens.
jest.mock('../../src/context/LoginPrewarmContext', () => ({
  useLoginPrewarm: () => ({
    getStatus: () => 'loggedIn',
    takePrewarmedCart: () => null,
    getSearchResults: () => new Map(),
    noteLiveVerdict: () => {},
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
import { __setNativeRunForTests, __resetNativeRunForTests } from '../../src/lib/native-rail';
import {
  NativeRunDriver, PostToSheet, __resetNativeRunForTests as resetGen, nativeGen,
} from '../../src/lib/native-rail/run';

/** What the fake driver was asked for, in order. */
let asked: string[] = [];
/** The terms of every search batch it was handed. One entry per batch. */
let batches: string[][] = [];
/** Held open so a test can decide WHEN a batch answers. */
let releaseSearch: (() => void) | null = null;

const CANDIDATE = {
  productName: 'Friendly Farms Sour Cream, 16 oz', imageUrl: null, outOfStock: false,
  preferences: null, price: '$1.65', productId: 'items_23898-1', skuId: null,
};

/**
 * A driver that answers instantly and records what it was asked.
 *
 * Deliberately NOT one of the shipped drivers. Those make real requests, and a
 * suite that mocked fetch to feed them would be testing the mock's idea of ALDI.
 * What is under test here is the SEAM -- that the sheet asks the driver instead
 * of the page, and that what the driver posts lands where the page's messages
 * land -- and a fake is the only thing that can observe both halves.
 */
function fakeDriver(opts: { noShop?: boolean } = {}): NativeRunDriver {
  return {
    id: 'fake',
    session: () => (post: PostToSheet) => {
      asked.push('session');
      post({
        type: 'ALDI_SESSION', ok: true, loggedIn: true, cartId: '1',
        storeId: opts.noShop ? null : '8583', retailerId: '12', shoppingContext: 'delivery',
      });
      return Promise.resolve();
    },
    cartRead: () => (post: PostToSheet) => {
      asked.push('cartRead');
      post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
      return Promise.resolve();
    },
    searchBatch: (terms) => {
      // NULL IS A REAL ANSWER, exactly as `rail.searchBatch` returning null is:
      // "this store cannot build a search from this session". The sheet must
      // treat both the same or a native store fails differently from a page one.
      if (opts.noShop) return null;
      batches.push([...terms]);
      return async (post: PostToSheet) => {
        asked.push('search');
        if (releaseSearch) await new Promise<void>((r) => { releaseSearch = r; });
        for (const term of terms) {
          post({ type: 'SEARCH_RESULT', source: 'network', term, candidates: [CANDIDATE] });
        }
        post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: terms.length });
      };
    },
    addBatch: () => (post: PostToSheet) => {
      asked.push('add');
      post({ type: 'NET_ADD_DONE', count: 0, wrote: 0 });
      return Promise.resolve();
    },
  };
}

beforeEach(() => {
  injected.length = 0;
  asked = [];
  batches = [];
  releaseSearch = null;
  resetGen();
});
afterEach(() => {
  __resetAutomationConfigForTests();
  __resetNativeRunForTests();
});

const meal = { id: 'm1', name: 'Quesadilla', ingredients: [
  { ingredientName: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
] };

function openNatively(driver: NativeRunDriver = fakeDriver()) {
  __setNativeRunForTests(() => driver);
  __applyAutomationConfigForTests({
    stores: { aldi: { networkSearch: true, networkAdd: false } },
  });
  const view = render(
    <WebViewCartSheet
      visible
      meals={[meal] as never}
      storeId="aldi"
      storeName="ALDI"
      onClose={() => {}}
    />,
  );
  const webview = () => view.getAllByTestId('mock-webview')[0];
  const loadEnd = (url: string) => act(() => {
    webview().props.onLoadEnd({ nativeEvent: { url } });
  });
  return { ...view, loadEnd };
}

describe('a run that needs no page', () => {
  it('asks the store without waiting for one to load', () => {
    // THE WHOLE POINT, and the one thing a page run cannot do. The injected
    // rails are same-origin, so the sheet has to hold their scripts until the
    // quiet page lands -- measured at 8,499ms of renderer on Stephen's Pixel
    // before a single request goes out. A native request carries the cookie jar
    // wherever it is made from, so there is nothing to wait for.
    openNatively();
    expect(asked).toContain('cartRead');
    expect(asked).toContain('session');
  });

  it('injects nothing into the WebView', () => {
    openNatively();
    expect(injected).toEqual([]);
  });

  it('reaches the choose screen on the messages the driver posted', () => {
    const { queryByText } = openNatively();
    expect(queryByText('Friendly Farms Sour Cream, 16 oz')).toBeTruthy();
  });

  it('does not ask again when a page happens to load anyway', () => {
    // The sheet still points a WebView somewhere -- a login may yet be needed,
    // and the WAF fallback will need one. A load landing must not re-ask what
    // has already been answered, or a native run doubles its own session and
    // cart traffic for a page it never used. The onLoadEnd retries exist for the
    // injected scripts that can land on about:blank and go nowhere, and a native
    // request cannot land anywhere but the store.
    const { loadEnd } = openNatively();
    const before = [...asked];
    loadEnd('https://www.aldi.us/robots.txt');
    expect(asked).toEqual(before);
  });
});

describe('the revert switch', () => {
  it('sends the store back to the injected rail without a release', () => {
    // Stephen, 2026-09-11: "we can always revert if we need to." The big hammer
    // -- turning networkSearch off -- would hand the user the store's search
    // page, which is a far larger regression than the injected rail. This is the
    // small one.
    __setNativeRunForTests(() => fakeDriver());
    __applyAutomationConfigForTests({
      stores: { aldi: { networkSearch: true, networkAdd: false, nativeRun: false } },
    });
    render(
      <WebViewCartSheet
        visible
        meals={[meal] as never}
        storeId="aldi"
        storeName="ALDI"
        onClose={() => {}}
      />,
    );
    expect(asked).toEqual([]);
  });
});

describe('a store the driver cannot build a search for', () => {
  it('hands over rather than searching with no shop', () => {
    // NULL MEANS CANNOT, on both transports. The injected rail returns null
    // when the session carried no shop id, because sending the retailer id
    // instead searches a catalogue the user cannot buy from. A driver says the
    // same thing the same way, and the sheet must take it the same way.
    const { queryByText } = openNatively(fakeDriver({ noShop: true }));
    expect(batches).toEqual([]);
    expect(queryByText('Friendly Farms Sour Cream, 16 oz')).toBeNull();
  });
});

describe('one batch, however many answers', () => {
  it('sends a single search batch for the run', () => {
    openNatively();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(['sour cream']);
  });
});

describe('the stop reaches this side of the bridge', () => {
  it('starts at generation zero and moves only when something stops it', () => {
    // The generation is what every native batch loop reads between terms, the
    // same way __mealioGen is what the injected loops read. A stop that did not
    // move it would leave a prewarm running beside the run it was stopped for --
    // which is the duplicate-burst shape MEAL-207 is about.
    expect(nativeGen()).toBe(0);
    const { nativeStop } = require('../../src/lib/native-rail/run');
    expect(nativeStop()).toBe(0);
    expect(nativeGen()).toBe(1);
  });
});
