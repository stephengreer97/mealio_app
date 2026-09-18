// THE ADD PHASE'S DEADLINE STOPS THE WRITES IT GAVE UP WAITING FOR.
//
// When the add phase times out, the sheet finalizes with what has come back and
// moves on to the read that decides what still needs adding. It did not stop
// the batch it had sent, so a write still going underneath could land after
// that read, and the top-up would add the same item again: an over-add. Both
// sides of the bridge are told now, the page (__mealioStop) and this process
// (nativeStop), which every driver's write loop reads before each write.

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
      injectJavaScript: (js: string) => { ((globalThis as any).__injected ||= []).push(js); },
      stopLoading: () => {}, goBack: () => {}, reload: () => {},
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
      logAutomationStart: jest.fn(async () => 'add-timeout-stop'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async (batch: any) => {
        ((globalThis as any).__batches ||= []).push(batch);
        return true;
      }),
    },
  };
});

// Serial route, so the run is driven by messages this test posts rather than by
// a worker pool. Nothing here is about concurrency.
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
import { nativeGen, __resetNativeRunForTests } from '../../src/lib/native-rail/run';

const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

const addDeadlineMs = (items: number) =>
  require('../../src/lib/webview-scripts/network-rail').getNetworkRail('heb').budgets.addMs(items);

const stopsInjected = () =>
  (((globalThis as any).__injected ?? []) as string[]).filter((s) => s.includes('__mealioStop')).length;

beforeEach(() => {
  jest.useFakeTimers();
  (globalThis as any).__injected = [];
  __resetNativeRunForTests();
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

it('stops both transports when the add phase times out', async () => {
  const view = render(
    <WebViewCartSheet visible meals={[{ id: 'm1', name: 'Tacos', ingredients: [chosen('Sour Cream')] }] as never}
      storeId="heb" storeName="H-E-B" onClose={() => {}} />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
  });
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  await act(async () => {});
  enableRail();
  post(SESSION_OK);
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post(SESSION_OK);
  post({
    type: 'SEARCH_RESULT', source: 'network', term: 'Sour Cream',
    candidates: [{ productName: 'Sour Cream', imageUrl: null, outOfStock: false, preferences: null,
      price: '$2', productId: 'p1', skuId: 's1' }],
  });
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });

  // The write is out and the store never answers it.
  const genBefore = nativeGen();
  const stopsBefore = stopsInjected();
  act(() => { jest.advanceTimersByTime(addDeadlineMs(1) + 100); });

  expect(nativeGen()).toBeGreaterThan(genBefore);
  expect(stopsInjected()).toBeGreaterThan(stopsBefore);
  view.unmount();
});
