// Another account taking over is the end of a session too (MEAL-146).
//
// MEAL-142 closed the leak chain for the SIGN-OUT boundary. All four of its
// guards key on `user` going null, and that turned out to be the wrong question,
// because a person can stop being the signed-in user without the app ever
// passing through a signed-out state:
//
//   RootNavigator registers the `mealio://verified?token=…` listener app-wide
//   (:83) and its handler calls `loginWithToken` with no signed-in check (:98).
//   So A is signed in on a shared phone, B taps the verification link in their
//   own email, and `user` goes A → B directly. Not one MEAL-142 guard fires.
//
// The payload is the same as MEAL-142's, which is the point: A's console ring
// buffer deliberately retains product names and cart contents, a bug report
// attaches it, and the server takes the userId from the token — so B files any
// report from Help and it carries A's groceries, authoritatively as B's.
//
// The fix keys every teardown on the identity changing (src/context/useSessionEnd.ts),
// of which becoming nobody is one case. This file pins the three transitions
// that matter, and the two negative ones are as load-bearing as the positive:
//
//   A → B   the full teardown runs
//   A → A   it does NOT (a token renewal / profile refresh hands down a new User
//           object for the same person; clearing their logs and killing their
//           live cart run for that would be a new bug of the same family)
//   null → B  it does NOT (an ordinary sign-in must not tear down the session it
//           is starting, and a signed-out launch's own login diagnostics are
//           exactly what a "it will not let me sign in" report needs)
//
// The harness enters at `loginWithToken`, which is precisely where
// RootNavigator's deep-link handler enters — its whole body is
// `await loginWithToken(verifiedToken)`. What is deliberately NOT covered here
// is whether that call should be refused while someone is signed in: that is a
// product decision about what B sees when they tap the link, and it is not this
// ticket's to make.
//
// MyMealsScreen's queued ingredient saves are the fourth guard; they need a
// different harness (the screen mocks AuthContext wholesale) and are pinned in
// mymeals-signout-ingredient-saves.test.tsx.

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

/** Stands in for the hidden prewarm probe; logs on mount the way the real one does. */
jest.mock('../../src/components/SilentLoginProbe', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return {
    __esModule: true,
    default: (props: any) => {
      RealReact.useEffect(() => {
        console.log('[Prewarm] probe mounted for', props.storeId, '→ loading store page');
        ((globalThis as any).__probes ||= []).push(props);
      }, []);
      return RealReact.createElement(RealView, { testID: `probe-${props.storeId}` });
    },
  };
});

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
      logAutomationStart: jest.fn(() => new Promise(() => {})),
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
import { PrewarmedCart } from '../../src/components/SilentLoginProbe';
import { AuthProvider, useAuth } from '../../src/context/AuthContext';
import { CartJobProvider, useCartJob } from '../../src/context/CartJobContext';
import { LoginPrewarmProvider, useLoginPrewarm, LoginPrewarmStatus } from '../../src/context/LoginPrewarmContext';
import { auth, bugReport } from '../../src/lib/api';
import { clearSessionLogs, getSessionLogs, installConsoleCapture } from '../../src/lib/logBuffer';
import { clearLastAutomationRun, getLastAutomationRun, setLastAutomationRun } from '../../src/lib/lastAutomationRun';

const submit = bugReport.submit as jest.Mock;
const verify = auth.verify as jest.Mock;
const login = auth.login as jest.Mock;

type ProbeProps = {
  storeId: string;
  onResult: (storeId: string, isLoggedIn: boolean, cart?: PrewarmedCart) => void;
};
const probes = () => ((globalThis as any).__probes ||= []) as ProbeProps[];
const probeFor = (storeId: string) => {
  const probe = probes().find((p) => p.storeId === storeId);
  if (!probe) throw new Error(`no probe mounted for ${storeId}`);
  return probe;
};

/**
 * A line of the kind the running cart engine writes on its own, several times
 * per item. jsdom cannot drive a real add, so the engine's output is stood in
 * for here; the buffer cannot tell the difference, because it is fed by console.
 */
const A_CART_LINE = '[Cart 10:00:01] ADD WORKER_RESULT w 1 success= true product= Kirkland Prenatal Vitamins';
const A_PRODUCT = 'Kirkland Prenatal Vitamins';

