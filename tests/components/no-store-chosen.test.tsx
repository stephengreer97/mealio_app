// NO STORE CHOSEN: ask for one, do not hand over six manual searches.
//
// Stephen, 2026-09-04: "If a store is not chosen, then we need to surface the
// webview and prompt the user to choose a store."
//
// Four of the five rails cannot run without one — H-E-B, the Albertsons family,
// ALDI's shop and Wegmans' store number all decide what a search may even
// return, so a run without one is shopping a catalogue the user cannot buy
// from. It used to answer that by handing them the store and a list of terms to
// search by hand, which is the most work for the least reason: the fix is one
// tap on a picker that is already on the storefront.
//
// Walmart is the exception and says so itself (needsStoreId: false). Its search
// is national and its cart is the account's; which store fulfils the order is a
// checkout question, and demanding one handed every Walmart run straight to the
// user.
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
      logAutomationStart: jest.fn(async () => 'run-login-poll'),
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
      statusVersion: 1, setSearchTerms: () => {}, getSearchResults: () => new Map(),
    }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { enableRail } from './helpers/railRun';

const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});
const MEALS = [{ id: 'm1', name: 'Tacos', ingredients: [chosen('Sour Cream')] }] as never;

beforeEach(() => { jest.useFakeTimers(); injected.length = 0; });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

const uriOf = (view: { getAllByTestId: (id: string) => Array<{ props: any }> }) =>
  String(view.getAllByTestId('mock-webview')[0].props.source?.uri ?? '');

/** Signed in, session usable, and no store on it. */
function sessionWithoutAStore(storeId = 'heb', type = 'HEB_SESSION') {
  enableRail();
  const view = render(
    <WebViewCartSheet visible meals={MEALS}
      storeId={storeId} storeName={storeId === 'heb' ? 'H-E-B' : 'Walmart'} onClose={() => {}} />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  // The login gate is satisfied — this user IS signed in. What is missing is
  // the store, which is a different question and gets a different screen.
  //
  // No storeId on EITHER answer, and that matters: the login check caches a
  // session only when it carries one, so an answer with a store here would be
  // reused by the run and it would never ask again.
  post({ type, ok: true, loggedIn: true });
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post({ type, ok: true, loggedIn: true });
  return { view, post };
}

describe('a rail that needs a store, on a session that has none', () => {
  it('asks the user to choose one', () => {
    const { view } = sessionWithoutAStore();
    expect(view.queryByTestId('blocker-banner')).toBeTruthy();
    expect(view.queryByText(/choose a H-E-B store/i)).toBeTruthy();
    // And says WHY, because "choose a store" without a reason reads as busywork.
    expect(view.queryByText(/prices and what is in stock are different/i)).toBeTruthy();
  });

  it('shows them the storefront, where the picker is', () => {
    const { view } = sessionWithoutAStore();
    // Not the quiet page: robots.txt has no picker, and nothing else on it either.
    expect(uriOf(view)).not.toContain('robots.txt');
    expect(uriOf(view)).toContain('heb.com');
  });

  it('does NOT hand them a list of searches to do by hand', () => {
    // The old answer. Most work, least reason.
    const { view } = sessionWithoutAStore();
    expect(view.queryByTestId('manual-bar')).toBeNull();
  });

  it('and Try again picks up the store they chose', () => {
    const { view } = sessionWithoutAStore();
    // By testID: the banner itself ends "then tap Try again", so matching on
    // the words presses the sentence rather than the button.
    act(() => { fireEvent.press(view.getByTestId('blocker-retry')); });
    // Back to the login check, which re-reads the session — and with it the
    // store. The banner is gone.
    expect(view.queryByText(/choose a H-E-B store/i)).toBeNull();
  });

  it('leaves the generic wording for a real block', () => {
    // The screen is shared with the challenge case and must still say the right
    // thing there — this banner is the only difference between them.
    const { view, post } = sessionWithoutAStore();
    expect(view.queryByText(/something is blocking mealio/i)).toBeNull();
    void post;
  });
});
