// A SESSION THAT CANNOT ANSWER IS NOT A SIGNED-OUT USER.
//
// The rail parks on a quiet page — robots.txt — so its requests get the renderer
// to themselves instead of queueing behind the storefront's own bundles. The
// cost of that is a session the site has never bootstrapped, and on Wegmans it
// is worse than that: MSAL renews its token pair only where the site's own code
// runs, so an hour after the user last opened the store there is a valid cookie
// jar and no usable token anywhere.
//
// There used to be a DOM login check behind that case. It is gone (2026-09-04),
// and nothing replaced it as a SECOND OPINION, because two answers to one
// question is how a signed-in ALDI user got shown a sign-in wall. What replaced
// it asks the SITE: load the real storefront, let its JavaScript run, and ask
// the same probe again on that page.
//
// MEASURED on the Pixel, 2026-09-04, and this is what the window length is for:
//
//   09:05:23.25  session: ok:false why:token_expired   -> load the storefront
//   09:05:24.05  storefront loaded
//   09:05:24.79  ok:false        (the load's own re-injection)
//   09:05:24.90  ok:false        (and its second)
//   09:05:43.57  ok:true loggedIn:true                 <- MSAL, nineteen seconds
//
// The first version of this allowed three ASKS. The page's own load events spent
// two of them inside 900ms and the third went 1.5s later, so the whole repair
// was over 3.4 seconds in, on a page that needed nineteen. The user got a
// sign-in screen one second before the store said they were signed in.

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

/** Tap Add and get an answer the probe could not make. */
function cannotAnswer() {
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
  post({ type: 'HEB_SESSION', ok: false, why: 'token_expired' });
  return { view, post };
}

/** Session probes injected so far. */
const checks = () => injected.filter((s) => s.includes('myPreferredStore')).length;
/** Where the sheet's WebView is pointed. */
const uri = (view: { getAllByTestId: (id: string) => Array<{ props: any }> }) =>
  String(view.getAllByTestId('mock-webview')[0].props.source?.uri ?? '');

describe('when the probe cannot answer, the site is asked to fix itself', () => {
  it('loads the real storefront, not the quiet page', () => {
    // robots.txt is where the rail lives precisely BECAUSE it runs none of the
    // site's JavaScript. Asking again there would get the same answer forever.
    const { view } = cannotAnswer();
    expect(uri(view)).toContain('heb.com');
    expect(uri(view)).not.toContain('robots.txt');
  });

  it('does not show the user a sign-in screen for it', () => {
    // The whole point. This user IS signed in; their token has aged out.
    const { view } = cannotAnswer();
    expect(view.queryByText(/log into your H-E-B account/i)).toBeNull();
  });

  it('keeps asking across the window, not for three answers', () => {
    // THE BUG THIS FILE EXISTS FOR. The storefront load posts answers of its
    // own — two inside 900ms on the device — and a repair budgeted in ASKS is
    // spent by them before the site has done anything.
    const { post } = cannotAnswer();
    const before = checks();
    post({ type: 'HEB_SESSION', ok: false, why: 'token_expired' });
    post({ type: 'HEB_SESSION', ok: false, why: 'token_expired' });
    post({ type: 'HEB_SESSION', ok: false, why: 'token_expired' });
    // Those cost nothing: one ask is pending, however many answers arrive.
    act(() => { jest.advanceTimersByTime(2_100); });
    expect(checks()).toBe(before + 1);
    // Twenty seconds in — past where the old version had given up — it is still
    // asking, because the device measurement above says nineteen.
    for (let i = 0; i < 9; i++) {
      post({ type: 'HEB_SESSION', ok: false, why: 'token_expired' });
      act(() => { jest.advanceTimersByTime(2_100); });
    }
    expect(checks()).toBeGreaterThanOrEqual(before + 9);
  });

  it('and never lets the login timeout fire underneath it', () => {
    // The login check's deadline is for a store that never answers. This store
    // is answering — it is answering "not yet" — and dropping the user on a
    // sign-in screen mid-repair is what the device run did.
    const { view, post } = cannotAnswer();
    // Past the login check's own 20s deadline — that is the point. Without the
    // re-arm this is where the device run put a sign-in screen in front of a
    // signed-in user.
    for (let i = 0; i < 12; i++) {
      post({ type: 'HEB_SESSION', ok: false, why: 'token_expired' });
      act(() => { jest.advanceTimersByTime(2_100); });
    }
    expect(view.queryByText(/log into your H-E-B account/i)).toBeNull();
  });

  it('starts the run the moment the site produces a session', () => {
    const { view, post } = cannotAnswer();
    act(() => { jest.advanceTimersByTime(2_100); });
    post({
      type: 'HEB_SESSION', ok: true, loggedIn: true,
      storeId: '476', shoppingContext: 'CURBSIDE_DELIVERY',
    });
    expect(view.queryByText(/log into your H-E-B account/i)).toBeNull();
    // The run is under way, with nobody having touched anything: the sheet is
    // reading the cart for its before-baseline, which is the first thing a rail
    // run does once the session is usable.
    // The run is under way with nobody having touched anything.
    expect(view.queryByText(/Finding Products/i)).toBeTruthy();
  });

  it('never while the user is signing in', () => {
    // The repair NAVIGATES, and on the login step the page it would navigate
    // away from is a sign-in form with the user's typing in it. An unanswerable
    // session is guaranteed there — H-E-B's sign-in is on accounts.heb.com, so
    // the script is cross-origin and cannot answer by construction.
    //
    // Caught on the device minutes after the repair shipped:
    //   10:32:44  login: navigating to .../my-account/login
    //   10:32:46  onLoadEnd accounts.heb.com/interaction/.../login
    //   10:32:49  onLoadEnd https://www.heb.com/?_t=...
    //
    // The run reaches the login step WITHOUT an inconclusive answer first, so
    // the repair window is untouched and the next ok:false is its FIRST — the
    // one that navigates. Getting here any other way spends the first attempt
    // early and the test passes whether or not the guard exists.
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
    expect(view.queryByText(/log into your H-E-B account/i)).toBeTruthy();
    const onTheForm = uri(view);
    expect(onTheForm).toContain('/my-account/login');
    // Now the poll asks from the sign-in page and cannot get an answer.
    for (let i = 0; i < 5; i++) {
      post({ type: 'HEB_SESSION', ok: false, why: 'no_response' });
      act(() => { jest.advanceTimersByTime(2_100); });
    }
    // The user is still on the form they were typing into.
    expect(uri(view)).toBe(onTheForm);
  });

  it('gives up eventually, rather than holding the user forever', () => {
    // A ceiling, not a wait. Past it the login check's own timeout takes over
    // and hands the storefront to the user, which is the honest end of a session
    // nothing could establish.
    const { view, post } = cannotAnswer();
    for (let i = 0; i < 25; i++) {
      post({ type: 'HEB_SESSION', ok: false, why: 'token_expired' });
      act(() => { jest.advanceTimersByTime(2_100); });
    }
    act(() => { jest.advanceTimersByTime(20_000); });
    expect(view.queryByText(/log into your H-E-B account/i)).toBeTruthy();
  });
});
