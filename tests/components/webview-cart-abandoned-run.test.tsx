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

import { act, render } from '@testing-library/react-native';

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
      logAutomationSteps: jest.fn(async (batch: any) => {
        ((globalThis as any).__batches ||= []).push(batch);
        return true;
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

const sheet = (props: { visible: boolean; storeId: string }) => (
  <WebViewCartSheet
    visible={props.visible}
    meals={[meal] as any}
    storeId={props.storeId}
    storeName={props.storeId}
    onClose={() => {}}
  />
);

beforeEach(() => {
  pendingStarts().length = 0;
  batches().length = 0;
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
    // anything ran; a pile of 'robot_challenge' is a store beating us.
    expect(typeof summaries[0].detail?.abandonedAt).toBe('string');
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
