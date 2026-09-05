// "On" must mean the device can actually receive something.
//
// MEASURED on the Pixel, 2026-09-05. Stephen tapped Turn On Notifications, got
// a spinner, and the screen then said "Push notifications are on". It was not.
// `getExpoPushTokenAsync` had thrown —
//
//   Default FirebaseApp is not initialized in this process co.mealio.app
//
// — because the build carries no FCM credentials. `requestAndRegister` returned
// 'granted' off the OS PERMISSION alone, so a server that had never heard of
// the device, and never would, was reported as a working subscription.
//
// Three things have to be true before "on" is honest: the OS allowed it, a
// token was obtained, and the server took it. This pins that.
jest.mock('expo-notifications', () => ({
  requestPermissionsAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => {}),
  setNotificationHandler: jest.fn(),
  AndroidImportance: { DEFAULT: 3 },
}));
jest.mock('expo-secure-store', () => {
  const store: Record<string, string> = {};
  return {
    __store: store,
    getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => { store[k] = v; }),
    deleteItemAsync: jest.fn(async (k: string) => { delete store[k]; }),
  };
});
jest.mock('expo-constants', () => ({
  __esModule: true,
  // supportsRemotePush() gates on the execution environment: Expo Go has no
  // push module at all, which is why the app needs a dev build.
  ExecutionEnvironment: { Bare: 'bare', Standalone: 'standalone', StoreClient: 'storeClient' },
  default: {
    expoConfig: { extra: { eas: { projectId: 'test-project' } } },
    deviceName: 'Pixel',
    executionEnvironment: 'bare',
    appOwnership: null,
  },
}));
jest.mock('../../src/lib/api', () => ({ push: { register: jest.fn(async () => ({})), unregister: jest.fn(async () => ({})) } }));

import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { push as pushApi } from '../../src/lib/api';
import { enablePush } from '../../src/lib/push';

const store = (SecureStore as unknown as { __store: Record<string, string> }).__store;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  jest.clearAllMocks();
  (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted' });
});

describe('enablePush only reports "on" when the device is actually reachable', () => {
  it('reports unregistered when no token can be obtained', async () => {
    // The exact production failure: permission granted, FCM missing.
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockRejectedValue(
      new Error('Default FirebaseApp is not initialized in this process co.mealio.app'));

    expect(await enablePush()).toBe('unregistered');
    expect(pushApi.register).not.toHaveBeenCalled();
  });

  it('reports unregistered when the server refuses the token', async () => {
    // The other half. A token that exists but is rejected leaves no live row,
    // so nothing can arrive and "on" would be the same lie.
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'ExponentPushToken[abc]' });
    (pushApi.register as jest.Mock).mockRejectedValue(new Error('Invalid Expo push token'));

    expect(await enablePush()).toBe('unregistered');
  });

  it('reports on only when a token was obtained AND accepted', async () => {
    (Notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'ExponentPushToken[abc]' });
    (pushApi.register as jest.Mock).mockResolvedValue({});

    expect(await enablePush()).toBe('on');
    expect(pushApi.register).toHaveBeenCalled();
  });

  it('still reports blocked when the OS says no', async () => {
    (Notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied' });
    expect(await enablePush()).toBe('blocked');
    expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });
});
