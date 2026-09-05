// MEAL-218. The screen may not tell you off before you have done anything.
//
// Stephen: "improve qty selection forcing in choose and review products.
// Instead of red text, how about a red glow around the qty #?"
//
// The colour was never the problem. Everything went red the MOMENT the screen
// opened -- label, number and a hint line -- so it said the same thing whether
// or not anything was wrong, and a warning that is always on is decoration.
// What replaces it: the unset quantity renders as a dash rather than a 0 (a 0
// looks like a value someone chose), nothing is red on arrival, and pressing
// the button with no quantity set flashes the STEPPER, because the thing to
// press is the +.
//
// The button therefore stays PRESSABLE while it refuses. That is not a detail:
// fireEvent.press does not reach onPress on a disabled Touchable, so a disabled
// button can neither answer the user nor be tested.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(), identifyUser: jest.fn(async () => {}), resetUser: jest.fn(async () => {}),
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
      logAutomationStart: jest.fn(async () => 'run-review-routing'),
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
  enableRail, postToSheet, SESSION_OK, cartCount, searchResult, searchDone, candidate,
} from './helpers/railRun';

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => { (globalThis as any).__flags = { presearchAdd: false, parallelAdd: true }; });

const ing = (ingredientName: string, searchTerm: string) => ({
  ingredientName, searchTerm, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

/**
 * A CHOOSE run, which lands on the quantity stepper directly.
 *
 * An ingredient with no searchTerm has no product chosen yet, so the run
 * searches and hands the user the Choose Products screen -- the same stepper,
 * reached without driving a whole add phase first.
 */
async function atReview() {
  enableRail();
  const view = render(
    <WebViewCartSheet
      visible
      meals={[{ id: 'm1', name: 'Dinner', ingredients: [
        { ingredientName: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
      ] }] as never}
      storeId="heb"
      storeName="H-E-B"
      onClose={() => {}}
    />,
  );
  await act(async () => {});
  const post = (p: Record<string, unknown>) => postToSheet(view, p);
  // NO "Add ingredients" TAP. A run whose ingredients are all unchosen skips the
  // qty step and starts itself -- there is nothing to set a quantity on until a
  // product has been picked, which is exactly the screen under test.
  post(SESSION_OK);
  post(cartCount(0, []));
  post(SESSION_OK);
  post(searchResult('sour cream', [candidate('Daisy Sour Cream, 16 oz')]));
  post(searchDone(1));
  act(() => { jest.advanceTimersByTime(1_500); });
  return view;
}

const stepper = (view: ReturnType<typeof render>) =>
  view.queryByTestId('qty-stepper-m1') ?? view.queryByTestId('qty-stepper-choose');

describe('arriving at the review screen', () => {
  it('shows a dash rather than a zero', async () => {
    const view = await atReview();
    expect(view.queryByText('—')).toBeTruthy();
  });

  it('says nothing in red before the user has done anything', async () => {
    // The specific copy that used to greet everyone.
    const view = await atReview();
    expect(view.queryByText(/set how many this meal needs/i)).toBeNull();
  });

  it('leaves the stepper unlit', async () => {
    const view = await atReview();
    const s = stepper(view);
    expect(s).toBeTruthy();
    // Fully transparent border: the flash has not run. Matched on the ALPHA
    // rather than an exact string -- Animated renders the interpolation with
    // spaces, and the first version of this asserted a string that can never
    // appear.
    expect(JSON.stringify(s!.props.style)).toMatch(/rgba\(239,\s*68,\s*68,\s*0\)/);
  });
});

describe('pressing the button with no quantity set', () => {
  it('does not advance', async () => {
    const view = await atReview();
    act(() => { fireEvent.press(view.getByTestId('review-primary')); });
    act(() => { jest.advanceTimersByTime(500); });
    // Still here, still asking.
    expect(stepper(view)).toBeTruthy();
  });

  it('LIGHTS THE STEPPER — the alert is a reply, not a greeting', async () => {
    // The point of the whole ticket. Before the press the border is fully
    // transparent (asserted above); after it, it is not.
    const view = await atReview();
    const before = JSON.stringify(stepper(view)!.props.style);
    expect(before).toMatch(/rgba\(239,\s*68,\s*68,\s*0\)/);

    act(() => { fireEvent.press(view.getByTestId('review-primary')); });
    act(() => { jest.advanceTimersByTime(160); });

    const after = JSON.stringify(stepper(view)!.props.style);
    expect(after).not.toBe(before);
    // A non-zero alpha somewhere in the red.
    expect(after).toMatch(/rgba\(239,\s*68,\s*68,\s*0?\.?[1-9]/);
  });

  it('reaches onPress at all, which a disabled button would not', async () => {
    // The mechanism, pinned. If this button is ever disabled again, the press
    // never arrives and every assertion in this block passes vacuously.
    const view = await atReview();
    expect(view.getByTestId('review-primary').props.accessibilityState?.disabled)
      .not.toBe(true);
  });

  it('says what is missing on the button itself', async () => {
    const view = await atReview();
    expect(view.queryByText(/choose quantity/i)).toBeTruthy();
  });
});

describe('once a quantity is set', () => {
  it('shows the number instead of the dash', async () => {
    const view = await atReview();
    act(() => { fireEvent.press(view.getAllByText('+')[0]); });
    expect(view.queryByText('—')).toBeNull();
  });

  it('stops offering to choose a quantity', async () => {
    const view = await atReview();
    act(() => { fireEvent.press(view.getAllByText('+')[0]); });
    expect(view.queryByText(/choose quantity/i)).toBeNull();
  });
});


describe('when something OTHER than the quantity is missing', () => {
  it('does not flash the stepper, because the stepper is not the problem', async () => {
    // Selecting "Other" with nothing typed leaves the run blocked on the TEXT,
    // not on the quantity. Flashing the stepper here would point the user at
    // the wrong control, which is worse than saying nothing — so the button
    // goes back to being properly disabled.
    //
    // This is the case a mutant survived: with `otherwiseReady` forced true,
    // every other test in this file still passed, because the choose flow
    // pre-selects a candidate and the quantity really is the only blocker there.
    const view = await atReview();
    act(() => { fireEvent.press(view.getByText(/other — type a product name/i)); });

    const btn = view.getByTestId('review-primary');
    expect(btn.props.accessibilityState?.disabled).toBe(true);

    const before = JSON.stringify(stepper(view)!.props.style);
    act(() => { fireEvent.press(btn); });
    act(() => { jest.advanceTimersByTime(300); });
    expect(JSON.stringify(stepper(view)!.props.style)).toBe(before);
  });
});
