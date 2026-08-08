// MEAL-31 wiring: a SELECTOR_HEALTH message arriving on the bridge reaches the
// run's tally, and reaches nothing else.
//
// The probe and the tally are tested on their own in tests/unit/selectorHealth.
// What only this level can prove is the seam between them: the message is a
// bridge message like any other, so a branch in the wrong place either drops the
// samples (the feature silently measures nothing) or eats a message the cart
// engine was waiting on (the feature breaks a run — the one thing telemetry is
// not allowed to do). Both are asserted here.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, _ref: any) =>
    RealReact.createElement(RealView, { testID: props.testID || 'mock-webview', ...props }),
  );
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

// The real tally, with every ingest recorded. Subclassed rather than stubbed so
// what the sheet is wired to is the object that actually ships — a jest.fn()
// here would pass just as happily against a tally that could not count.
jest.mock('../../src/lib/selector-health', () => {
  const actual = jest.requireActual('../../src/lib/selector-health');
  class RecordingTally extends actual.SelectorHealthTally {
    ingest(sel: unknown) {
      ((globalThis as any).__ingested ||= []).push(sel);
      super.ingest(sel);
    }
  }
  return { ...actual, SelectorHealthTally: RecordingTally };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { SELECTOR_HEALTH_MESSAGE } from '../../src/lib/selector-health';

const ingested = () => ((globalThis as any).__ingested ?? []) as unknown[];

beforeEach(() => { (globalThis as any).__ingested = []; });

const meal = {
  id: 'm1',
  name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
};

/** Render, start the run, and return a way to post messages onto the bridge. */
function startRun() {
  const view = render(
    <WebViewCartSheet visible meals={[meal]} storeId="aldi" storeName="ALDI" onClose={() => {}} />,
  );
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  const post = (payload: Record<string, unknown>) => {
    const webview = view.getAllByTestId('mock-webview')[0];
    act(() => {
      webview.props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
    });
  };
  return { ...view, post };
}

describe('SELECTOR_HEALTH on the cart bridge', () => {
  it('reaches the run\'s tally', () => {
    const { post } = startRun();
    post({ type: SELECTOR_HEALTH_MESSAGE, sel: { card: 0, title: 1 } });
    expect(ingested()).toEqual([{ card: 0, title: 1 }]);
  });

  it('accumulates across the run rather than replacing', () => {
    const { post } = startRun();
    post({ type: SELECTOR_HEALTH_MESSAGE, sel: { card: 0 } });
    post({ type: SELECTOR_HEALTH_MESSAGE, sel: { card: -1 } });
    expect(ingested()).toEqual([{ card: 0 }, { card: -1 }]);
  });

  it('does not disturb the step machine', () => {
    // The sample arrives between a script's result and the next one. If the
    // branch were placed after the engine's own dispatch — or forgot to return —
    // this message would fall through into it.
    const { post, getByText } = startRun();
    expect(getByText(/checking login/i)).toBeTruthy();
    post({ type: SELECTOR_HEALTH_MESSAGE, sel: { card: 0 } });
    expect(getByText(/checking login/i)).toBeTruthy();
  });

  it('lets the engine\'s own messages through untouched', () => {
    // The other half: a branch that matched too eagerly would swallow the login
    // result and hang the run on its safety timeout.
    const { post, queryByText } = startRun();
    post({ type: 'LOGIN_STATUS', isLoggedIn: false });
    expect(queryByText(/checking login/i)).toBeNull();
    expect(ingested()).toEqual([]);
  });
});
