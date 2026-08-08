// MEAL-5: a run that ends without reaching the done screen still reports.
//
// `run_summary` was emitted from one place, the effect that fires on step
// 'done'. Every other way a run ends produced no terminal row: the user closes
// the sheet at the qty screen, at a login, at a robot wall; a sign-out ends the
// job; a store wedges until they give up. `logAutomationStart` has already
// written the `automation_runs` row by then, so those runs were present in the
// run table and absent from the funnel — and a run someone abandons is not a
// random run, it is disproportionately one that was going badly. The funnel read
// healthier than reality by exactly the runs that went worst.
//
// Every assertion below reads the batch the UPLOAD function actually received.
// The real AutomationTelemetry is used on purpose — the recorder is where a row
// can be dropped (sampling, the buffer, sanitizeDetail, dispose) and a spy on
// `record` would prove none of it. `webview-cart-run-generation.test.tsx`
// substitutes the class instead; it is asking a different question.

import { act, fireEvent, render } from '@testing-library/react-native';

/** The main WebView's live props, so a test can post engine messages to it. */
let mainWebViewProps: any = null;

jest.mock('../../src/lib/purchases', () => ({
  // Only reached transitively — WebViewCartSheet → LoginPrewarmContext →
  // AuthContext. The real module pulls react-native-purchases' ESM dist, which
  // this project's transform does not cover.
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    // The worker tiles render their own WebViews; only the main one is the
    // engine's message channel.
    if (!props.testID || props.testID === 'mock-webview') mainWebViewProps = props;
    RealReact.useImperativeHandle(ref, () => ({ injectJavaScript: () => {} }));
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

/**
 * The two usage endpoints the run lifecycle drives. `logAutomationStart` parks so
 * a test can decide when — and whether — the run id lands, which is what decides
 * whether a recorder exists at all. `logAutomationSteps` records every batch.
 */
jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn((data: any) => new Promise((resolve) => {
        ((globalThis as any).__pendingStarts ||= []).push({ storeId: data.storeId, resolve });
      })),
      logAutomationComplete: jest.fn(async () => {}),
      // Returns whatever `__uploadOk` says, so a test can make the server refuse
      // the batch (a 5xx, the retryable case) and watch what the recorder does
      // with the timer it re-arms.
      logAutomationSteps: jest.fn(async (batch: any) => {
        ((globalThis as any).__batches ||= []).push(batch);
        return (globalThis as any).__uploadOk !== false;
      }),
    },
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import type { StepRecord } from '../../src/lib/automation-telemetry';

type PendingStart = { storeId: string; resolve: (id: string) => void };
type Batch = { runId: string; steps: StepRecord[] };

const pendingStarts = () => ((globalThis as any).__pendingStarts ||= []) as PendingStart[];
const batches = () => ((globalThis as any).__batches ||= []) as Batch[];

/** Every step row that reached the upload function, in the order it was sent. */
const uploaded = (): StepRecord[] => batches().flatMap((b) => b.steps);

/** Land the parked start response for `storeId`, as `run-<storeId>`. */
async function landStartFor(storeId: string) {
  const pending = pendingStarts().find((p) => p.storeId === storeId);
  if (!pending) throw new Error(`no logAutomationStart in flight for ${storeId}`);
  await act(async () => {
    pending.resolve(`run-${storeId}`);
    await Promise.resolve();
  });
}

const meal = {
  id: 'm1',
  name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
};

/** The same meal with nothing chosen yet. The sheet skips the qty screen for
 *  this and auto-starts the choose flow, so the run sits on 'login_check'
 *  without the test touching the UI. */
const unchosenMeal = {
  id: 'm2',
  name: 'Chili',
  ingredients: [
    { ingredientName: 'Kidney Beans', searchTerm: null, productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
};

/** Post an engine message to the main WebView. */
function post(payload: unknown) {
  act(() => {
    mainWebViewProps.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
  });
}

const settle = () => act(async () => { await Promise.resolve(); });

const sheet = (props: { visible: boolean; storeId: string; meals?: unknown[] }) => (
  <WebViewCartSheet
    visible={props.visible}
    meals={(props.meals ?? [meal]) as any}
    storeId={props.storeId}
    storeName={props.storeId}
    onClose={() => {}}
  />
);

beforeEach(() => {
  pendingStarts().length = 0;
  batches().length = 0;
  (globalThis as any).__uploadOk = true;
  mainWebViewProps = null;
});

describe('a cart run that never reaches the done screen', () => {
  it('uploads a terminal run_summary when the sheet is torn down mid-run', async () => {
    // How the live mount site ends a run: CartJobContext renders the sheet with
    // `visible` hardcoded true and drops the job, so it unmounts and the close
    // branch never runs. Before MEAL-5 that path emitted no terminal row at all.
    const { unmount } = render(sheet({ visible: true, storeId: 'heb' }));
    await landStartFor('heb');
    await act(async () => { unmount(); });
    await act(async () => { await Promise.resolve(); });

    const summaries = uploaded().filter((s) => s.step === 'run_summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].outcome).toBe('skipped');
    // 'skipped' is the only non-success outcome that carries no code, so an
    // abandoned run cannot move the failure-code distribution.
    expect(summaries[0].code).toBeUndefined();
    expect(summaries[0].detail).toMatchObject({
      terminal: 'abandoned',
      runComplete: false,
      requested: 0,
      itemsAdded: 0,
    });
    // The actionable field: a pile of 'qty' is people changing their mind before
    // anything ran; a pile of 'robot_challenge' is a store beating us. Asserted
    // as a VALUE — `typeof … === 'string'` passes just as happily on a constant,
    // and a constant is exactly how this field goes silently wrong.
    expect(summaries[0].detail?.abandonedAt).toBe('qty');
    // And it is filed under the run the `automation_runs` row is keyed to,
    // which is the whole point of emitting it — the two counts have to line up.
    expect(batches().every((b) => b.runId === 'run-heb')).toBe(true);
  });

  it('uploads one when the sheet is hidden rather than unmounted', async () => {
    // The other teardown, taken by the !FEATURE_BACKGROUND_CART mount. It
    // disposed the recorder already; what it never did was give it a last row.
    const { rerender } = render(sheet({ visible: true, storeId: 'heb' }));
    await landStartFor('heb');
    await act(async () => { rerender(sheet({ visible: false, storeId: 'heb' })); });
    await act(async () => { await Promise.resolve(); });

    expect(uploaded().filter((s) => s.step === 'run_summary')).toHaveLength(1);
  });

  it('emits exactly one terminal row when a hidden sheet is then unmounted', async () => {
    // Both teardowns in sequence, which is the ordinary close: hide, then drop
    // the component. Two terminal rows for one run would overcount the funnel in
    // the opposite direction, so the close path has to disarm the unmount path.
    const { rerender, unmount } = render(sheet({ visible: true, storeId: 'heb' }));
    await landStartFor('heb');
    await act(async () => { rerender(sheet({ visible: false, storeId: 'heb' })); });
    await act(async () => { unmount(); });
    await act(async () => { await Promise.resolve(); });

    expect(uploaded().filter((s) => s.step === 'run_summary')).toHaveLength(1);
  });

  it('names the step the run actually stopped on, not the one it started on', async () => {
    // The other half of the assertion above: every other test in this file
    // abandons at 'qty', so a hardcoded 'qty' would satisfy all of them. An
    // ingredient with no chosen product skips the qty screen and auto-starts the
    // choose flow, which parks the run on 'login_check' with no UI interaction —
    // a genuinely different value for the field whose whole purpose is to vary.
    const { unmount } = render(sheet({ visible: true, storeId: 'heb', meals: [unchosenMeal] }));
    await landStartFor('heb');
    await act(async () => { unmount(); });
    await settle();

    const summaries = uploaded().filter((s) => s.step === 'run_summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].detail?.abandonedAt).toBe('login_check');
    // A choose run has no cart outcome, so it is excluded from both north-star
    // rates by `requested === 0` — the abandonment row must not invent one.
    expect(summaries[0].detail).toMatchObject({ kind: 'choose', requested: 0 });
  });

  it('carries the work already done when the run is abandoned part-way', async () => {
    // Same defect as abandonedAt, one field over, and it survived the fix for it:
    // every other test here tears down before the CTA press, so `requested` and
    // `itemsAdded` are only ever asserted at 0 and a hardcoded 0 satisfies all of
    // them. Cold review measured that — pinning either to the constant passed
    // 11/11.
    //
    // These two are the north-star numerator and denominator, and a run abandoned
    // AFTER some items landed is exactly the population MEAL-5 exists to stop
    // under-reporting. A zero here would say the user got nothing when they got
    // something.
    const r = render(sheet({ visible: true, storeId: 'aldi' }));
    await landStartFor('aldi');
    await act(async () => { fireEvent.press(r.getByText(/add ingredients to/i)); });
    post({ type: 'LOGIN_STATUS', loggedIn: true });
    await settle();
    post({
      type: 'SEARCH_AND_ADD_RESULT', success: true, added: 1,
      productName: 'Sour Cream', term: 'sour cream',
    });
    await settle();

    // Torn down before the done screen, with one item already in the cart.
    await act(async () => { r.unmount(); });
    await settle();

    const summaries = uploaded().filter((s) => s.step === 'run_summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].detail).toMatchObject({
      terminal: 'abandoned', kind: 'add', requested: 1, itemsAdded: 1, runComplete: false,
    });
  });

  it('stays silent for a run the server never issued an id for', async () => {
    // No runId means no `automation_runs` row either, so there is nothing for a
    // terminal row to be the missing half of — and the recorder is the no-op
    // that drops everything. Invisible on both sides is consistent; a row here
    // would be a row keyed to no run.
    const { unmount } = render(sheet({ visible: true, storeId: 'heb' }));
    await act(async () => { unmount(); });
    await act(async () => { await Promise.resolve(); });

    expect(uploaded()).toHaveLength(0);
  });
});

// The run that DID finish. Its terminal row is not in question — the done effect
// has always emitted one — but two things about its teardown are.
describe('a cart run that reaches the done screen', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /**
   * Drive a one-item ALDI run all the way to the done screen: qty CTA, a
   * logged-in answer, and the fused search-and-add result that finishes it. The
   * last hop sits behind the add-commit jitter, hence the timer advance.
   */
  async function runToDone() {
    const r = render(sheet({ visible: true, storeId: 'aldi' }));
    await landStartFor('aldi');
    await act(async () => { fireEvent.press(r.getByText(/add ingredients to/i)); });
    post({ type: 'LOGIN_STATUS', loggedIn: true });
    await settle();
    post({
      type: 'SEARCH_AND_ADD_RESULT', success: true, added: 1,
      productName: 'Sour Cream', term: 'sour cream',
    });
    await act(async () => { jest.advanceTimersByTime(30_000); await Promise.resolve(); });
    // The done screen, so a run that silently stalled cannot pass as finished.
    expect(r.queryByText(/added to your/i)).toBeTruthy();
    return r;
  }

  it('emits exactly one terminal row across done and unmount, and it is the finished one', async () => {
    // The guard under test is `automationCompletedRef` in endRun. Without it the
    // teardown ships a SECOND run_summary, outcome 'skipped', for a run that
    // finished cleanly — and mealio_central's automation-trace takes the LAST
    // run_summary as the run's terminal row, so the duplicate would blank the
    // run's code and relabel a clean run in the drilldown. Overcounting the
    // funnel in the opposite direction to the gap this branch exists to close.
    const r = await runToDone();
    await act(async () => { r.unmount(); });
    await act(async () => { jest.advanceTimersByTime(30_000); await Promise.resolve(); });

    const summaries = uploaded().filter((s) => s.step === 'run_summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].outcome).toBe('ok');
    expect(summaries[0].detail).not.toHaveProperty('terminal');
  });

  it('leaves no retry timer running when the run tears down mid-retry', async () => {
    // The leak the audit's third finding named, on the path that actually
    // matters. `dispose()` sends what is buffered AND stops the timer; `flush()`
    // does only the first, and the retry re-arms on every refused upload — so a
    // recorder nobody disposed keeps posting every flush interval for the life of
    // the process. Nothing had ever disposed one on the live mount site.
    //
    // Observed as behaviour rather than as a spy on dispose: with the server
    // refusing every batch, a disposed recorder makes no further attempt and a
    // merely-flushed one makes another on each interval.
    (globalThis as any).__uploadOk = false;
    const r = await runToDone();
    await act(async () => { r.unmount(); });
    await act(async () => { await Promise.resolve(); });

    const attemptsAtTeardown = batches().length;
    expect(attemptsAtTeardown).toBeGreaterThan(0); // it really did try
    await act(async () => { jest.advanceTimersByTime(120_000); await Promise.resolve(); });
    expect(batches().length).toBe(attemptsAtTeardown);
  });
});
