// SIGNING OUT OF MEALIO SIGNS THIS DEVICE OUT OF EVERY STORE.
//
// Stephen's call. Before, only Account's "Sign out of my stores" button cleared
// the WebView cookie jar and bumped the rail-cache generation; logout cleared
// the prewarm and nothing else, so on a shared phone the next person to sign in
// inherited the last person's H-E-B, ALDI and Albertsons logins.
//
// Both now run lib/storeSignOut. Pinned here: logout runs it, an account switch
// runs it, a refused session runs it, and a store sign-out that fails does not
// keep anyone signed in to Mealio.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import CookieManager from '@react-native-cookies/cookies';

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
import { currentEpoch } from '../../src/lib/store-session-epoch';

const USER_A = { id: 'user-A', email: 'a@example.com' };
const USER_B = { id: 'user-B', email: 'b@example.com' };

let verifyAs: Record<string, unknown> = {};
let mealsStatus = 200;
let renewStatus = 200;

function res(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

const realFetch = global.fetch;
function installFetch() {
  global.fetch = jest.fn(async (url: any, init: any) => {
    const path = String(url).replace('https://mealio.co', '');
    const authz = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
    if (path === '/api/auth/verify') {
      const u = verifyAs[authz.replace('Bearer ', '')];
      return (u ? res(200, { user: u }) : res(401, { error: 'bad' })) as any;
    }
    if (path === '/api/auth/renew') return res(renewStatus, renewStatus === 200 ? { accessToken: 'x' } : {}) as any;
    if (path === '/api/meals') return res(mealsStatus, { meals: [] }) as any;
    return res(200, {}) as any;
  }) as any;
}

let api: ReturnType<typeof useAuth> | null = null;
function Screen() {
  api = useAuth();
  return (
    <>
      <Text testID="who">{api.isLoading ? 'loading' : api.user?.id ?? 'signed-out'}</Text>
      <TouchableOpacity testID="logout" onPress={() => { void api!.logout(); }}><Text>out</Text></TouchableOpacity>
    </>
  );
}

const clearAll = CookieManager.clearAll as jest.Mock;

async function launchAsA() {
  mockKeychain.set('mealio_access_token', 'token-A');
  mockKeychain.set('mealio_user', JSON.stringify(USER_A));
  const utils = render(<AuthProvider><Screen /></AuthProvider>);
  await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-A'));
  clearAll.mockClear();
  return utils;
}

beforeEach(() => {
  mockKeychain.clear();
  verifyAs = { 'token-A': USER_A, 'token-B': USER_B };
  mealsStatus = 200;
  renewStatus = 200;
  installFetch();
  clearAll.mockReset();
  clearAll.mockImplementation(async () => true);
});
afterEach(() => { global.fetch = realFetch; });

describe('signing out of Mealio', () => {
  it('clears the store cookie jar both ways and orphans the rail caches', async () => {
    const utils = await launchAsA();
    const epoch = currentEpoch();

    await act(async () => { fireEvent.press(utils.getByTestId('logout')); });

    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('signed-out'));
    expect(clearAll).toHaveBeenCalledWith(true);
    expect(clearAll).toHaveBeenCalledWith(false);
    expect(currentEpoch()).toBe(epoch + 1);
  });

  it('still signs out of Mealio when the store sign-out fails', async () => {
    const utils = await launchAsA();
    clearAll.mockImplementation(async () => { throw new Error('cookie jar locked'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const epoch = currentEpoch();

    await act(async () => { fireEvent.press(utils.getByTestId('logout')); });

    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('signed-out'));
    expect(mockKeychain.get('mealio_access_token')).toBeUndefined();
    // The generation still moves: the rail caches go even if the jar would not.
    expect(currentEpoch()).toBe(epoch + 1);
    warn.mockRestore();
  });
});

describe('another account taking over', () => {
  it('signs the device out of the stores when A becomes B', async () => {
    const utils = await launchAsA();
    await act(async () => { await api!.loginWithToken('token-B'); });

    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('user-B'));
    expect(clearAll).toHaveBeenCalledWith(true);
    expect(clearAll).toHaveBeenCalledWith(false);
  });

  it('leaves the stores alone when the same account is re-set', async () => {
    const utils = await launchAsA();
    await act(async () => { await api!.loginWithToken('token-A'); });
    await act(async () => { await api!.refreshUser(); });

    expect(utils.getByTestId('who')).toHaveTextContent('user-A');
    expect(clearAll).not.toHaveBeenCalled();
  });
});

describe('a session the server refuses', () => {
  it('signs the device out of the stores along with Mealio', async () => {
    const utils = await launchAsA();
    mealsStatus = 401;
    renewStatus = 401;
    await act(async () => { await meals.list().catch(() => {}); });

    await waitFor(() => expect(utils.getByTestId('who')).toHaveTextContent('signed-out'));
    expect(clearAll).toHaveBeenCalledWith(true);
  });
});
