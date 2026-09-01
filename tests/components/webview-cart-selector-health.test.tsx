// MEAL-31 wiring: a SELECTOR_HEALTH message arriving on the bridge reaches the
// run's tally, and reaches nothing else.
//
// The probe and the tally are tested on their own in tests/unit/selectorHealth.
// What only this level can prove is the seam between them: the message is a
// bridge message like any other, so a branch in the wrong place either drops the
// samples (the feature silently measures nothing) or eats a message the cart
// engine was waiting on (the feature breaks a run — the one thing telemetry is
// not allowed to do). Both are asserted here.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  const MockWebView = RealReact.forwardRef((props: any, _ref: any) =>
    RealReact.createElement(RealView, { testID: props.testID || 'mock-webview', ...props }),
  );
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

// The real telemetry API, with the uploaded batches captured. `logAutomationStart`
// resolves immediately so the recorder exists — without a runId the sheet installs
// a no-op recorder and every row is dropped, which would make an end-to-end
// assertion pass against a feature that records nothing.
jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    usage: {
      ...actual.usage,
      logAutomationStart: jest.fn(async () => 'run-selector-health'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async (batch: any) => {
        ((globalThis as any).__batches ||= []).push(batch);
        return true;
      }),
    },
  };
});

// The real tally, with every ingest recorded. Subclassed rather than stubbed so
// what the sheet is wired to is the object that actually ships — a jest.fn()
// here would pass just as happily against a tally that could not count.
jest.mock('../../src/lib/selector-health', () => {
  const actual = jest.requireActual('../../src/lib/selector-health');
  class RecordingTally extends actual.SelectorHealthTally {
    ingest(sel: unknown) {
      ((globalThis as any).__ingested ||= []).push(sel);
      super.ingest(sel);
    }
  }
  return { ...actual, SelectorHealthTally: RecordingTally };
});

// Report the store as already signed in. This is the ONLY thing standing between
// a component test and the pre-search parking pool: the effect that calls
// presearchPool.start gates on `loginPrewarm.getStatus(storeId) === 'loggedIn'`,
// and nothing in a test ever runs the silent probe that sets it. (An earlier note
// in WebViewCartSheet blamed the browser region not being mounted on the qty
// screen. That was wrong — the region's gate is `step !== 'qty' || presearchGrid`
// and the parked tiles render offscreen, where RNTL still finds them.)
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    // Per-test, defaulting to 'unknown' so every other test in this file sees the
    // real flow. Reporting 'loggedIn' globally would skip the login check and
    // park pre-search workers under all of them.
    useLoginPrewarm: () => ({
      checkStore: () => {},
      getStatus: () => (globalThis as any).__prewarmStatus ?? 'unknown',
      takePrewarmedCart: () => null,
      statusVersion: (globalThis as any).__prewarmStatus === 'loggedIn' ? 1 : 0,
    }),
  };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { SELECTOR_HEALTH_MESSAGE } from '../../src/lib/selector-health';

const ingested = () => ((globalThis as any).__ingested ?? []) as unknown[];
/** Every step row the upload function was actually handed. */
const uploaded = () =>
  (((globalThis as any).__batches ?? []) as Array<{ steps: any[] }>).flatMap((b) => b.steps);

beforeEach(() => {
  (globalThis as any).__ingested = [];
  (globalThis as any).__batches = [];
  (globalThis as any).__prewarmStatus = 'unknown';
});

const meal = {
  id: 'm1',
  name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
};

/** Render, start the run, and return a way to post messages onto the bridge. */
function startRun() {
  const view = render(
    <WebViewCartSheet visible meals={[meal]} storeId="aldi" storeName="ALDI" onClose={() => {}} />,
  );
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  const post = (payload: Record<string, unknown>) => {
    const webview = view.getAllByTestId('mock-webview')[0];
    act(() => {
      webview.props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
    });
  };
  return { ...view, post };
}

describe('SELECTOR_HEALTH on the cart bridge', () => {
  it('reaches the run\'s tally', () => {
    const { post } = startRun();
    post({ type: SELECTOR_HEALTH_MESSAGE, sel: { card: 0, title: 1 } });
    expect(ingested()).toEqual([{ card: 0, title: 1 }]);
  });

  it('accumulates across the run rather than replacing', () => {
    const { post } = startRun();
    post({ type: SELECTOR_HEALTH_MESSAGE, sel: { card: 0 } });
    post({ type: SELECTOR_HEALTH_MESSAGE, sel: { card: -1 } });
    expect(ingested()).toEqual([{ card: 0 }, { card: -1 }]);
  });

  it('does not disturb the step machine', () => {
    // The sample arrives between a script's result and the next one. If the
    // branch were placed after the engine's own dispatch — or forgot to return —
    // this message would fall through into it.
    const { post, getByText } = startRun();
    expect(getByText(/checking login/i)).toBeTruthy();
    post({ type: SELECTOR_HEALTH_MESSAGE, sel: { card: 0 } });
    expect(getByText(/checking login/i)).toBeTruthy();
  });

  it('lets the engine\'s own messages through untouched', () => {
    // The other half: a branch that matched too eagerly would swallow the login
    // result and hang the run on its safety timeout.
    const { post, queryByText } = startRun();
    post({ type: 'LOGIN_STATUS', isLoggedIn: false });
    expect(queryByText(/checking login/i)).toBeNull();
    expect(ingested()).toEqual([]);
  });
});

