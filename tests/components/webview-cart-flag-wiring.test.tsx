// The remote flags actually reach the cart's decisions (MEAL-162).
//
// `automationConfigDecisions.test.ts` proves the decision FUNCTIONS. This proves
// the wiring — that the sheet hands them the real config rather than a literal,
// a stale snapshot, or nothing.
//
// That distinction is the entire history of MEAL-32. Four flags merged,
// validated and logged as applied while nothing consumed them; the guard added
// to catch it read the component's SOURCE, lost five rounds to comments and
// strings, and then lost two more to value flow. Extracting the decisions into
// pure functions killed the source-text family for good — and moved the hole one
// level up, which a cold review caught: with the functions covered but the call
// sites not, `flags: {}` at a call site restored the original defect verbatim
// (merged, validated, inert) and passed all 1922 tests, while `origin/main`
// killed it.
//
// So these tests vary a flag and assert the cart behaves differently. No source
// is inspected. Every mutant of the "call site stops passing the real flags"
// shape fails here, because a literal cannot vary.
//
// The observable is the parked pre-search workers: the pool mounts one WebView
// per parked item on the qty screen, offscreen, where RNTL still finds them.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  // A ref that records WHEN each script is injected. The other cart tests hand
  // back no ref at all, so `injectJavaScript` is a no-op there and nothing sees
  // the scripts — and the pre-search commit's delay is the one flag effect that
  // is only visible here.
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: () => { ((globalThis as any).__injectedAt ||= []).push(Date.now()); },
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
      logAutomationStart: jest.fn(async () => 'run-flag-wiring'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});

// Signed in, so the pre-search effect can get past its login gate. Same reason
// and same shape as `webview-cart-selector-health.test.tsx`.
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      checkStore: () => {},
      getStatus: () => 'loggedIn',
      takePrewarmedCart: () => null,
      statusVersion: 1,
    }),
  };
});

// The config the sheet reads, overridable per test. The REAL merge and bundled
// defaults underneath — only the flags block is swapped, so a test cannot
// accidentally assert against a config shape that could never ship.
jest.mock('../../src/lib/automation-config', () => {
  const actual = jest.requireActual('../../src/lib/automation-config');
  return {
    ...actual,
    getAutomationConfig: () => {
      const base = actual.getAutomationConfig();
      return { ...base, flags: { ...base.flags, ...((globalThis as any).__flags ?? {}) } };
    },
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';

type Ing = { ingredientName: string; searchTerm?: string; productQty: number; qty: number; unit: string; measure: string | null };

const chosen = (name: string): Ing => ({
  ingredientName: name, searchTerm: name.toLowerCase(), productQty: 1, qty: 1, unit: 'qty', measure: null,
});

const sheet = (...ingredients: Ing[]) => (
  <WebViewCartSheet
    visible
    meals={[{ id: 'm1', name: 'Tacos', ingredients }] as never}
    storeId="walmart"
    storeName="Walmart"
    onClose={() => {}}
  />
);

/** WebViews mounted while still on the qty screen: the main one, plus parked workers. */
function parkedOnQtyScreen(flags: Record<string, unknown>) {
  (globalThis as any).__flags = flags;
  // Four chosen items: the first parked slot is the COLD one (the main WebView
  // enlisted as an extra add surface), so a short run never reaches a tile.
  const view = render(sheet(chosen('Sour Cream'), chosen('Tortillas'), chosen('Cheese'), chosen('Salsa')));
  act(() => { jest.advanceTimersByTime(5_000); });
  // Still on the qty screen — this is the parking phase, before any tap.
  expect(view.getByText(/add ingredients to/i)).toBeTruthy();
  // `queryAll`, not `getAll`: with parking off there are ZERO WebViews on the
  // qty screen — the main one mounts when the run starts — and `getAll` throws
  // on an empty match rather than returning 0.
  const count = view.queryAllByTestId('mock-webview').length;
  view.unmount();
  return count;
}

beforeEach(() => { jest.useFakeTimers(); (globalThis as any).__flags = {}; (globalThis as any).__injectedAt = []; });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); (globalThis as any).__flags = {}; (globalThis as any).__injectedAt = []; });

describe('flags.presearchAdd reaches the parking decision', () => {
  it('parks workers when on, and none when off', () => {
    const on = parkedOnQtyScreen({ presearchAdd: true });
    const off = parkedOnQtyScreen({ presearchAdd: false });

    // Not vacuous: parking really happened in the ON case, so the OFF case is a
    // difference rather than two empty runs. Measured 3 and 0.
    expect(on).toBeGreaterThan(0);
    expect(off).toBe(0);
  });

  it('is read from the config the sheet actually holds', () => {
    // The mutant this exists for: a call site that stops passing `cfgFlags` —
    // `flags: {}` or `flags: { presearchAdd: true }` — is inert against the real
    // config, which is precisely the MEAL-32 defect. A literal cannot vary, so
    // it cannot produce these two different answers.
    expect(parkedOnQtyScreen({ presearchAdd: true })).not.toBe(parkedOnQtyScreen({ presearchAdd: false }));
  });

  it('cannot be routed around by a second arming site', () => {
    // A live arming block placed before the gate, repeating every non-flag
    // condition and omitting only `flags.presearchAdd`, survived the whole suite
    // when this file did not exist. With the flag off, NOTHING may park.
    expect(parkedOnQtyScreen({ presearchAdd: false })).toBe(0);
  });
});

describe('flags.parallelAddWorkers reaches the pool size', () => {
  it('parks more workers when the flag is raised', () => {
    // The flag whose read could be replaced with an unused constant while every
    // test passed — the fifth review's survivor, and the reason this ticket
    // exists. It is a number the cart acts on, so it is a number a test can see.
    const few = parkedOnQtyScreen({ presearchAdd: true, parallelAddWorkers: 1 });
    const many = parkedOnQtyScreen({ presearchAdd: true, parallelAddWorkers: 3 });

    expect(many).toBeGreaterThan(few);
  });
});

