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

  it('says signing in once is the whole of it', () => {
    const { view } = atTheLoginScreen();
    expect(view.queryByText(/log into your H-E-B account once and Mealio won.t ask again/i)).toBeTruthy();
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

  it('slows down only when the page has stopped moving', () => {
    // NOT after a fixed number of ticks. Stephen: "it definately takes longer
    // than 30 seconds to login with 2FA" — and most of that is a user waiting
    // for a text, which a tick count reads as "nobody is here".
    const { post } = atTheLoginScreen();
    // Nothing happens for a minute: no loads, no redirects.
    for (let i = 0; i < 60; i++) {
      act(() => { jest.advanceTimersByTime(1_100); });
      post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
    }
    const before = checks();
    act(() => { jest.advanceTimersByTime(1_100); });
    expect(checks()).toBe(before);            // a second no longer buys one
    act(() => { jest.advanceTimersByTime(4_500); });
    expect(checks()).toBe(before + 1);        // five does
  });

  it('goes quick again the moment the page moves', () => {
    // Entering the 2FA code is a navigation. A login three minutes in is as
    // responsive as one three seconds in.
    const { view, post } = atTheLoginScreen();
    for (let i = 0; i < 60; i++) {
      act(() => { jest.advanceTimersByTime(1_100); });
      post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
    }
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onNavigationStateChange({
        url: 'https://www.heb.com/my-account', loading: false,
      });
    });
    post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
    const before = checks();
    act(() => { jest.advanceTimersByTime(1_100); });
    expect(checks()).toBe(before + 1);
  });
});

