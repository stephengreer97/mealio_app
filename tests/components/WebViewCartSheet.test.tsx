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

describe('WebViewCartSheet — the pre-run header counts items, not lines', () => {
  // Stephen: "the add to cart pre automation screen says 18 ingredients at the
  // top. Since two of them have count of two, I actually want it to say 20
  // items." The header counted rows in the list; the quantities on those rows
  // are what actually goes in the cart.
  const twoOfSome = {
    id: 'm1',
    name: 'Tacos',
    ingredients: [
      { ingredientName: 'Lime', searchTerm: 'lime', productQty: 2, qty: 2, unit: 'qty', measure: null },
      { ingredientName: 'Roma Tomato', searchTerm: 'roma tomato', productQty: 2, qty: 2, unit: 'qty', measure: null },
      { ingredientName: 'Avocado', searchTerm: 'avocado', productQty: 1, qty: 1, unit: 'qty', measure: null },
    ],
  };

  it('sums the quantities rather than counting the rows', () => {
    const { getByText } = render(
      <WebViewCartSheet visible meals={[twoOfSome]} storeId="aldi" storeName="ALDI" onClose={() => {}} />,
    );
    // 3 rows, quantities 2 + 2 + 1 = 5.
    expect(getByText(/5 items/)).toBeTruthy();
  });

  it('says "1 item", not "1 items"', () => {
    const one = { id: 'm2', name: 'Snack', ingredients: [
      { ingredientName: 'Lime', searchTerm: 'lime', productQty: 1, qty: 1, unit: 'qty', measure: null },
    ] };
    const { getByText } = render(
      <WebViewCartSheet visible meals={[one]} storeId="aldi" storeName="ALDI" onClose={() => {}} />,
    );
    expect(getByText(/1 item(?!s)/)).toBeTruthy();
  });
});

