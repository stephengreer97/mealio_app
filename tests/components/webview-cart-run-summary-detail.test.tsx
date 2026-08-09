// What the cart actually puts in the run_summary row (MEAL-153).
//
// The only component test that touched telemetry replaced the whole
// `AutomationTelemetry` class with a stub whose `record()` is a no-op, so the
// detail payload the component builds was observed by nothing. Measured
// independently by two cold reviews: replacing `tel().failureCodeSummary()` with
// `undefined` at the call site left the entire suite at baseline.
//
// That wiring has shipped broken once already. `failureCodes` went out as a
// nested Record that `sanitizeDetail` discarded, so the row claimed a failure
// distribution it did not carry and no test noticed. MEAL-123 secured the
// payload SHAPE — `runSummaryFailureDetail` is round-tripped through the real
// sanitizer in `northStar.test.ts` — but the ARGUMENT that supplies the tally
// was still held by nothing.
//
// So this file does the thing the ticket said was the blocker: it drives a real
// run to a terminal row. The recorder subclasses the real class rather than
// replacing it, so `record` still populates the failure counts that
// `primaryFailureCode()` and `failureCodeSummary()` read — a stub returning
// `undefined` from those would make this file agree with the bug it exists to
// catch. Only `flush` is neutralised, because that is the network.

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
      logAutomationStart: jest.fn(async () => 'run-summary-detail'),
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

type Batch = { runId: string; steps: Array<Record<string, any>> };
const batches = () => ((globalThis as any).__batches ?? []) as Batch[];
/** Every row that reached the upload function, in the order it was sent. */
const uploaded = () => batches().flatMap((b) => b.steps);
const runSummary = () => uploaded().filter((r) => r.step === 'run_summary');

const chosen = (name: string) => ({
  ingredientName: name, searchTerm: name, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

const sheet = (...ingredients: unknown[]) => (
  <WebViewCartSheet
    visible
    meals={[{ id: 'm1', name: 'Tacos', ingredients }] as never}
    storeId="heb"
    storeName="H-E-B"
    onClose={() => {}}
  />
);

/**
 * Drive one item from the qty screen to a terminal row.
 *
 * Every message here is one the store's own scripts really post. `addSucceeds`
 * decides whether the run ends 'ok' or 'error', which is the branch the detail
 * differs across.
 */
async function runOneItem({ addSucceeds }: { addSucceeds: boolean }) {
  const view = render(sheet(chosen('Sour Cream')));
  const post = (payload: Record<string, unknown>) => act(() => {
    view.getAllByTestId('mock-webview')[0].props.onMessage({
      nativeEvent: { data: JSON.stringify(payload) },
    });
  });

  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  // `logAutomationStart` is a round trip, and the recorder is a no-op until it
  // resolves — every call site fires into nothing before then. Flushing the
  // microtask queue here is what installs the real one.
  await act(async () => {});
  post({ type: 'LOGIN_STATUS', isLoggedIn: true });
  post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://heb.test/cart' });
  // An exact match, so the item auto-picks and reaches the add rather than the
  // review screen.
  post({
    type: 'SEARCH_RESULT',
    candidates: [{ productName: 'Sour Cream', imageUrl: null, outOfStock: false, preferences: null, price: '$2' }],
  });
  post(addSucceeds
    ? { type: 'ADD_RESULT', success: true }
    : { type: 'ADD_RESULT', success: false, reason: 'add button not found' });
  act(() => { jest.advanceTimersByTime(30_000); });
  // The terminal row lands with the cart snapshot that closes the run.
  post({ type: 'CART_COUNT', count: addSucceeds ? 1 : 0, items: [], url: 'https://heb.test/cart' });
  // The terminal rows land in a LATER batch than the per-item ones: the run
  // emits run_summary and reconcile after the closing cart snapshot, then calls
  // `void tel().flush()`. So this needs both — the timers to reach the terminal
  // path, and a microtask turn for the upload promise to settle. Reading one
  // batch too early is why the first version of this file saw only
  // login_check..confirm and no run_summary at all.
  act(() => { jest.advanceTimersByTime(30_000); });
  await act(async () => {});

  // Read BEFORE teardown. Unmount emits its own 'skipped' abandonment row, and
  // a guard test that cannot tell that row from the terminal one would not
  // notice if the terminal path stopped emitting — measured: with the driver
  // truncated, the old version of this file still passed on
  // {"outcome":"skipped","detail":{"terminal":"abandoned"}}.
  // Teardown, then read. The terminal row is RECORDED during the run but only
  // UPLOADED when `dispose()` makes its final flush, so a read before unmount
  // sees the per-item rows and no run_summary at all — measured.
  //
  // That is why the tests below assert the row IS the terminal one rather than
  // relying on when it was read: unmount also emits an abandonment row, and a
  // guard that could not tell them apart would not notice if the terminal path
  // stopped emitting. `outcome: 'error'` with no `detail.terminal` is the
  // terminal row; the abandoned one is `'skipped'` with `terminal: 'abandoned'`.
  view.unmount();
  await act(async () => {});
  return runSummary();
}

beforeEach(() => { jest.useFakeTimers(); (globalThis as any).__batches = []; });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); (globalThis as any).__batches = []; });