describe('what you can watch in the log', () => {
  // Stephen, 2026-09-02: "do we have any logging that I can watch for this login
  // checker probe?" There was none — the timer asked in complete silence, which
  // made a poll you cannot see doing a job you cannot verify.
  //
  // ONE TAG for the whole conversation, so `grep login-poll` follows a sign-in
  // start to finish: what triggered each ask, what came back, how long it took,
  // when the rate changes and when it stops.
  const lines = (): string[] => {
    const spy = console.log as unknown as jest.Mock;
    return spy.mock.calls
      .map((c) => c.map((x: unknown) => String(x)).join(' '))
      .filter((l) => l.includes('[login-poll]'));
  };
  let spy: jest.SpyInstance;
  beforeEach(() => { spy = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { spy.mockRestore(); });

  it('says when it starts, what it is asking and how often', () => {
    atTheLoginScreen();
    expect(lines().some((l) => /started .* heb every 1000ms/.test(l))).toBe(true);
  });

  it('names what triggered each ask', () => {
    const { view, post } = atTheLoginScreen();
    act(() => { jest.advanceTimersByTime(1_100); });
    post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
    expect(lines().some((l) => l.includes('ask #1 (timer)'))).toBe(true);
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onNavigationStateChange({
        url: 'https://www.heb.com/my-account', loading: false,
      });
    });
    expect(lines().some((l) => l.includes('ask #2 (page moved, no load'))).toBe(true);
  });

  it('pairs the answer with its question, and times it', () => {
    const { post } = atTheLoginScreen();
    act(() => { jest.advanceTimersByTime(1_100); });
    post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
    expect(lines().some((l) => /ask #1 → signed out in \d+ms/.test(l))).toBe(true);
  });

  it('does not pair an answer with a question nobody asked', () => {
    // The login check that PUT the user on this screen is not a poll answer.
    // Logging it as one produced "ask #0 → signed out in 1788401254337ms".
    atTheLoginScreen();
    expect(lines().some((l) => l.includes('ask #0'))).toBe(false);
  });

  it('says SIGNED IN when that is what came back', () => {
    const { post } = atTheLoginScreen();
    act(() => { jest.advanceTimersByTime(1_100); });
    post({ type: 'HEB_SESSION', ok: true, loggedIn: true, storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY' });
    expect(lines().some((l) => l.includes('→ SIGNED IN'))).toBe(true);
  });

  it('says when the rate changes, once, not on every tick', () => {
    const { post } = atTheLoginScreen();
    for (let i = 0; i < 60; i++) {
      act(() => { jest.advanceTimersByTime(1_100); });
      post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
    }
    const slowed = lines().filter((l) => l.includes('every 5000ms'));
    expect(slowed.length).toBe(1);
    expect(slowed[0]).toMatch(/nothing has happened/);
  });

  it('says when it stops, and how many it asked', () => {
    const { post } = atTheLoginScreen();
    act(() => { jest.advanceTimersByTime(1_100); });
    post({ type: 'HEB_SESSION', ok: true, loggedIn: true, storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY' });
    expect(lines().some((l) => /stopped after 1 ask\(s\)/.test(l))).toBe(true);
  });

  it('does not dump the whole answer once a second', () => {
    // The full-JSON line was written for a one-shot login check and now sits in
    // a poll. Two hundred characters per tick is how the rail phase got pushed
    // out of the device log once already. The routine ticks get the compact
    // line; the whole answer is kept for the ones that decide something.
    const all = (): string[] => (console.log as unknown as jest.Mock).mock.calls
      .map((c) => c.map((x: unknown) => String(x)).join(' '));
    const { post } = atTheLoginScreen();
    // Measured from AFTER the setup: the check that put the user on this screen
    // is not a poll answer, and it is right that it gets the full line.
    const dumpsBefore = all().filter((l) => l.includes('login answered over the network')).length;
    for (let i = 0; i < 5; i++) {
      act(() => { jest.advanceTimersByTime(1_100); });
      post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
    }
    expect(all().filter((l) => l.includes('login answered over the network')).length).toBe(dumpsBefore);
    expect(lines().filter((l) => /ask #\d+ → signed out/.test(l)).length).toBe(5);

    // ...but a signed-IN answer is worth the whole thing: it starts a run.
    post({ type: 'HEB_SESSION', ok: true, loggedIn: true, storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY' });
    expect(all().some((l) => l.includes('login answered over the network'))).toBe(true);
  });

  it('says when an ask went unanswered', () => {
    atTheLoginScreen();
    act(() => { jest.advanceTimersByTime(1_100); });
    act(() => { jest.advanceTimersByTime(13_000); });
    expect(lines().some((l) => l.includes('never answered in'))).toBe(true);
  });
});

describe('the redirect after signing in', () => {
  // Stephen, 2026-09-02: "After a login, the user is redirected. Can we not
  // detect that redirect and then poll the login when that happens?"
  //
  // It already did, and that is worth a test rather than a shrug: the re-check
  // is gated on isLoginSuccessUrl / reinjectLoginCheckOnNav, and every store in
  // the catalogue passes it — H-E-B and the Albertsons family through
  // reinjectLoginCheckOnNav. Nothing here was untested because it was missing;
  // it was untested because nobody had asked.
  //
  // (A first attempt "ungated" it for rail stores and was a no-op. The mutant
  // that removed the ungate passed every test, which is how it was caught.)
  //
  // What genuinely was missing is the second case below: a sign-in that finishes
  // without a page load at all.
  it('asks the moment the page finishes loading', () => {
    const { view } = atTheLoginScreen();
    const load = (url: string) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onLoadEnd({ nativeEvent: { url } });
    });
    // The FIRST load drains the queue the login step left behind, so it never
    // reaches the gated branch at all. It is the loads AFTER it — which is what
    // a redirect chain and a 2FA flow are made of — that do.
    load('https://www.heb.com/');
    const before = checks();
    load('https://www.heb.com/my-account');
    expect(checks()).toBe(before + 1);
  });

  it('asks on a step that re-renders without a load', () => {
    // The sign-in that finishes in place. onLoadEnd never fires for it.
    const { view } = atTheLoginScreen();
    const before = checks();
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onNavigationStateChange({
        url: 'https://www.heb.com/my-account', loading: false,
      });
    });
    expect(checks()).toBe(before + 1);
  });

  it('does not ask twice for the same URL', () => {
    const { view } = atTheLoginScreen();
    const nav = (url: string) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onNavigationStateChange({ url, loading: false });
    });
    const before = checks();
    nav('https://www.heb.com/my-account');
    nav('https://www.heb.com/my-account');
    expect(checks()).toBe(before + 1);
  });

  it('ignores a navigation that has not finished', () => {
    const { view } = atTheLoginScreen();
    const before = checks();
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onNavigationStateChange({
        url: 'https://www.heb.com/my-account', loading: true,
      });
    });
    expect(checks()).toBe(before);
  });
});
