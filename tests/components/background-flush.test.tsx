// BACKGROUNDING THE APP SHIPS WHAT IS ALREADY BUFFERED (MEAL-161).
//
// MEAL-5 made the terminal `run_summary` row ship on every path, so a run that
// is killed still has a start and an end. It did not fix the MIDDLE. There was
// no AppState listener anywhere in the telemetry path, so a run backgrounded
// and then killed by the OS lost up to one flush interval of steps that had
// ALREADY BEEN RECORDED.
//
// Why that is worse than it sounds, and the reason this is a p2 rather than a
// nicety: the run row survives and the terminal row survives, so the funnel
// shows a COMPLETE run with holes in the middle. A hole reads as a step that
// failed rather than as data that never arrived. A partial funnel is worse than
// an absent one because it looks like evidence, which is the same misreading
// the per-run sampling roll exists to prevent.
//
// Asserted through the SHEET rather than by calling flush() on a recorder built
// in the test: [[measure-the-feature-not-the-function]]. What is under test is
// whether the listener is wired to the live recorder at all, and a recorder
// constructed here proves nothing about that.

import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState } from 'react-native';

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
      logAutomationStart: jest.fn(async () => 'run-background-flush'),
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
import { usage } from '../../src/lib/api';
import { AutomationTelemetry } from '../../src/lib/automation-telemetry';
import {
  enableRail, postToSheet, SESSION_OK, cartCount, searchResult, searchDone, candidate,
  addResult, addDone,
} from './helpers/railRun';

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  // Before the spy below, and before anything else: `logAutomationSteps` is a
  // module-level mock shared by every test in this file, so without this a run
  // that flushed in one test is still on the call list in the next -- which is
  // exactly how the "nothing uploaded yet" premise came to pass for the wrong
  // reason.
  jest.clearAllMocks();
  disposeSpy = jest.spyOn(AutomationTelemetry.prototype, 'dispose');
  (globalThis as any).__flags = { presearchAdd: false, parallelAdd: true };
  appStateHandlers = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((event: string, handler: any) => {
    if (event === 'change') appStateHandlers.push(handler);
    return { remove: jest.fn() };
  }) as any);
});

const steps = () => (usage.logAutomationSteps as jest.Mock);

/** Set in beforeEach so "backgrounding did not end the run" can be asserted. */
let disposeSpy: jest.SpyInstance;

/**
 * The sheet's AppState handler, captured at subscribe time.
 *
 * `AppState.emit('change', ...)` does not reach it under jest-expo's React
 * Native mock. It returns silently, which would make this whole file pass by
 * never running the code it is about. Spying on `addEventListener` is the
 * version that actually exercises the flush, and the same trick
 * creator-draft-badge.test.tsx already needed for the same reason.
 */
let appStateHandlers: Array<(state: string) => void> = [];

/** Send the app to the given state, the way React Native would. */
function toState(state: string): void {
  act(() => { appStateHandlers.forEach((h) => h(state)); });
}

const background = () => toState('background');

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
  return { view, post: (p: Record<string, unknown>) => postToSheet(view, p) };
}

/**
 * A run holding recorded-but-not-yet-uploaded steps.
 *
 * Async because the recorder does not exist until `logAutomationStart`
 * RESOLVES -- steps are keyed to a runId the server issues -- and under fake
 * timers that promise only settles when the microtask queue is drained inside
 * `act`. Get this wrong and every assertion below runs against the no-op
 * recorder, which discards everything and makes the suite pass by testing
 * nothing. That is what the first `it` in this file exists to catch.
 *
 * THE TIMING IS THE WHOLE SETUP, so it is spelled out rather than tuned until
 * green. Measured on this run: the `search` step is recorded about 14 seconds
 * in, when the search settles, and recording ARMS the flush timer for one
 * interval later (10s). So rows sit in the buffer between roughly 14s and 24s,
 * and that is the only window in which "backgrounded with something to lose"
 * is a real state. This stops at 15s, inside it.
 *
 * Advanced a second at a time on purpose. One jump of 15s would cross the
 * flush boundary from wherever the step actually landed and upload the rows
 * before the test could background the app.
 */
async function midRun() {
  const { view, post } = openSheet();
  await act(async () => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  await act(async () => { await Promise.resolve(); });
  act(() => { jest.advanceTimersByTime(2_000); });
  post(SESSION_OK);
  act(() => { jest.advanceTimersByTime(500); });
  post(cartCount(0, []));
  act(() => { jest.advanceTimersByTime(500); });
  post(searchResult('sour cream', [candidate('Sour Cream, 16 oz')]));
  post(searchDone(1));
  for (let i = 0; i < 15; i++) {
    act(() => { jest.advanceTimersByTime(1_000); });
    // A SECOND act boundary, and it is load-bearing. Advancing the clock queues
    // the effects the search settle runs in; they only flush when act exits, so
    // without this the step is never recorded and the run sits one effect short
    // of the state this file is about.
    act(() => {});
  }
  return { view, post };
}

describe('a run that is backgrounded mid-flight', () => {
  it('has recorded steps that have NOT been uploaded yet', async () => {
    // The premise. Without this the test below could pass on a run that had
    // already flushed for its own reasons, and would be asserting nothing.
    await midRun();
    expect(steps()).not.toHaveBeenCalled();
  });

  it('uploads them when the app goes to background', async () => {
    await midRun();
    steps().mockClear();
    background();
    expect(steps()).toHaveBeenCalled();
    const uploaded = steps().mock.calls[0][0];
    expect(uploaded.runId).toBe('run-background-flush');
    expect(uploaded.steps.length).toBeGreaterThan(0);
  });

  it('does not end the run, because a backgrounded run may come back', async () => {
    const { view } = await midRun();
    // Cleared here, not in beforeEach: opening the sheet disposes the no-op
    // recorder it starts with, and counting that would make this pass on a
    // listener that disposes too.
    disposeSpy.mockClear();
    background();

    // Backgrounding is not an ending. It emits no terminal row, and it does not
    // hand the user off to the store: MEAL-5 deliberately left the terminal row
    // out of an AppState listener, and that call was endorsed in review. A
    // backgrounded run may resume, a killed app cannot emit anyway, and
    // `runConcern` already catches stale started rows from the run table.
    expect(usage.logAutomationComplete as jest.Mock).not.toHaveBeenCalled();
    expect(view.queryByTestId('manual-bar')).toBeFalsy();

    // And it did not DISPOSE the recorder, which is the specific over-reach
    // this ticket has to avoid. dispose() emits the final flush, clears the
    // timers and wipes the buffer, so a run that came back to the foreground
    // and carried on would record the rest of itself into a dead object and
    // ship none of it. Nothing about that is visible on screen, so it is
    // asserted on the call.
    //
    // This is the assertion that fails when someone reaches for dispose()
    // because it "flushes too". Checked: swapping flush() for dispose() in the
    // listener leaves every other test in this file green.
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it('ignores every state that is not background', async () => {
    await midRun();
    steps().mockClear();
    // iOS emits 'inactive' for a notification pull-down and for the app
    // switcher preview. Neither is a run in danger, and 'inactive' precedes
    // 'background' anyway when the app really does leave, so flushing on it
    // would double every departure.
    toState('inactive');
    toState('active');
    expect(steps()).not.toHaveBeenCalled();
  });
});
