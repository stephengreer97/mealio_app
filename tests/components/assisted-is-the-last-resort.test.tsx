// "DO IT YOURSELF" IS THE LAST RESORT, and it has to be structurally last.
//
// Stephen, 2026-09-04: "I want to change the do it yourself logic to only ever
// appear if these retries all fail. That should be the only scenario a user
// ever sees the do it yourself logic."
//
// It was the answer to eleven different questions instead. Every dead end in
// the run called netHandOverToUser, and that opened the store's search page
// whether the run had learned nothing or nearly everything. Three things now
// have to be true before a user sees it, and each one is a test below:
//
//   1. The whole-run retry has been spent.
//   2. There is nothing the review screen could show.
//   3. ...and even then it only happens once, because the retry allowance is
//      per run and a rerun does not refill it.
//
// Asserted on the SCREEN, not on decideHandover: [[measure-the-feature-not-the-
// function]], and the last time a routing change was checked at the function it
// shipped to two stores out of six.

import { act, fireEvent, render } from '@testing-library/react-native';

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
    meals: { ...actual.meals, update: jest.fn(() => new Promise(() => {})) },
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'run-review-routing'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      checkStore: () => {}, getStatus: () => 'loggedIn', takePrewarmedCart: () => null,
      statusVersion: 1, setSearchTerms: () => {}, getSearchResults: () => new Map(),
    }),
  };
});
jest.mock('../../src/lib/automation-config', () => {
  const actual = jest.requireActual('../../src/lib/automation-config');
  return {
    ...actual,
    getAutomationConfig: () => {
      const base = actual.getAutomationConfig();
      return {
        ...base,
        flags: { ...base.flags, ...((globalThis as any).__flags ?? {}) },
        stores: { ...base.stores, ...((globalThis as any).__stores ?? {}) },
      };
    },
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import {
  enableRail, postToSheet, SESSION_OK, cartCount, searchResult, searchDone, candidate,
} from './helpers/railRun';

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => { (globalThis as any).__flags = { presearchAdd: false, parallelAdd: true }; });

const SESSION_DEAD = { type: 'HEB_SESSION', ok: false, why: 'no_response' };

function openSheet() {
  enableRail();
  const view = render(
    <WebViewCartSheet
      visible
      meals={[{ id: 'm1', name: 'Dinner', ingredients: [
        { ingredientName: 'Sour Cream', searchTerm: 'sour cream',
          productQty: 1, qty: 1, unit: 'qty', measure: null },
      ] }] as never}
      storeId="heb"
      storeName="H-E-B"
      onClose={() => {}}
    />,
  );
  const post = (p: Record<string, unknown>) => postToSheet(view, p);
  return { view, post };
}

/** Start the run and get as far as the session ask. */
function beginRun() {
  const { view, post } = openSheet();
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  act(() => { jest.advanceTimersByTime(2_000); });
  post(SESSION_OK);
  act(() => { jest.advanceTimersByTime(500); });
  post(cartCount(0, []));
  act(() => { jest.advanceTimersByTime(500); });
  return { view, post };
}

/**
 * The assisted step, by its testID.
 *
 * NOT by its copy: "add it yourself" is split across nested Text nodes, so a
 * queryByText for it never matches and the assertion passes on every screen.
 */
const onAssistedScreen = (view: ReturnType<typeof render>) =>
  !!view.queryByTestId('manual-bar');

describe('a transient dead end reruns the run before it gives up', () => {
  it('does not open the store on the first session failure', () => {
    const { view, post } = beginRun();
    post(SESSION_DEAD);
    act(() => { jest.advanceTimersByTime(200); });
    expect(onAssistedScreen(view)).toBe(false);
  });

  it('is running again a beat later, and takes a session when offered one', () => {
    const { view, post } = beginRun();
    post(SESSION_DEAD);
    act(() => { jest.advanceTimersByTime(2_000); });
    // The rerun is a REAL run: it asks for the session again, and an answer
    // this time carries it into the search phase.
    post(SESSION_OK);
    act(() => { jest.advanceTimersByTime(500); });
    post(searchResult('sour cream', [candidate('Sour Cream, 16 oz')]));
    post(searchDone(1));
    act(() => { jest.advanceTimersByTime(500); });
    expect(onAssistedScreen(view)).toBe(false);
  });
});

describe('the allowance is one, and a rerun does not refill it', () => {
  it('opens the store on the SECOND failure, not the first', () => {
    const { view, post } = beginRun();
    post(SESSION_DEAD);
    act(() => { jest.advanceTimersByTime(2_000); });
    expect(onAssistedScreen(view)).toBe(false);   // retried, not surrendered
    // The rerun fails the same way. There is nothing to review -- no term ever
    // got an answer -- so this is the one scenario that earns the store.
    post(SESSION_DEAD);
    act(() => { jest.advanceTimersByTime(2_000); });
    expect(onAssistedScreen(view)).toBe(true);
  });

  it('does not rerun forever', () => {
    // The loop this guards against: reset the allowance inside startNetworkRun
    // instead of at the start of the flow, and every rerun refills it.
    const { view, post } = beginRun();
    for (let i = 0; i < 5; i++) {
      post(SESSION_DEAD);
      act(() => { jest.advanceTimersByTime(2_000); });
    }
    expect(onAssistedScreen(view)).toBe(true);
  });
});

describe('anything the run learned goes to review instead', () => {
  it('shows the product it found rather than the store search page', () => {
    const { view, post } = beginRun();
    // The run's OWN session, not the login check's -- beginRun stops at the
    // first. Without this the run is still in its session phase and drops the
    // search result, and the test passes for the wrong reason.
    post(SESSION_OK);
    act(() => { jest.advanceTimersByTime(500); });
    // The search answers, and THEN the run hits its deadline. Under the old
    // routing this handed the user the term it had already found a product for.
    post(searchResult('sour cream', [candidate('Friendly Farms Sour Cream, 16 oz')]));
    act(() => { jest.advanceTimersByTime(500); });
    act(() => { jest.advanceTimersByTime(200_000); });   // past the search deadline
    expect(view.queryByText('Friendly Farms Sour Cream, 16 oz')).toBeTruthy();
    expect(onAssistedScreen(view)).toBe(false);
  });
});

