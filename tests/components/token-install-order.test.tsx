// A token must be validated before it is installed (MEAL-155).
//
// `loginWithToken` is how a token the app was handed from OUTSIDE becomes the
// session: the email-verification deep link (`mealio://verified?token=…`, which
// RootNavigator listens for app-wide with no signed-in check) and the
// Google/Apple exchanges in LoginScreen. It used to write the token to
// SecureStore and only then ask `auth.verify()` whose it was — because verify,
// like every request in lib/api, reads the token back out of SecureStore.
//
// On a shared phone that ordering splits the app's identity in two. A is signed
// in. B taps the link in their own email. B's token lands in the keychain, and
// then verify fails TRANSIENTLY — a blip, not a bad token. RootNavigator's
// handler swallows it, React state still says A, and from that moment every
// request goes out as B. A is looking at B's meals and B's account under A's UI,
// with no transition to see. `beginSession` never ran, so the MEAL-146 account
// boundary is not defeated — it is never consulted.
//
// The benign half of the same bug is the originally reported one: a bad link
// silently signs A out. B's dead token 401s, lib/api's retry path renews the
// STORED token to try again — which is A's — the renew fails, and clear() takes
// A's session with it.
//
// WHAT THIS FILE ASSERTS ON, deliberately, is the keychain and the wire. Not
// "verify was called", not "save was called": the bug is entirely about which
// bytes are in SecureStore at which moment and which token the next request
// carries, and a spy on a function name cannot see either. So `src/lib/api` is
// the REAL module here — only `fetch` is mocked — and every assertion below is
// either a read of the in-memory keychain or a read of the Authorization header
// the api layer actually put on a request.
//
// The three transitions, all with A already signed in:
//
//   verify blips (network)  → A's token stays, A stays signed in, next request is A
//   verify succeeds as B    → B's token is installed, next request is B
//   verify says 401         → A's token stays, A is NOT signed out, no renew fires

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

jest.mock('../../src/lib/purchases', () => ({
  initPurchases: jest.fn(),
  identifyUser: jest.fn(async () => {}),
  resetUser: jest.fn(async () => {}),
}));

jest.mock('../../src/lib/push', () => ({
  unregisterDevice: jest.fn(async () => {}),
}));

import { AuthProvider, useAuth } from '../../src/context/AuthContext';
import { meals } from '../../src/lib/api';

// ── The network ──────────────────────────────────────────────────────────────

const ACCESS_TOKEN_KEY = 'mealio_access_token';
const USER_KEY = 'mealio_user';

type Call = { path: string; method: string; authorization: string | null };

/** Every request the api layer actually put on the wire, in order. */
let calls: Call[] = [];