/** A's prewarmed H-E-B cart, of the kind the probe really reports. */
const A_CART: PrewarmedCart = {
  count: 2,
  items: [
    { name: 'Kirkland Prenatal Vitamins', quantity: 1 } as any,
    { name: 'Plan B One-Step', quantity: 1 } as any,
  ],
};

const meal = {
  id: 'm1',
  name: 'Tacos',
  ingredients: [
    { ingredientName: 'Sour Cream', searchTerm: 'sour cream', productQty: 1, qty: 1, unit: 'qty', measure: null },
  ],
};

/** The prewarm context, reached imperatively the way its consumers reach it. */
let prewarm: ReturnType<typeof useLoginPrewarm>;

function Screens() {
  const { user, login: doLogin, loginWithToken, logout, refreshUser } = useAuth();
  const cartJob = useCartJob();
  prewarm = useLoginPrewarm();
  return (
    <>
      <Text testID="who">{user?.id ?? 'signed-out'}</Text>
      <Text testID="cart">{cartJob.isActive ? 'running' : 'idle'}</Text>
      <TouchableOpacity testID="login-a" onPress={() => { void doLogin('a@example.com', 'pw'); }}>
        <Text>login A</Text>
      </TouchableOpacity>
      {/*
        The deep link. RootNavigator's handler for `mealio://verified?token=…`
        is exactly this call, from a listener registered app-wide — which is why
        it reaches here while somebody else is already signed in.
      */}
      <TouchableOpacity testID="verified-link" onPress={() => { void loginWithToken('token-from-email'); }}>
        <Text>tap verification link</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="refresh" onPress={() => { void refreshUser(); }}>
        <Text>refresh profile</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="logout" onPress={() => { void logout(); }}>
        <Text>log out</Text>
      </TouchableOpacity>
      <TouchableOpacity
        testID="start-cart"
        onPress={() => cartJob.startJob({ meals: [meal] as any, storeId: 'heb', storeName: 'H-E-B' })}
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
 * Fires in the COMMIT where the signed-in account changes — before the
 * providers' passive effects have had a chance to tear anything down, and so
 * before the cart sheet has unmounted. That is the window one more line of A's
 * still-live cart engine lands in, and a layout effect is the only place a test
 * can stand to watch it.
 */
function SwapWindow({ onSwap }: { onSwap: () => void }) {
  const { user } = useAuth();
  const seen = useRef<string | null | undefined>(undefined);
  const id = user?.id ?? null;
  useLayoutEffect(() => {
    const previous = seen.current;
    seen.current = id;
    if (previous === undefined || previous === null || previous === id) return;
    onSwap();
  }, [id, onSwap]);
  return null;
}

async function renderApp(onSwap?: () => void) {
  // The real nesting from App.tsx: LoginPrewarmProvider and CartJobProvider
  // inside AuthProvider, above where the navigator would be.
  const utils = render(
    <AuthProvider>
      {onSwap && <SwapWindow onSwap={onSwap} />}
      <LoginPrewarmProvider>
        <CartJobProvider>
          <Screens />
        </CartJobProvider>
      </LoginPrewarmProvider>
    </AuthProvider>,
  );
  await act(async () => { await Promise.resolve(); });
  return utils;
}

type App = Awaited<ReturnType<typeof renderApp>>;

/** Sign in with a password, from signed out. */
async function signInAsA(utils: App) {
  login.mockResolvedValue({ accessToken: 'token-user-A', user: { id: 'user-A', email: 'a@example.com' } });
  await act(async () => { fireEvent.press(utils.getByTestId('login-a')); });
  await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-A'));
}

/**
 * B taps the verification link in their email on A's phone. `auth.verify` is what
 * `loginWithToken` uses to find out whose token it is, so answering it as B is
 * what makes this an account switch rather than a renewal.
 */
async function tapVerificationLinkAs(utils: App, id: string) {
  verify.mockResolvedValueOnce({ user: { id, email: `${id}@example.com` } });
  await act(async () => { fireEvent.press(utils.getByTestId('verified-link')); });
  await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent(id));
}

/** A's own profile being re-read — same person, a brand new User object. */
async function refreshProfile(utils: App) {
  verify.mockResolvedValueOnce({ user: { id: 'user-A', email: 'a@example.com', tier: 'paid' } });
  await act(async () => { fireEvent.press(utils.getByTestId('refresh')); });
  await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-A'));
}

/** Start an H-E-B run. */
async function startCart(utils: App) {
  await act(async () => { fireEvent.press(utils.getByTestId('start-cart')); });
  expect(utils.getByTestId('cart')).toHaveTextContent('running');
}

/** Queue a prewarm the way MyMealsScreen does, and let it answer. */
async function prewarmHebFor(utils: App) {
  await act(async () => { prewarm.checkStore('heb'); });
  expect(utils.queryByTestId('probe-heb')).not.toBeNull();
  act(() => { probeFor('heb').onResult('heb', true, A_CART); });
}

async function fileReport(utils: App, text: string) {
  fireEvent.changeText(utils.getByPlaceholderText(/Describe the problem/i), text);
  await act(async () => { fireEvent.press(utils.getByText('Send report')); });
  await waitFor(() => expect(submit).toHaveBeenCalled());
}

const lastReport = () => submit.mock.calls[submit.mock.calls.length - 1][0];
const prewarmLines = () => getSessionLogs().split('\n').filter((l) => l.includes('[Prewarm]'));

beforeAll(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  installConsoleCapture();
});

