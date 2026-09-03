// An ingredient Mealio could not add goes to the REVIEW screen, not to the store.
//
// Stephen, 2026-09-02, on a 31-item Albertsons run that added 29 and sent him to
// albertsons.com for the other two:
//
//   "Those two should be going to reconcilliation (review ingredients screen).
//    Not do it yourself. Why? Failed Add, then failed lookup, we should show the
//    user their alternatives."
//
// How they got there. An ingredient that is never written is not a "definitive
// failure" to the reconcile — the cart is simply SHORT of it, which is a top-up.
// The top-up then tries to re-write it, has no product id to write, and the last
// line of that branch handed the user the store's own search page. That is the
// last resort — what a store with no rail gets — and reaching it from here
// skipped the one screen built for this exact situation.
//
// The observable is the screen the user lands on, because that is what went
// wrong. Asserting on the routing function would have passed before the change.

import { act, fireEvent, render } from '@testing-library/react-native';

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
      logAutomationStart: jest.fn(async () => 'run-review-routing'),
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
import {
  enableRail, postToSheet, SESSION_OK, cartCount, searchResult, searchDone,
  candidate, addResult, addDone,
} from './helpers/railRun';

beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });
beforeEach(() => { (globalThis as any).__flags = { presearchAdd: false, parallelAdd: true }; });

const ing = (ingredientName: string, searchTerm: string) => ({
  ingredientName, searchTerm, productQty: 1, qty: 1, unit: 'qty', measure: null,
});

/**
 * Two ingredients. One lands; one never gets written at all, and the cart read
 * confirms it is not there — which is the shape of Stephen's run.
 *
 * `strandedCandidates` is what the ingredient-name fallback found for it: some
 * alternatives, or none.
 */
async function runWithOneStranded(
  strandedCandidates: ReturnType<typeof candidate>[],
  // true  = the store never answered the search (Stephen's case)
  // false = the store answered with nothing
  unanswered = false,
) {
  enableRail();
  const view = render(
    <WebViewCartSheet
      visible
      meals={[{ id: 'm1', name: 'Dinner', ingredients: [
        ing('Sour Cream', 'sour cream'),
        ing('Chicken Tenders', 'PERDUE SIMPLY SMART ORGANIC Tenders'),
      ] }] as never}
      storeId="heb"
      storeName="H-E-B"
      onClose={() => {}}
    />,
  );
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

  // One term matches. The other is the case that actually stranded Stephen: the
  // store never ANSWERED the search — a timeout, not an empty result. Those are
  // different facts and the run records them differently.
  post(searchResult('sour cream', [candidate('sour cream')]));
  if (unanswered) {
    post({ type: 'SEARCH_RESULT_FAILED', source: 'network',
      term: 'PERDUE SIMPLY SMART ORGANIC Tenders', why: 'no_response', ms: 15000 });
  } else {
    post(searchResult('PERDUE SIMPLY SMART ORGANIC Tenders', []));
  }
  post(searchDone(2));
  act(() => { jest.advanceTimersByTime(200); });
  // ...and the ingredient-name search the run fires alongside the writes.
  post(searchResult('Chicken Tenders', strandedCandidates));
  act(() => { jest.advanceTimersByTime(500); });

  post(addResult(0, 'sour cream', true));
  post(addDone(1, [], [{ name: 'sour cream', qty: 1 }]));
  act(() => { jest.advanceTimersByTime(5_000); });

  // The reconcile read: one item there, the other absent.
  post(cartCount(1, [{ name: 'sour cream', qty: 1 }]));
  act(() => { jest.advanceTimersByTime(2_000); });
  return view;
}

/** The review step opens on an "Items Not Added" summary; the cards are one tap
 *  further in. Both are the review screen — neither is the store. */
function openTheCard(view: ReturnType<typeof render>) {
  const btn = view.queryByText(/review \d+ ingredient/i);
  if (!btn) throw new Error('no review button — the run did not reach the review screen');
  act(() => { fireEvent.press(btn); });
}

describe('a search the store never answered', () => {
  // STEPHEN'S ACTUAL CASE, and the one the routing got wrong.
  //
  // An unanswered search is not an empty one. The engine already knew that — it
  // stamps `search_unanswered` and its comment says "it goes to review instead,
  // which is where an item nobody could answer for belongs". But that reason was
  // not in the reconcile's list of definitive failures, so the item fell through
  // to quantity matching, the cart had none of it, and it came out as a
  // SHORTFALL. The shortfall had no product id to write, and the last line of
  // that branch handed the user albertsons.com.
  //
  //   reconcile: confirmed= 29 retry= 2 [...] review= 0 []
  //   cart verdicts: ... missing= [] unverified= 2
  //   network top-up: cannot write these — handing over
  it('reaches the review screen, not the store', async () => {
    const view = await runWithOneStranded([candidate('H-E-B Chicken Breast Tenders')], true);
    expect(view.queryByText(/items not added/i)).toBeTruthy();
    expect(view.queryByText(/PERDUE SIMPLY SMART ORGANIC Tenders/i)).toBeTruthy();
  });

  it('offers the alternatives the ingredient-name search found', async () => {
    // This branch never fired that search, which is why the stranded items
    // reached the user with an empty card.
    const view = await runWithOneStranded([
      candidate('H-E-B Chicken Breast Tenders'),
      candidate('Perdue Chicken Tenders, 12 oz'),
    ], true);
    openTheCard(view);
    expect(view.queryByText(/H-E-B Chicken Breast Tenders/i)).toBeTruthy();
    expect(view.queryByText(/Perdue Chicken Tenders, 12 oz/i)).toBeTruthy();
  });

  it('says the store did not answer, rather than that it had nothing', async () => {
    // The two suggest different next steps. "No products found" tells the user
    // this store does not stock it, which we never established.
    const view = await runWithOneStranded([candidate('H-E-B Chicken Breast Tenders')], true);
    openTheCard(view);
    expect(view.queryByText(/didn't answer our search/i)).toBeTruthy();
    expect(view.queryByText(/no products found/i)).toBeNull();
  });

  it('keeps the item that DID land', async () => {
    const view = await runWithOneStranded([candidate('H-E-B Chicken Breast Tenders')], true);
    expect(view.queryByText(/1 item/i)).toBeTruthy();      // one not added, not two
  });
});

describe('a search the store answered with nothing', () => {
  // Already routed correctly before this change; here so a future edit to the
  // reason list cannot quietly break the case that was working.
  it('reaches the review screen too', async () => {
    const view = await runWithOneStranded([candidate('H-E-B Chicken Breast Tenders')]);
    expect(view.queryByText(/items not added/i)).toBeTruthy();
    openTheCard(view);
    expect(view.queryByText(/H-E-B Chicken Breast Tenders/i)).toBeTruthy();
  });

  it('still reviews it when nothing at all was found', async () => {
    // An empty card is still the right screen: it says so plainly and the user
    // can search from there. Handing them the store outright skips the run's own
    // summary of what did land.
    const view = await runWithOneStranded([]);
    expect(view.queryByText(/items not added/i)).toBeTruthy();
  });
});
