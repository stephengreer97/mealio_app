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
import { enableRail, SESSION_OK } from './helpers/railRun';

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
  enableRail();
  post(SESSION_OK);
  post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
  post(SESSION_OK);
  // An exact match, so the rail WRITES it rather than routing to review.
  post({
    type: 'SEARCH_RESULT', source: 'network', term: 'Sour Cream',
    candidates: [{
      productName: 'Sour Cream', imageUrl: null, outOfStock: false, preferences: null,
      price: '$2', productId: 'p1', skuId: 's1',
    }],
  });
  post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 1 });
  post({
    type: 'NET_ADD_RESULT', idx: 0, name: 'Sour Cream', success: addSucceeds,
    productId: 'p1', skuId: 's1',
    // cart_not_incremented: the write went out and the cart did not move. That is
    // the confirm_failed family — dispatched, no evidence it landed — which is
    // what these cases rank. 'not_found' is a scoring miss and rides another code.
    reason: addSucceeds ? null : 'cart_not_incremented',
  });
  post({
    type: 'NET_ADD_DONE', wrote: 1, count: 1, cartBefore: [],
    cartAfter: addSucceeds ? [{ name: 'Sour Cream', qty: 1 }] : [],
  });
  // The terminal row lands with the cart snapshot that closes the run.
  post({ type: 'CART_COUNT', count: addSucceeds ? 1 : 0, items: [], source: 'network' });
  if (!addSucceeds) {
    // The reconcile tops the shortfall up over the rail. Answer it, still short:
    // unanswered, the pass times out and reports write_unresolved instead, which
    // is a different code and a different test.
    post({
      type: 'NET_ADD_RESULT', idx: 0, name: 'Sour Cream', success: false,
      productId: 'p1', skuId: 's1', reason: 'cart_not_incremented',
    });
    post({ type: 'NET_ADD_DONE', wrote: 1, count: 1, cartBefore: [], cartAfter: [] });
  }
  act(() => { jest.advanceTimersByTime(30_000); });
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
    // THREE, not one, and every one of them is a real row. The rail writes,
    // the cart says it did not move, the reconcile finds the shortfall and
    // writes AGAIN — the write sets an absolute quantity, so a retry is safe —
    // and it is refused a second time. Two attempts plus the reconcile's own
    // verdict. On the DOM path this read as one because the retry loaded a page
    // that never answered inside the test.
    expect(row.detail?.failureCodes).toBe('confirm_failed:3');
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

describe('a run that fails more than one way', () => {
  // The one-item run above cannot tell a real tally from several broken ones.
  // A cold review measured it: with a single failure, `confirm_failed:1` is
  // produced identically by a tally that hardcodes every count to 1, by one
  // truncated to its first entry, and by one with the severity ranking removed.
  // Three items failing two different ways separates all of them — one code with
  // a count of 2, one with 1, and a chosen code that is NOT the most frequent.
  /** The store's own add-phase ceiling, so this test cannot drift from it. */
  const addDeadlineMs = (items: number) =>
    require('../../src/lib/webview-scripts/network-rail')
      .getNetworkRail('heb').budgets.addMs(items);

  const runThree = async () => {
    (globalThis as any).__batches = [];
    const view = render(sheet(chosen('Sour Cream'), chosen('Tortillas'), chosen('Cheese')));
    const post = (payload: Record<string, unknown>) => act(() => {
      view.getAllByTestId('mock-webview')[0].props.onMessage({
        nativeEvent: { data: JSON.stringify(payload) },
      });
    });

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    await act(async () => {});
    enableRail();
    post(SESSION_OK);
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    post(SESSION_OK);
    post({ type: 'CART_COUNT', count: 0, items: [], url: 'https://heb.test/cart' });

    // Every item is searched before any is added, so all three answers come
    // first. Posting an ADD_RESULT before that ends the run one item in.
    for (const productName of ['Sour Cream', 'Tortillas', 'Cheese']) {
      post({
        type: 'SEARCH_RESULT', source: 'network', term: productName,
        candidates: [{
          productName, imageUrl: null, outOfStock: false, preferences: null, price: '$2',
          productId: 'p' + productName, skuId: 's' + productName,
        }],
      });
    }
    post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: 3 });
    // Two are refused; the THIRD never answers at all, so the add phase's own
    // deadline finalizes it — a different code, which is the point of the case.
    post({ type: 'NET_ADD_RESULT', idx: 0, name: 'Sour Cream', success: false, productId: 'pSour Cream', skuId: 'sSour Cream', reason: 'cart_not_incremented' });
    post({ type: 'NET_ADD_RESULT', idx: 1, name: 'Tortillas', success: false, productId: 'pTortillas', skuId: 'sTortillas', reason: 'cart_not_incremented' });
    // Just past the add phase's own deadline, which is the STORE'S number now
    // rather than one shared constant — a flat 80s here used to work only
    // because every store waited 75. Overshooting it expires the reconcile's
    // cart probe before the CART_COUNT below arrives.
    act(() => { jest.advanceTimersByTime(addDeadlineMs(3) + 1_000); });
    post({ type: 'CART_COUNT', count: 0, items: [], source: 'network' });
    // The reconcile tops all three up over the rail. Two are refused again; the
    // third stays silent and the add phase's deadline finalizes the pass.
    post({ type: 'NET_ADD_RESULT', idx: 0, name: 'Sour Cream', success: false, productId: 'pSour Cream', skuId: 'sSour Cream', reason: 'cart_not_incremented' });
    post({ type: 'NET_ADD_RESULT', idx: 1, name: 'Tortillas', success: false, productId: 'pTortillas', skuId: 'sTortillas', reason: 'cart_not_incremented' });
    // The reconcile pass has its own fixed deadline, not the rail's.
    act(() => { jest.advanceTimersByTime(50_000); });
    await act(async () => {});
    view.unmount();
    await act(async () => {});
    return runSummary();
  };

  it('counts each code, and keeps them all', async () => {
    // Both halves still matter. A tally that hardcoded `:1` would read
    // "confirm_failed:1,timeout:1"; one truncated to the primary would drop the
    // timeout entirely. Neither is this string.
    //
    // The numbers doubled when the run moved onto the rail, and every row is
    // real: each item is attempted TWICE — the write, then the reconcile's
    // top-up, because the write sets an absolute quantity and retrying it is
    // safe — plus the reconcile's own verdict on top. Two refused items and one
    // silent one, each seen twice, is 5 and 2.
    const summaries = await runThree();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].detail?.failureCodes).toBe('confirm_failed:5,timeout:2');
  });

  it('ranks by severity rather than by how often a code happened', async () => {
    // `confirm_failed` happened twice and `timeout` once, and the row is coded
    // `timeout` — so the code is chosen by severity, not frequency. With the
    // ranking removed the frequency fallback would pick `confirm_failed`, which
    // on a one-item run is the same answer and invisible.
    const [row] = await runThree();
    expect(row.code).toBe('timeout');
    expect(row.detail?.codeSource).toBe('severity');
  });

  it('still reports the run totals alongside the codes', async () => {
    const [row] = await runThree();
    expect(row.detail?.requested).toBe(3);
    expect(row.detail?.itemsAdded).toBe(0);
    // `kind` tells the funnel this was an add run rather than a choose run, and
    // was asserted by nothing anywhere before this.
    expect(row.detail?.kind).toBe('add');
  });
});