beforeEach(() => {
  submit.mockClear();
  submit.mockResolvedValue({ ok: true });
  login.mockReset();
  verify.mockReset();
  verify.mockRejectedValue(new Error('no session')); // the launch-time initAuth
  mockKeychain.clear();
  probes().length = 0;
  clearSessionLogs();
  clearLastAutomationRun();
});

// ── A → B: the transition MEAL-146 is about ─────────────────────────────────

describe('B takes the phone over through the verification link', () => {
  it("leaves none of A's diagnostics in the report B files", async () => {
    const utils = await renderApp();
    await signInAsA(utils);

    // A's session does what a session does.
    console.log(A_CART_LINE);
    setLastAutomationRun('run-belongs-to-A', 'heb');
    expect(getSessionLogs()).toContain(A_PRODUCT);

    // A never signs out. B taps the link in their own email.
    await tapVerificationLinkAs(utils, 'user-B');
    expect(utils.getByTestId('who')).toHaveTextContent('user-B');

    await fileReport(utils, 'the app will not load my meals');

    const report = lastReport();
    // The report is authoritatively B's — the server takes the userId from the
    // token — so anything of A's riding along is attributed to B.
    expect(report.context.userId).toBe('user-B');
    // Asserting on the buffer's actual contents, not on a call.
    expect(getSessionLogs()).not.toContain(A_PRODUCT);
    expect(report.logs).not.toContain(A_PRODUCT);
    expect(report.context.lastCartRunId).toBeNull();
    expect(report.context.lastCartRunStore).toBeNull();
    expect(report.context.lastCartRunAge).toBeNull();
  });

  it("ends A's cart run instead of leaving it automating under B", async () => {
    const utils = await renderApp();
    await signInAsA(utils);
    await startCart(utils);
    // The engine is on screen — its first item row is rendered.
    expect(utils.queryByTestId('qty-checkbox-0')).not.toBeNull();

    await tapVerificationLinkAs(utils, 'user-B');

    // No job and no sheet, so nothing of A's is left to automate, to log, or to
    // sit on top of B's screen.
    expect(utils.getByTestId('cart')).toHaveTextContent('idle');
    expect(utils.queryByTestId('qty-checkbox-0')).toBeNull();
  });

  it("drops what A's run writes after the clear but before the teardown lands", async () => {
    // The narrow window, and the reason clearing at the swap is not on its own
    // enough: AuthContext clears, then a render, then the provider's effect, then
    // the commit that unmounts the sheet. A run emits a line every few hundred ms,
    // so one can land inside that window and outlive a clear that already ran.
    let hits = 0;
    const utils = await renderApp(() => { hits += 1; console.log(A_CART_LINE); });
    await signInAsA(utils);
    await startCart(utils);

    await tapVerificationLinkAs(utils, 'user-B');
    expect(hits).toBe(1); // the window really was entered

    await fileReport(utils, 'cannot see my saved meals');

    const report = lastReport();
    expect(report.context.userId).toBe('user-B');
    expect(report.logs).not.toContain(A_PRODUCT);
  });

  it("clears A's state before B is installed, not after B has started writing", async () => {
    // Order, which is the one thing a teardown like this can get exactly
    // backwards and still look right. The instant `user` becomes B, B's session
    // starts — the creator check, the RevenueCat identify, every screen keyed on
    // `user?.id` — and any of it can log. A teardown that ran a tick LATER would
    // be clearing B's fresh state in place of A's stale state: the leak intact,
    // plus B's own diagnostics destroyed.
    //
    // No cart run here on purpose. CartJobProvider deliberately clears a second
    // time after tearing a run down, which costs B their first lines whichever
    // order this runs in; with no run to tear down, what survives is decided by
    // the order alone.
    const utils = await renderApp(() => { console.log('[Prewarm] B first line, B session'); });
    await signInAsA(utils);
    console.log(A_CART_LINE);

    await tapVerificationLinkAs(utils, 'user-B');

    expect(getSessionLogs()).not.toContain(A_PRODUCT);   // A's is gone…
    expect(getSessionLogs()).toContain('B first line');  // …and B's is not
  });

  it("tears down A's prewarm probe, cached login and cart baseline", async () => {
    const utils = await renderApp();
    await signInAsA(utils);
    await prewarmHebFor(utils);
    expect(prewarm.getStatus('heb')).toBe<LoginPrewarmStatus>('loggedIn');

    await tapVerificationLinkAs(utils, 'user-B');

    // B re-checks the store under their own name rather than inheriting A's
    // verdict, and gets a live cart snapshot rather than A's baseline.
    expect(prewarm.getStatus('heb')).toBe<LoginPrewarmStatus>('unknown');
    expect(prewarm.takePrewarmedCart('heb')).toBeNull();
    expect(utils.queryByTestId('probe-heb')).toBeNull();
  });

  it('leaves B able to run a cart of their own afterwards', async () => {
    // The teardown has to end A's session, not disable the feature. This is the
    // "too eager" direction, and it is the direction the first version of this
    // fix got wrong on MyMealsScreen: a guard set at the hand-over stayed set,
    // on a provider that — like this one — is never unmounted by an account
    // switch. Nothing here latches (the flag this provider sets is cleared by
    // its own clear-again effect as soon as the job is null), and this is what
    // says so.
    const utils = await renderApp();
    await signInAsA(utils);
    await startCart(utils);

    await tapVerificationLinkAs(utils, 'user-B');
    expect(utils.getByTestId('cart')).toHaveTextContent('idle');

    // B starts their own run on the same never-unmounted provider.
    await startCart(utils);
    expect(utils.getByTestId('cart')).toHaveTextContent('running');
    expect(utils.queryByTestId('qty-checkbox-0')).not.toBeNull();

    // B's own run records its own diagnostics — the buffer is B's now, not
    // permanently muted by A's departure.
    console.log('[Cart 11:00:00] ADD WORKER_RESULT w 1 success= true product= B Brand Sour Cream');
    expect(getSessionLogs()).toContain('B Brand Sour Cream');

    await act(async () => { fireEvent.press(utils.getByTestId('close-cart')); });
  });

  it("does not hand A's queued prewarm stores to B", async () => {
    const utils = await renderApp();
    await signInAsA(utils);
    await act(async () => { prewarm.checkStore('heb'); });
    await act(async () => { prewarm.checkStore('walmart'); }); // still queued

    await tapVerificationLinkAs(utils, 'user-B');
    await act(async () => { prewarm.checkStore('aldi'); });

    // B's own store, not the one A left at the head of the queue.
    expect(utils.queryByTestId('probe-aldi')).not.toBeNull();
    expect(utils.queryByTestId('probe-walmart')).toBeNull();
  });
});

