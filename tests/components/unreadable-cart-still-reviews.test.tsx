// AN UNREADABLE CART DOES NOT MAKE AN UNMATCHED ITEM UNREVIEWABLE.
//
// MEASURED on the Pixel, Walmart, 2026-09-04. The cart read answered 412 -- one
// of that store's anti-bot statuses -- and four items the SEARCH had already
// failed to match were printed on the done screen as "could not be added" text
// with nothing to press. The same run a minute later read the cart fine and the
// same four items went to review, which is what makes this a routing bug rather
// than a Walmart one: the 412 is transient and the items' reasons never had
// anything to do with the cart.
//
// Stephen's rule, 2026-09-04: "Ideally if there is any problem adding something
// to the cart, then that item should go to review." The cart decides what
// LANDED. It has no say over an item that was never written.
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(), identifyUser: jest.fn(async () => {}), resetUser: jest.fn(async () => {}),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: () => {}, stopLoading: () => {}, goBack: () => {}, reload: () => {},
    }));
    return RealReact.createElement(RealView, { testID: props.testID || 'mock-webview', ...props });
  });
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});
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
jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    meals: { ...actual.meals, update: jest.fn(() => new Promise(() => {})) },
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'run-unreadable-cart'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      checkStore: () => {}, getStatus: () => 'loggedIn', takePrewarmedCart: () => null,
      statusVersion: 1, setSearchTerms: () => {}, getSearchResults: () => new Map(),
    }),
  };
});
jest.mock('../../src/lib/automation-config', () => {
  const actual = jest.requireActual('../../src/lib/automation-config');
  return {
    ...actual,
    getAutomationConfig: () => {
      const base = actual.getAutomationConfig();
      return {
        ...base,
        flags: { ...base.flags, ...((globalThis as any).__flags ?? {}) },
        stores: { ...base.stores, ...((globalThis as any).__stores ?? {}) },
      };
    },
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import {
  enableRail, postToSheet, SESSION_OK, cartCount, searchResult, searchDone,
  candidate, addResult, addDone,
} from './helpers/railRun';

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => { (globalThis as any).__flags = { presearchAdd: false, parallelAdd: true }; });

const ing = (ingredientName: string, searchTerm: string) => ({
  ingredientName, searchTerm, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

/**
 * One item lands, one never matches, and then the reconcile read of the cart
 * comes back unreadable -- `count: null`, which is what a rail posts for a 412.
 */
function runWithUnreadableCart(strandedCandidates: ReturnType<typeof candidate>[]) {
  enableRail();
  const view = render(
    <WebViewCartSheet
      visible
      meals={[{ id: 'm1', name: 'Dinner', ingredients: [
        ing('Sour Cream', 'sour cream'),
        ing('Chicken Breasts', 'Freshness Guaranteed Chicken Breasts'),
      ] }] as never}
      storeId="heb"
      storeName="H-E-B"
      onClose={() => {}}
    />,
  );
  const post = (p: Record<string, unknown>) => postToSheet(view, p);

  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  act(() => { jest.advanceTimersByTime(2_000); });
  post(SESSION_OK);
  act(() => { jest.advanceTimersByTime(500); });
  post(cartCount(0, []));
  act(() => { jest.advanceTimersByTime(500); });
  post(SESSION_OK);
  act(() => { jest.advanceTimersByTime(500); });

  post(searchResult('sour cream', [candidate('sour cream')]));
  post(searchResult('Freshness Guaranteed Chicken Breasts', []));
  post(searchDone(2));
  act(() => { jest.advanceTimersByTime(200); });
  // The ingredient-name search that fires alongside the writes.
  post(searchResult('Chicken Breasts', strandedCandidates));
  act(() => { jest.advanceTimersByTime(500); });

  post(addResult(0, 'sour cream', true));
  post(addDone(1, [], [{ name: 'sour cream', qty: 1 }]));
  act(() => { jest.advanceTimersByTime(5_000); });

  // THE 412. A rail that cannot read the cart posts count: null.
  post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_failed', status: 412 });
  act(() => { jest.advanceTimersByTime(2_000); });
  return view;
}

describe('the cart could not be read', () => {
  it('still says so, once the user is finished with the review', () => {
    // The unverified banner lives on the DONE screen, so routing to review
    // defers it rather than dropping it -- which is the right order: deal with
    // the item you can still fix, then be told to check the cart. Skipping to
    // the end is what proves it survived rather than being lost.
    const view = runWithUnreadableCart([candidate('Perdue Chicken Breasts')]);
    const skip = view.queryByText(/^Skip$/) ?? view.queryByText(/skip/i);
    if (skip) act(() => { fireEvent.press(skip); });
    act(() => { jest.advanceTimersByTime(3_000); });
    expect(view.queryByText(/could ?n.t verify|double-check/i)).toBeTruthy();
  });

  it('sends the unmatched item to review rather than printing it on the done screen', () => {
    const view = runWithUnreadableCart([candidate('Perdue Chicken Breasts')]);
    expect(view.queryByText('Perdue Chicken Breasts')).toBeTruthy();
  });

  it('does not re-offer the item that DID land', () => {
    // It plausibly landed and the cart cannot say otherwise. Offering it again
    // is how the user buys two.
    const view = runWithUnreadableCart([candidate('Perdue Chicken Breasts')]);
    expect(view.queryByText(/^sour cream$/i)).toBeNull();
  });

  it('summarises rather than offering a pick when there is nothing to pick', () => {
    const view = runWithUnreadableCart([]);
    expect(view.queryByText(/Chicken Breasts/i)).toBeTruthy();
    // No candidates means no pick screen -- that was the dead-buttons bug.
    expect(view.queryByText(/Items Not Added/i)).toBeTruthy();
  });
});