describe('flags.parallelAddWorkers reaches BOTH pools', () => {
  // `PARALLEL_ADD_WORKER_COUNT` feeds two of them: the pre-search pool and the
  // parallel-ADD pool. The parking test above watches only the first, so
  // hardcoding the second's `workerCount` left the flag inert on the route that
  // runs in the common `presearchAdd:false, parallelAdd:true` configuration —
  // and the full suite stayed green. Same defect as the call-site mutants, one
  // consumer over, which is why this asserts the other pool by itself.
  const poolSize = (workers: number) => {
    (globalThis as any).__flags = { presearchAdd: false, parallelAdd: true, parallelAddWorkers: workers };
    const view = render(sheet(
      chosen('Sour Cream'), chosen('Tortillas'), chosen('Cheese'), chosen('Salsa'), chosen('Beans'),
    ));
    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    const post = (payload: Record<string, unknown>) => act(() => {
      view.queryAllByTestId('mock-webview')[0]?.props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });
    post({ type: 'LOGIN_STATUS', isLoggedIn: true });
    post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://example.test/cart' });
    act(() => { jest.advanceTimersByTime(5_000); });
    const count = view.queryAllByTestId('mock-webview').length;
    view.unmount();
    return count;
  };

  it('sizes the parallel-ADD pool too, not only the parked one', () => {
    const few = poolSize(1);
    const many = poolSize(5);

    expect(many).toBeGreaterThan(few);
  });
});

describe('flags.parallelAdd reaches the add route', () => {
  it('runs serially when the kill switch is off', () => {
    // The lever's whole purpose: stop adding concurrently without a release.
    // Pre-search is off here so the run takes the parallel-ADD branch rather
    // than committing parked workers — the two flags are separate halves and
    // this asserts the second one alone.
    const started = (flags: Record<string, unknown>) => {
      (globalThis as any).__flags = flags;
      const view = render(sheet(chosen('Sour Cream'), chosen('Tortillas')));
      act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
      // The route is only chosen once the run reaches `beginSearchFlow`, which is
      // gated behind the login answer and the before-cart baseline. Both are
      // messages the store's own scripts really post; without them the run stops
      // before the decision and both flag values look identical.
      const post = (payload: Record<string, unknown>) => act(() => {
        view.queryAllByTestId('mock-webview')[0]?.props.onMessage({
          nativeEvent: { data: JSON.stringify(payload) },
        });
      });
      post({ type: 'LOGIN_STATUS', isLoggedIn: true });
      post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://example.test/cart' });
      act(() => { jest.advanceTimersByTime(5_000); });
      const count = view.queryAllByTestId('mock-webview').length;
      view.unmount();
      return count;
    };

    const parallel = started({ presearchAdd: false, parallelAdd: true });
    const serial = started({ presearchAdd: false, parallelAdd: false });

    expect(parallel).toBeGreaterThan(1);
    expect(serial).toBe(1);
  });
});

describe('flags.addCommitJitterMs reaches the wire', () => {
  // The narrowest of the four, and the one that hid the longest. Passing the
  // BUILD CONSTANT to `setTimeout` while still computing the jitter kept every
  // test green: the config read and the randomisation both stopped reaching the
  // store, silently. The retired source-text oracle used to pin it by matching
  // `, jitter);`.
  //
  // I first claimed this was unreachable without the cart harness of MEAL-158.
  // That was wrong, and a cold review demonstrated it: parking a worker needs
  // one `onMessage` post of `WORKER_RESULT phase:'search'` — the same idiom this
  // file already uses for `LOGIN_STATUS` — and the commit then dispatches on the
  // jitter timer. No new machinery.
  const injectionsBy = (advanceMs: number) => {
    (globalThis as any).__flags = {
      presearchAdd: true, parallelAdd: true, parallelAddWorkers: 2, addCommitJitterMs: 800,
    };
    // Floor of the range, so the delay is exactly the configured value and the
    // assertion can sit one millisecond either side of it.
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    const view = render(sheet(chosen('Sour Cream'), chosen('Tortillas'), chosen('Cheese'), chosen('Salsa')));
    act(() => { jest.advanceTimersByTime(2_000); });

    const postTo = (i: number, payload: Record<string, unknown>) => act(() => {
      view.queryAllByTestId('mock-webview')[i]?.props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });
    // Each parked tile reports its search. This is what moves a worker to
    // `parked`, which is the state `commit` dispatches an add from.
    view.queryAllByTestId('mock-webview').forEach((_w, i) => {
      postTo(i, { type: 'WORKER_RESULT', phase: 'search', workerId: i, candidates: [] });
    });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    postTo(0, { type: 'LOGIN_STATUS', isLoggedIn: true });
    postTo(0, { type: 'CART_COUNT', count: 0, items: [], url: 'https://example.test/cart' });

    act(() => { jest.advanceTimersByTime(advanceMs); });
    const injected = ((globalThis as any).__injectedAt ?? []).length;
    random.mockRestore();
    view.unmount();
    return injected;
  };

  it('waits the configured jitter before committing a parked add', () => {
    // 800ms configured, floor of the range. Nothing may have gone to the store
    // at 799; something must have by 800. A constant delay cannot produce both,
    // and neither can a jitter computed from the build constant instead of the
    // flag — which is exactly the mutant that survived until this existed.
    expect(injectionsBy(799)).toBe(0);
    expect(injectionsBy(800)).toBeGreaterThan(0);
  });
});
