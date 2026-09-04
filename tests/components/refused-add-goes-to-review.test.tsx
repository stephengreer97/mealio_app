// ANY PROBLEM ADDING SOMETHING IS A REVIEW. The cap is the one exception.
//
// Stephen, 2026-09-04: "As a general rule of thumb - we want the warning message
// on the cart screen to be very rarely hit. Ideally if there is any problem
// adding something to the cart, then that item should go to review. An exception
// of course is the one I just gave you - too many in cart already."
//
// The reconcile already routed its DEFINITE failures (out of stock, no results,
// needs a weight) to review. What did not was the RETRY path: an item the
// reconcile thought it could fix, retried, and still could not get. Those landed
// in the failed list and out onto the done screen as "Could not add: X" — the
// one place the user can do nothing about it.
//
// His Morton Salt did exactly that: refused, retried into the identical refusal
// a second later, then reported as unaddable with no alternatives.
//
// The cap is the right exception and the reason is worth stating: no other
// product answers "you already have fifteen of these", so a review screen would
// be asking the user to solve a problem that is not about the product. It gets
// its own banner instead.
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
      reload: () => {}, stopLoading: () => {}, goBack: () => {},
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
jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'run-login-poll'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});
// 'unknown', so the sheet runs its own login check rather than trusting a
// prewarm — which is how a user reaches the login screen at all.
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      checkStore: () => {}, getStatus: () => 'unknown', takePrewarmedCart: () => null,
      statusVersion: 1, setSearchTerms: () => {}, getSearchResults: () => new Map(),
    }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { enableRail, SESSION_OK } from './helpers/railRun';

const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

beforeEach(() => { jest.useFakeTimers(); injected.length = 0; });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

/**
 * One item the reconcile thinks it can FIX — a short add — whose top-up the
 * store then refuses.
 *
 * This is the path the rule is about, and reaching it takes a shortfall: a
 * definite failure never gets a top-up at all, so a test that starts with one
 * passes on the reconcile's own filter and says nothing about this branch.
 * Measured: with the cap routed to review as a mutant, the first version of the
 * exception test below still passed.
 */
