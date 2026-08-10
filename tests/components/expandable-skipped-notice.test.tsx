// MEAL-177 — the skipped-items list must be reachable, not truncated.
//
// The done screen told the user "N items skipped during review" and then rendered
// the names with numberOfLines={3}. A run that skipped a dozen items showed three
// of them, with no affordance to see the rest — and looked complete while doing
// it, which is the part that makes silent truncation worse than either honest
// alternative.
//
// The fix is the affordance, not the hiding. Collapsing the names away entirely
// would have been a worse trade — three lines hold about ten comma-joined
// grocery names, so truncation only bit at 12+ skipped items while collapsing
// would have hidden the names on every run, including the one-item case. So the
// collapsed state shows exactly what it always showed, RN's trailing ellipsis
// appears when (and only when) there is genuinely more, and the tap reaches it.
//
// Two levels here, deliberately:
//
//   1. The component's behaviour — collapsed previews the list under a line cap,
//      tapping reveals all of it, and the revealed list scrolls inside a bounded
//      height instead of growing the sheet.
//   2. The WIRING — a real run, a real skip, a real done screen. Without this the
//      component could be perfect and unused; the previous code path rendered
//      plain <Text> and would have passed every test in group 1.

import { act, fireEvent, render } from '@testing-library/react-native';

// A cart run logs its completion through `usage`, and with the real module that
// is a live POST to https://mealio.co/api/usage/automation — a production
// automation-run row written by the test suite, and a suite that fails when the
// box is offline. Both sibling sheet tests stub it for the same reason.
jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'expandable-skipped'),
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

import ExpandableNotice from '../../src/components/ui/ExpandableNotice';
import WebViewCartSheet from '../../src/components/WebViewCartSheet';

describe('ExpandableNotice (MEAL-177)', () => {
  const NAMES = 'Sour Cream, Tortillas, Cheese, Salsa, Limes, Cilantro';

  it('shows the summary AND a preview of the list while collapsed', () => {
    const view = render(<ExpandableNotice testID="n" title="6 items skipped" body={NAMES} />);
    // The count is the part that must survive collapsing — hiding it would hide
    // the fact that anything happened.
    expect(view.queryByText('6 items skipped')).toBeTruthy();
    // And the names are still there. This is the assertion that inverts the
    // first cut: collapsing them away regressed every run under a dozen items.
    expect(view.queryByText(NAMES)).toBeTruthy();
  });

  it('caps the collapsed preview and marks the cut with a trailing ellipsis', () => {
    // The "..." is what makes the row read as tappable, so it is asserted rather
    // than left to RN's default. ellipsizeMode only draws it when the text
    // actually overflows the cap, which is why a short list promises nothing.
    const view = render(<ExpandableNotice testID="n" title="6 items skipped" body={NAMES} />);
    const preview = view.getByTestId('n-preview');
    expect(preview.props.numberOfLines).toBe(3);
    expect(preview.props.ellipsizeMode).toBe('tail');
  });

  it('honours a caller-set preview height', () => {
    const view = render(<ExpandableNotice testID="n" title="t" body={NAMES} collapsedLines={5} />);
    expect(view.getByTestId('n-preview').props.numberOfLines).toBe(5);
  });

  it('drops the cap on tap so the whole list is reachable, and restores it', () => {
    const view = render(<ExpandableNotice testID="n" title="6 items skipped" body={NAMES} />);
    fireEvent.press(view.getByTestId('n-toggle'));
    // Expanded: no line cap at all — the point of the ticket.
    expect(view.queryByTestId('n-preview')).toBeNull();
    expect(view.getByTestId('n-body')).toBeTruthy();
    expect(view.queryByText(NAMES)).toBeTruthy();
    fireEvent.press(view.getByTestId('n-toggle'));
    expect(view.getByTestId('n-preview').props.numberOfLines).toBe(3);
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
    // The ellipsis is a visual signal only, so the label carries the affordance
    // for a reader that never sees it.
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

  it('expands when the ellipsized preview itself is tapped', () => {
    // The "…" is what the collapsed state offers as the signal that there is
    // more, so it has to be inside the target. An affordance that ignores the
    // finger teaches the user there is nothing behind it.
    const view = render(<ExpandableNotice testID="n" title="6 items skipped" body={NAMES} />);
    fireEvent.press(view.getByTestId('n-preview'));
    expect(view.queryByTestId('n-preview')).toBeNull();
    expect(view.getByTestId('n-body')).toBeTruthy();
  });
});

describe('the done screen uses it for skipped items (MEAL-177 wiring)', () => {
  const mounted: Array<{ unmount: () => void }> = [];

  // A cart run arms real timeouts — the cart probe, the add jitter — and this
  // one reaches 'done' with several still pending. Left alone they fire after
  // the test has finished ("Cannot log after tests are done") and hold the
  // worker open. Nothing here waits on a timer.
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => {
    while (mounted.length) mounted.pop()!.unmount();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('previews the skipped names under a cap, with a toggle to the rest, after a real skip', () => {
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
    mounted.push(view);
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

    // The done screen: the count is visible, the name is still visible, and
    // there is now a toggle that lifts the line cap. Before this change the name
    // rendered in a truncating <Text> with no toggle at all — everything past
    // the third line was simply unreachable.
    expect(view.queryByText(/1 item skipped during review/i)).toBeTruthy();
    expect(view.queryByTestId('snapshot-skipped-toggle')).toBeTruthy();
    const preview = view.getByTestId('snapshot-skipped-preview');
    expect(preview.props.numberOfLines).toBe(3);
    expect(view.queryByText(/sour cream/i)).toBeTruthy();

    // Reverting the wiring to a plain <Text> fails here: there is no toggle to
    // press, and nothing lifts the cap.
    fireEvent.press(view.getByTestId('snapshot-skipped-toggle'));
    expect(view.queryByTestId('snapshot-skipped-preview')).toBeNull();
    expect(view.getByTestId('snapshot-skipped-body')).toBeTruthy();
    expect(view.queryByText(/sour cream/i)).toBeTruthy();
  });
});