describe('the run_summary row a failing run emits', () => {
  it('is emitted at all, exactly once', async () => {
    // The guard the rest of this file needs: without a terminal row every
    // assertion below is vacuously true of a run that never reported.
    const summaries = await runOneItem({ addSucceeds: false });
    expect(summaries).toHaveLength(1);
    // ...and it is the row the run finished with, not the one teardown emits.
    expect(summaries[0].outcome).toBe('error');
    expect(summaries[0].detail?.terminal).toBeUndefined();
  });

  it('carries the failure tally the component was asked for', async () => {
    // The argument nothing held: `tel().failureCodeSummary()`. Replacing it with
    // `undefined` at the call site left the whole suite green, so a row could
    // claim a code while carrying no distribution behind it — which is the shape
    // that shipped broken once already.
    const row = (await runOneItem({ addSucceeds: false }))[0];

    expect(row.outcome).toBe('error');
    expect(row.code).toBeTruthy();
    expect(typeof row.detail?.failureCodes).toBe('string');
    expect(row.detail?.failureCodes).toContain(String(row.code));
  });

  it('says which code it chose and where the code came from', async () => {
    // `toBeTruthy()` was the whole assertion here, and `codeSource` is either
    // 'severity' or 'fallback' — both truthy. A mutant that turned the severity
    // ranking into a permanent guess left it green.
    const row = (await runOneItem({ addSucceeds: false }))[0];
    expect(row.code).toBe('confirm_failed');
    expect(row.detail?.codeSource).toBe('severity');
  });

  it('reports the run as failing rather than as merely finished', async () => {
    // The counts the funnel divides by. `requested` is the denominator and
    // `itemsAdded` the numerator, so a row that carried the code but not these
    // would put a failure in the charts with nothing to weigh it against.
    const row = (await runOneItem({ addSucceeds: false }))[0];

    expect(row.detail?.outcome).toBe('failed');
    expect(row.detail?.requested).toBe(1);
    expect(row.detail?.itemsAdded).toBe(0);
  });

  it('counts the code rather than merely naming it', async () => {
    // `failureCodes` is the tally, flattened to a string because a nested Record
    // is what `sanitizeDetail` silently discarded the first time this shipped.
    // One confirm failure on a one-item run reads exactly this way.
    const row = (await runOneItem({ addSucceeds: false }))[0];
    expect(row.detail?.failureCodes).toBe('confirm_failed:1');
  });
});

describe('the run_summary row a clean run emits', () => {
  it('is ok, and carries no failure code or tally', async () => {
    // The other side of the branch. A success row that carried a code would put
    // this run in the failure charts.
    const summaries = await runOneItem({ addSucceeds: true });
    expect(summaries).toHaveLength(1);

    const row = summaries[0];
    expect(row.outcome).toBe('ok');
    expect(row.code).toBeUndefined();
    expect(row.detail?.failureCodes).toBeUndefined();
  });
});
