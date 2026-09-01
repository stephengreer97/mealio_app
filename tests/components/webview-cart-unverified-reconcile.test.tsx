// MEAL-190 — a reconcile that could not read the cart must SAY SO.
//
// There are two ways the reconcile fails to get a cart reading, and until this
// change they were reported asymmetrically:
//
//   • The probe never answers. triggerCartProbe's timeout fires and sets
//     "Couldn't verify your <store> cart".
//   • The probe answers "I cannot prove this page is the cart" — `count: null`
//     with NO `items`, which is exactly what the MEAL-152 page-identity guard
//     posts on a cart URL that redirected. That landed in the `!rows` branch,
//     which reconciles from the workers' own reports and went to the done screen
//     SILENTLY.
//
// The silent one is the likely one: the code's own comment calls that branch the
// EXPECTED outcome rather than a rarity, because MEAL-152 made a redirected cart
// page post no items by design. Stephen's 21:31 run hit the timeout half and was
// warned; the same run's prewarm hit the other half.
//
// Why it is worth a test rather than a glance. This is the state in which NOTHING
// can contradict the run: MEAL-185's multi-qty under-add, MEAL-187's unhydrated
// zero and MEAL-188's over-adding retry all report success on their own internal
// checks, and the cart diff is the only thing that ever disagreed with them. A
// run with no diff and no warning presents a guess as a verified result, which is
// the reporting half of "never over or under add".
//
// The observable is what the DONE SCREEN says, driven through a real parallel add
// pass — not the helper that formats the string. A test that asserted on the
// reconcile function would have passed before this change too.

