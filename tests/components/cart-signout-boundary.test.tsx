// Signing out has to END the cart run, not just wipe what it has written so far
// (MEAL-142 confirming review).
//
// AuthContext.logout clears the console ring buffer and the recorded cart run.
// That was not enough, because nothing stopped the run that refills them:
//
//   • CartJobProvider is mounted ABOVE NavigationContainer (App.tsx), so the
//     navigator swapping to the auth stack does not unmount it.
//   • In layer mode the sheet is a plain root View, `pointerEvents: 'none'` when
//     collapsed — which is exactly why the app underneath stays usable during a
//     background run.
//
// So: A starts an H-E-B run, minimises to the bubble (the designed flow), signs
// out. The WebView kept automating and kept logging product names, failed adds
// and ingredient names back into the buffer logout had just emptied — enough
// lines in one run to refill all 600. B signs in on the login screen showing over
// A's still-live cart layer, files a report from Help, and A's cart contents go
// to support attached to B's token-verified userId (the server overrides
// context.userId from the token, so B's report is authoritatively B's).
//
// Two windows, both covered below: the run that keeps going indefinitely after
// the clears, and the narrow one where one more line of its output lands after
// the clears but before the teardown has committed. A logAutomationStart response
// (a 100-500ms round trip) can land in that second window too; it is exercised
// here but not asserted on, because what stops it is the run-generation guard,
// pinned directly in webview-cart-run-generation.test.tsx — see the window test.
//
// The cart run is not the only thing that outlives a sign-out: the ingredient
// saves MyMealsScreen queues do too, and they get their own guard and their own
// file (mymeals-signout-ingredient-saves.test.tsx).

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React, { useLayoutEffect, useRef } from 'react';
import { Alert, Text, TouchableOpacity } from 'react-native';

// ── Module mocks ─────────────────────────────────────────────────────────────

/** In-memory keychain, shared across the file on purpose: it is "the device". */
const mockKeychain = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockKeychain.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockKeychain.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockKeychain.delete(k); }),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
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
  const icon = (props: any) => RealReact.createElement(RealText, { testID: 'mock-icon' }, props.name);
  return { Ionicons: icon, Feather: icon, MaterialIcons: icon };
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
 * `logAutomationStart` never settles on its own: each call parks on the queue
 * below so a test can land the response at the exact moment it wants to.
 */
jest.mock('../../src/lib/api', () => {
  const actual = jest.requireActual('../../src/lib/api');
  return {
    ...actual,
    bugReport: { submit: jest.fn(async () => ({ ok: true })) },
    auth: {
      login: jest.fn(),
      logout: jest.fn(async () => ({ ok: true })),
      verify: jest.fn(async () => { throw new Error('no session'); }),
      renew: jest.fn(async () => ({})),
      verify2FA: jest.fn(),
    },
    creators: { getMe: jest.fn(async () => ({ creator: null })) },
    usage: {
      ...actual.usage,
      logOpen: jest.fn(async () => {}),
      logAutomationStart: jest.fn((data: any) => new Promise((resolve) => {
        ((globalThis as any).__pendingStarts ||= []).push({ storeId: data.storeId, resolve });
      })),
      logAutomationComplete: jest.fn(async () => {}),
      logAutomationSteps: jest.fn(async () => {}),
    },
  };
});

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('../../src/lib/push', () => ({
  unregisterDevice: jest.fn(async () => {}),
}));

import BugReportSheet from '../../src/components/BugReportSheet';
import { AuthProvider, useAuth } from '../../src/context/AuthContext';
import { CartJobProvider, useCartJob } from '../../src/context/CartJobContext';
import { auth, bugReport } from '../../src/lib/api';
import { clearSessionLogs, getSessionLogs, installConsoleCapture } from '../../src/lib/logBuffer';
import { clearLastAutomationRun, getLastAutomationRun, setLastAutomationRun } from '../../src/lib/lastAutomationRun';

const submit = bugReport.submit as jest.Mock;
const login = auth.login as jest.Mock;

type PendingStart = { storeId: string; resolve: (id: string) => void };
const pendingStarts = () => ((globalThis as any).__pendingStarts ||= []) as PendingStart[];

/** Land the parked start response for `storeId`, as `run-<storeId>`. */
function landStartFor(storeId: string) {
  const pending = pendingStarts().find((p) => p.storeId === storeId);
  if (!pending) throw new Error(`no logAutomationStart in flight for ${storeId}`);
  pending.resolve(`run-${storeId}`);
}

/**
 * A line of the kind the running cart engine writes on its own, several times per
 * item (WebViewCartSheet logs `product=`, `failed adds:` with names, and the
 * active ingredient list). jsdom cannot drive a real add, so the engine's output
 * is stood in for here; the buffer cannot tell the difference, because the buffer
 * is fed by console.
 */
const A_CART_LINE = '[Cart 10:00:01] ADD WORKER_RESULT w 1 success= true product= Kirkland Prenatal Vitamins';
const A_PRODUCT = 'Kirkland Prenatal Vitamins';

const meal = {
  id: 'm1',
  name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
};

