// OPENING THE APP WITHOUT A SERVER MUST NOT SIGN YOU OUT.
//
// initAuth asks /api/auth/verify whether the stored token is still good. Any
// failure of that used to fall through to /api/auth/renew, which failed the
// same way for the same reason, and both failure paths cleared the keychain. So
// a launch on a plane, in a basement, or during a mealio.co outage put the user
// on the sign-in screen with their credentials gone.
//
// Only the server saying no (a 401/403 from verify AND from renew) is a reason
// to clear. Everything else starts the session from the stored user and asks
// again later.
//
// Like token-install-order.test.tsx, `src/lib/api` is the REAL module and only
// `fetch` is mocked, so what is asserted is the keychain and the screen.

import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { AppState, Text } from 'react-native';

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

const ACCESS_TOKEN_KEY = 'mealio_access_token';
const USER_KEY = 'mealio_user';
const STORED_USER = { id: 'user-A', email: 'a@example.com' };

type Answer = { status: number; body: unknown } | 'network';
let onVerify: () => Answer = () => 'network';
let onRenew: () => Answer = () => 'network';
let onMeals: () => Answer = () => ({ status: 200, body: { meals: [] } });
let paths: string[] = [];

function res(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

const realFetch = global.fetch;
function installFetch() {
  global.fetch = jest.fn(async (url: any) => {
    const path = String(url).replace('https://mealio.co', '');
    paths.push(path);
    let answer: Answer = { status: 200, body: {} };
    if (path === '/api/auth/verify') answer = onVerify();
    if (path === '/api/auth/renew') answer = onRenew();
    if (path === '/api/meals') answer = onMeals();
    if (answer === 'network') throw new TypeError('Network request failed');
    return res(answer.status, answer.body) as any;
  }) as any;
}

let appStateHandlers: Array<(s: string) => void> = [];
const foreground = () => { for (const h of appStateHandlers) h('active'); };

function Screen() {
  const { user, isLoading } = useAuth();
  return <Text testID="who">{isLoading ? 'loading' : user?.id ?? 'signed-out'}</Text>;
}

async function launch() {
  const utils = render(<AuthProvider><Screen /></AuthProvider>);
  await waitFor(() => expect(utils.getByTestId('who')).not.toHaveTextContent('loading'));
  return utils;
}

beforeEach(() => {
  paths = [];
  onMeals = () => ({ status: 200, body: { meals: [] } });
  mockKeychain.clear();
  mockKeychain.set(ACCESS_TOKEN_KEY, 'token-A');
  mockKeychain.set(USER_KEY, JSON.stringify(STORED_USER));
  installFetch();
  appStateHandlers = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_t: any, h: any) => {
    appStateHandlers.push(h);
    return { remove: () => {} } as any;
  });
});

afterEach(() => { global.fetch = realFetch; jest.restoreAllMocks(); });

const ok = (body: unknown) => ({ status: 200, body });
const expiredAnswer = { status: 401, body: { error: 'Invalid or expired token' } };