import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('react-native-webview', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  // A ref that records WHEN each script is injected. The other cart tests hand
  // back no ref at all, so `injectJavaScript` is a no-op there and nothing sees
  // the scripts — and the pre-search commit's delay is the one flag effect that
  // is only visible here.
  const MockWebView = RealReact.forwardRef((props: any, ref: any) => {
    RealReact.useImperativeHandle(ref, () => ({
      injectJavaScript: () => {},
      stopLoading: () => {}, goBack: () => {}, reload: () => {},
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
      logAutomationStart: jest.fn(async () => 'run-unverified-reconcile'),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => true),
    },
  };
});

// Signed in, so the pre-search effect can get past its login gate. Same reason
// and same shape as `webview-cart-selector-health.test.tsx`.
jest.mock('../../src/context/LoginPrewarmContext', () => {
  const actual = jest.requireActual('../../src/context/LoginPrewarmContext');
  return {
    ...actual,
    useLoginPrewarm: () => ({
      checkStore: () => {},
      getStatus: () => 'loggedIn',
      takePrewarmedCart: () => null,
      statusVersion: 1,
    }),
  };
});

// The config the sheet reads, overridable per test. The REAL merge and bundled
// defaults underneath — only the flags block is swapped, so a test cannot
// accidentally assert against a config shape that could never ship.
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
import { usage } from '../../src/lib/api';

/** What the run reported to /api/usage/automation when it finished. */
const completedRun = () => {
  const calls = (usage.logAutomationComplete as jest.Mock).mock.calls;
  return calls.length > 0 ? calls[calls.length - 1][0] : null;
};

type Ing = { ingredientName: string; searchTerm?: string; productQty: number; qty: number; unit: string; measure: string | null };


const chosen = (name: string): Ing => ({
  ingredientName: name, searchTerm: name.toLowerCase(), productQty: 1, qty: 1, unit: 'qty', measure: null,
});

const sheet = (...ingredients: Ing[]) => (
  <WebViewCartSheet
    visible
    meals={[{ id: 'm1', name: 'Tacos', ingredients }] as never}
    storeId="heb"
    storeName="H-E-B"
    onClose={() => {}}
  />
);

// The advanceTimersByTime calls below were copied from the flag-wiring test
// without its useFakeTimers, so every one of them was a no-op that logged a
// warning. Installing them for real matters beyond the noise: the run arms a
// ~14s cartProbeResultMs timeout, and a test that relies on real time not
// elapsing is one slow CI box away from observing the timeout path instead of
// the branch it means to test.
beforeAll(() => { jest.useFakeTimers(); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  // Pre-search off so the run takes the parallel ADD pool, which is the path that
  // ends in finishParallelAdd -> triggerCartProbe('reconcile'). Pre-search commits
  // through the same reconcile, but parking adds a phase this test does not need.
  (globalThis as any).__flags = { presearchAdd: false, parallelAdd: true };
  (usage.logAutomationComplete as jest.Mock).mockClear();
});

/**
 * Drive a parallel add pass to the reconcile, then answer the reconcile probe
 * with `answer`.
 *
 * Everything posted here is a message the store's own scripts really post. The
 * reconcile answer is the variable under test: one with `items` gives the diff a
 * cart to compare, one without is the MEAL-152 refusal.
 */
async function runToReconcile(
  answer: Record<string, unknown>,
  workerSucceeded = true,
  // A rail verdict riding on the add's report, exactly as heb-cart-query posts
  // it. Present, it is what the walled-cart guard weighs the cart read against.
  confirm?: Record<string, unknown>,
) {
  // Driven over the NETWORK RAIL. This used to run a parallel add pass through
  // the worker pool and answer the reconcile probe from the cart PAGE; both are
  // gone. The reconcile itself, and everything this file asserts about it, is
  // reached identically — `finishParallelAdd` is still where a pass ends.
  enableRail();
  const view = render(sheet(chosen('Sour Cream')));
  // Let logAutomationStart's promise settle. It is a `.then` on a mocked async
  // function, so no timer advance will ever deliver it — only yielding to the
  // microtask queue does, and a synchronous act() does not yield. Without this the
  // run holds a null runId, `if (runId)` skips logAutomationComplete entirely, and
  // every assertion about what the run REPORTED reads an empty mock.
  await act(async () => {});
  const post = (payload: Record<string, unknown>) => postToSheet(view, payload);

  act(() => { fireEvent.press(view.getByText(/add ingredients to/i)); });
  act(() => { jest.advanceTimersByTime(2_000); });

  // Posted TWICE, and not defensively: the session probe answers two different
  // questions and the run asks them in this order. The first answers the login
  // check (skipped entirely when the prewarm already knows), the second is the
  // run's own session read, which beginSearchFlow makes after the baseline.
  post(SESSION_OK);
  act(() => { jest.advanceTimersByTime(500); });
  // The before-snapshot, read over the rail rather than by loading /cart. It has
  // to succeed, or the run would be unverified for a different reason and the
  // test would prove nothing about the reconcile.
  post(cartCount(0, []));
  act(() => { jest.advanceTimersByTime(500); });
  post(SESSION_OK);
  act(() => { jest.advanceTimersByTime(500); });

  // Search answers, then the write.
  // Keyed by the term the run actually searched — `chosen()` lowercases it — and
  // the candidate is named the same, because the add path takes an EXACT match
  // only. A mismatch here routes to review instead of writing, which is a
  // different test.
  post(searchResult('sour cream', [candidate('sour cream')]));
  post(searchDone(1));
  act(() => { jest.advanceTimersByTime(500); });
  post(addResult(0, 'sour cream', workerSucceeded,
    workerSucceeded
      ? (confirm ? { confirm } : {})
      : { reason: 'add button not found', ...(confirm ? { confirm } : {}) }));
  post(addDone(1, [], workerSucceeded ? [{ name: 'sour cream', qty: 1 }] : []));
  act(() => { jest.advanceTimersByTime(5_000); });

  post(answer);
  act(() => { jest.advanceTimersByTime(2_000); });
  return view;
}

describe('reconcile that cannot read the cart (MEAL-190)', () => {
  it('warns when the cart page refuses to identify itself', async () => {
    // `count: null` and NO `items` — verbatim what cartPathGuardJs posts when the
    // cart URL landed somewhere that is not the cart. Before this change the run
    // reconciled from its own worker reports and said nothing.
    const view = await runToReconcile({
      type: 'CART_COUNT', count: null, reason: 'not_cart_page', url: 'https://www.heb.com/',
    });
    expect(view.queryByText(/couldn't verify your h-e-b cart/i)).toBeTruthy();
  });

  it('does not warn when the cart answered with rows', async () => {
    // The other side of the rule: a reconcile that really did read the cart must
    // not carry an unverified warning, or the message means nothing.
    const view = await runToReconcile({
      type: 'CART_COUNT', count: 1,
      items: [{ name: 'Sour Cream', qty: 1 }],
      url: 'https://www.heb.com/cart',
    });
    expect(view.queryByText(/couldn't verify your h-e-b cart/i)).toBeNull();
  });
  it('warns on the done screen even when nothing was added', async () => {
    // The loudest version of this state, and it renders through a DIFFERENT
    // banner than the two cases above. `!rows` sets totalAdded from the worker
    // reports, so a run whose workers also failed lands on the nothing-added
    // done screen — the run most in need of the warning, since it has neither a
    // cart reading nor a success to point at. Covered separately because
    // deleting the nothing-added banner leaves the other tests green.
    const view = await runToReconcile(
      { type: 'CART_COUNT', count: null, reason: 'not_cart_page', url: 'https://www.heb.com/' },
      false,
    );
    expect(view.queryByText(/couldn't verify your h-e-b cart/i)).toBeTruthy();
  });

  // THE MUTANT THIS FILE USED TO LEAVE UNCOVERED is now killed, by the state
  // split rather than by a new test. When the warning lived in cartDeltaWarning,
  // hoisting it above `if (!rows)` kept every test here green: the rows path
  // cleared cartDeltaWarning before finalizing, so the hoist was only observable
  // on a top-up finalizing through the serial 'after' phase, several phases past
  // where these tests stop. cartUnverified is cleared only when a run OPENS —
  // nothing clears it mid-run, because every path that sets it finalizes the run
  // on the spot — so a hoisted setCartUnverified now shows a banner on the rows
  // case above and fails it directly. No defensive clear was added in the rows
  // path for that reason: it would restore the hole.
});

// ── What the run REPORTS, not just what it says ─────────────────────────────
//
// Stephen's call on this ticket (option c): `unverified` gets a telemetry value of
// its own before the banner ships. The banner and the outcome are two different
// audiences and only one of them is in the kitchen — the fleet view is where
// "this store's cart has not been readable for a week" is visible at all.
//
// Recording these as `partial` was the alternative, and it is a claim about a cart
// nobody saw: indistinguishable from a run that really did under-add, which is the
// exact confusion MEAL-185/187/188 already live in. Recording them as `success` is
// the silence this ticket exists to end. mealio_central accepts the fourth value
// (app/api/usage/automation/route.ts there); an outcome it does not recognise is
// stored as NULL, which is why the two halves ship in that order.
describe('the outcome an unverifiable run reports (MEAL-190)', () => {
  it('reports unverified when the cart could not be read', async () => {
    await runToReconcile({
      type: 'CART_COUNT', count: null, reason: 'not_cart_page', url: 'https://www.heb.com/',
    });
    // The add itself succeeded — this run is not a failure, and its one item may
    // well be sitting in the cart. What is missing is anything that could say so.
    expect(completedRun()).toMatchObject({ itemsAdded: 1, outcome: 'unverified' });
  });

  it('still reports success when the cart answered', async () => {
    // The other side of the rule. If a verified-clean run reported 'unverified'
    // too, the value would say nothing and the fleet number built on it would be
    // a count of runs rather than a count of unchecked ones.
    await runToReconcile({
      type: 'CART_COUNT', count: 1,
      items: [{ name: 'Sour Cream', qty: 1 }],
      url: 'https://www.heb.com/cart',
    });
    expect(completedRun()).toMatchObject({ itemsAdded: 1, outcome: 'success' });
  });

  it('reports failed, not unverified, when nothing was added', async () => {
    // Ordering inside the outcome expression, pinned: a run that added nothing has
    // a worse thing to say about itself than "we could not check". Moving
    // `unverified` ahead of the zero-added test would relabel every failed run at
    // a store whose cart page redirects.
    await runToReconcile(
      { type: 'CART_COUNT', count: null, reason: 'not_cart_page', url: 'https://www.heb.com/' },
      false,
    );
    expect(completedRun()).toMatchObject({ itemsAdded: 0, outcome: 'failed' });
  });
});


// ── The walled cart (MEAL-16, run 7 of 2026-08-14) ───────────────────────────
//
// Under the Imperva wall the /cart page renders with no rows and the count
// script posts `{count: 0, items: []}` — `reason: null`, `onBlockedPage: false`.
// Nothing downstream can tell that from a genuinely empty cart: `[]` IS an
// array, so the `!rows` refusal above never fired. Reconcile believed it, and
// re-added all 18 items on top of the 12 the rail had just confirmed `landed`.
// The measured cost was 12 duplicate units across 10 lines.
//
// The contradiction is already in the caller's hands — the verdicts are computed
// from the same `attempts` six lines earlier — so a read that disagrees with them
// about the whole cart loses.
describe('a cart read that contradicts the rail (MEAL-16)', () => {
  const landed = { state: 'landed', reason: 'qty_increased', via: 'cart_query', skuId: '123', productId: null };

  it('treats an empty cart read as UNREAD when the rail confirmed a landing', async () => {
    const view = await runToReconcile(
      { type: 'CART_COUNT', count: 0, items: [], url: 'https://www.heb.com/cart' },
      true,
      landed,
    );
    expect(view.queryByText(/couldn't verify your h-e-b cart/i)).toBeTruthy();
  });

  it('does not re-add what the rail said landed', async () => {
    // The defect this exists to stop. Believing the empty read sends the run back
    // to 'searching' to re-add an item that is already in the cart; the honest
    // path finishes on the done screen instead.
    const view = await runToReconcile(
      { type: 'CART_COUNT', count: 0, items: [], url: 'https://www.heb.com/cart' },
      true,
      landed,
    );
    expect(view.queryByText(/1 item added to your h-e-b cart/i)).toBeTruthy();
    expect(view.queryByText(/topping up/i)).toBeNull();
  });

  it('still believes an empty cart when the rail confirmed nothing', async () => {
    // Deliberately narrow. With no landed verdict there is no contradiction, so
    // an empty cart has to keep reading as an empty cart — otherwise every run
    // that genuinely added nothing would claim it could not check.
    //
    // Driven by a FAILED write, which is the only way to get "no landed verdict"
    // now. It used to be a write that succeeded without a confirm: on the DOM
    // path a worker could report success from a click it never verified. The rail
    // cannot — it checks each write against that write's own response — so on the
    // rail success and confirmation are the same fact.
    const view = await runToReconcile(
      { type: 'CART_COUNT', count: 0, items: [], url: 'https://www.heb.com/cart' },
      false,
    );
    expect(view.queryByText(/couldn't verify your h-e-b cart/i)).toBeNull();
  });
});


// ── The cart-check banner folds its list (MEAL-174 / MEAL-176) ───────────────
//
// The banner is the ONLY place a user is told a run may have over- or
// under-added, and it names every product it applies to. On a big cart that
// list ran to a wall of text. So the LIST folds and the VERDICT does not —
// collapsing the whole thing would hide the fact that anything is wrong, which
// is the one job this banner has.
describe('the cart-check banner (MEAL-174 / MEAL-176)', () => {
  const landed = { state: 'landed', reason: 'qty_increased', via: 'cart_query', skuId: '123', productId: null };

  /** A cart read holding something nobody asked for — the shape that makes the
   *  banner name products. */
  const withAnExtraProduct = () => runToReconcile(
    {
      type: 'CART_COUNT',
      count: 2,
      items: [{ name: 'Sour Cream', qty: 1 }, { name: 'Chicken Thighs', qty: 1 }],
      url: 'https://www.heb.com/cart',
    },
    true,
    landed,
  );

  it('states the verdict without needing to be expanded', async () => {
    // This is the finishParallelAdd over-add warning, not buildCartVerdict's —
    // the reconcile probe answers before the after-probe ever runs, so this is
    // the wording a real over-add reaches the user through.
    const view = await withAnExtraProduct();
    expect(view.queryByText(/cart check: your h-e-b cart has/i)).toBeTruthy();
  });

  it('folds the list behind a toggle, and opens it on tap', async () => {
    // The discriminator: only ExpandableNotice emits these. A plain <Text>
    // banner — what this used to be — has none, so this fails if the banner
    // ever regresses to one string.
    const view = await withAnExtraProduct();
    expect(view.queryByTestId('cart-check-warning-toggle')).toBeTruthy();
    // Collapsed the list is a line-capped preview; the scrolling body only
    // exists once opened, which is what stops a long list being the page.
    expect(view.queryByTestId('cart-check-warning-preview')).toBeTruthy();
    expect(view.queryByTestId('cart-check-warning-body')).toBeNull();

    act(() => { fireEvent.press(view.getByTestId('cart-check-warning-toggle')); });
    expect(view.queryByTestId('cart-check-warning-body')).toBeTruthy();
  });

  it('keeps the product names out of the always-visible verdict', async () => {
    // The verdict line counts them; it must not carry the list, or folding the
    // list saves nothing.
    const view = await withAnExtraProduct();
    const verdict = view.queryByText(/cart check: your h-e-b cart has/i);
    expect(String(verdict?.props.children)).not.toMatch(/Chicken Thighs/);
  });

  it('stays a plain banner when there is no list to fold', async () => {
    // The unread-cart message is one sentence naming nothing. Giving it a
    // disclosure arrow would promise detail that does not exist.
    const view = await runToReconcile({
      type: 'CART_COUNT', count: null, reason: 'not_cart_page', url: 'https://www.heb.com/',
    });
    expect(view.queryByText(/couldn't verify your h-e-b cart/i)).toBeTruthy();
    expect(view.queryByTestId('cart-check-warning-toggle')).toBeNull();
  });
});
