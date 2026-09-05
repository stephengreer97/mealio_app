// A WEIGHT AND A COUNT ARE DIFFERENT WIDTHS (MEAL-179).
//
// On the pre-automation add-to-cart screen the stepper column was 20px wide,
// which is right for "1" and "12" and far too narrow for "0.75 lb". With
// nothing stopping it the label wrapped to "0.7" / "5" / "lb": three lines in a
// row sized for one.
//
// The string was never the problem. `weightLabelLb` returns exactly what it
// should; the column it had to fit in was sized for a different kind of value.
//
// This asserts the LAYOUT rather than the text, because the text was already
// correct and a test for it passed all the way through the bug. What can be
// checked without a device is the resolved style on the node and the wrap
// setting, and those are the two things that were wrong.
import { render } from '@testing-library/react-native';

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
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(() => new Promise(() => {})),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { weightLabelLb } from '../../src/lib/weightDisplay';

/** Sold by the pound: `weightStep` is what makes the row a weight row. */
const WEIGHED = {
  ingredientName: 'Bulk Coffee',
  searchTerm: 'bulk coffee',
  productQty: 3,
  qty: 3,
  unit: 'qty',
  measure: null,
  weightStep: 0.25,
};

const COUNTED = {
  ingredientName: 'Sour Cream',
  searchTerm: 'sour cream',
  productQty: 3,
  qty: 3,
  unit: 'qty',
  measure: null,
};

function renderWith(ingredients: object[]) {
  return render(
    <WebViewCartSheet
      visible
      meals={[{ id: 'm1', name: 'Dinner', ingredients }] as never}
      storeId="aldi"
      storeName="ALDI"
      onClose={() => {}}
    />,
  );
}

/** The width the stepper cell actually resolves to, flattened style and all. */
function widthOf(node: { props: Record<string, any> }): number | undefined {
  const flat = [node.props.style].flat(Infinity).filter(Boolean) as Array<Record<string, unknown>>;
  // Later entries win, the way React Native merges an array style.
  return flat.reduce<number | undefined>(
    (acc, s) => (typeof s.width === 'number' ? s.width : acc),
    undefined,
  );
}

const text = (node: { props: Record<string, any> }) =>
  [node.props.children].flat(Infinity).join('');

describe('the stepper cell on the add-to-cart screen', () => {
  it('shows the weight, which was never the broken part', () => {
    const { getByTestId } = renderWith([WEIGHED]);
    // 3 steps of 0.25 lb.
    expect(text(getByTestId('qty-num-0'))).toBe(weightLabelLb(0.75));
    expect(text(getByTestId('qty-num-0'))).toBe('0.75 lb');
  });

  it('is wide enough for that label to sit on one line', () => {
    const { getByTestId } = renderWith([WEIGHED]);
    const width = widthOf(getByTestId('qty-num-0'));
    // The failing width was 20. "0.75 lb" is seven characters at 13px, so
    // anything near 20 wraps it however the string is written.
    expect(width).toBeGreaterThanOrEqual(56);
  });

  it('never wraps, whatever the label turns out to be', () => {
    // The width is sized for the longest label `weightLabelLb` can produce.
    // This is the guard for the day something longer arrives: truncating on one
    // line is a legible wrong, three lines in a one-line row is not.
    const { getByTestId } = renderWith([WEIGHED]);
    expect(getByTestId('qty-num-0').props.numberOfLines).toBe(1);
  });

  it('stays narrow for a plain count, so a list of counts keeps its names', () => {
    // Widening every row would take 36px of ingredient name from every screen
    // that has no weights on it at all, which is most of them.
    const { getByTestId } = renderWith([COUNTED]);
    expect(text(getByTestId('qty-num-0'))).toBe('3');
    expect(widthOf(getByTestId('qty-num-0'))).toBe(20);
  });
});
