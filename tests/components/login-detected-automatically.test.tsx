// Nobody should have to tell Mealio they are signed in.
//
// The login screen carried an "I'm already logged in" button. Stephen, 2026-09-02:
// "see if you can get rid of the I am Already Logged in Button. Can we jsut do a
// login detection check every 100ms?"
//
// The button existed because the page-load re-check is GATED — it fires only on
// `isLoginSuccessUrl` or `reinjectLoginCheckOnNav` — so a store with neither, or
// a sign-in that finishes without a navigation we notice, left a signed-in user
// looking at a prompt with no way forward but that button.
//
// NOT every 100ms, and the reason is measured: this is a request to the STORE,
// not a page read. H-E-B's session probe is two GraphQL posts; Albertsons' is a
// fetch to its account endpoint, timed at 455ms. At 100ms that is 10-20 requests
// a second at the operation a store watches hardest, and half of them would be
// asking a question the previous one had not answered. One second, never
// overlapping, slowing to five after the first thirty.

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

beforeEach(() => { jest.useFakeTimers(); injected.length = 0; });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

/** Tap Add, be told you are signed out, and land on the login screen. */
function atTheLoginScreen() {
  enableRail();
  const view = render(
    <WebViewCartSheet visible meals={[{ id: 'm1', name: 'Tacos', ingredients: [chosen('sour cream')] }] as never}
      storeId="heb" storeName="H-E-B" onClose={() => {}} />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
  return { view, post };
}

/** Session probes injected so far. */
const checks = () => injected.filter((s) => s.includes('myPreferredStore')).length;

describe('the login screen', () => {
  it('does not offer an "I am already logged in" button any more', () => {
    const { view } = atTheLoginScreen();
    expect(view.queryByText(/already logged in/i)).toBeNull();
  });

  it('tells the user they can just sign in and leave it', () => {
    const { view } = atTheLoginScreen();
    expect(view.queryByText(/carry on by itself/i)).toBeTruthy();
  });
});

describe('asking the store on a timer instead', () => {
  it('asks again while the user is signing in', () => {
    const { post } = atTheLoginScreen();
    const before = checks();
    act(() => { jest.advanceTimersByTime(1_100); });
    expect(checks()).toBe(before + 1);
    // Answered signed-out; the next tick asks again.
    post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
    act(() => { jest.advanceTimersByTime(1_100); });
    expect(checks()).toBe(before + 2);
  });

  it('never has two questions out at once', () => {
    // A store slower than the interval must not get a second copy of the same
    // question on top of the first. That burst is the shape this repo keeps
    // having to undo.
    const { post } = atTheLoginScreen();
    const before = checks();
    act(() => { jest.advanceTimersByTime(1_100); });   // one goes out
    act(() => { jest.advanceTimersByTime(5_000); });   // ...and is never answered
    expect(checks()).toBe(before + 1);
    // Once it answers, the poll resumes.
    post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
    act(() => { jest.advanceTimersByTime(1_100); });
    expect(checks()).toBe(before + 2);
  });

  it('gives up on an answer that never comes, rather than stopping for good', () => {
    // A single dropped request must not end the poll — the user would be back to
    // having no way forward, which is the whole problem being removed.
    const { post } = atTheLoginScreen();
    const before = checks();
    act(() => { jest.advanceTimersByTime(1_100); });
    expect(checks()).toBe(before + 1);
    act(() => { jest.advanceTimersByTime(13_000); });   // past the answer window
    expect(checks()).toBeGreaterThan(before + 1);
    post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
  });

  it('starts the run the moment the store says they are in', () => {
    const { view, post } = atTheLoginScreen();
    act(() => { jest.advanceTimersByTime(1_100); });
    post({
      type: 'HEB_SESSION', ok: true, loggedIn: true,
      storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY',
    });
    // Off the login screen without the user touching anything.
    expect(view.queryByText(/log in to your h-e-b account/i)).toBeNull();
  });

  it('stops asking once the user is off the login screen', () => {
    const { post } = atTheLoginScreen();
    post({
      type: 'HEB_SESSION', ok: true, loggedIn: true,
      storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY',
    });
    const after = checks();
    act(() => { jest.advanceTimersByTime(20_000); });
    expect(checks()).toBe(after);
  });

  it('slows down once nobody is plausibly still typing', () => {
    // Thirty seconds covers actually signing in. Past that the sheet is sitting
    // open and a request a second is just noise the store has to serve.
    const { post } = atTheLoginScreen();
    const start = checks();
    for (let i = 0; i < 30; i++) {
      act(() => { jest.advanceTimersByTime(1_100); });
      post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
    }
    const fast = checks() - start;
    expect(fast).toBe(30);

    // Now a second buys nothing more.
    const before = checks();
    act(() => { jest.advanceTimersByTime(1_100); });
    expect(checks()).toBe(before);
    act(() => { jest.advanceTimersByTime(4_500); });
    expect(checks()).toBe(before + 1);
  });
});