/** Every onClose the provider fired, so the normal close path can be checked. */
const closes: string[] = [];

/**
 * Stands in for the app's screens: the account screen's Log Out, a sign-in
 * screen, the My Meals button that starts a cart job, and the bug report sheet
 * that HelpScreen mounts.
 */
function Screens() {
  const { user, login: doLogin, logout } = useAuth();
  const cartJob = useCartJob();
  return (
    <>
      <Text testID="who">{user?.id ?? 'signed-out'}</Text>
      <Text testID="cart">{cartJob.isActive ? 'running' : 'idle'}</Text>
      <TouchableOpacity testID="login-a" onPress={() => { void doLogin('a@example.com', 'pw'); }}>
        <Text>login A</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="login-b" onPress={() => { void doLogin('b@example.com', 'pw'); }}>
        <Text>login B</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="logout" onPress={() => { void logout(); }}>
        <Text>log out</Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="start-cart"
        onPress={() => cartJob.startJob({
          meals: [meal] as any,
          storeId: 'heb',
          storeName: 'H-E-B',
          onClose: () => { closes.push('closed'); },
        })}
      >
        <Text>add to cart</Text>
      </TouchableOpacity>
      {/* What the sheet's own Done button reaches, via the job's onClose. */}
      <TouchableOpacity testID="close-cart" onPress={() => cartJob.closeJob()}>
        <Text>done</Text>
      </TouchableOpacity>
      <BugReportSheet visible onClose={() => {}} currentRoute="Help" />
    </>
  );
}

/**
 * Fires once, in the COMMIT where `user` becomes null — before CartJobProvider's
 * passive effect has had a chance to end the job, and so before the sheet has
 * unmounted. That is the window a late `logAutomationStart` response or one more
 * line of cart logging lands in, and a layout effect is the only place a test can
 * stand to watch it.
 */
function SignOutWindow({ onSignedOut }: { onSignedOut: () => void }) {
  const { user } = useAuth();
  const wasSignedIn = useRef(false);
  useLayoutEffect(() => {
    if (user) { wasSignedIn.current = true; return; }
    if (!wasSignedIn.current) return;
    wasSignedIn.current = false;
    onSignedOut();
  }, [user, onSignedOut]);
  return null;
}

async function renderApp(onSignOutWindow?: () => void) {
  // The real nesting: CartJobProvider inside AuthProvider, above the navigator.
  const utils = render(
    <AuthProvider>
      {onSignOutWindow && <SignOutWindow onSignedOut={onSignOutWindow} />}
      <CartJobProvider>
        <Screens />
      </CartJobProvider>
    </AuthProvider>,
  );
  await act(async () => { await Promise.resolve(); });
  return utils;
}

function asUser(id: string) {
  login.mockResolvedValue({ accessToken: `token-${id}`, user: { id, email: `${id}@example.com` } });
}

type App = Awaited<ReturnType<typeof renderApp>>;

async function signIn(utils: App, which: 'a' | 'b') {
  asUser(`user-${which.toUpperCase()}`);
  await act(async () => { fireEvent.press(utils.getByTestId(`login-${which}`)); });
  await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent(`user-${which.toUpperCase()}`));
}

async function signOut(utils: App) {
  await act(async () => { fireEvent.press(utils.getByTestId('logout')); });
  await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('signed-out'));
}

/** Start an H-E-B run and leave its start request in flight. */
async function startCart(utils: App) {
  await act(async () => { fireEvent.press(utils.getByTestId('start-cart')); });
  expect(utils.getByTestId('cart')).toHaveTextContent('running');
}

async function fileReport(utils: App, text: string) {
  fireEvent.changeText(utils.getByPlaceholderText(/Describe the problem/i), text);
  await act(async () => { fireEvent.press(utils.getByText('Send report')); });
  await waitFor(() => expect(submit).toHaveBeenCalled());
}

const lastReport = () => submit.mock.calls[submit.mock.calls.length - 1][0];

beforeAll(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  installConsoleCapture();
});

beforeEach(() => {
  submit.mockClear();
  submit.mockResolvedValue({ ok: true });
  login.mockReset();
  mockKeychain.clear();
  pendingStarts().length = 0;
  closes.length = 0;
  clearSessionLogs();
  clearLastAutomationRun();
});

// ── The run itself has to stop ───────────────────────────────────────────────

