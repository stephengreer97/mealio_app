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
      logAutomationSteps: jest.fn(async () => true),
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

// The REAL telemetry, with every row recorded on its way through. Subclassed
// rather than stubbed on purpose: `record` is what populates the failure counts
// that `primaryFailureCode()` and `failureCodeSummary()` read, so a stub would
// hand the component the same `undefined` the mutant does and this file would
// pass against the defect it exists to catch.
jest.mock('../../src/lib/automation-telemetry', () => {
  const actual = jest.requireActual('../../src/lib/automation-telemetry');
  class RecordingTelemetry extends actual.AutomationTelemetry {
    record(...args: unknown[]) {
      ((globalThis as any).__rows ||= []).push(args);
      return (actual.AutomationTelemetry.prototype.record as any).apply(this, args);
    }
    // The network, and only the network.
    async flush() {}
  }
  return { ...actual, AutomationTelemetry: RecordingTelemetry };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';

type Row = [string, string, Record<string, any>?];
const rows = () => ((globalThis as any).__rows ?? []) as Row[];
const runSummary = () => rows().filter((r) => r[0] === 'run_summary');

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
  (globalThis as any).__rows = [];
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
  act(() => { jest.advanceTimersByTime(30_000); });
  await act(async () => {});

  view.unmount();
  return runSummary();
}

beforeEach(() => { jest.useFakeTimers(); (globalThis as any).__rows = []; });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); (globalThis as any).__rows = []; });

describe('the run_summary row a failing run emits', () => {
  it('is emitted at all, exactly once', async () => {
    // The guard the rest of this file needs: without a terminal row every
    // assertion below is vacuously true of a run that never reported.
    const summaries = await runOneItem({ addSucceeds: false });
    expect(summaries).toHaveLength(1);
  });

  it('carries the failure tally the component was asked for', async () => {
    // The argument nothing held: `tel().failureCodeSummary()`. Replacing it with
    // `undefined` at the call site left the whole suite green, so a row could
    // claim a code while carrying no distribution behind it — which is the shape
    // that shipped broken once already.
    const [, outcome, extra] = (await runOneItem({ addSucceeds: false }))[0];

    expect(outcome).toBe('error');
    expect(extra?.code).toBeTruthy();
    expect(typeof extra?.detail?.failureCodes).toBe('string');
    expect(extra?.detail?.failureCodes).toContain(String(extra?.code));
  });

  it('says which code it chose and where the code came from', async () => {
    const [, , extra] = (await runOneItem({ addSucceeds: false }))[0];
    expect(extra?.detail?.codeSource).toBeTruthy();
  });

  it('reports the run as failing rather than as merely finished', async () => {
    // The counts the funnel divides by. `requested` is the denominator and
    // `itemsAdded` the numerator, so a row that carried the code but not these
    // would put a failure in the charts with nothing to weigh it against.
    const [, , extra] = (await runOneItem({ addSucceeds: false }))[0];

    expect(extra?.detail?.outcome).toBe('failed');
    expect(extra?.detail?.requested).toBe(1);
    expect(extra?.detail?.itemsAdded).toBe(0);
  });

  it('counts the code rather than merely naming it', async () => {
    // `failureCodes` is the tally, flattened to a string because a nested Record
    // is what `sanitizeDetail` silently discarded the first time this shipped.
    // One confirm failure on a one-item run reads exactly this way.
    const [, , extra] = (await runOneItem({ addSucceeds: false }))[0];
    expect(extra?.detail?.failureCodes).toBe('confirm_failed:1');
  });
});

describe('the run_summary row a clean run emits', () => {
  it('is ok, and carries no failure code or tally', async () => {
    // The other side of the branch. A success row that carried a code would put
    // this run in the failure charts.
    const summaries = await runOneItem({ addSucceeds: true });
    expect(summaries).toHaveLength(1);

    const [, outcome, extra] = summaries[0];
    expect(outcome).toBe('ok');
    expect(extra?.code).toBeUndefined();
    expect(extra?.detail?.failureCodes).toBeUndefined();
  });
});
