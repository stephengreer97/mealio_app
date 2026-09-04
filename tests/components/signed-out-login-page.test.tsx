// A signed-out rail store must be shown a page it can sign in on.
//
// FOUND ON THE PIXEL, 2026-09-04, TWICE. H-E-B, signed out: the sheet said
// "Log in to H-E-B", told the user "Log into your H-E-B account once and Mealio
// won't ask again", and rendered a blank white page. Nothing to type into.
//
// The rail parks on robots.txt so its requests are not queued behind the
// storefront's own bundles. Four separate routes lead to the login step, each
// deciding for itself whether to navigate first, and the two a rail store
// actually uses did not navigate at all — they set the step and left the
// WebView on the quiet page. The first fix reached the other two, which is how
// this was found twice: the device showed the same blank page after it.
//
// So the routes are one function now (surfaceLogin), and this exercises the one
// a rail store takes: its session probe answering loggedIn:false.
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
      reload: () => { (global as any).__onReload?.(); },
      stopLoading: () => {}, goBack: () => {},
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

import * as fs from 'fs';
import * as path from 'path';

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { enableRail } from './helpers/railRun';

const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});
const MEALS = [{ id: 'm1', name: 'Tacos', ingredients: [chosen('sour cream')] }] as never;

beforeEach(() => { jest.useFakeTimers(); injected.length = 0; });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

const uriOf = (view: { getAllByTestId: (id: string) => Array<{ props: any }> }) =>
  String(view.getAllByTestId('mock-webview')[0].props.source?.uri ?? '');

/** Tap Add, land on the quiet page, then be told the session is signed out. */
function signedOutOnTheQuietPage() {
  enableRail();
  const view = render(
    <WebViewCartSheet visible meals={MEALS}
      storeId="heb" storeName="H-E-B" onClose={() => {}} />,
  );
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });
  const load = (url: string) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onLoadEnd({ nativeEvent: { url } });
  });
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  // The quiet page lands, exactly as it does on a device — this is what made
  // the old "are we already on the store's domain" test answer yes.
  load('https://www.heb.com/robots.txt?_t=1788535270654.1');
  return { view, post, load };
}

describe('a signed-out rail store', () => {
  it('is taken off the quiet page to somewhere it can sign in', () => {
    const { view, post } = signedOutOnTheQuietPage();
    post({ type: 'HEB_SESSION', ok: true, loggedIn: false });
    expect(view.queryByText(/log into your H-E-B account/i)).toBeTruthy();
    // THE ASSERTION. robots.txt has no sign-in form; the login URL does.
    expect(uriOf(view)).not.toContain('robots.txt');
    expect(uriOf(view)).toContain('/my-account/login');
  });

  it('and every OTHER route to the login step goes through the same door', () => {
    // The bug was four routes, each deciding for itself whether to navigate.
    // Two of them — the ones a rail store actually takes — decided not to. This
    // is the check that there is one door, because reaching each of the four
    // through the component costs more than it proves, and a fifth route added
    // later is exactly how this comes back.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/components/WebViewCartSheet.tsx'), 'utf8');
    const sets = [...src.matchAll(/setStep\('login'\)/g)];
    // One: inside surfaceLogin itself.
    expect(sets.length).toBe(1);
    // And it is that one — the line above it names the function.
    const at = src.indexOf("setStep('login')");
    expect(src.slice(0, at)).toMatch(/const surfaceLogin = useCallback\([\s\S]*$/);
  });

  it('leaves a real store page alone, which is why the skip exists', () => {
    // A store whose check opened a sign-in menu must not have it navigated out
    // from under the user. That was the whole reason for the skip, and it still
    // holds — the rule changed from "on this domain" to "can sign in here".
    enableRail();
    const view = render(
      <WebViewCartSheet visible meals={MEALS}
        storeId="heb" storeName="H-E-B" onClose={() => {}} />,
    );
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onLoadEnd({
        nativeEvent: { url: 'https://www.heb.com/my-account/sign-in-menu-open' },
      });
    });
    const before = uriOf(view);
    act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify({ type: 'HEB_SESSION', ok: true, loggedIn: false }) },
      });
    });
    expect(uriOf(view)).toBe(before);
  });
});
