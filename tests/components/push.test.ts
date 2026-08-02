// Push registration + tap routing (MEAL-88).
//
// Lives in the jest-expo project rather than tests/unit because src/lib/push.ts
// imports expo-notifications and expo-constants, which the node project's
// ts-jest transform doesn't handle. Everything Expo-facing is mocked, so this
// never touches a device, a token service, or the network.

import { Platform } from 'react-native';

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
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => {}),
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted', canAskAgain: false })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted', canAskAgain: false })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[new]' })),
  addPushTokenListener: jest.fn(() => ({ remove: jest.fn() })),
}));

jest.mock('../../src/lib/api', () => ({
  push: { register: jest.fn(async () => ({ ok: true })), unregister: jest.fn(async () => ({ ok: true })) },
}));

jest.mock('../../src/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { push as pushApi } from '../../src/lib/api';
import {
  disablePush,
  enablePush,
  getPushStatus,
  routeForNotification,
  supportsRemotePush,
  syncRegistration,
  unregisterDevice,
} from '../../src/lib/push';

const notifications = Notifications as jest.Mocked<typeof Notifications>;
const api = pushApi as jest.Mocked<typeof pushApi>;

function setPermission(status: string, canAskAgain = true) {
  (notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ status, canAskAgain });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(secureStore)) delete secureStore[k];
  (Constants as any).executionEnvironment = 'standalone';
  setPermission('granted', false);
  (notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'ExponentPushToken[new]' });
  (notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'granted', canAskAgain: false });
});

describe('routeForNotification', () => {
  it('routes a creator draft to the Creator tab and carries the draft id (MEAL-89 seam)', () => {
    expect(routeForNotification({ type: 'creator_draft', draftId: 'd1' }))
      .toEqual({ target: 'Creator', draftId: 'd1' });
  });

  it('routes the other known payload types', () => {
    expect(routeForNotification({ type: 'meal' })).toEqual({ target: 'MyMeals' });
    expect(routeForNotification({ type: 'broadcast' })).toEqual({ target: 'Discover' });
  });

  it('returns null for an unknown type rather than guessing a destination', () => {
    expect(routeForNotification({ type: 'something-newer-than-this-build' })).toBeNull();
  });

  it('returns null for a missing or non-object payload', () => {
    expect(routeForNotification(undefined)).toBeNull();
    expect(routeForNotification(null)).toBeNull();
    expect(routeForNotification('creator_draft')).toBeNull();
  });
});

describe('supportsRemotePush', () => {
  it('is false in Expo Go, where remote push cannot work on SDK 53+', () => {
    (Constants as any).executionEnvironment = 'storeClient';
    expect(supportsRemotePush()).toBe(false);
  });

  it('is true in a dev/production build', () => {
    expect(supportsRemotePush()).toBe(true);
  });
});

describe('getPushStatus', () => {
  it('reports unsupported in Expo Go so the settings UI hides rather than lying', async () => {
    (Constants as any).executionEnvironment = 'storeClient';
    await expect(getPushStatus()).resolves.toBe('unsupported');
  });

  it('reports on when permission is granted and the user has not opted out', async () => {
    await expect(getPushStatus()).resolves.toBe('on');
  });

  it('reports blocked when the OS denied it — only Settings can undo that', async () => {
    setPermission('denied', false);
    await expect(getPushStatus()).resolves.toBe('blocked');
  });

  it('treats undetermined-but-cannot-ask as blocked, since requesting would no-op', async () => {
    setPermission('undetermined', false);
    await expect(getPushStatus()).resolves.toBe('blocked');
  });

  it('reports off when we have never asked', async () => {
    setPermission('undetermined', true);
    await expect(getPushStatus()).resolves.toBe('off');
  });
});

describe('syncRegistration', () => {
  it('never prompts — it only refreshes an existing grant', async () => {
    await syncRegistration();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it('does nothing when permission was never granted', async () => {
    setPermission('undetermined', true);
    await syncRegistration();
    expect(api.register).not.toHaveBeenCalled();
  });

  it('does nothing in Expo Go', async () => {
    (Constants as any).executionEnvironment = 'storeClient';
    await syncRegistration();
    expect(api.register).not.toHaveBeenCalled();
  });

  it('sends the previous token so a rotation replaces the old row instead of adding one', async () => {
    (notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'ExponentPushToken[old]' });
    await syncRegistration();
    expect(api.register).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: 'ExponentPushToken[old]', previousToken: undefined }),
    );

    (notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'ExponentPushToken[new]' });
    await syncRegistration();
    expect(api.register).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: 'ExponentPushToken[new]', previousToken: 'ExponentPushToken[old]' }),
    );
  });

  it('reports the platform and device name so a user can tell their devices apart', async () => {
    await syncRegistration();
    expect(api.register).toHaveBeenCalledWith(
      expect.objectContaining({ platform: Platform.OS, deviceName: 'Test Phone' }),
    );
  });

  it('keeps the stored token untouched when the register call fails, so the retry still rotates', async () => {
    await syncRegistration();
    (notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValue({ data: 'ExponentPushToken[rotated]' });
    (api.register as jest.Mock).mockRejectedValueOnce(new Error('offline'));

    await expect(syncRegistration()).resolves.toBeUndefined();

    await syncRegistration();
    expect(api.register).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: 'ExponentPushToken[rotated]', previousToken: 'ExponentPushToken[new]' }),
    );
  });

  it('survives a token fetch that throws (no APNs/FCM credentials in this build)', async () => {
    (notifications.getExpoPushTokenAsync as jest.Mock).mockRejectedValue(new Error('no credentials'));
    await expect(syncRegistration()).resolves.toBeUndefined();
    expect(api.register).not.toHaveBeenCalled();
  });
});

describe('enable / disable', () => {
  it('asks the OS and registers on a grant', async () => {
    setPermission('undetermined', true);
    await expect(enablePush()).resolves.toBe('on');
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it('degrades to blocked on a denial without registering anything', async () => {
    setPermission('undetermined', true);
    (notifications.requestPermissionsAsync as jest.Mock).mockResolvedValue({ status: 'denied', canAskAgain: false });
    await expect(enablePush()).resolves.toBe('blocked');
    expect(api.register).not.toHaveBeenCalled();
  });

  it('retires the token and makes the opt-out stick across a relaunch', async () => {
    await syncRegistration();
    await disablePush();

    expect(api.unregister).toHaveBeenCalledWith('ExponentPushToken[new]');
    // OS permission is still granted; without the recorded opt-out the next
    // launch would silently re-enrol the device.
    await expect(getPushStatus()).resolves.toBe('off');
    (api.register as jest.Mock).mockClear();
    await syncRegistration();
    expect(api.register).not.toHaveBeenCalled();
  });

  it('re-enabling clears the opt-out', async () => {
    await syncRegistration();
    await disablePush();
    await expect(enablePush()).resolves.toBe('on');
    await expect(getPushStatus()).resolves.toBe('on');
  });

  it('unregisterDevice is a no-op when this device never registered', async () => {
    await unregisterDevice();
    expect(api.unregister).not.toHaveBeenCalled();
  });
});