describe('a launch the server cannot answer', () => {
  it.each([
    ['no network', 'network' as Answer],
    ['a 503', { status: 503, body: { error: 'down' } } as Answer],
    ['a 500', { status: 500, body: {} } as Answer],
  ])('keeps the stored session on %s', async (_label, answer) => {
    onVerify = () => answer;
    onRenew = () => answer;
    const utils = await launch();

    expect(utils.getByTestId('who')).toHaveTextContent('user-A');
    expect(mockKeychain.get(ACCESS_TOKEN_KEY)).toBe('token-A');
    expect(JSON.parse(mockKeychain.get(USER_KEY)!).id).toBe('user-A');
  });

  it('keeps it when verify says 401 but renew cannot be reached', async () => {
    // The server refused the old token, and the renew that might have replaced
    // it never got an answer. Nobody has said the SESSION is dead.
    onVerify = () => expiredAnswer;
    onRenew = () => 'network';
    const utils = await launch();

    expect(utils.getByTestId('who')).toHaveTextContent('user-A');
    expect(mockKeychain.get(ACCESS_TOKEN_KEY)).toBe('token-A');
  });

  it('confirms the session when the app comes back with a network', async () => {
    onVerify = () => 'network';
    onRenew = () => 'network';
    const utils = await launch();
    expect(utils.getByTestId('who')).toHaveTextContent('user-A');

    onVerify = () => ok({ user: { id: 'user-A', email: 'a@example.com', firstName: 'Ann' } });
    const before = paths.filter((p) => p === '/api/auth/verify').length;
    await act(async () => { foreground(); });
    await waitFor(() => expect(paths.filter((p) => p === '/api/auth/verify').length).toBe(before + 1));
    await waitFor(() => expect(JSON.parse(mockKeychain.get(USER_KEY)!).firstName).toBe('Ann'));
    expect(utils.getByTestId('who')).toHaveTextContent('user-A');
  });

  it('signs out when the later check finds the server refusing the session', async () => {
    onVerify = () => 'network';
    onRenew = () => 'network';
    const utils = await launch();
    expect(utils.getByTestId('who')).toHaveTextContent('user-A');

    onVerify = () => expiredAnswer;
    onRenew = () => expiredAnswer;
    await act(async () => { foreground(); });
    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('signed-out'));
    expect(mockKeychain.get(ACCESS_TOKEN_KEY)).toBeUndefined();
  });
});

describe('a launch the server does answer', () => {
  it('signs out when both verify and renew refuse the token', async () => {
    onVerify = () => expiredAnswer;
    onRenew = () => expiredAnswer;
    const utils = await launch();

    expect(utils.getByTestId('who')).toHaveTextContent('signed-out');
    expect(mockKeychain.get(ACCESS_TOKEN_KEY)).toBeUndefined();
    expect(mockKeychain.get(USER_KEY)).toBeUndefined();
  });

  it('adopts a renewed token when verify refuses and renew answers', async () => {
    onVerify = () => expiredAnswer;
    onRenew = () => ok({ accessToken: 'token-A2', user: STORED_USER });
    const utils = await launch();

    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-A'));
    expect(mockKeychain.get(ACCESS_TOKEN_KEY)).toBe('token-A2');
  });
});

// A SESSION THE SERVER REFUSES MID-USE MUST LOOK SIGNED OUT.
//
// lib/api renews on a 401 and, when the renew failed for ANY reason, cleared
// the keychain without telling AuthContext. The UI stayed signed in over no
// token, every request 401'd, and nothing led to the sign-in screen until a
// restart. And a renew that merely could not be reached cleared it too.
describe('a request that 401s while signed in', () => {
  async function signedIn() {
    onVerify = () => ok({ user: STORED_USER });
    const utils = await launch();
    expect(utils.getByTestId('who')).toHaveTextContent('user-A');
    return utils;
  }

  it('signs the app out when the renew is refused', async () => {
    const utils = await signedIn();
    onMeals = () => expiredAnswer;
    onRenew = () => expiredAnswer;
    await act(async () => { await meals.list().catch(() => {}); });

    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('signed-out'));
    expect(mockKeychain.get(ACCESS_TOKEN_KEY)).toBeUndefined();
  });

  it.each([
    ['cannot be reached', 'network' as Answer],
    ['gets a 503', { status: 503, body: {} } as Answer],
  ])('keeps the session when the renew %s', async (_label, renewAnswer) => {
    const utils = await signedIn();
    onMeals = () => expiredAnswer;
    onRenew = () => renewAnswer;
    await act(async () => { await meals.list().catch(() => {}); });

    expect(utils.getByTestId('who')).toHaveTextContent('user-A');
    expect(mockKeychain.get(ACCESS_TOKEN_KEY)).toBe('token-A');
  });
});
