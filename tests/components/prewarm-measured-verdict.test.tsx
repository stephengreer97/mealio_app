// A "MEASURED SIGNED OUT" MUST NOT OUTLIVE THE VERDICT IT DESCRIBES.
//
// signedOutIsMeasured is what lets the cart sheet skip its six-second boot grace
// and show the sign-in screen at once: the store itself answered guest:true over
// the wire, so re-proving it is seven wasted seconds (Stephen, 2026-09-16).
//
// The flag lived in a second Set beside the status map, and its own comment said
// it was "cleared whenever a status is set". It was cleared in exactly one of the
// eight places a status is set -- the native path that sets it. A pre-launch
// review found the rest, and the live case is the bad one:
//
//   native check answers guest:true      -> store marked measured-out
//   the user signs in on the WebView
//   noteLiveVerdict(store, true)         -> status loggedIn, flag LEFT SET
//   next run, a transient mid-boot "no"  -> corroborated, grace skipped,
//                                           signed-in user walled
//
// which is precisely the fault the grace exists to prevent. forgetAll had the
// same hole in the other direction, carrying one account's verdict into the next
// user's session.
//
// Every status write now goes through one setter, so the two cannot drift. These
// tests pin the property rather than the setter: they only ever ask what the
// context reports.

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

/**
 * The search prewarm's hidden WebView, stubbed for the same reason as the login
 * probe above: jsdom has no native WebView, and importing the real component
 * pulls one in. Its behaviour under a sign-out is pinned in
 * selection-search-prewarm.test.tsx; here it only has to not exist.
 */
jest.mock('../../src/components/SilentSearchProbe', () => {
  const RealReact = jest.requireActual('react');
  const RealView = jest.requireActual('react-native').View;
  return {
    __esModule: true,
    default: (props: any) => RealReact.createElement(RealView, { testID: `search-probe-${props.storeId}` }),
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
// THIS SUITE IS ABOUT THE WEBVIEW PROBE, which is now one branch of three:
// checkStore asks over HTTP first and only falls back to a renderer for a store
// that cannot be answered that way. Everything below still describes behaviour
// worth pinning, so the checker is stubbed to send every store down it.
//
// The teardown this file guards matters MORE since that change, not less: the
// check became asynchronous, which opened a ~400ms window in which a sign-out
// can land mid-check. That race has its own test in native-login-first.test.tsx.
import { __setLoginCheckerForTests, __resetLoginCheckerForTests } from '../../src/lib/native-login';

const login = auth.login as jest.Mock;

let prewarm: ReturnType<typeof useLoginPrewarm>;

function Probe() {
  const { login: doLogin } = useAuth();
  prewarm = useLoginPrewarm();
  return (
    <TouchableOpacity testID="login" onPress={() => { void doLogin('a@example.com', 'pw'); }}>
      <Text>login</Text>
    </TouchableOpacity>
  );
}

async function renderApp() {
  const utils = render(
    <AuthProvider>
      <LoginPrewarmProvider>
        <Probe />
      </LoginPrewarmProvider>
    </AuthProvider>,
  );
  await act(async () => { await Promise.resolve(); });
  login.mockResolvedValue({ accessToken: 'tok', user: { id: 'user-A', email: 'a@example.com' } });
  await act(async () => { fireEvent.press(utils.getByTestId('login')); });
  await act(async () => { await Promise.resolve(); });
  return utils;
}

/** The store itself answered: signed out, over the wire. */
const measuredOut = () => __setLoginCheckerForTests(async () => ({
  state: 'out' as const, how: 'native: currentUser.guest: signed out', measured: true, ms: 1,
}));

beforeEach(() => { mockKeychain.clear(); jest.clearAllMocks(); });
afterEach(() => { __resetLoginCheckerForTests(); });

describe('a measured signed-out verdict', () => {
  it('is reported while it is still the verdict', async () => {
    // The control. Without it the rest could pass by never setting the flag.
    measuredOut();
    await renderApp();
    await act(async () => { prewarm.checkStore('aldi'); });
    await waitFor(() => expect(prewarm.getStatus('aldi')).toBe('loggedOut'));
    expect(prewarm.signedOutIsMeasured('aldi')).toBe(true);
  });

  it('stops being reported once the user signs in on the WebView', async () => {
    // THE LIVE BUG. noteLiveVerdict is how the cart sheet tells the prewarm what
    // it learned on the page the user just signed in on. The status flipped and
    // the flag did not, so the next run read a stale corroboration and skipped
    // the grace that exists to stop exactly that.
    measuredOut();
    await renderApp();
    await act(async () => { prewarm.checkStore('aldi'); });
    await waitFor(() => expect(prewarm.signedOutIsMeasured('aldi')).toBe(true));
    act(() => { prewarm.noteLiveVerdict('aldi', true); });
    expect(prewarm.getStatus('aldi')).toBe('loggedIn');
    expect(prewarm.signedOutIsMeasured('aldi')).toBe(false);
  });

  it('does not survive a sign-out into the next account', async () => {
    // forgetAll cleared the statuses and left this behind, so user B inherited
    // user A's verdict about a store B may never have opened.
    measuredOut();
    const utils = await renderApp();
    await act(async () => { prewarm.checkStore('aldi'); });
    await waitFor(() => expect(prewarm.signedOutIsMeasured('aldi')).toBe(true));
    await act(async () => { prewarm.forgetAll(); });
    expect(prewarm.signedOutIsMeasured('aldi')).toBe(false);
    utils.unmount();
  });

  it('is not claimed for a verdict the probe merely guessed', async () => {
    // A hidden WebView's answer is the thing the sheet re-checks, never the
    // thing it acts on. Only the native path may mark a verdict measured.
    __setLoginCheckerForTests(async () => ({
      state: 'out' as const, how: 'no cookies for this origin: never signed in here', ms: 1,
    }));
    await renderApp();
    await act(async () => { prewarm.checkStore('aldi'); });
    await waitFor(() => expect(prewarm.getStatus('aldi')).toBe('loggedOut'));
    expect(prewarm.signedOutIsMeasured('aldi')).toBe(false);
  });
});