// ── A → A: the teardown must NOT fire ───────────────────────────────────────

describe('the same account being re-set', () => {
  it('leaves a profile refresh alone — logs, run record and live cart all survive', async () => {
    // `refreshUser` re-verifies and hands down a NEW User object for the SAME
    // person; a token renewal does the same. Keying on object identity would
    // wipe a live user's diagnostics and kill their in-flight cart run here.
    const utils = await renderApp();
    await signInAsA(utils);
    await startCart(utils);

    console.log(A_CART_LINE);
    setLastAutomationRun('run-belongs-to-A', 'heb');

    await refreshProfile(utils);

    // Nothing of A's has been taken away from A.
    expect(getSessionLogs()).toContain(A_PRODUCT);
    expect(getLastAutomationRun()).toMatchObject({ runId: 'run-belongs-to-A', storeId: 'heb' });
    expect(utils.getByTestId('cart')).toHaveTextContent('running');
    expect(utils.queryByTestId('qty-checkbox-0')).not.toBeNull();

    // And A's own report still joins to A's own run.
    await fileReport(utils, 'sour cream never made it into the cart');
    expect(lastReport().context.userId).toBe('user-A');
    expect(lastReport().context.lastCartRunId).toBe('run-belongs-to-A');
    expect(lastReport().logs).toContain(A_PRODUCT);
  });

  it('leaves the prewarm cache alone across a profile refresh', async () => {
    // Separate from the cart above only because a mounted cart sheet and a
    // settled prewarm interact — the sheet consumes the prewarm status — and
    // that interaction is not what either test is about.
    const utils = await renderApp();
    await signInAsA(utils);
    await prewarmHebFor(utils);

    await refreshProfile(utils);

    expect(prewarm.getStatus('heb')).toBe<LoginPrewarmStatus>('loggedIn');
    expect(prewarm.takePrewarmedCart('heb')).toMatchObject({ count: 2 });
  });

  it('leaves A alone when A re-opens their own verification link', async () => {
    // Same entry point as the leak — `loginWithToken` while signed in — but the
    // token resolves to the person already here. Nothing ended, so nothing goes.
    const utils = await renderApp();
    await signInAsA(utils);
    await startCart(utils);
    console.log(A_CART_LINE);
    setLastAutomationRun('run-belongs-to-A', 'heb');

    await tapVerificationLinkAs(utils, 'user-A');

    expect(getSessionLogs()).toContain(A_PRODUCT);
    expect(getLastAutomationRun()).toMatchObject({ runId: 'run-belongs-to-A' });
    expect(utils.getByTestId('cart')).toHaveTextContent('running');
  });
});

