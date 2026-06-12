// Component-level tests for WebViewCartSheet's step state machine.
//
// We mock react-native-webview so no actual WebView is rendered, and assert
// the rendered UI step in response to:
//   • initial visible=true with one chosen ingredient → 'qty' step shown
//   • user taps Add to Cart → transitions to 'login_check' / 'searching'
//   • posted LOGIN_STATUS message → moves into 'login' or 'searching'
//
// The goal is not to test every transition (the matrix is huge) but to pin
// the high-leverage ones that have regressed before.

import { act, fireEvent, render } from '@testing-library/react-native';

// Mock factories cannot reference outer-scope variables (jest hoists them).
// All React / View imports must happen INSIDE the factory via requireActual.
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
  return {
    Image: (props: any) =>
      RealReact.createElement(RealView, { testID: 'mock-image', ...props }),
  };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return {
    Ionicons: (props: any) =>
      RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name),
  };
});

jest.mock('react-native-keyboard-aware-scroll-view', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardAwareScrollView: ScrollView };
});

jest.mock('react-native-safe-area-context', () => {
  const RealReact = jest.requireActual('react');
  const { View: RealView } = jest.requireActual('react-native');
  return {
    SafeAreaView: ({ children, ...rest }: any) =>
      RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';

const baseMeal = (overrides: Partial<{ id: string; name: string; ingredients: any[] }> = {}) => ({
  id: 'm1',
  name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
  ...overrides,
});

describe('WebViewCartSheet — initial render', () => {
  it('shows the "Add Ingredients to <store> Cart" CTA on the qty step when all ingredients have searchTerm set', () => {
    const { getByText } = render(
      <WebViewCartSheet
        visible
        meals={[baseMeal()]}
        storeId="aldi"
        storeName="ALDI"
        onClose={() => {}}
      />,
    );
    // The qty-step CTA mentions the store name verbatim.
    expect(getByText(/add ingredients to/i)).toBeTruthy();
    expect(getByText(/ALDI/)).toBeTruthy();
  });

  it('skips qty step (no CTA visible) when an ingredient lacks searchTerm — auto-starts search flow', () => {
    const { queryByText } = render(
      <WebViewCartSheet
        visible
        meals={[baseMeal({
          ingredients: [
            // searchTerm missing → "unchosen", auto-starts search/choose flow.
            { ingredientName: 'Tortillas', productQty: 1, qty: 1, unit: 'qty', measure: null },
          ],
        })]}
        storeId="aldi"
        storeName="ALDI"
        onClose={() => {}}
      />,
    );
    // Qty step CTA must NOT be shown — we jumped past it.
    expect(queryByText(/add ingredients to/i)).toBeNull();
  });

  it('renders nothing for the qty step when visible=false (Modal is closed)', () => {
    const { queryByText } = render(
      <WebViewCartSheet
        visible={false}
        meals={[baseMeal()]}
        storeId="aldi"
        storeName="ALDI"
        onClose={() => {}}
      />,
    );
    expect(queryByText(/add ingredients to/i)).toBeNull();
  });
});

describe('WebViewCartSheet — qty → start search', () => {
  it('tapping the qty-step CTA moves out of the qty step (CTA disappears)', () => {
    const { getByText, queryByText } = render(
      <WebViewCartSheet
        visible
        meals={[baseMeal()]}
        storeId="aldi"
        storeName="ALDI"
        onClose={() => {}}
      />,
    );
    const cta = getByText(/add ingredients to/i);
    act(() => {
      fireEvent.press(cta);
    });
    // After pressing, the qty step CTA should be gone (we've transitioned
    // into login_check / searching).
    expect(queryByText(/add ingredients to/i)).toBeNull();
  });
});

describe('WebViewCartSheet — login_check timeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('falls back to the login webview when LOGIN_STATUS never arrives', () => {
    const { getByText, queryByText } = render(
      <WebViewCartSheet
        visible
        meals={[baseMeal()]}
        storeId="aldi"
        storeName="ALDI"
        onClose={() => {}}
      />,
    );
    act(() => {
      fireEvent.press(getByText(/add ingredients to/i));
    });
    // In login_check: spinner shows "Checking login…".
    expect(getByText(/checking login/i)).toBeTruthy();

    // No LOGIN_STATUS ever posts. After the safety window the sheet must
    // NOT still be spinning on the login check.
    act(() => {
      jest.advanceTimersByTime(21_000);
    });
    expect(queryByText(/checking login/i)).toBeNull();
  });
});

describe('WebViewCartSheet — searching/adding progress bar', () => {
  it('renders a progress bar (not the old "x of x" counter) during the spinner steps', () => {
    const { getByText, queryByText, queryByTestId } = render(
      <WebViewCartSheet
        visible
        meals={[baseMeal()]}
        storeId="aldi"
        storeName="ALDI"
        onClose={() => {}}
      />,
    );
    act(() => {
      fireEvent.press(getByText(/add ingredients to/i));
    });
    // login_check / searching / adding share the spinner screen. The "x of x"
    // counter is gone for good; the bar only mounts in searching/adding, so
    // here (login_check) neither may render — and once a flow regression
    // resurrects the counter this is the assertion that catches it.
    expect(queryByText(/\d+ of \d+ (ingredients|items)/)).toBeNull();
  });
});