async function shortThenRefused(reason: string) {
  const view = render(
    <WebViewCartSheet visible
      meals={[{ id: 'm1', name: 'Tacos', ingredients: [{ ...chosen('Sour Cream'), productQty: 2, qty: 2 }] }] as never}
      storeId="heb" storeName="H-E-B" onClose={() => {}} />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  await act(async () => {});
  enableRail();
  post(SESSION_OK);
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post(SESSION_OK);
  post({
    type: 'SEARCH_RESULT', source: 'network', term: 'Sour Cream',
    candidates: [{
      productName: 'Sour Cream', imageUrl: null, outOfStock: false, preferences: null,
      price: '$2', productId: 'p1', skuId: 's1',
    }],
  });
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
  // Reported added, but the cart holds ONE of the two — a shortfall the
  // reconcile schedules a top-up for.
  post({ type: 'NET_ADD_RESULT', idx: 0, name: 'Sour Cream', success: true,
         productId: 'p1', skuId: 's1' });
  post({ type: 'NET_ADD_DONE', wrote: 1, count: 1, cartBefore: [], cartAfter: [] });
  post({ type: 'CART_COUNT', count: 1, items: [{ name: 'Sour Cream', qty: 1 }], source: 'network' });
  act(() => { jest.advanceTimersByTime(2_000); });
  // The top-up, refused.
  post({ type: 'NET_ADD_RESULT', idx: 0, name: 'Sour Cream', success: false,
         productId: 'p1', skuId: 's1', reason });
  post({ type: 'NET_ADD_DONE', wrote: 0, count: 1, cartBefore: [], cartAfter: [] });
  act(() => { jest.advanceTimersByTime(30_000); });
  await act(async () => {});
  return view;
}

/** One item, searched and matched, whose write the store refuses twice. */
async function refusedTwice(reason: string) {
  const view = render(
    <WebViewCartSheet visible
      meals={[{ id: 'm1', name: 'Tacos', ingredients: [chosen('Sour Cream')] }] as never}
      storeId="heb" storeName="H-E-B" onClose={() => {}} />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  await act(async () => {});
  enableRail();
  post(SESSION_OK);
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post(SESSION_OK);
  post({
    type: 'SEARCH_RESULT', source: 'network', term: 'Sour Cream',
    candidates: [{
      productName: 'Sour Cream', imageUrl: null, outOfStock: false, preferences: null,
      price: '$2', productId: 'p1', skuId: 's1',
    }],
  });
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
  post({ type: 'NET_ADD_RESULT', idx: 0, name: 'Sour Cream', success: false,
         productId: 'p1', skuId: 's1', reason });
  post({ type: 'NET_ADD_DONE', wrote: 0, count: 1, cartBefore: [], cartAfter: [] });
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  // The reconcile's top-up, refused the same way.
  post({ type: 'NET_ADD_RESULT', idx: 0, name: 'Sour Cream', success: false,
         productId: 'p1', skuId: 's1', reason });
  post({ type: 'NET_ADD_DONE', wrote: 0, count: 1, cartBefore: [], cartAfter: [] });
  act(() => { jest.advanceTimersByTime(30_000); });
  await act(async () => {});
  return view;
}

describe('an item the store would not add', () => {
  it('reaches the review screen instead of the done screen', async () => {
    const view = await refusedTwice('cart_not_incremented');
    // The "Items Not Added" summary offers the review — the done screen's
    // "Could not add" line offers nothing.
    expect(view.queryByText(/review \d+ ingredient/i)).toBeTruthy();
  });

  it('and says the store refused rather than inventing a cause', async () => {
    const view = await refusedTwice('cart_not_incremented');
    const review = view.getByText(/review \d+ ingredient/i);
    act(() => { fireEvent.press(review); });
    expect(view.queryByText(/would not add this/i)).toBeTruthy();
  });

  it('carries the candidates the search already found, so there is something to pick', async () => {
    const view = await refusedTwice('cart_not_incremented');
    act(() => { fireEvent.press(view.getByText(/review \d+ ingredient/i)); });
    // NOT "the name appears somewhere" — the screen prints "You searched for
    // Sour Cream" whatever happens, and asserting that passed while every card
    // was being built with an empty candidate list. The button is the proof: it
    // is enabled only once a candidate is selected and a quantity is set.
    const plus = view.queryAllByText('+');
    expect(plus.length).toBeGreaterThan(0);
    act(() => { fireEvent.press(plus[0]); });
    expect(view.queryByText(/add to cart only/i)).toBeTruthy();
    expect(view.queryByText(/set a quantity above/i)).toBeNull();
  });

  it('by the top-up route as well as the first refusal', async () => {
    // The route Morton Salt actually took: reported, retried by the reconcile,
    // refused again.
    const view = await shortThenRefused('cart_not_incremented');
    expect(view.queryByText(/review \d+ ingredient/i)).toBeTruthy();
  });

  it('EXCEPT a cap already reached, which no other product answers', async () => {
    // "You already have fifteen of these" is not a question about the product,
    // so it gets a banner and not a review card. Through the TOP-UP route, which
    // is the one this exception has to hold on — a definite failure never gets a
    // top-up, so starting with one proves nothing about this branch.
    const view = await shortThenRefused('quantity_limit_reached');
    expect(view.queryByText(/review \d+ ingredient/i)).toBeNull();
  });
});

describe('and the review fires once, not in a loop', () => {
  // A review pick is written as a TOP-UP — it is the reconcile's own correction
  // in every respect but who chose it — so it finishes through the same
  // netFinalize that now routes a failed top-up back to review.
  //
  // Without a guard that is a loop: pick a substitute, the store refuses it,
  // the sheet offers the review again, and the only way out is to skip. The
  // user has already been given the choice this run has to offer, so a failure
  // there lands on the done screen.
  it('a substitute the store also refuses does not re-open the review', async () => {
    const view = await shortThenRefused('cart_not_incremented');
    act(() => { fireEvent.press(view.getByText(/review \d+ ingredient/i)); });
    // Pick the candidate the search found, with a quantity.
    const plus = view.queryAllByText('+')[0];
    expect(plus).toBeTruthy();
    act(() => { fireEvent.press(plus); });
    const addOnly = view.queryByText(/add to cart only/i);
    expect(addOnly).toBeTruthy();
    act(() => { fireEvent.press(addOnly!); });
    // The store refuses the substitute too.
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify({
          type: 'NET_ADD_RESULT', idx: 0, name: 'Sour Cream', success: false,
          productId: 'p1', skuId: 's1', reason: 'cart_not_incremented' }) },
      });
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify({
          type: 'NET_ADD_DONE', wrote: 0, count: 1, cartBefore: [], cartAfter: [] }) },
      });
    });
    act(() => { jest.advanceTimersByTime(30_000); });
    await act(async () => {});
    // No second offer. The run ends where the user can see what happened.
    expect(view.queryByText(/review \d+ ingredient/i)).toBeNull();
  });
});
