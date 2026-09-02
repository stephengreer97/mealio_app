// MEAL-178 — "N items" on the done screen counts UNITS, and the units it counts
// are the ones the run actually intended.
//
// tests/unit/cartReconcile.test.ts pins unitsForNames and the cart check on its
// own. This drives a real run instead, because the interesting half is not the
// arithmetic — it is WHICH quantity reaches it.
//
// The pre-run quantity is not that quantity whenever an item goes through
// review. `PickedItem.qty` is seeded at 0 and set by the user on the review
// screen, so a x3 request the user resolves down to x1 adds one unit. Counting
// the label off the pre-run intent claims three landed, and on a header-badge
// store (no cart rows, so the per-item audit cannot run) it also raises a cart
// check against a run that was correct. Both are the governing rule broken —
// a wrong count is a false claim, not a cosmetic slip.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

let mockWebViewProps: any = {};

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    mockWebViewProps = props;
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
import { enableRail, SESSION_OK } from './helpers/railRun';

const post = (payload: Record<string, unknown>) => act(() => {
  mockWebViewProps.onMessage?.({ nativeEvent: { data: JSON.stringify(payload) } });
});

/** Drive a run for one ingredient requested at `productQty` up to the review
 *  screen, where the automation could not settle it on its own. */
function runToReview(productQty: number) {
  const view = render(
    <WebViewCartSheet
      visible
      meals={[{
        id: 'm1',
        name: 'Tacos',
        ingredients: [{
          ingredientName: 'Sour Cream', searchTerm: 'sour cream',
          productQty, qty: productQty, unit: 'qty', measure: null,
        }],
      }] as never}
      storeId="heb"
      storeName="H-E-B"
      onClose={() => {}}
    />,
  );
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  // A RAIL store, where this was ALDI. The review screen is reached by a search,
  // and an assisted store has none of its own — its run hands the user the
  // store's page. What is under test is the COUNT, which is the same either way.
  enableRail();
  post(SESSION_OK);
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post(SESSION_OK);
  // The candidate has to do two things at once. It must not match the term
  // EXACTLY, or the item auto-picks and never reaches review — and it must still
  // resolve to the intended item by name, or the count falls through to the
  // one-unit fallback for unresolvable names and the test proves nothing. A real
  // store title for the searched product is both.
  post({
    type: 'SEARCH_RESULT', source: 'network', term: 'sour cream',
    candidates: [{
      productName: 'Daisy Sour Cream, 16 oz', imageUrl: null, outOfStock: false,
      preferences: null, price: '$2',
      // Ids, so the pick can be WRITTEN over the rail rather than clicked.
      productId: 'p1', skuId: 's1',
    }],
  });
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  act(() => { fireEvent.press(view.getByText(/review 1 ingredient/i)); });
  return view;
}

describe('the done screen counts the units the run intended (MEAL-178)', () => {
  it('reports the quantity the user set at review, not the one they started with', async () => {
    const view = runToReview(3);

    // Pick the candidate, then set the quantity. The review stepper seeds at 0 —
    // one press is one unit, against a request of three.
    fireEvent.press(view.getByTestId('candidate-0'));
    fireEvent.press(view.getByText('+'));
    act(() => { fireEvent.press(view.getByText(/add to cart only/i)); });

    // The pick is written over the rail; NET_ADD_DONE ends the pass.
    post({ type: 'NET_ADD_RESULT', idx: 0, name: 'Daisy Sour Cream, 16 oz', success: true, productId: 'p1', skuId: 's1', reason: null });
    post({ type: 'NET_ADD_DONE', wrote: 1, count: 1, cartBefore: [], cartAfter: [{ name: 'Daisy Sour Cream, 16 oz', qty: 1 }] });

    // The whole point: ONE unit landed, so the headline says one. Counting off
    // the pre-run productQty renders "3 items added to your H-E-B cart!" here,
    // which is the false claim this ticket exists to stop. The wait is the 400ms
    // buffer the add path leaves before advancing to the done screen.
    await waitFor(() => expect(view.queryByText(/1 item added to your H-E-B cart!/i)).toBeTruthy());
    expect(view.queryByText(/3 items added/i)).toBeNull();
  });

  it('still counts a multi-unit pick as multiple items', async () => {
    // The inverse, so the test above cannot be satisfied by hardcoding 1: the
    // label must track the stepper, not merely stop trusting the request.
    const view = runToReview(3);
    fireEvent.press(view.getByTestId('candidate-0'));
    fireEvent.press(view.getByText('+'));
    fireEvent.press(view.getByText('+'));
    act(() => { fireEvent.press(view.getByText(/add to cart only/i)); });

    // The pick is written over the rail; NET_ADD_DONE ends the pass.
    post({ type: 'NET_ADD_RESULT', idx: 0, name: 'Daisy Sour Cream, 16 oz', success: true, productId: 'p1', skuId: 's1', reason: null });
    post({ type: 'NET_ADD_DONE', wrote: 1, count: 1, cartBefore: [], cartAfter: [{ name: 'Daisy Sour Cream, 16 oz', qty: 1 }] });

    await waitFor(() => expect(view.queryByText(/2 items added to your H-E-B cart!/i)).toBeTruthy());
  });

  it('says how many INGREDIENTS are left to review, not how many units', () => {
    // The queue length is a count of screens the user is about to step through.
    // Inflating it by quantity would promise three and show one.
    const view = render(
      <WebViewCartSheet
        visible
        meals={[{
          id: 'm1', name: 'Tacos',
          ingredients: [{
            ingredientName: 'Sour Cream', searchTerm: 'sour cream',
            productQty: 3, qty: 3, unit: 'qty', measure: null,
          }],
        }] as never}
        storeId="heb"
        storeName="H-E-B"
        onClose={() => {}}
      />,
    );
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    enableRail();
    post(SESSION_OK);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION_OK);
    post({
      type: 'SEARCH_RESULT', source: 'network', term: 'sour cream',
      candidates: [{ productName: 'Daisy Sour Cream, 16 oz', imageUrl: null, outOfStock: false, preferences: null, price: '$2' }],
    });
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });

    // Three units could not be added, across one ingredient. Both numbers are on
    // this screen and they are deliberately different.
    expect(view.queryByText(/3 items could not be added to cart/i)).toBeTruthy();
    expect(view.queryByText(/review 1 ingredient/i)).toBeTruthy();
  });
});
