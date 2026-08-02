import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { push as pushApi } from './api';
import { logger } from './logger';

// ─────────────────────────────────────────────────────────────────────────────
// Push registration (MEAL-88)
//
// Everything here is best-effort by design: the app is fully usable without
// notifications, so a denial, a missing dev build, or a failed register call
// must never surface as an error or block a screen.
//
// The permission PROMPT is not fired from anywhere in this module on its own.
// It only happens inside requestAndRegister(), which is called from an explicit
// user tap — never on launch, never on mount. iOS gives exactly one system
// prompt per install, so it is spent behind our own in-app ask, where the user
// already knows what they are saying yes to. `syncRegistration()` is the launch
// path and is silent: it refreshes an existing grant and does nothing otherwise.
// ─────────────────────────────────────────────────────────────────────────────

/** The Expo token this device last successfully registered with the server. */
const TOKEN_KEY = 'mealio_push_token';

/**
 * Set when the user turns notifications off in Account. Needed because OS
 * permission stays granted after an in-app opt-out — without this the next
 * launch would helpfully re-register the device and undo their choice.
 */
const OPT_OUT_KEY = 'mealio_push_opt_out';

export type PushPermission = 'granted' | 'denied' | 'undetermined';

/**
 * What the settings UI needs to know, collapsing OS permission and the in-app
 * opt-out into the four states a user can actually be in.
 *
 *   on          receiving; a token is registered
 *   off         not receiving, and we can still ask
 *   blocked     denied at the OS level; only Settings can undo it
 *   unsupported no remote push in this build (Expo Go)
 */
export type PushStatus = 'on' | 'off' | 'blocked' | 'unsupported';

/**
 * Remote push needs a development/production build plus APNs and FCM
 * credentials; it does not work in Expo Go on SDK 53+. Detecting that and doing
 * nothing is the honest behaviour — the alternative is a thrown error on every
 * launch for anyone running the QR-code workflow.
 */
export function supportsRemotePush(): boolean {
  return Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
}

/** EAS project id — required by getExpoPushTokenAsync since SDK 49. */
function projectId(): string | undefined {
  return (
    (Constants.expoConfig?.extra as any)?.eas?.projectId ??
    (Constants as any).easConfig?.projectId
  );
}

/**
 * How a foregrounded notification is presented. Set once, at startup, before
 * any listener can fire — without it a notification that arrives while the app
 * is open is delivered silently and the user never learns push works.
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/**
 * Android needs a channel to exist before the first notification lands, or the
 * system files it under a default channel the user cannot tune. No-op on iOS.
 */
export async function configureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Mealio',
      importance: Notifications.AndroidImportance.DEFAULT,
      lightColor: '#DD0031',
    });
  } catch (err) {
    logger.warn('push_channel_failed', String(err));
  }
}

export async function getPermission(): Promise<PushPermission> {
  try {
    const { status, canAskAgain } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return 'granted';
    // `undetermined` is the only state where asking does anything. Once
    // canAskAgain is false the OS silently resolves the request, so treat it as
    // a denial and send the user to Settings instead of a no-op button.
    if (status === 'undetermined' && canAskAgain) return 'undetermined';
    return 'denied';
  } catch {
    return 'denied';
  }
}

async function fetchExpoToken(): Promise<string | null> {
  const id = projectId();
  if (!id) {
    logger.warn('push_no_project_id', 'expo.extra.eas.projectId missing');
    return null;
  }
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    return data ?? null;
  } catch (err) {
    // Thrown when the build has no APNs/FCM credentials. Nothing the user can
    // do about it, so it stays in the log.
    logger.warn('push_token_failed', String(err));
    return null;
  }
}

/**
 * Sends the current token to the server, telling it which token this device
 * used to have. The server can only tell "this device rotated" from "this user
 * added a second device" if we say so, and without that a rotation leaves the
 * old row live and every future send pays for a device that will never receive.
 */
async function registerToken(token: string): Promise<boolean> {
  const previous = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  try {
    await pushApi.register({
      token,
      platform: Platform.OS,
      deviceName: Constants.deviceName ?? undefined,
      previousToken: previous ?? undefined,
    });
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    return true;
  } catch (err) {
    // Leave the stored token alone: the next sync retries, and it still carries
    // the correct `previousToken` so the rotation is not lost.
    logger.warn('push_register_failed', String(err));
    return false;
  }
}

/**
 * Silent refresh, safe to call on every launch and every sign-in. Registers only
 * if permission was already granted; never prompts, never alerts.
 *
 * Re-registering an unchanged token is deliberate rather than wasteful — it is
 * what makes the row survive a server-side prune, and it costs one request per
 * launch.
 */
