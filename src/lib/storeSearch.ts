// Finding a store in a list of forty (MEAL-229).
//
// The picker is alphabetical, which is right, and was the wrong SHAPE for its
// length: reaching Wegmans took 18 scrolls, past Acme, Baker's, Balducci's,
// Carrs and City Market before anything most people recognise.
//
// Three things a query has to survive, all of them from real store names:
//
//   • PUNCTUATION. "heb" must find "H-E-B", "jewel" must find "Jewel-Osco",
//     "picknsave" must find "Pick 'n Save". Comparing raw strings answers no to
//     all three, so every comparison also runs on a form with the punctuation
//     taken out of BOTH sides.
//   • SPACES. "fred meyer" is two words to a person and one token to that
//     stripped form, so the raw lowercase comparison is kept alongside it.
//   • FAMILY. "Kroger" must surface Ralphs, and "Albertsons" must surface Tom
//     Thumb -- see STORE_SEARCH_ALIASES for where that comes from and why it is
//     not read from the server.
//
// Substring, not fuzzy. A typo tolerance that matches "Vons" for "vans" also
// matches things nobody asked for, and in a picker that writes a store id onto
// a saved meal, a wrong-but-plausible row is worse than no row.

import { Store, STORE_SEARCH_ALIASES } from '../constants/stores';

/** Lowercased with everything that is not a letter or digit removed. */
function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Does this store answer to this query? Empty query matches everything. */
export function storeMatchesQuery(store: Store, query: string): boolean {
  const raw = query.trim().toLowerCase();
  if (raw === '') return true;
  const squashed = squash(query);
  if (squashed === '') return true;

  if (store.name.toLowerCase().includes(raw)) return true;
  if (squash(store.name).includes(squashed)) return true;

  for (const alias of STORE_SEARCH_ALIASES[store.id] ?? []) {
    if (alias.toLowerCase().includes(raw)) return true;
    if (squash(alias).includes(squashed)) return true;
  }
  return false;
}

/** The stores matching a query, in the order they were given. */
export function filterStores(stores: Store[], query: string): Store[] {
  const raw = query.trim();
  if (raw === '') return stores;
  return stores.filter((s) => storeMatchesQuery(s, query));
}
