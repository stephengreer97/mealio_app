// React binding for the store catalog.
//
// Kept out of ./index so that module stays React-free and importable by the pure
// node test project, the same separation ./store gets for expo-secure-store.

import { useSyncExternalStore } from 'react';
import { getStores, subscribeStores, Store } from './index';

/**
 * The live store list, re-rendering the caller when a remote catalog lands.
 *
 * getStores() alone would almost always be enough — the catalog arrives moments
 * after sign-in, and any later state change picks it up. "Almost always" is what
 * this hook is for: a screen mounted at the moment the fetch resolves would
 * otherwise show the bundled list until something unrelated happened to move.
 *
 * getStores() memoises its result, so the snapshot identity is stable between
 * catalog changes — which is what makes it a legal useSyncExternalStore snapshot
 * rather than an infinite re-render.
 */
export function useStores(): Store[] {
  return useSyncExternalStore(subscribeStores, getStores, getStores);
}
