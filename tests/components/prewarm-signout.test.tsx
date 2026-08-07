// Signing out has to stop the silent login prewarm too (MEAL-142).
//
// The fourth writer that outlived a sign-out, after the cart run
// (cart-signout-boundary.test.tsx) and the queued ingredient saves
// (mymeals-signout-ingredient-saves.test.tsx).
//
// LoginPrewarmProvider had no auth awareness at all. It sits ABOVE
// NavigationContainer (App.tsx), so the navigator swapping to the auth stack does
// not unmount it, and its hidden SilentLoginProbe can be in flight or queued
// straight through a sign-out — cart pre-capture alone is bounded at 15s, and the
// deferred pump a settling probe schedules could even START one afterwards. All
// of it logs: store login status, and LOGIN_DEBUG/EXTRACT_DEBUG dumps that go
// through JSON.stringify and so can carry cart contents. Those lines land in the
// console ring buffer that AuthContext.logout had just emptied, so the next
// person on a shared phone files a report from Help and it carries the previous
// person's data under their own token-verified userId.
//
// Scoped honestly: the cached cart baseline is not the headline. The STORE login
// is device-level rather than Mealio-account-level, so the next person would
// largely see that cart on the store's own site regardless — the baseline is not
// wrong for them, only possibly stale. The new exposure is the log lines. The
// cache is dropped anyway, because stale-by-default is the better failure and it
// costs nothing.
//
// Two things deliberately NOT pinned here, both recorded rather than hidden:
//
//   • The provider's `pump` also refuses to start while signed out. No test can
//     kill that line, because both routes into pump are shut before it (see the
//     comment on it) — it is there for the next caller pump grows.
//   • The one window still open: logout empties the buffer and only then sets
//     user null, so a microtask already queued at that moment (a loadMeals
//     resolving and prewarming the top store) runs before React's render, still
//     sees the old user, and gets three lines out — all of them naming a store,
//     none naming a product or a cart, and the probe is torn down one commit
//     later. Measured with a throwaway harness that wrapped clearSessionLogs;
//     asserting it would pin the leak, not the fix.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';

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

/**
 * Stands in for the hidden probe, faithful in the two ways that matter here:
 * it logs a `[Prewarm]` line when it MOUNTS (the real one logs "probe mounted
 * for …" plus a line per store message it relays) and it logs nothing when it
 * unmounts. Its props are parked so a test can land a store's answer at the
 * moment it chooses — that is the only way to reach the provider's settle path,
 * since jsdom has no WebView to post a real LOGIN_STATUS.
 */
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
    auth: {
      login: jest.fn(),
      logout: jest.fn(async () => ({ ok: true })),
      verify: jest.fn(async () => { throw new Error('no session'); }),
      renew: jest.fn(async () => ({})),
      verify2FA: jest.fn(),
    },
    creators: { getMe: jest.fn(async () => ({ creator: null })) },
    usage: { ...actual.usage, logOpen: jest.fn(async () => {}) },
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

import { AuthProvider, useAuth } from '../../src/context/AuthContext';
import {
  LoginPrewarmProvider,
  useLoginPrewarm,
  LoginPrewarmStatus,
} from '../../src/context/LoginPrewarmContext';
import { PrewarmedCart } from '../../src/components/SilentLoginProbe';
import { auth } from '../../src/lib/api';
import { clearSessionLogs, getSessionLogs, installConsoleCapture } from '../../src/lib/logBuffer';

const login = auth.login as jest.Mock;

type ProbeProps = {
  storeId: string;
  onLogin: (storeId: string, isLoggedIn: boolean) => void;
  onResult: (storeId: string, isLoggedIn: boolean, cart?: PrewarmedCart) => void;
  onError: (storeId: string) => void;
};
const probes = () => ((globalThis as any).__probes ||= []) as ProbeProps[];
const probeFor = (storeId: string) => {
  const probe = probes().find((p) => p.storeId === storeId);
  if (!probe) throw new Error(`no probe mounted for ${storeId} (mounted: ${probes().map((p) => p.storeId).join(', ') || 'none'})`);
  return probe;
};

/** A's prewarmed H-E-B cart, of the kind the probe really reports. */
const A_CART: PrewarmedCart = {
  count: 2,
  items: [
    { name: 'Kirkland Prenatal Vitamins', quantity: 1 } as any,
    { name: 'Plan B One-Step', quantity: 1 } as any,
  ],
};

