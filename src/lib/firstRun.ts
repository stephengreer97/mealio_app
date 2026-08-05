// First-run flags: "has this device been shown X yet?".
//
// expo-secure-store, because it is the only key-value storage this app already
// depends on — tokens, the push opt-out, the review-queue cursor and the
// automation-config cache all live there, and adding AsyncStorage would mean a
// new native module and a new EAS build for two booleans. Nothing here is
// secret; the keychain is just the store that exists.
//
// The flags are per-device and per-install, not per-account. First run means the
// first time this person is put in front of the thing, and signing out and back
// in is not a new first time. They survive app restarts (that is the whole
// point) and are cleared by uninstalling — on Android the keychain entry goes
// with the app; on iOS a keychain item can outlive a reinstall, so a reinstalled
// app may still consider itself seen. `resetFirstRun()` is the deliberate way
// back, and is what the tests use.

import * as SecureStore from 'expo-secure-store';

/**
 * The pitch — what Mealio does — shown once on Discover, the app's front door
 * for signed-in and signed-out users alike.
 */
export const FIRST_RUN_WELCOME = 'mealio.firstRun.welcome';

/**
 * The Choose Products explainer, shown once immediately before the first run of
 * that flow. Separate from the welcome flag on purpose: someone can meet the
 * app weeks before they ever save a meal at a store, and the explanation has to
 * arrive next to the thing it explains.
 */
export const FIRST_RUN_CHOOSE_PRODUCTS = 'mealio.firstRun.chooseProducts';

const ALL_KEYS = [FIRST_RUN_WELCOME, FIRST_RUN_CHOOSE_PRODUCTS];

/**
 * Has this device already been shown `key`?
 *
 * A storage failure reads as "yes, already seen". Everything gated on this is
 * an interruption, and the safe answer to "I cannot tell" is to not interrupt:
 * a broken keychain must never turn a one-time explainer into one that shows on
 * every launch.
 */
export async function hasSeen(key: string): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(key)) != null;
  } catch {
    return true;
  }
}

/** Record that `key` has been shown. Best-effort; a failure is not worth an error. */
export async function markSeen(key: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, '1');
  } catch {
    // Worst case the explainer shows once more. Not worth interrupting anyone.
  }
}

/** Clear every first-run flag, so the next launch is a first run again. */
export async function resetFirstRun(): Promise<void> {
  await Promise.all(
    ALL_KEYS.map((k) => SecureStore.deleteItemAsync(k).catch(() => {})),
  );
}
