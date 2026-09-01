// MEAL-182 — what the review step calls itself, per reason.
//
// One step serves three situations and the new name only fits two of them.
// "Pick a Substitute" says the match failed, which is true for a low-confidence
// or out-of-stock item and FALSE for a sold-by-weight one: there Mealio matched
// the product exactly and is asking for a poundage. The old name ("Review
// Ingredients") was vague enough to cover both — a name that says what to DO
// cannot be, which is the cost of the rename and the reason the title branches.
//
// Pinned as a test because the branch is one ternary away from being flattened
// back by anyone who reads the ticket and not the screen.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'review-step-titles'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

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
  return { Image: (props: any) => RealReact.createElement(RealView, props) };
});

jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      checkStore: () => {},
      getStatus: () => 'loggedIn',
      takePrewarmedCart: () => null,
      statusVersion: 1,
    }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { enableRail } from './helpers/railRun';

/** Post to the MAIN WebView. HEB mounts worker views too, so a module-level
 *  capture of the last-rendered props would address a worker instead. */
const post = (view: any, payload: Record<string, unknown>) => act(() => {
  view.getAllByTestId('mock-webview')[0].props.onMessage({
    nativeEvent: { data: JSON.stringify(payload) },
  });
});

describe('the review step is titled for what it is asking (MEAL-182)', () => {
  const mounted: Array<{ unmount: () => void }> = [];

  // The run arms real timeouts it never gets to clear here; left alone they fire
  // after the test finishes and hold the worker open.
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => {
    while (mounted.length) mounted.pop()!.unmount();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /** A run for one already-chosen ingredient, driven to the review screen. */
  const runToReview = () => {
    const view = render(
      <WebViewCartSheet
        visible
        meals={[{
          id: 'm1', name: 'Sandwiches',
          ingredients: [{
            ingredientName: 'Turkey Breast', searchTerm: 'sliced turkey',
            productQty: 1, qty: 1, unit: 'qty', measure: null,
          }],
        }] as never}
        storeId="heb"
        storeName="H-E-B"
        onClose={() => {}}
      />,
    );
    mounted.push(view);
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    // Over the rail: the session probe answers the login check, then the cart is
    // read by request rather than by loading /cart.
    enableRail();
    post(view, { type: 'HEB_SESSION', ok: true, loggedIn: true, storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY' });
    post(view, { type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(view, { type: 'HEB_SESSION', ok: true, loggedIn: true, storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY' });
    return view;
  };

  it('asks for a substitute when the automation could not settle the match', () => {
    const view = runToReview();
    post(view, {
      type: 'SEARCH_RESULT', source: 'network', term: 'sliced turkey',
      candidates: [{ productName: 'Some Other Brand Turkey', imageUrl: null, outOfStock: false, preferences: null, price: '$8' }],
    });
    // The batch has to CLOSE, or the add pass never starts and nothing routes
    // to review. On the page path the single result was the whole answer.
    post(view, { type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
    // Nothing matched exactly, so the pass ends with no writes and reconciles
    // against the cart before it can offer the review gate.
    post(view, { type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    // The gate button, used here only to get INTO the step. MEAL-178 renamed it
    // from "Review 1 Item" to "Review 1 Ingredient": once "item" means a unit,
    // calling a review row an item contradicts every other count on the screen.
    // This assertion is about the step TITLE below, not the button's wording.
    act(() => { fireEvent.press(view.getByText(/review 1 ingredient/i)); });

    expect(view.queryByText(/Pick a Substitute \(1 of 1\)/)).toBeTruthy();
  });

  it('asks for an AMOUNT on a sold-by-weight item — nothing failed, so nothing is being substituted', () => {
    const view = runToReview();
    // An EXACT match that is sold by weight. The rail will not write one: the
    // user has to choose an amount, and an over-add on a weight item cannot be
    // undone (MEAL-200). So it reports needs_weight with the options and routes
    // to review — the same destination heb.ts's fused add used to reach by
    // bailing out of the click.
    post(view, {
      type: 'SEARCH_RESULT', source: 'network', term: 'sliced turkey',
      candidates: [{
        productName: 'sliced turkey',
        imageUrl: null, outOfStock: false, preferences: null, price: '$9.98',
        productId: 'p1', skuId: 's1',
        isWeightItem: true, weightOptions: [0.25, 0.5, 1],
      }],
    });
    post(view, { type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
    post(view, { type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    act(() => { jest.advanceTimersByTime(500); });
    // The gate button, used here only to get INTO the step. MEAL-178 renamed it
    // from "Review 1 Item" to "Review 1 Ingredient": once "item" means a unit,
    // calling a review row an item contradicts every other count on the screen.
    // This assertion is about the step TITLE below, not the button's wording.
    act(() => { fireEvent.press(view.getByText(/review 1 ingredient/i)); });

    expect(view.queryByText(/Choose an Amount \(1 of 1\)/)).toBeTruthy();
    // The claim that matters: it must not tell the user the match failed.
    expect(view.queryByText(/Pick a Substitute/)).toBeNull();
    // And it really is the weight prompt underneath, not some other screen.
    expect(view.queryByText(/Sold by weight/i)).toBeTruthy();
  });
});