/** The context, reached imperatively the way its consumers reach it. */
let prewarm: ReturnType<typeof useLoginPrewarm>;

function Screens() {
  const { user, login: doLogin, logout } = useAuth();
  prewarm = useLoginPrewarm();
  return (
    <>
      <Text testID="who">{user?.id ?? 'signed-out'}</Text>
      <TouchableOpacity testID="login-a" onPress={() => { void doLogin('a@example.com', 'pw'); }}>
        <Text>login A</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="login-b" onPress={() => { void doLogin('b@example.com', 'pw'); }}>
        <Text>login B</Text>
      </TouchableOpacity>
      <TouchableOpacity testID="logout" onPress={() => { void logout(); }}>
        <Text>log out</Text>
      </TouchableOpacity>
    </>
  );
}

async function renderApp() {
  // The real nesting: LoginPrewarmProvider inside AuthProvider, above where the
  // navigator would be.
  const utils = render(
    <AuthProvider>
      <LoginPrewarmProvider>
        <Screens />
      </LoginPrewarmProvider>
    </AuthProvider>,
  );
  await act(async () => { await Promise.resolve(); });
  return utils;
}

type App = Awaited<ReturnType<typeof renderApp>>;

async function signIn(utils: App, which: 'a' | 'b') {
  const id = `user-${which.toUpperCase()}`;
  login.mockResolvedValue({ accessToken: `token-${id}`, user: { id, email: `${id}@example.com` } });
  await act(async () => { fireEvent.press(utils.getByTestId(`login-${which}`)); });
  await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent(id));
}

async function signOut(utils: App) {
  await act(async () => { fireEvent.press(utils.getByTestId('logout')); });
  await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('signed-out'));
}

/** Queue a prewarm the way MyMealsScreen does. */
async function checkStore(storeId: string) {
  await act(async () => { prewarm.checkStore(storeId); });
}

const prewarmLines = () => getSessionLogs().split('\n').filter((l) => l.includes('[Prewarm]'));

beforeAll(() => { installConsoleCapture(); });

beforeEach(() => {
  login.mockReset();
  mockKeychain.clear();
  probes().length = 0;
  clearSessionLogs();
});

// ── The probe itself has to stop ─────────────────────────────────────────────

