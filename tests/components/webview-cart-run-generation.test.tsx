// Closing the cart sheet mid-flight must retire its run (MEAL-142 review).
//
// `logAutomationStart` is a round trip of roughly 100-500ms and its `.then()` is
// where three things get written: the run id the completion call uses, the
// per-step telemetry recorder, and (new in MEAL-142) the run a bug report names.
// The close path re-arms `automationStartedRef`, so closing and reopening puts
// two starts in flight at once — open HEB, close before the response lands, open
// Walmart — and whichever responds LAST wins all three writes.
//
// Both halves are real damage and neither is visible in the age of the run: both
// are seconds old.
//   • the bug report names an abandoned HEB run while Walmart is the one failing
//   • WORSE, and pre-existing: the recorder installed by the late response is
//     keyed to HEB, so Walmart's steps upload under HEB's run id
//
// So the fix is a generation counter, and these tests drive the responses out of
// order on purpose.

import { act, render } from '@testing-library/react-native';

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
 * `logAutomationStart` never settles on its own here — each call parks on the
 * global queue below so a test can land the responses in whatever order it wants.
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
      logAutomationSteps: jest.fn(async () => {}),
    },
  };
});

/** Records the run id every recorder is constructed with. */
jest.mock('../../src/lib/automation-telemetry', () => {
  const actual = jest.requireActual('../../src/lib/automation-telemetry');
  class RecordingTelemetry {
    constructor(opts: any) {
      ((globalThis as any).__recorderRunIds ||= []).push(opts.runId);
    }
    record() {}
    startTimer() { return () => {}; }
    dominantFailureCode() { return undefined; }
    async flush() {}
    async dispose() {}
  }
  return { ...actual, AutomationTelemetry: RecordingTelemetry };
});

import WebViewCartSheet from '../../src/components/WebViewCartSheet';
import { clearLastAutomationRun, getLastAutomationRun } from '../../src/lib/lastAutomationRun';

type PendingStart = { storeId: string; resolve: (id: string) => void };

const pendingStarts = () => ((globalThis as any).__pendingStarts ||= []) as PendingStart[];
const recorderRunIds = () => ((globalThis as any).__recorderRunIds ||= []) as string[];

/** Land the parked response for `storeId`, as `run-<storeId>`. */
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
  recorderRunIds().length = 0;
  clearLastAutomationRun();
});

describe('a cart sheet closed before its run id arrives', () => {
  it('lets the reopened store win both the recorded run and the recorder, whichever responds last', async () => {
    // Open for HEB. The start request is in flight.
    const { rerender } = render(sheet({ visible: true, storeId: 'heb' }));
    expect(pendingStarts().map((p) => p.storeId)).toEqual(['heb']);

    // The user backs out before it lands and immediately opens Walmart, so a
    // second start goes out while HEB's is still unanswered.
    await act(async () => { rerender(sheet({ visible: false, storeId: 'heb' })); });
    await act(async () => { rerender(sheet({ visible: true, storeId: 'walmart' })); });
    expect(pendingStarts().map((p) => p.storeId)).toEqual(['heb', 'walmart']);

    // Walmart answers first, then the abandoned HEB request answers second —
    // the ordering that used to let HEB write last and win.
    await landStartFor('walmart');
    await landStartFor('heb');

    // The run a bug report would name is the one being automated.
    expect(getLastAutomationRun()).toMatchObject({
      runId: 'run-walmart',
      storeId: 'walmart',
    });

    // And the recorder uploading Walmart's steps is keyed to Walmart's run. HEB's
    // late response must not install a recorder at all — that is the pre-existing
    // half of this bug, and it misfiles real telemetry.
    expect(recorderRunIds()).toEqual(['run-walmart']);
  });

  it('records nothing at all when the sheet is closed and not reopened', async () => {
    const { rerender } = render(sheet({ visible: true, storeId: 'heb' }));
    await act(async () => { rerender(sheet({ visible: false, storeId: 'heb' })); });
    await landStartFor('heb');

    // Covers the sheet that closes itself on open for a store it cannot automate
    // (a Kroger-family id or mockstore has no WebView scripts, so the reset-on-open
    // effect calls onClose immediately). A run that automated nothing is not the
    // run a bug report is about.
    expect(getLastAutomationRun()).toBeNull();
    expect(recorderRunIds()).toEqual([]);
  });

  it('records nothing when the sheet is torn down rather than hidden', async () => {
    // How the live mount site ends a run: CartJobContext renders this with
    // `visible` hardcoded true and drops the job, so the component unmounts and
    // the close branch never runs. The component's own refs go with it, but the
    // recorded run is module state and outlives it.
    const { unmount } = render(sheet({ visible: true, storeId: 'heb' }));
    await act(async () => { unmount(); });
    await landStartFor('heb');

    expect(getLastAutomationRun()).toBeNull();
  });

  it('still records the run for a sheet that stays open', async () => {
    render(sheet({ visible: true, storeId: 'heb' }));
    await landStartFor('heb');

    expect(getLastAutomationRun()).toMatchObject({ runId: 'run-heb', storeId: 'heb' });
    expect(recorderRunIds()).toEqual(['run-heb']);
  });
});
