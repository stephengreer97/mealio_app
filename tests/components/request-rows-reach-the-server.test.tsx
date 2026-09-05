// A REQUEST'S ROW HAS TO REACH THE SERVER, not just exist as a type.
//
// MEAL-219. The whole ticket exists because HTTP statuses were computed on the
// device and dropped at the boundary, so a test that only checked the record()
// contract would be re-making the original mistake one layer up
// [[measure-the-feature-not-the-function]]. This drives the sheet, posts what a
// rail posts, and reads what was UPLOADED.

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
import { enableRail, postToSheet, SESSION_OK, cartCount } from './helpers/railRun';
import { recordPrewarmRequest, clearPrewarmRequests } from '../../src/lib/prewarm-requests';

type Batch = { runId: string; steps: Array<Record<string, any>> };
const batches = () => ((globalThis as any).__batches ?? []) as Batch[];
const uploaded = () => batches().flatMap((b) => b.steps);
/** The rows a request produced, which carry an op in their detail. */
const requestRows = () => uploaded().filter((r) => r.detail?.via === 'request');

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => { (globalThis as any).__batches = []; clearPrewarmRequests(); });

const ing = (n: string) => ({
  ingredientName: n, searchTerm: n, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

/** Open a run and get as far as the search phase, then post request reports. */
async function runWith(reports: Array<Record<string, unknown>>) {
  enableRail();
  const view = render(
    <WebViewCartSheet
      visible
      meals={[{ id: 'm1', name: 'Dinner', ingredients: [ing('sour cream')] }] as never}
      storeId="heb"
      storeName="H-E-B"
      onClose={() => {}}
    />,
  );
  // logAutomationStart is a mocked async function and the run's id arrives on a
  // `.then`. No timer advance delivers a microtask, so without this the run
  // holds a null runId, telemetry never starts, and EVERY assertion below reads
  // an empty upload — which the first version of this file did, passing one
  // test vacuously on an array that was empty for the wrong reason.
  await act(async () => {});
  const post = (p: Record<string, unknown>) => postToSheet(view, p);
  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  act(() => { jest.advanceTimersByTime(2_000); });
  post(SESSION_OK);
  act(() => { jest.advanceTimersByTime(500); });
  post(cartCount(0, []));
  act(() => { jest.advanceTimersByTime(500); });
  post(SESSION_OK);
  act(() => { jest.advanceTimersByTime(500); });
  for (const r of reports) post({ type: 'NET_REQUEST', ...r });
  act(() => { jest.advanceTimersByTime(30_000); });
  return view;
}

describe('a request that reported itself reaches the upload', () => {
  it('keeps the status EXACTLY, which is the whole point of the ticket', async () => {
    await runWith([{ phase: 'search', op: 'productSearchPageV2', status: 503, why: 'http', attempts: 3, ms: 1800 }]);
    const row = requestRows().find((r) => r.httpStatus === 503);
    expect(row).toBeTruthy();
    expect(row!.httpStatus).toBe(503);
  });

  it('carries the phase, so a failure can be placed in the run', async () => {
    await runWith([{ phase: 'cart_read', op: 'CartLines', status: 412, why: 'http', attempts: 1, ms: 90 }]);
    expect(requestRows().find((r) => r.httpStatus === 412)?.phase).toBe('cart_read');
  });

  it('carries how many times it was asked', async () => {
    // Distinct from detail.attempt, which only the deleted click path ever set
    // and which the admin tab still reads.
    await runWith([{ phase: 'add', op: 'cartItemV2', status: 500, why: 'http', attempts: 3, ms: 2100 }]);
    expect(requestRows().find((r) => r.httpStatus === 500)?.attempts).toBe(3);
  });

  it('names the rail, not just the store', async () => {
    await runWith([{ phase: 'search', op: 'x', status: 500, why: 'http', attempts: 2, ms: 10 }]);
    expect(requestRows()[0]?.rail).toBe('heb');
  });

  it('records a successful request too, or a status histogram has no denominator', async () => {
    await runWith([{ phase: 'search', op: 'productSearchPageV2', status: 200, attempts: 1, ms: 240 }]);
    const ok = requestRows().find((r) => r.httpStatus === 200);
    expect(ok).toBeTruthy();
    expect(ok!.outcome).toBe('ok');
    expect(ok!.code).toBeUndefined();
  });

  it('gives every failing row a code, and never one that blames the match', async () => {
    await runWith([
      { phase: 'search', op: 'a', status: 500, why: 'http', attempts: 3, ms: 5 },
      { phase: 'add', op: 'b', status: 429, why: 'http', attempts: 3, ms: 5 },
    ]);
    const failed = requestRows().filter((r) => r.outcome === 'error');
    expect(failed.length).toBe(2);
    for (const r of failed) {
      expect(r.code).toBeTruthy();
      expect(r.code).not.toBe('match_rejected');
    }
    expect(failed.find((r) => r.httpStatus === 429)!.code).toBe('waf_block');
  });

  it('does not attribute a request to an item', async () => {
    // Under concurrency the request in flight is not the item being reported,
    // so an itemIndex here would be a confident lie.
    await runWith([{ phase: 'add', op: 'x', status: 500, why: 'http', attempts: 1, ms: 5 }]);
    // Assert the row EXISTS before asserting what it lacks. The first version
    // of this checked `requestRows()[0]?.itemIndex` on an array that was empty
    // for an unrelated reason, and passed while every other test in the file
    // failed.
    expect(requestRows()).toHaveLength(1);
    expect(requestRows()[0].itemIndex).toBeUndefined();
  });
});

describe("the prewarm's searches are the run's searches", () => {
  it('records rows the PREWARM produced before the run started', async () => {
    // MEASURED ON THE PIXEL. A run whose searches were prewarmed produced six
    // request rows and not one was a `search`: SilentSearchProbe has its own
    // WebView and its own onMessage, and that handler had never heard of
    // NET_REQUEST. The dashboard showed session, cart_read and add and looked
    // complete.
    recordPrewarmRequest({
      storeId: 'heb', phase: 'search', op: 'productSearchPageV2',
      status: 503, why: 'http', attempts: 3, ms: 1800,
    });
    await runWith([]);
    const row = requestRows().find((r) => r.httpStatus === 503);
    expect(row).toBeTruthy();
    expect(row!.phase).toBe('search');
    expect(row!.attempts).toBe(3);
  });

  it('does not record them twice when a run reruns', async () => {
    // startNetworkRun is what a whole-run retry calls, so a read-not-drain here
    // would count every prewarmed request again for every rerun.
    recordPrewarmRequest({
      storeId: 'heb', phase: 'search', op: 'x', status: 200, why: null, attempts: 1, ms: 10,
    });
    await runWith([]);
    expect(requestRows().filter((r) => r.detail?.op === 'x')).toHaveLength(1);
  });
});