// ── null → B: an ordinary sign-in must not be torn down ─────────────────────

describe('signing in from signed out', () => {
  it('keeps the signed-out launch diagnostics a "cannot sign in" report needs', async () => {
    // The launch case. Both the previous and the next id are effectively "not a
    // session" at mount, and a teardown here would delete exactly the output
    // that explains why sign-in failed.
    console.log('[Login] heb login check: signed_out, selector matched nothing');
    const utils = await renderApp();
    console.log('[Login] heb login check: retry, still signed_out');

    await signInAsA(utils);

    expect(getSessionLogs()).toContain('selector matched nothing');
    expect(getSessionLogs()).toContain('still signed_out');
    await fileReport(utils, 'it would not let me sign in at all');
    expect(lastReport().logs).toContain('selector matched nothing');
  });

  it('lets a first sign-in through the verification link work normally', async () => {
    // The link's ordinary purpose: a brand new account confirming their email on
    // a phone nobody is signed in on. Nothing about the guard may touch it.
    const utils = await renderApp();
    console.log('[Prewarm] app launched signed out');

    await tapVerificationLinkAs(utils, 'user-B');

    expect(utils.getByTestId('who')).toHaveTextContent('user-B');
    expect(prewarmLines().length).toBeGreaterThan(0);

    // And B's session works from there.
    await prewarmHebFor(utils);
    expect(prewarm.getStatus('heb')).toBe<LoginPrewarmStatus>('loggedIn');
  });

  it('still tears down on a plain sign-out, and not on the sign-in after it', async () => {
    // The MEAL-142 boundary, re-pinned here because generalising the guard is the
    // obvious place to break it: recording the new id only after an early return
    // would make the B sign-in that follows a sign-out look like A → B and tear
    // down B's own fresh session.
    const utils = await renderApp();
    await signInAsA(utils);
    console.log(A_CART_LINE);
    setLastAutomationRun('run-belongs-to-A', 'heb');

    await act(async () => { fireEvent.press(utils.getByTestId('logout')); });
    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('signed-out'));
    expect(getSessionLogs()).not.toContain(A_PRODUCT);
    expect(getLastAutomationRun()).toBeNull();

    // B signs in on the clean login screen, and writes their own first lines.
    await tapVerificationLinkAs(utils, 'user-B');
    console.log('[Prewarm] B first line');
    setLastAutomationRun('run-belongs-to-B', 'heb');

    // Which are still there — the sign-out is behind us, not being replayed.
    expect(getSessionLogs()).toContain('B first line');
    expect(getLastAutomationRun()).toMatchObject({ runId: 'run-belongs-to-B' });
  });
});
