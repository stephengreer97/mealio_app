// The account's store, shared by every screen that saves or lists meals.
//
// One store per account (mealio_central lib/default-store.ts): every meal lives
// there and every cart runs there. My Meals changes it; the save sheets read it
// so a save goes straight there and only an account with none yet is asked.
//
// Cached for the session and cleared on sign-out, so the save sheets do not
// each cost a request. `refreshDefaultStore` is the way to re-read it.

import { useEffect, useState } from 'react';
import { account } from './api';

let cached: string | null | undefined;
const listeners = new Set<(store: string | null) => void>();

function publish(store: string | null) {
  cached = store;
  for (const listener of listeners) listener(store);
}

/** The account's store, from the cache when it has been read this session. */
export async function getDefaultStore(): Promise<string | null> {
  if (cached !== undefined) return cached;
  return refreshDefaultStore();
}

export async function refreshDefaultStore(): Promise<string | null> {
  try {
    const store = await account.getDefaultStore();
    publish(store);
    return store;
  } catch {
    return cached ?? null;
  }
}

/** Records a store the server has just confirmed (a switch, or a first save). */
export function rememberDefaultStore(store: string | null) {
  publish(store);
}

/** Forgets the cached store, so the next account to sign in reads its own. */
export function clearDefaultStore() {
  cached = undefined;
}

/** The account's store, re-rendering when it changes. Undefined while loading. */
export function useDefaultStore(): string | null | undefined {
  const [store, setStore] = useState<string | null | undefined>(cached);
  useEffect(() => {
    listeners.add(setStore);
    if (cached === undefined) void refreshDefaultStore();
    else setStore(cached);
    return () => { listeners.delete(setStore); };
  }, []);
  return store;
}