describe('signing out mid-run', () => {
  it('tears the cart sheet down instead of leaving it running over the login screen', async () => {
    const utils = await renderApp();
    await signIn(utils, 'a');
    await startCart(utils);
    // The engine is on screen — its first item row is rendered.
    expect(utils.queryByTestId('qty-checkbox-0')).not.toBeNull();

    await signOut(utils);

    // No job and no sheet, so nothing is left to automate, to log, or to sit on
    // top of the next account's login screen.
    expect(utils.getByTestId('cart')).toHaveTextContent('idle');
    expect(utils.queryByTestId('qty-checkbox-0')).toBeNull();
  });

  it('empties both diagnostic channels at sign-out, so the next account starts clean', async () => {
    // Scoped deliberately: this pins logout's OWN clears, and nothing more. It
    // passes with the sign-out effect above deleted entirely (measured), because
    // by the time B files a report the clears have run either way. The headline
    // gap — the run that keeps writing after them — is pinned by the test before
    // this one, the window test after it, and the onClose test at the end.
    const utils = await renderApp();
    await signIn(utils, 'a');
    await startCart(utils);

    // A's run does what a run does: names of things going into A's cart.
    console.log(A_CART_LINE);
    setLastAutomationRun('run-belongs-to-A', 'heb');
    expect(getSessionLogs()).toContain(A_PRODUCT);

    // A hands the phone over.
    await signOut(utils);
    await signIn(utils, 'b');
    await fileReport(utils, 'the app will not load my meals');

    const report = lastReport();
    expect(report.context.userId).toBe('user-B');
    expect(report.logs).not.toContain(A_PRODUCT);
    expect(report.context.lastCartRunId).toBeNull();
    expect(report.context.lastCartRunStore).toBeNull();
    expect(report.context.lastCartRunAge).toBeNull();
  });

  it('drops what the run writes after the clears but before the teardown lands', async () => {
    // The narrow window, and the reason ending the job is not on its own enough:
    // logout's clears run first, then a render, then the provider's effect, then
    // the commit that unmounts the sheet. A run emits a line every few hundred ms
    // and its start response is a 100-500ms round trip, so either can land inside
    // that window and outlive a clear that has already happened.
    let hits = 0;
    const utils = await renderApp(() => {
      hits += 1;
      console.log(A_CART_LINE);        // one more line from the still-live engine
      landStartFor('heb');             // and the start response finally arrives
    });
    await signIn(utils, 'a');
    await startCart(utils);

    await signOut(utils);
    expect(hits).toBe(1); // the window really was entered

    await signIn(utils, 'b');
    await fileReport(utils, 'cannot see my saved meals');

    const report = lastReport();
    expect(report.context.userId).toBe('user-B');
    // The one line that discriminates: delete the clear-again-after-teardown
    // effect and A's product arrives on B's report right here.
    expect(report.logs).not.toContain(A_PRODUCT);
    // The late start response is deliberately NOT asserted on. It cannot re-arm
    // A's run in this harness for a reason that has nothing to do with clearing:
    // under `act()` React flushes the sheet's unmount — which bumps the run
    // generation — before the microtask queue drains, so the parked `.then()`
    // bails on the generation guard whether or not this provider clears again.
    // Measured: with the clear-again effect deleted, `lastCartRunId` is still
    // null, so asserting it here would pin nothing. In production the response
    // can land first, and the generation guard that stops it is pinned directly
    // in webview-cart-run-generation.test.tsx ("records nothing when the sheet is
    // torn down rather than hidden"). It is still landed above, because both
    // writers really do try inside this window.
  });

  it('leaves a signed-out launch its own diagnostics', async () => {
    // The clear-again-after-teardown step is keyed to a sign-out that really ended
    // a run, NOT to "no user and no job" — both of which are true at launch. The
    // line below is written before the provider's effects run, which is where the
    // app's startup output and AuthProvider's token verify/renew output land too;
    // a "it will not let me sign in" report needs all of it.
    console.log('[Login] heb login check: signed_out, selector matched nothing');
    const utils = await renderApp();
    console.log('[Login] heb login check: retry, still signed_out');
    await fileReport(utils, 'it will not let me sign in at all');

    expect(lastReport().logs).toContain('selector matched nothing');
    expect(lastReport().logs).toContain('still signed_out');
  });
});

// ── The normal close path must be untouched ─────────────────────────────────

describe('ending a run the ordinary way', () => {
  it('keeps the run and the logs, so the report that follows still joins to it', async () => {
    const utils = await renderApp();
    await signIn(utils, 'a');
    await startCart(utils);

    console.log('[Cart 10:00:01] ADD WORKER_RESULT w 1 success= false product= Sour Cream');
    await act(async () => { landStartFor('heb'); });
    expect(getLastAutomationRun()).toMatchObject({ runId: 'run-heb', storeId: 'heb' });

    // The user finishes and taps Done — still signed in, same account either side.
    await act(async () => { fireEvent.press(utils.getByTestId('close-cart')); });
    expect(utils.getByTestId('cart')).toHaveTextContent('idle');
    expect(closes).toEqual(['closed']);

    // Reporting a failed add is the whole point of the feature, and it happens
    // right after the sheet closes. Both channels have to survive that.
    await fileReport(utils, 'sour cream never made it into the cart');
    const report = lastReport();
    expect(report.context.userId).toBe('user-A');
    expect(report.context.lastCartRunId).toBe('run-heb');
    expect(report.context.lastCartRunStore).toBe('heb');
    expect(report.logs).toContain('Sour Cream');
  });

  it('still calls the job onClose when a sign-out ends the run', async () => {
    // MyMealsScreen clears the meal selection in onClose; a run that ended must
    // not leave those meals looking queued.
    const utils = await renderApp();
    await signIn(utils, 'a');
    await startCart(utils);
    expect(closes).toEqual([]);

    await signOut(utils);
    expect(closes).toEqual(['closed']);
  });
});
