// MEAL-177 — the skipped-items list must be reachable, not truncated.
//
// The done screen told the user "N items skipped during review" and then rendered
// the names with numberOfLines={3}. A run that skipped a dozen items showed three
// of them, with no affordance to see the rest — and looked complete while doing
// it, which is the part that makes silent truncation worse than either honest
// alternative.
//
// Two levels here, deliberately:
//
//   1. The component's behaviour — collapsed hides the list, tapping reveals it,
//      and the revealed list scrolls inside a bounded height instead of growing
//      the sheet.
//   2. The WIRING — a real run, a real skip, a real done screen. Without this the
//      component could be perfect and unused; the previous code path rendered
//      plain <Text> and would have passed every test in group 1.

import { act, fireEvent, render } from '@testing-library/react-native';

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

import ExpandableNotice from '../../src/components/ui/ExpandableNotice';
import WebViewCartSheet from '../../src/components/WebViewCartSheet';

describe('ExpandableNotice (MEAL-177)', () => {
  const NAMES = 'Sour Cream, Tortillas, Cheese, Salsa, Limes, Cilantro';

  it('shows the summary and hides the detail until tapped', () => {
    const view = render(<ExpandableNotice testID="n" title="6 items skipped" body={NAMES} />);
    // The count is the part that must survive collapsing — hiding it would hide
    // the fact that anything happened.
    expect(view.queryByText('6 items skipped')).toBeTruthy();
    expect(view.queryByText(NAMES)).toBeNull();
  });

  it('reveals the detail on tap and hides it again', () => {
    const view = render(<ExpandableNotice testID="n" title="6 items skipped" body={NAMES} />);
    fireEvent.press(view.getByTestId('n-toggle'));
    expect(view.queryByText(NAMES)).toBeTruthy();
    fireEvent.press(view.getByTestId('n-toggle'));
    expect(view.queryByText(NAMES)).toBeNull();
  });

  it('scrolls the revealed detail inside a bounded height', () => {
    // The banner sits above the cart-result rows on a screen that already
    // scrolls. An unbounded body would push those rows off, trading one
    // truncation for another — so the assertion is on the cap, not just on the
    // presence of a ScrollView.
    const view = render(<ExpandableNotice testID="n" title="6 items skipped" body={NAMES} maxBodyHeight={120} />);
    fireEvent.press(view.getByTestId('n-toggle'));
    const body = view.getByTestId('n-body');
    expect(String(body.type)).toMatch(/ScrollView/);
    expect(body.props.style).toMatchObject({ maxHeight: 120 });
    // Deliberately NOT nestedScrollEnabled — it is Android-only and nothing
    // competes for this gesture. Pinned so it does not come back with the wrong
    // rationale attached, which is how it arrived the first time.
    expect(body.props.nestedScrollEnabled).toBeFalsy();
  });

  it('tells a screen reader what the tap does', () => {
    // Collapsed, the only text is the count — which the reader already announced.
    // Without this label the control is invisible to it.
    const view = render(<ExpandableNotice testID="n" title="6 items skipped" body={NAMES} />);
    const toggle = view.getByTestId('n-toggle');
    expect(toggle.props.accessibilityLabel).toBe('6 items skipped. Show details');
    fireEvent.press(toggle);
    expect(view.getByTestId('n-toggle').props.accessibilityLabel).toBe('6 items skipped. Hide details');
  });

  it('announces as a button and reports its expanded state', () => {
    // Both were deletable with every other test still green. The role is what
    // makes it announce as a control at all; the state is what tells a reader
    // whether the detail is already open.
    const view = render(<ExpandableNotice testID="n" title="6 items skipped" body={NAMES} />);
    expect(view.getByTestId('n-toggle').props.accessibilityRole).toBe('button');
    expect(view.getByTestId('n-toggle').props.accessibilityState).toMatchObject({ expanded: false });
    fireEvent.press(view.getByTestId('n-toggle'));
    expect(view.getByTestId('n-toggle').props.accessibilityState).toMatchObject({ expanded: true });
  });
});

describe('the done screen uses it for skipped items (MEAL-177 wiring)', () => {
  it('collapses the skipped names behind the count after a real skip', () => {
    const ing = {
      ingredientName: 'Sour Cream', searchTerm: 'sour cream',
      productQty: 1, qty: 1, unit: 'qty', measure: null,
    };
    const view = render(
      <WebViewCartSheet
        visible
        meals={[{ id: 'm1', name: 'Tacos', ingredients: [ing] }] as never}
        storeId="heb"
        storeName="H-E-B"
        onClose={() => {}}
      />,
    );
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    post({ type: 'LOGIN_STATUS', isLoggedIn: true });
    post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://www.heb.com/cart' });
    // A candidate that does NOT match the search term exactly, so the item cannot
    // auto-pick and lands on the review screen where skipping is possible.
    post({
      type: 'SEARCH_RESULT',
      candidates: [{ productName: 'Some Other Brand Cream', imageUrl: null, outOfStock: false, preferences: null, price: '$2' }],
    });
    // The run stops on the "Items Not Added" gate first — that screen is the
    // handoff into review, not the review itself.
    act(() => { fireEvent.press(view.getByText(/review 1 item/i)); });
    act(() => { fireEvent.press(view.getByText(/skip this ingredient/i)); });

    // The done screen: the count is visible, the name is not, and there is a
    // toggle to reach it. Before this change the name rendered immediately in a
    // truncating <Text> and there was no toggle at all.
    expect(view.queryByText(/1 item skipped during review/i)).toBeTruthy();
    expect(view.queryByTestId('snapshot-skipped-toggle')).toBeTruthy();
    expect(view.queryByText(/sour cream/i)).toBeNull();

    fireEvent.press(view.getByTestId('snapshot-skipped-toggle'));
    expect(view.queryByText(/sour cream/i)).toBeTruthy();
  });
});
