// A search that finds nothing leaves the user on a screen whose only useful
// control is the one that looks least like a control: a row of placeholder text
// under an empty list. The glow points at it.
//
// So the property under test is not "a glow exists" — it is WHEN it exists. It
// has to be absent whenever there is something to pick, or it stops meaning
// "this one" and becomes decoration.

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

jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'run-glow'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});

jest.mock('../../src/lib/automation-config', () => {
  const actual = jest.requireActual('../../src/lib/automation-config');
  return {
    ...actual,
    getAutomationConfig: () => {
      const base = actual.getAutomationConfig();
      return { ...base, flags: { ...base.flags, parallelAdd: false, presearchAdd: false } };
    },
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { enableRail, SESSION_OK } from './helpers/railRun';

const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

/** Drive one item to the review screen with whatever candidates are given. */
async function runToReview(candidates: unknown[]) {
  const view = render(
    <WebViewCartSheet
      visible
      meals={[{ id: 'm1', name: 'Tacos', ingredients: [chosen('sour cream')] }] as never}
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
  enableRail();
  // Twice: the session probe answers the login check, then the run's own
  // session read after the baseline.
  post(SESSION_OK);
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post(SESSION_OK);
  post({ type: 'SEARCH_RESULT', source: 'network', term: 'sour cream', candidates });
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  act(() => { fireEvent.press(view.getByText(/review 1 ingredient/i)); });
  return view;
}

const candidate = (name: string, over: Record<string, unknown> = {}) => ({
  productName: name, imageUrl: null, outOfStock: false, preferences: null, price: '$2', ...over,
});

describe('the "type a product name" row glows when a search found nothing', () => {
  it('glows when there is nothing to choose from', async () => {
    const view = await runToReview([]);
    expect(view.queryByText(/other: type a product name/i)).toBeTruthy();
    expect(view.queryByTestId('custom-row-glow')).toBeTruthy();
  });

  it('does not glow when there are products to pick', async () => {
    // With something to choose, the row is the fallback, not the answer — a glow
    // here would point away from the products the user should be looking at.
    const view = await runToReview([candidate('Some Other Brand Cream')]);
    expect(view.queryByText(/other: type a product name/i)).toBeTruthy();
    expect(view.queryByTestId('custom-row-glow')).toBeNull();
  });

  it('does not glow for an out-of-stock product, which is still a product', async () => {
    // The list is not empty; the user can still see what the store carries and
    // decide. The glow is for having nothing at all.
    const view = await runToReview([candidate('sour cream', { outOfStock: true })]);
    expect(view.queryByTestId('custom-row-glow')).toBeNull();
  });
});
