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
    post(view, { type: 'LOGIN_STATUS', isLoggedIn: true });
    post(view, { type: 'CART_COUNT', count: 0, items: [], url: 'https://www.heb.com/cart' });
    return view;
  };

  it('asks for a substitute when the automation could not settle the match', () => {
    const view = runToReview();
    post(view, {
      type: 'SEARCH_RESULT',
      candidates: [{ productName: 'Some Other Brand Turkey', imageUrl: null, outOfStock: false, preferences: null, price: '$8' }],
    });
    act(() => { fireEvent.press(view.getByText(/review 1 item/i)); });

    expect(view.queryByText(/Pick a Substitute \(1 of 1\)/)).toBeTruthy();
  });

  it('asks for an AMOUNT on a sold-by-weight item — nothing failed, so nothing is being substituted', () => {
    const view = runToReview();
    // What heb.ts posts when it matched the product exactly but has no remembered
    // weight: the add bails with the weight options and routes straight to review.
    post(view, {
      type: 'SEARCH_AND_ADD_RESULT',
      success: false,
      reason: 'needs_weight',
      candidates: [{
        productName: 'H-E-B Deli Oven Roasted Turkey Breast, lb',
        imageUrl: null, outOfStock: false, preferences: null, price: '$9.98',
        isWeightItem: true, weightOptions: [0.25, 0.5, 1],
      }],
    });
    // The needs_weight route buffers 400ms before advancing the queue, so the
    // review screen is not reachable until that fires.
    act(() => { jest.advanceTimersByTime(500); });
    act(() => { fireEvent.press(view.getByText(/review 1 item/i)); });

    expect(view.queryByText(/Choose an Amount \(1 of 1\)/)).toBeTruthy();
    // The claim that matters: it must not tell the user the match failed.
    expect(view.queryByText(/Pick a Substitute/)).toBeNull();
    // And it really is the weight prompt underneath, not some other screen.
    expect(view.queryByText(/Sold by weight/i)).toBeTruthy();
  });
});
