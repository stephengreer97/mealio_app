// MEAL-64: all three preview surfaces hand a tap handler to useDraggablePreview.
//
// The ticket's real requirement is consistency — a full-screen view that works
// on two surfaces out of three is worse than none, because the user learns the
// photo is not tappable. The tap itself is a captured PanResponder gesture and
// needs a device; what a test CAN hold is that every surface subscribes to it,
// which is the thing a future refactor would silently drop.

import { render } from '@testing-library/react-native';

// Mock factories cannot reference outer-scope variables (jest hoists them), so
// the spy is created inside and pulled back out through the mocked import.
jest.mock('../../src/lib/useDraggablePreview', () => {
  const preview = {
    transform: [],
    panHandlers: {},
    onContainerLayout: jest.fn(),
    onAnchorLayout: jest.fn(),
    reset: jest.fn(),
    setDefaultOffset: jest.fn(),
    scrollEnabled: true,
  };
  return {
    __esModule: true,
    useDraggablePreview: jest.fn(() => preview),
    isTapGesture: () => true,
    TAP_SLOP_PX: 8,
  };
});

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
  return { Image: (props: any) => RealReact.createElement(RealView, props) };
});

jest.mock('@expo/vector-icons', () => {
  const RealReact = jest.requireActual('react');
  const RealText = jest.requireActual('react-native').Text;
  return {
    Ionicons: (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name),
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
    SafeAreaView: ({ children, ...rest }: any) => RealReact.createElement(RealView, rest, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

// The whole api module is replaced, so every export the three sheets touch has
// to be here. Searches never resolve — these tests only need the first render.
jest.mock('../../src/lib/api', () => ({
  kroger: { searchProducts: jest.fn(() => new Promise(() => {})) },
  meals: { update: jest.fn(() => new Promise(() => {})) },
  usage: {
    logAutomationStart: jest.fn(() => Promise.resolve(null)),
    logAutomationComplete: jest.fn(() => Promise.resolve(null)),
    logAutomationSteps: jest.fn(() => Promise.resolve(null)),
  },
}));

import { useDraggablePreview as useDraggablePreviewMock } from '../../src/lib/useDraggablePreview';
import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import KrogerCartReviewSheet from '../../src/components/KrogerCartReviewSheet';
import ProductChooserSheet from '../../src/components/ProductChooserSheet';

const meal = {
  id: 'm1',
  name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
} as any;

const useDraggablePreview = useDraggablePreviewMock as unknown as jest.Mock;

/** The 4th argument of the most recent useDraggablePreview call. */
const lastOnTap = () => useDraggablePreview.mock.calls.at(-1)?.[3];

describe('MEAL-64 — every preview surface subscribes to the tap', () => {
  beforeEach(() => useDraggablePreview.mockClear());

  it('WebViewCartSheet (reconcile, WebView stores)', () => {
    render(
      <WebViewCartSheet visible meals={[meal]} storeId="aldi" storeName="ALDI" onClose={() => {}} />,
    );
    expect(typeof lastOnTap()).toBe('function');
  });

  it('KrogerCartReviewSheet (reconcile, Kroger)', () => {
    render(
      <KrogerCartReviewSheet
        visible
        meals={[meal]}
        locationId="loc1"
        storeId="kroger"
        storeName="Kroger"
        onClose={() => {}}
      />,
    );
    // Kroger converged onto the shared hook + FloatingPreviewImage; before
    // MEAL-64 it drew its own pointerEvents="none" box and called nothing.
    expect(useDraggablePreview).toHaveBeenCalled();
    expect(typeof lastOnTap()).toBe('function');
  });

  it('ProductChooserSheet (Choose Product)', () => {
    render(
      <ProductChooserSheet
        visible
        meal={meal}
        locationId="loc1"
        storeName="Kroger"
        storeColor="#003087"
        onClose={() => {}}
        onMealUpdated={() => {}}
      />,
    );
    expect(typeof lastOnTap()).toBe('function');
  });
});
