/**
 * The pin for MEAL-157 — the root `__mocks__/react-native-purchases.js`.
 *
 * THIS FILE DELIBERATELY CARRIES NO `jest.mock('../../src/lib/purchases', …)`
 * AND NO `jest.mock('react-native-purchases', …)`. That absence is the whole
 * point: it is the thing twelve other test files each had to remember, and
 * forgetting did not fail a test — `react-native-purchases` reaches
 * `@revenuecat/purchases-js-hybrid-mappings`, which is ESM that jest-expo's
 * transform does not cover, so the SUITE failed to load, before a single test
 * ran, with a message naming only a file in node_modules. `AuthContext` imports
 * `src/lib/purchases`, so that trap sat under most of the component tree, and it
 * is what kept main red for a working session.
 *
 * On origin/main this file fails to run. Here it passes. If the root mock is
 * ever deleted or stops being picked up, this is what says so — in a test
 * failure that names this file and this comment, rather than in twelve unrelated
 * suites at once.
 *
 * Do not add a purchases mock to this file. If you need one for a new
 * assertion, write the assertion in a different file.
 */

import { render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

// ── Supporting mocks ─────────────────────────────────────────────────────────
// None of these is `purchases`. AuthProvider talks to the keychain and the API
// on mount, and neither belongs in a test about module loading; stubbing them
// keeps this test off the network without touching the path under test.

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));

jest.mock('../../src/lib/api', () => ({
  auth: {
    verify: jest.fn(async () => { throw new Error('no session'); }),
    renew: jest.fn(async () => ({})),
    login: jest.fn(),
    logout: jest.fn(async () => ({ ok: true })),
    verify2FA: jest.fn(),
  },
  creators: { getMe: jest.fn(async () => ({ creator: null })) },
  usage: { logOpen: jest.fn(async () => {}) },
  push: { register: jest.fn(), unregister: jest.fn() },
}));

// The real modules, imported exactly as application code imports them.
import Purchases, { LOG_LEVEL } from 'react-native-purchases';
import { AuthProvider, useAuth } from '../../src/context/AuthContext';
import {
  checkEntitlement,
  getAllOfferings,
  getEntitlementDetails,
  getManagementURL,
  getOffering,
  initPurchases,
} from '../../src/lib/purchases';

describe('react-native-purchases stands in for itself, everywhere, unasked', () => {
  it('lets a suite import the component tree without mocking purchases', () => {
    // Reaching this line at all is the assertion — a suite that could not parse
    // the ESM dist never gets here. The rest keeps that honest by proving the
    // import produced the real modules and not undefined.
    expect(typeof AuthProvider).toBe('function');
    expect(typeof useAuth).toBe('function');
    expect(typeof initPurchases).toBe('function');
  });

  it('mounts a component tree rooted at AuthProvider', async () => {
    function Consumer() {
      const { isLoading } = useAuth();
      return <Text>{isLoading ? 'loading' : 'ready'}</Text>;
    }

    // AuthProvider calls the REAL initPurchases() in a mount effect. It must not
    // throw against the stand-in.
    const { getByText } = render(
      <AuthProvider>
        <Consumer />
      </AuthProvider>,
    );
    await waitFor(() => expect(getByText('ready')).toBeTruthy());
  });

  it('keeps the named exports genuine, so a test reading them is not lied to', () => {
    // Re-exported from @revenuecat/purchases-typescript-internal rather than
    // hand-written, so these are the SDK's own values.
    expect(LOG_LEVEL).toMatchObject({
      VERBOSE: 'VERBOSE',
      DEBUG: 'DEBUG',
      INFO: 'INFO',
      WARN: 'WARN',
      ERROR: 'ERROR',
    });
  });

  it('answers like a device with no store: real shapes, nothing bought', async () => {
    // Called directly, because src/lib/purchases short-circuits every one of
    // these while unconfigured — so only a direct call reaches the stand-in and
    // can catch it being shaped wrong.
    const info = await Purchases.getCustomerInfo();
    expect(info.entitlements.active).toEqual({});
    expect(info.entitlements.all).toEqual({});
    expect(info.activeSubscriptions).toEqual([]);
    expect(info.managementURL).toBeNull();

    const offerings = await Purchases.getOfferings();
    expect(offerings.current).toBeNull();
    expect(offerings.all).toEqual({});
  });

  it('leaves src/lib/purchases returning its unavailable answers', async () => {
    // No RevenueCat API key in the test environment, so initPurchases() bails
    // and the module reports "no store" — the same thing it reports in Expo Go.
    // A component under test therefore sees a signed-out, unsubscribed world by
    // default, rather than a crash or a fabricated subscription.
    initPurchases();
    await expect(getOffering()).resolves.toBeNull();
    await expect(getAllOfferings()).resolves.toEqual([]);
    await expect(checkEntitlement()).resolves.toBe(false);
    await expect(getEntitlementDetails()).resolves.toBeNull();
    await expect(getManagementURL()).resolves.toBeNull();
  });
});