describe('signing out with a prewarm in flight', () => {
  it('unmounts the hidden probe instead of leaving it loading a store page', async () => {
    const utils = await renderApp();
    await signIn(utils, 'a');
    await checkStore('heb');
    expect(utils.queryByTestId('probe-heb')).not.toBeNull();

    await signOut(utils);

    // The probe is gone, so the WebView is gone with it and there is nothing left
    // to report a login status, dump EXTRACT_DEBUG, or finish a 15s cart capture
    // into the next person's buffer.
    expect(utils.queryByTestId('probe-heb')).toBeNull();
  });

  it('writes no [Prewarm] line at all once nobody is signed in', async () => {
    const utils = await renderApp();
    await signIn(utils, 'a');
    await checkStore('heb');
    expect(prewarmLines().length).toBeGreaterThan(0); // A's own session logs freely

    await signOut(utils);
    // Everything MyMealsScreen's teardown can still reach: a loadMeals that
    // resolves late and prewarms the top store, and a store tab tap racing the
    // navigator. Each used to mount a probe and log.
    await checkStore('heb');
    await checkStore('walmart');
    await act(async () => { await new Promise((r) => setTimeout(r, 1)); });

    await signIn(utils, 'b');
    // Not one line, including skip lines: a skip line is still a line in a buffer
    // that now belongs to B.
    expect(prewarmLines()).toEqual([]);
  });

  it('starts nothing from a checkStore that lands after the sign-out', async () => {
    // MyMealsScreen prewarms the top store from inside loadMeals, so the call can
    // arrive on a promise continuation after `user` has already gone null. The
    // queue clear cannot help here — the push happens after it — so this pins the
    // guard that reads the user during render.
    const utils = await renderApp();
    await signIn(utils, 'a');
    await signOut(utils);

    await checkStore('heb');

    expect(utils.queryByTestId('probe-heb')).toBeNull();
    expect(probes().map((p) => p.storeId)).toEqual([]);
  });

  it('does not let a probe settling into the sign-out start the next one', async () => {
    // `settle` schedules `setTimeout(pump, 0)` so the finished probe unmounts
    // first. That timer outlives a sign-out that lands in between, and on a real
    // phone it will: the probe settles on a WebView message and the sign-out is
    // several awaited round trips (push unregister, logout, keychain).
    //
    // Fake timers, and no `waitFor` while they are on: with real ones a 0ms timer
    // fires during logout's own awaits, so the pump would run while A is still
    // signed in and the race would never be set up. RNTL's waitFor advances fake
    // timers itself, which would spring the same trap.
    const utils = await renderApp();
    await signIn(utils, 'a');
    jest.useFakeTimers();
    try {
      await checkStore('heb');
      await checkStore('walmart'); // queued behind H-E-B

      // H-E-B answers, which schedules the deferred pump...
      act(() => { probeFor('heb').onResult('heb', false); });
      // ...then A signs out before it runs.
      await act(async () => { fireEvent.press(utils.getByTestId('logout')); });
      expect(utils.getByTestId('who')).toHaveTextContent('signed-out');

      await act(async () => { jest.advanceTimersByTime(1); });

      expect(utils.queryByTestId('probe-walmart')).toBeNull();
      expect(probes().map((p) => p.storeId)).toEqual(['heb']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not hand A\'s queued stores to B\'s session', async () => {
    // Distinct from the timer above: here the pump is B's own, so the user guard
    // lets it through and only an emptied queue keeps A's work out of it.
    const utils = await renderApp();
    await signIn(utils, 'a');
    await checkStore('heb');
    await checkStore('walmart'); // still queued when A leaves

    await signOut(utils);
    await signIn(utils, 'b');
    await checkStore('aldi');

    // B's own store, not the one A left at the head of the queue.
    expect(utils.queryByTestId('probe-aldi')).not.toBeNull();
    expect(utils.queryByTestId('probe-walmart')).toBeNull();
  });
});

// ── The cached state goes too ────────────────────────────────────────────────

describe('the prewarm cache across a sign-out', () => {
  it('gives the next account no prewarmed cart baseline', async () => {
    const utils = await renderApp();
    await signIn(utils, 'a');
    await checkStore('heb');
    // A is logged in to H-E-B and the probe captured their cart.
    act(() => { probeFor('heb').onResult('heb', true, A_CART); });

    await signOut(utils);
    await signIn(utils, 'b');

    // What WebViewCartSheet asks for at the start of B's run. A stale baseline
    // makes the run's before/after diff wrong; B gets a live snapshot instead.
    expect(prewarm.takePrewarmedCart('heb')).toBeNull();
  });

  it('makes the next account re-check the store login under its own name', async () => {
    const utils = await renderApp();
    await signIn(utils, 'a');
    await checkStore('heb');
    act(() => { probeFor('heb').onResult('heb', true, A_CART); });
    expect(prewarm.getStatus('heb')).toBe<LoginPrewarmStatus>('loggedIn');

    await signOut(utils);
    await signIn(utils, 'b');

    expect(prewarm.getStatus('heb')).toBe<LoginPrewarmStatus>('unknown');
  });
});

// ── A signed-in session must be untouched ───────────────────────────────────

describe('prewarming while signed in', () => {
  it('still probes, caches and drains the queue exactly as before', async () => {
    const utils = await renderApp();
    await signIn(utils, 'a');

    await checkStore('heb');
    await checkStore('walmart');
    expect(utils.queryByTestId('probe-heb')).not.toBeNull();
    expect(utils.queryByTestId('probe-walmart')).toBeNull(); // one at a time

    // H-E-B finishes logged-in with a baseline; the deferred pump starts Walmart.
    act(() => { probeFor('heb').onResult('heb', true, A_CART); });
    await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
    expect(utils.queryByTestId('probe-walmart')).not.toBeNull();

    expect(prewarm.getStatus('heb')).toBe<LoginPrewarmStatus>('loggedIn');
    expect(prewarm.takePrewarmedCart('heb')).toMatchObject({ count: 2 });
    // One-shot, unchanged: the next run after ours live-snapshots.
    expect(prewarm.takePrewarmedCart('heb')).toBeNull();
  });

  it('leaves a signed-out launch its own diagnostics', async () => {
    // The guard must not turn into "clear the buffer at launch": a signed-out
    // launch is exactly when a "it will not let me sign in" report is filed, and
    // the login output it needs is written before anyone is signed in.
    console.log('[Login] heb login check: signed_out, selector matched nothing');
    await renderApp();
    expect(getSessionLogs()).toContain('selector matched nothing');
  });
});