describe('WebViewCartSheet — login_check timeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('falls back to the login webview when LOGIN_STATUS never arrives', () => {
    // WALMART, because this is the DOM login check's timeout and Walmart is a
    // store that still uses it. ALDI used to be the vehicle here and gained a
    // rail (MEAL-208), which answers the login question over the network
    // instead — so the test was no longer exercising the path it names. The
    // rail's own equivalent is covered in login-detected-automatically.test.tsx.
    const { getByText, queryByText } = render(
      <WebViewCartSheet
        visible
        meals={[baseMeal()]}
        storeId="amazon"
        storeName="Amazon Fresh"
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

// MEAL-65: qty 0 unchecks the box and strikes the name. The row was already
// excluded from the run at qty 0 — this pins the feedback that was missing, and
// the weight-priced exception that must NOT be struck out.
describe('WebViewCartSheet — qty 0 feedback (MEAL-65)', () => {
  /** Does this element's style (array or object) carry a strikethrough? */
  const isStruckThrough = (el: any) => {
    const flat = [el.props.style].flat(Infinity).filter(Boolean);
    return flat.some((s: any) => s && s.textDecorationLine === 'line-through');
  };

  const renderSheet = (ingredients?: any[]) =>
    render(
      <WebViewCartSheet
        visible
        meals={[ingredients ? baseMeal({ ingredients }) : baseMeal()]}
        storeId="aldi"
        storeName="ALDI"
        onClose={() => {}}
      />,
    );

  /** What the stepper is showing for a row, as text. */
  const qtyOf = (el: any) => [el.props.children].flat(Infinity).join('');

  it('shows a checked, un-struck row at qty 1', () => {
    const { getByText, queryByTestId } = renderSheet();
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
    expect(isStruckThrough(getByText('sour cream'))).toBe(false);
  });

  it('unchecks the box and strikes the name once qty hits 0', () => {
    const { getByText, queryByTestId } = renderSheet();
    act(() => { fireEvent.press(getByText('−')); });
    expect(queryByTestId('qty-checked-0')).toBeNull();
    expect(isStruckThrough(getByText('sour cream'))).toBe(true);
  });

  it('disables the run CTA at qty 0 — the row really is excluded', () => {
    const { getByText } = renderSheet();
    act(() => { fireEvent.press(getByText('−')); });
    // activeCount === 0 → CTA disabled, so pressing it must not leave qty.
    act(() => { fireEvent.press(getByText(/add ingredients to/i)); });
    expect(getByText(/add ingredients to/i)).toBeTruthy();
  });

  it('restores qty 1 and re-checks when the + is pressed from 0', () => {
    const { getByText, queryByTestId } = renderSheet();
    act(() => { fireEvent.press(getByText('−')); });
    act(() => { fireEvent.press(getByText('+')); });
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
    expect(isStruckThrough(getByText('sour cream'))).toBe(false);
  });

  it('restores qty 1 when the checkbox is tapped from 0 — not a dead tap', () => {
    const { getByText, getByTestId, queryByTestId } = renderSheet();
    act(() => { fireEvent.press(getByText('−')); });
    act(() => { fireEvent.press(getByTestId('qty-checkbox-0')); });
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
    expect(isStruckThrough(getByText('sour cream'))).toBe(false);
  });

  it('keeps the quantity when the box is unchecked at qty ≥ 1', () => {
    const { getByText, getByTestId, queryByTestId } = renderSheet();
    act(() => { fireEvent.press(getByTestId('qty-checkbox-0')); });
    expect(queryByTestId('qty-checked-0')).toBeNull();
    expect(isStruckThrough(getByText('sour cream'))).toBe(true);
    act(() => { fireEvent.press(getByTestId('qty-checkbox-0')); });
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
  });

  it('preserves the NUMBER across an uncheck/recheck — 3 units come back as 3', () => {
    // At qty 1 "preserved" and "clobbered to 1" are indistinguishable, so the
    // case above cannot tell them apart. The restore path (updateQty(i, 1)) is
    // for ZEROED rows only; 3 units must survive a round trip as 3.
    const { getByTestId, queryByTestId } = renderSheet([
      { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 3, qty: 3, unit: 'qty', measure: null },
    ]);
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('3');

    act(() => { fireEvent.press(getByTestId('qty-checkbox-0')); });
    expect(queryByTestId('qty-checked-0')).toBeNull();
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('3'); // not touched on the way out

    act(() => { fireEvent.press(getByTestId('qty-checkbox-0')); });
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('3'); // and not on the way back in
  });

  it('recovers from doubly-excluded — "Uncheck all" on an already-zeroed row', () => {
    // The only route into unchecked AND zeroed at once: the steppers are dead
    // while the box is off, so qty can only reach 0 with the box still on, and
    // the box can only go off afterwards via the header. One checkbox tap has
    // to clear BOTH exclusions or the row is stranded.
    const { getByText, getByTestId, queryByTestId } = renderSheet();
    act(() => { fireEvent.press(getByText('−')); });
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('0');

    act(() => { fireEvent.press(getByText('Uncheck all')); });
    expect(queryByTestId('qty-checked-0')).toBeNull();
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('0');

    // Both steppers are disabled here — no way up except the checkbox.
    act(() => { fireEvent.press(getByText('+')); });
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('0');

    act(() => { fireEvent.press(getByTestId('qty-checkbox-0')); });
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
    expect(qtyOf(getByTestId('qty-num-0'))).toBe('1');
    expect(isStruckThrough(getByText('sour cream'))).toBe(false);
  });

  it('never strikes out a weight-priced item — its stepper floors at one step', () => {
    // Sold-by-weight (a chosen purchaseWeight): the stepper adjusts the WEIGHT
    // and floors at one step, so the row can never zero out and must keep
    // reading as included. See isZeroedOut / isWeightPriced.
    const { getByText, queryByTestId } = renderSheet([
      {
        ingredientName: 'Deli Turkey',
        searchTerm: 'deli turkey',
        productQty: 1,
        qty: 1,
        unit: 'lb',
        measure: '0.5',
        purchaseWeight: 0.5,
        weightStep: 0.25,
      },
    ]);
    expect(getByText('0.5 lb')).toBeTruthy();
    // Step down to the floor, then keep pressing: still weight-priced, still in.
    act(() => { fireEvent.press(getByText('−')); });
    expect(getByText('0.25 lb')).toBeTruthy();
    act(() => { fireEvent.press(getByText('−')); });
    expect(getByText('0.25 lb')).toBeTruthy();
    expect(queryByTestId('qty-checked-0')).toBeTruthy();
    expect(isStruckThrough(getByText('deli turkey'))).toBe(false);
    expect(getByText(/add ingredients to/i)).toBeTruthy();
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