function res(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/**
 * What /api/auth/verify does, given the Authorization header it was actually
 * sent. Taking the header rather than a canned sequence is the point: a verify
 * that answers regardless of who asked cannot tell a token being validated from
 * the stored one being re-read, which is the exact confusion under test.
 *
 * Returning `{ status, body }` keeps the two failure kinds distinguishable in
 * the harness the way they are on a phone: a 401 is an ANSWER (the server
 * replied, the token is bad), while a rejection is no answer at all (the
 * network died). They land in the same catch in the app today, but they are not
 * the same event and a test that could not tell them apart would be pinning the
 * wrong thing.
 */
let onVerify: (authorization: string | null) => Promise<{ status: number; body: unknown }> = async () => {
  throw new Error('no verify handler installed');
};

/**
 * The keychain as it stood at the moment verify was called — the ordering
 * assertion. Captured inside the handler because that is the only instant at
 * which "validated yet?" and "installed yet?" can be compared.
 */
let keychainDuringVerify: Record<string, string | undefined> = {};

const realFetch = global.fetch;

function installFetch() {
  global.fetch = jest.fn(async (url: any, init: any) => {
    const path = String(url).replace('https://mealio.co', '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers.Authorization ?? null;
    calls.push({ path, method: init?.method ?? 'GET', authorization });

    if (path === '/api/auth/verify') {
      keychainDuringVerify = {
        [ACCESS_TOKEN_KEY]: mockKeychain.get(ACCESS_TOKEN_KEY),
        [USER_KEY]: mockKeychain.get(USER_KEY),
      };
      const answer = await onVerify(authorization); // may reject — a dead network does
      return res(answer.status, answer.body) as any;
    }

    if (path === '/api/auth/login') {
      return res(200, { accessToken: 'token-user-A', user: { id: 'user-A', email: 'a@example.com' } }) as any;
    }

    // Nothing else in these tests is meant to be reachable with a session worth
    // renewing; a test that wants a renew asserts on the recorded call instead.
    if (path === '/api/auth/renew') {
      return res(401, { error: 'Session expired' }) as any;
    }

    if (path === '/api/meals') {
      return res(200, { meals: [] }) as any;
    }

    return res(200, {}) as any;
  }) as any;
}

const verifyCalls = () => calls.filter((c) => c.path === '/api/auth/verify');
const renewCalls = () => calls.filter((c) => c.path === '/api/auth/renew');
const storedToken = () => mockKeychain.get(ACCESS_TOKEN_KEY) ?? null;
const storedUserId = () => {
  const raw = mockKeychain.get(USER_KEY);
  return raw ? (JSON.parse(raw).id as string) : null;
};

/**
 * What the api layer would send on the NEXT ordinary request — the thing the
 * leak is actually made of. Goes through the real `request()`, so it reads the
 * token the way every screen in the app does.
 */
async function tokenOnTheWire(): Promise<string | null> {
  await act(async () => { await meals.list(); });
  const last = calls[calls.length - 1];
  expect(last.path).toBe('/api/meals');
  return last.authorization;
}

// ── Harness ──────────────────────────────────────────────────────────────────

/** The last error `loginWithToken` threw, as RootNavigator's catch would see it. */
let lastLinkError: any = null;

function Screen() {
  const { user, login, loginWithToken } = useAuth();
  return (
    <>
      <Text testID="who">{user?.id ?? 'signed-out'}</Text>
      <TouchableOpacity testID="login-a" onPress={() => { void login('a@example.com', 'pw'); }}>
        <Text>sign in as A</Text>
      </TouchableOpacity>
      {/*
        RootNavigator's `mealio://verified?token=…` handler is exactly this: a
        bare `await loginWithToken(token)` inside a try/catch that swallows,
        from a listener registered app-wide — which is why it arrives while
        somebody else is signed in.
      */}
      <TouchableOpacity
        testID="verified-link"
        onPress={() => {
          void (async () => {
            try {
              lastLinkError = null;
              await loginWithToken('token-user-B');
            } catch (err) {
              lastLinkError = err;
            }
          })();
        }}
      >
        <Text>tap B's verification link</Text>
      </TouchableOpacity>
    </>
  );
}

async function renderApp() {
  const utils = render(<AuthProvider><Screen /></AuthProvider>);
  await act(async () => { await Promise.resolve(); });
  return utils;
}

type App = Awaited<ReturnType<typeof renderApp>>;

async function signInAsA(utils: App) {
  await act(async () => { fireEvent.press(utils.getByTestId('login-a')); });
  await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-A'));
  expect(storedToken()).toBe('token-user-A');
}

async function tapBsLink(utils: App) {
  await act(async () => { fireEvent.press(utils.getByTestId('verified-link')); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  calls = [];
  keychainDuringVerify = {};
  lastLinkError = null;
  mockKeychain.clear();
  installFetch();
  // The launch-time initAuth: nothing stored, so it returns without a request.
  onVerify = async () => { throw new Error('no verify handler installed'); };
});

afterEach(() => { global.fetch = realFetch; });

// ── The leak: a transient verify failure ─────────────────────────────────────

describe('B\'s link is tapped on A\'s phone and verify blips', () => {
  /** A dead network. RN's fetch rejects with a TypeError; it never answers. */
  const networkBlip = async () => { throw new TypeError('Network request failed'); };

  it("leaves A's token in the keychain, so the next request still goes out as A", async () => {
    const utils = await renderApp();
    await signInAsA(utils);

    onVerify = networkBlip;
    await tapBsLink(utils);

    // The attempt was real — B's token did go to the server to be checked.
    expect(verifyCalls().map((c) => c.authorization)).toContain('Bearer token-user-B');
    // And it failed, loudly enough for a caller to see.
    expect(lastLinkError).toBeInstanceOf(TypeError);

    // A is untouched on every surface identity is kept on.
    expect(utils.getByTestId('who')).toHaveTextContent('user-A');
    expect(storedToken()).toBe('token-user-A');
    expect(storedUserId()).toBe('user-A');

    // The one that is the leak itself: what the api layer puts on the wire.
    expect(await tokenOnTheWire()).toBe('Bearer token-user-A');
  });

  it('had not written the token to the keychain by the time it asked', async () => {
    // The ordering, stated directly. Everything above is downstream of this: if
    // the token is already stored when verify is asked, then whether A survives
    // depends on verify happening to succeed, which is not a property.
    const utils = await renderApp();
    await signInAsA(utils);

    onVerify = networkBlip;
    await tapBsLink(utils);

    expect(keychainDuringVerify[ACCESS_TOKEN_KEY]).toBe('token-user-A');
    expect(keychainDuringVerify[ACCESS_TOKEN_KEY]).not.toBe('token-user-B');
  });

  it('leaves nobody signed in when the phone had nobody signed in', async () => {
    // The same failure with no A to protect. The fix must not install on failure
    // here either — a signed-out phone that half-adopts a token is the same
    // split identity with a smaller blast radius.
    const utils = await renderApp();

    onVerify = networkBlip;
    await tapBsLink(utils);

    expect(utils.getByTestId('who')).toHaveTextContent('signed-out');
    expect(storedToken()).toBeNull();
    expect(await tokenOnTheWire()).toBeNull();
  });
});

// ── The success path still has to work ───────────────────────────────────────

describe("B's link is tapped on A's phone and verify succeeds", () => {
  it('installs B, and the next request goes out as B', async () => {
    const utils = await renderApp();
    await signInAsA(utils);

    // Answering from the header, not from a queue: a verify that returned B
    // while being asked as A would mean the token under test never left the
    // device, and the whole check would be theatre.
    onVerify = async (authorization) => {
      if (authorization !== 'Bearer token-user-B') {
        throw new Error(`verify asked as ${authorization}, not as the token being validated`);
      }
      return { status: 200, body: { user: { id: 'user-B', email: 'b@example.com' } } };
    };
    await tapBsLink(utils);

    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-B'));
    expect(lastLinkError).toBeNull();
    expect(storedToken()).toBe('token-user-B');
    expect(storedUserId()).toBe('user-B');
    expect(await tokenOnTheWire()).toBe('Bearer token-user-B');
  });

  it('works the same on a phone nobody was signed in on', async () => {
    // The link's ordinary purpose: a new account confirming their email. Nothing
    // about validating first may cost it.
    const utils = await renderApp();

    onVerify = async (authorization) => {
      expect(authorization).toBe('Bearer token-user-B');
      return { status: 200, body: { user: { id: 'user-B', email: 'b@example.com' } } };
    };
    await tapBsLink(utils);

    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-B'));
    expect(storedToken()).toBe('token-user-B');
    expect(await tokenOnTheWire()).toBe('Bearer token-user-B');
  });
});

// ── The benign half: a dead link must not sign A out ─────────────────────────

describe("B's link is expired", () => {
  it("does not renew A's session to answer for B's token", async () => {
    // The reported symptom, and the reason `auth.verify(token)` opts out of the
    // 401 renew-and-retry. Renewing here would authenticate the retry as A —
    // answering "whose token is this?" with the phone's owner — and when the
    // renew fails, lib/api's clear() takes A's session with it.
    const utils = await renderApp();
    await signInAsA(utils);

    // An ANSWER, not a dead socket: the server replied, and what it said is that
    // this token is no good.
    onVerify = async () => ({ status: 401, body: { error: 'Invalid or expired token' } });
    await tapBsLink(utils);

    expect(verifyCalls().map((c) => c.authorization)).toContain('Bearer token-user-B');
    expect(renewCalls()).toHaveLength(0);
    expect(lastLinkError).toBeTruthy();

    // A is still here, still signed in, still A on the wire.
    expect(utils.getByTestId('who')).toHaveTextContent('user-A');
    expect(storedToken()).toBe('token-user-A');
    expect(storedUserId()).toBe('user-A');
    expect(await tokenOnTheWire()).toBe('Bearer token-user-A');
  });
});
