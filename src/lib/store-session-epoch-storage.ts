// Persisting the sign-out generation. Split from store-session-epoch.ts so the
// rail's script builders can stamp their keys without importing a native
// module -- see the note there.
//
// expo-secure-store, because it is the only key-value storage this app already
// depends on and adding AsyncStorage would mean a new native module and a new
// EAS build for one integer. Nothing here is secret; the keychain is just the
// store that exists.

import * as SecureStore from 'expo-secure-store';
import { EPOCH_STORAGE_KEY, currentEpoch, setEpoch, resetEpochValue } from './store-session-epoch';

/**
 * Read the stored generation into memory. Call once at startup, before any run
 * can build a script.
 *
 * A storage failure reads as generation zero, which is the pre-existing key.
 * That is the safe direction: the worst case is a stale shop id, which the
 * session probe already drops on a 401, and inventing a new generation because
 * the keychain hiccuped would silently discard every store's cache on a device
 * with nothing wrong with it.
 */
export async function loadEpoch(): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(EPOCH_STORAGE_KEY);
    setEpoch(raw == null ? 0 : Number.parseInt(raw, 10));
  } catch {
    setEpoch(0);
  }
  return currentEpoch();
}

/**
 * Start a new generation, orphaning every rail cache in every store's
 * localStorage. Called by "sign out of all grocery stores".
 *
 * The in-memory value advances even when the write fails, so the sign-out the
 * user just asked for takes effect for THIS session regardless. A failed write
 * means it does not survive a restart, which is a smaller wrong than ignoring
 * the button.
 */
export async function bumpEpoch(): Promise<number> {
  setEpoch(currentEpoch() + 1);
  try {
    await SecureStore.setItemAsync(EPOCH_STORAGE_KEY, String(currentEpoch()));
  } catch {
    // Kept in memory; see above.
  }
  return currentEpoch();
}

/** Reset to generation zero, in memory and in storage. Tests only. */
export async function resetEpoch(): Promise<void> {
  resetEpochValue();
  try {
    await SecureStore.deleteItemAsync(EPOCH_STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}
