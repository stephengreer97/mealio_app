// MEAL-7. What the last run put in a store's cart, so the canary's cleanup can
// remove exactly that.
//
// WHY IT IS PERSISTED RATHER THAN PASSED. The cleanup is driven through the UI
// -- a tap on a dev control -- and a tap carries no arguments. The run is the
// only thing that knows which lines it added (diffCartItems computes the
// before/after delta to colour the done screen's green rows), so it writes them
// down and the clear probe reads them back.
//
// This matters because the alternative is an unscoped clear. The canary runs
// against a real account whose cart holds real shopping, and "empty the cart to
// tidy up after a test" deletes someone's groceries.
//
// expo-secure-store, because it is the only key-value storage this app already
// depends on -- the same reasoning as store-session-epoch-storage. Nothing here
// is secret; the keychain is just the store that exists.

import * as SecureStore from 'expo-secure-store';

const KEY = 'canary_added_ids_v1';

type Bag = Record<string, string[]>;

async function read(): Promise<Bag> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Bag) : {};
  } catch {
    return {};
  }
}

/**
 * Add to what this store's cleanup owns.
 *
 * ACCUMULATES rather than replaces: a canary does three windows against one
 * store, and adds land on top (2026-09-01), so each window contributes lines the
 * cleanup is responsible for. Replacing would strand the first two windows'
 * items in the cart.
 */
export async function rememberAddedIds(storeId: string, ids: string[]): Promise<void> {
  if (!storeId || !ids.length) return;
  try {
    const bag = await read();
    const merged = new Set([...(bag[storeId] ?? []), ...ids.map(String)]);
    bag[storeId] = [...merged];
    await SecureStore.setItemAsync(KEY, JSON.stringify(bag));
  } catch { /* a cleanup hint is never worth failing a run over */ }
}

/** What this store's cleanup should remove. Empty means "nothing known". */
export async function takeAddedIds(storeId: string): Promise<string[]> {
  const bag = await read();
  return bag[storeId] ?? [];
}

/** Forget a store's list, once its cleanup has actually run. */
export async function clearAddedIds(storeId: string): Promise<void> {
  try {
    const bag = await read();
    delete bag[storeId];
    await SecureStore.setItemAsync(KEY, JSON.stringify(bag));
  } catch { /* as above */ }
}
