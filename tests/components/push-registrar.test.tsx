// Notification tap routing (MEAL-88).
//
// PushRegistrar renders nothing, so these tests assert entirely on what it asks
// navigationRef to do. The navigator is mocked rather than mounted because the
// thing under test is the retry's readiness condition, and a real
// NavigationContainer would make that a race instead of an assertion.

import React from 'react';
import { act, render } from '@testing-library/react-native';

const secureStore: Record<string, string> = {};

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => secureStore[k] ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { secureStore[k] = v; }),
  deleteItemAsync: jest.fn(async (k: string) => { delete secureStore[k]; }),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  ExecutionEnvironment: { Bare: 'bare', Standalone: 'standalone', StoreClient: 'storeClient' },
  default: {
    executionEnvironment: 'standalone',
    deviceName: 'Test Phone',
    expoConfig: { extra: { eas: { projectId: 'project-1' } } },
  },
}));

jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: jest.fn(async () => {}),
  getPermissionsAsync: jest.fn(async () => ({ status: 'denied', canAskAgain: false })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[new]' })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('../../src/lib/api', () => ({
  push: { register: jest.fn(async () => ({ ok: true })), unregister: jest.fn(async () => ({ ok: true })) },
}));

jest.mock('../../src/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

jest.mock('../../src/navigation/navigationRef', () => ({
  navigationRef: { isReady: jest.fn(() => true), getRootState: jest.fn(), navigate: jest.fn() },
}));

import * as Notifications from 'expo-notifications';
import { navigationRef } from '../../src/navigation/navigationRef';
import PushRegistrar from '../../src/components/PushRegistrar';

const notifications = Notifications as jest.Mocked<typeof Notifications>;
const nav = navigationRef as unknown as {
  isReady: jest.Mock; getRootState: jest.Mock; navigate: jest.Mock;
};

/** The shape navigationRef.getRootState() returns: tabs nested in the stack. */
function rootStateWithTabs(tabs: string[]) {
  return { routeNames: ['Main'], routes: [{ name: 'Main', state: { routeNames: tabs, routes: [] } }] };
}

const BASE_TABS = ['Discover', 'MyMeals', 'Account', 'Help'];

/** A cold-start tap: the response that launched the app. */
function launchedBy(data: Record<string, unknown>) {
  (notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue({
    notification: { request: { identifier: 'notif-1', content: { data } } },
  });
}

/** Let the launch-response promise settle, then run `ms` of retry frames. */
async function tick(ms: number) {
  await act(async () => {});
  act(() => { jest.advanceTimersByTime(ms); });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  for (const k of Object.keys(secureStore)) delete secureStore[k];
  nav.isReady.mockReturnValue(true);
  nav.getRootState.mockReturnValue(rootStateWithTabs(BASE_TABS));
  (notifications.getLastNotificationResponseAsync as jest.Mock).mockResolvedValue(null);
});

afterEach(() => { jest.useRealTimers(); });

describe('notification tap routing', () => {
  it('routes a tap to a tab that already exists', async () => {
    launchedBy({ type: 'meal' });

    render(<PushRegistrar />);
    await tick(50);

    expect(nav.navigate).toHaveBeenCalledWith('MyMeals', undefined);
  });

  it('waits for the Creator tab to appear before routing a creator_draft tap', async () => {
    // The cold-start ordering this exists for: AuthContext sets the user, so
    // MainTabs mounts and isReady() flips true — but the Creator tab is gated
    // on isCreator, which is a whole extra round trip away. A navigate() fired
    // in that gap is dropped with no error and the user lands on Discover,
    // which is the default outcome for the payload type this feature is for.
    launchedBy({ type: 'creator_draft', draftId: 'd1' });

    render(<PushRegistrar />);
    await tick(1000);
    expect(nav.navigate).not.toHaveBeenCalled();

    nav.getRootState.mockReturnValue(rootStateWithTabs([...BASE_TABS, 'Creator']));
    await tick(100);

    // With the params that open the review queue on arrival (MEAL-89), rather
    // than landing on the portal and leaving the creator to find the thing the
    // notification was about.
    expect(nav.navigate).toHaveBeenCalledWith('Creator', { openQueue: true, draftId: 'd1' });
  });

  it('waits for the navigator itself, not just the route', async () => {
    nav.isReady.mockReturnValue(false);
    launchedBy({ type: 'broadcast' });

    render(<PushRegistrar />);
    await tick(500);
    expect(nav.navigate).not.toHaveBeenCalled();

    nav.isReady.mockReturnValue(true);
    await tick(100);

    expect(nav.navigate).toHaveBeenCalledWith('Discover', undefined);
  });

  it('gives up rather than looping when the tab never arrives', async () => {
    // A non-creator tapping a creator payload, or an app wedged for unrelated
    // reasons. Leaving them on the default screen beats retrying forever.
    launchedBy({ type: 'creator_draft', draftId: 'd1' });

    render(<PushRegistrar />);
    await tick(30_000);

    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('ignores a payload type this build does not know', async () => {
    launchedBy({ type: 'something-newer-than-this-build' });

    render(<PushRegistrar />);
    await tick(1000);

    expect(nav.navigate).not.toHaveBeenCalled();
  });
});