// ── The parallel pools' own bridges ─────────────────────────────────────────

// "SELECTOR_HEALTH from a pool worker" lived here: three cases proving a sample
// posted from inside a parallel-search, pre-search or parallel-add worker
// reached the run's tally through the pool's own postMessage wrapper. The pools
// were deleted on 2026-09-01. The bridge cases above still cover the path a
// sample takes from the one WebView that remains.

describe('a finished run uploads its selector health', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /**
   * Drive one ALDI run to the done screen.
   *
   * The path is the shortest real one: login confirms, the results page loads,
   * the fused search-and-add reports, the item lands in review, and the user
   * skips it. `samples` are posted onto the bridge during the run, exactly as
   * the injected probe would post them.
   */
  const sheet = (visible: boolean) => (
    <WebViewCartSheet visible={visible} meals={[meal]} storeId="aldi" storeName="ALDI" onClose={() => {}} />
  );

  async function driveRun(
    view: ReturnType<typeof render>,
    samples: Array<Record<string, number>>,
  ) {
    const webview = () => view.getAllByTestId('mock-webview')[0];
    const post = (payload: Record<string, unknown>) =>
      act(() => { webview().props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } }); });
    // async: the recorder is installed in logAutomationStart's `.then()`, and a
    // microtask is not a timer — advancing the clock alone leaves the run with the
    // no-op recorder and every assertion below trivially true.
    const settle = async () => { await act(async () => { jest.advanceTimersByTime(30_000); }); };

    act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
    await settle();  // lets logAutomationStart resolve, which is what installs the recorder
    post({ type: 'LOGIN_STATUS', isLoggedIn: true });
    act(() => {
      webview().props.onLoadEnd({ nativeEvent: { url: 'https://www.aldi.us/store/aldi/s?k=sour%20cream' } });
    });
    for (const sel of samples) post({ type: SELECTOR_HEALTH_MESSAGE, sel });
    post({ type: 'SEARCH_AND_ADD_RESULT', success: true, productName: 'Sour Cream', candidates: [] });
    await settle();
    act(() => { fireEvent.press(view.getByText(/Review /)); });
    await settle();
    act(() => { fireEvent.press(view.getByText(/Skip this ingredient/)); });
    await settle();
    expect(view.getByText('Done!')).toBeTruthy();
    return view;
  }

  /** A fresh mount driven to the done screen. */
  async function runToDone(samples: Array<Record<string, number>>) {
    return driveRun(render(sheet(true)), samples);
  }

  it('uploads one reconcile row carrying the run\'s tally', async () => {
    // The end of the chain, asserted on what the upload function RECEIVED. Every
    // link between a bridge message and a server row is real here: the tally, the
    // detail builder, AutomationTelemetry, and — the one that has silently eaten
    // a payload in this project before — sanitizeDetail.
    await runToDone([
      { card: 0, title: 1 },
      { card: -1, title: 1 },
    ]);
    const rows = uploaded();
    const health = rows.filter((r) => r.step === 'reconcile' && r.detail?.phase === 'selector_health');
    expect(health).toHaveLength(1);
    expect(health[0].outcome).toBe('ok');
    // No code: a store that has half-drifted is not this run failing, and
    // run_summary ranks by severity — a selector_miss here would outrank the
    // real cause of a genuinely failed run.
    expect(health[0].code).toBeUndefined();
    expect(health[0].detail).toEqual({
      phase: 'selector_health',
      selectors: 2,
      samples: 2,
      sel1: 'card:2/1/0,title:2/0/2',
    });
  });

  it('starts a second run from zero rather than from the first run\'s samples', async () => {
    // Under !FEATURE_BACKGROUND_CART this component survives between runs. What
    // it publishes is a RATE, so carrying a healthy run's denominator into the
    // next one is precisely the way to hide a store that broke between them: run
    // 1's ten clean samples would drown run 2's single miss.
    const view = render(sheet(true));
    await driveRun(view, [{ card: 0 }, { card: 0 }]);
    act(() => { view.rerender(sheet(false)); });
    act(() => { view.rerender(sheet(true)); });
    await driveRun(view, [{ card: -1 }]);

    const health = uploaded().filter((r) => r.detail?.phase === 'selector_health');
    expect(health).toHaveLength(2);
    expect(health[0].detail.sel1).toBe('card:2/2/0');
    expect(health[1].detail.sel1).toBe('card:1/0/0');
  });

  it('uploads no such row when the run sampled nothing', async () => {
    // A run that never reached a store page, or a store with no probed
    // selectors, costs the funnel nothing at all.
    await runToDone([]);
    expect(uploaded().filter((r) => r.detail?.phase === 'selector_health')).toHaveLength(0);
  });

  it('does not delay the row the funnel cares about most', async () => {
    // run_summary is the row most likely to survive a dropped batch, so it is
    // recorded first and this rides behind it.
    await runToDone([{ card: 0 }]);
    const rows = uploaded();
    const summary = rows.findIndex((r) => r.step === 'run_summary');
    const health = rows.findIndex((r) => r.detail?.phase === 'selector_health');
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(health).toBeGreaterThan(summary);
  });
});