export async function syncRegistration(): Promise<void> {
  if (!supportsRemotePush()) return;
  if (await isOptedOut()) return;
  if ((await getPermission()) !== 'granted') return;
  const token = await fetchExpoToken();
  if (token) await registerToken(token);
}

async function isOptedOut(): Promise<boolean> {
  return !!(await SecureStore.getItemAsync(OPT_OUT_KEY).catch(() => null));
}

/** Collapsed state for the Account toggle. */
export async function getPushStatus(): Promise<PushStatus> {
  if (!supportsRemotePush()) return 'unsupported';
  const permission = await getPermission();
  if (permission === 'denied') return 'blocked';
  if (permission === 'granted' && !(await isOptedOut())) return 'on';
  return 'off';
}

/**
 * Turns notifications on from an explicit tap: clears any previous opt-out, then
 * asks the OS if it has not been asked yet.
 */
export async function enablePush(): Promise<PushStatus> {
  await SecureStore.deleteItemAsync(OPT_OUT_KEY).catch(() => {});
  const permission = await requestAndRegister();
  if (permission === 'granted') return 'on';
  return permission === 'denied' ? 'blocked' : 'off';
}

/**
 * Turns notifications off from inside the app. Records the choice locally so a
 * still-granted OS permission does not silently re-enrol the device on the next
 * launch, and retires the token server-side so sends stop now.
 */
export async function disablePush(): Promise<void> {
  await SecureStore.setItemAsync(OPT_OUT_KEY, '1').catch(() => {});
  await unregisterDevice();
}

/**
 * The one place that fires the system permission prompt. Call it from an
 * explicit tap only.
 *
 * Returns the resulting permission state so the caller can show the "you'll
 * need to enable this in Settings" path without a second round trip.
 */
export async function requestAndRegister(): Promise<PushPermission> {
  if (!supportsRemotePush()) return 'denied';

  let status: PushPermission;
  try {
    const result = await Notifications.requestPermissionsAsync();
    status = result.status === 'granted' ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
  if (status !== 'granted') return status;

  await configureAndroidChannel();
  const token = await fetchExpoToken();
  if (token) await registerToken(token);
  return 'granted';
}

/**
 * Stops sends to this device immediately, without waiting for a delivery
 * receipt to notice. Used by the Account toggle and by sign-out — a shared
 * phone must not keep receiving the previous account's notifications.
 */
export async function unregisterDevice(): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  if (!token) return;
  try {
    await pushApi.unregister(token);
  } catch (err) {
    logger.warn('push_unregister_failed', String(err));
  }
  // Cleared either way: this device's local claim on the token is gone, and a
  // later syncRegistration() re-registers from scratch if permission is still on.
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
}

/**
 * Expo can hand the app a new token while it is running (rare, but it happens
 * after some OS updates). Without this the app would keep a dead token until
 * the next cold start.
 */
export function addTokenRotationListener(): { remove: () => void } {
  return Notifications.addPushTokenListener((token) => {
    if (token?.data) void registerToken(token.data);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tap routing
//
// A notification's payload carries a `type` that names WHERE the tap should
// land. Keeping the mapping in one pure function means the navigation wiring
// stays a two-line adapter and this stays unit-testable without a navigator.
// ─────────────────────────────────────────────────────────────────────────────

/** Tab names in MainTabs; see src/navigation/MainTabs.tsx. */
export type PushTarget = 'Creator' | 'MyMeals' | 'Discover';

export interface PushRoute {
  target: PushTarget;
  /**
   * MEAL-89 SEAM. `creator_draft` notifications carry the draft id, and the
   * review queue screen they should open does not exist yet. Until it does the
   * tap lands on the Creator tab — the closest true destination — and the id is
   * passed through so wiring the real screen is a change here and in the
   * adapter, not a change to the payload contract or the server.
   */
  draftId?: string;
}

export function routeForNotification(data: unknown): PushRoute | null {
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  const draftId = typeof payload.draftId === 'string' ? payload.draftId : undefined;

  switch (payload.type) {
    // MEAL-89: replace with the review-queue screen once it exists.
    case 'creator_draft':
      return { target: 'Creator', draftId };
    case 'meal':
      return { target: 'MyMeals' };
    case 'broadcast':
      return { target: 'Discover' };
    default:
      // An unknown type is a newer server than this build. Opening the app on
      // its normal first screen is right; guessing is not.
      return null;
  }
}
