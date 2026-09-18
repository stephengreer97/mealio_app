// ONLY THE STORE MAY STEER A RUN.
//
// The sheet's WebView can be navigated off the store (a link, a redirect, an
// ad) and the message bridge goes with it. onMessage used to act on whatever
// any page posted, so another site could answer the session probe, post search
// results or report adds. A message whose page is not the locked store's is now
// dropped. The allow-list itself is pinned in tests/unit/webview-message-origin.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(), identifyUser: jest.fn(async () => {}), resetUser: jest.fn(async () => {}),
}));

const injected: string[] = [];
jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: (s: string) => { (global as any).__injected.push(s); },
      reload: () => {}, stopLoading: () => {}, goBack: () => {},
    }));
    return RealReact.createElement(RealView, { testID: props.testID || 'mock-webview', ...props });
  });
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});
(global as any).__injected = injected;

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
      logAutomationStart: jest.fn(async () => 'run-origin'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});
// 'unknown', so the sheet runs its own login check rather than trusting a
// prewarm — which is how a user reaches the login screen at all.
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      checkStore: () => {}, getStatus: () => 'unknown', takePrewarmedCart: () => null,
      signedOutIsMeasured: () => !!(global as any).__measuredOut,
      statusVersion: 1, setSearchTerms: () => {}, getSearchResults: () => new Map(),
      noteLiveVerdict: () => {},
    }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { enableRail } from './helpers/railRun';

const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

beforeEach(() => { jest.useFakeTimers(); injected.length = 0; });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

function startRun() {
  enableRail();
  const view = render(
    <WebViewCartSheet visible meals={[{ id: 'm1', name: 'Tacos', ingredients: [chosen('sour cream')] }] as never}
      storeId="heb" storeName="H-E-B" onClose={() => {}} />,
  );
  const postFrom = (url: string | undefined, payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload), ...(url ? { url } : {}) },
    });
  });
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  return { view, postFrom };
}

const SIGNED_IN = { type: 'HEB_SESSION', ok: true, loggedIn: true, storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY' };

it('ignores a session answer posted by another site', () => {
  const { view, postFrom } = startRun();
  postFrom('https://evil.example/landing', SIGNED_IN);
  expect(view.queryByText(/Finding Products/i)).toBeNull();
});

it('ignores one from a host that merely contains the store domain', () => {
  const { view, postFrom } = startRun();
  postFrom('https://heb.com.evil.example/', SIGNED_IN);
  expect(view.queryByText(/Finding Products/i)).toBeNull();
});

it('acts on the same answer from the store', () => {
  const { view, postFrom } = startRun();
  postFrom('https://www.heb.com/robots.txt', SIGNED_IN);
  expect(view.queryByText(/Finding Products/i)).toBeTruthy();
});
