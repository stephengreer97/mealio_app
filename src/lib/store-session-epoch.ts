// WHAT "SIGN OUT OF ALL GROCERY STORES" CANNOT REACH.
//
// The button clears the cookie jar, and for a cookie-borne session that is a
// real sign-out: Instacart's session is HttpOnly (39 cookie names on ALDI, not
// one of them an auth token visible to document.cookie) and the rail calls
// same-origin /graphql, so a cleared jar leaves nothing to present.
//
// COOKIES AND localStorage ARE DIFFERENT STORES, though, and the rail keeps
// three caches in the second one:
//
//   ops   the storefront's persisted-query hashes  -- public, harmless
//   shop  WHICH ALDI BRANCH the user shops         -- learned while signed in
//   zone  their delivery zone                      -- learned while signed in
//
// The last two describe the account, and they outlive the sign-out that was
// supposed to end it. Stephen's captures showed the consequence: shopFrom
// "cache" with the same shop id 8583 across a sign-out, so a run after the
// button was still pointed at the branch the signed-in session had chosen.
//
// WHY AN EPOCH RATHER THAN A DELETE. Deleting them means being inside the
// WebView, and at sign-out there is no WebView open -- we would have to load
// each store origin in a hidden one purely to call removeItem, which is a page
// load per store, on a network, to clear two strings.
//
// So the key carries a generation instead. Sign-out bumps the number, every
// cache key changes with it, and every entry written under the old number is
// orphaned the instant the button is pressed -- no WebView, no page load, no
// network. The orphans are two small strings per store that the browser evicts
// on its own; the shop id has a freshness stamp and was never read past it.
//
// Per device and per install, like the first-run flags, and for the same
// reason: it is a fact about this app's storage, not about an account.

// PURE ON PURPOSE: no native module, no import of one.
//
// The rail's script builders import this to stamp their cache keys, and the
// unit-test project runs those builders under plain node. Importing
// expo-secure-store here dragged an untransformed ESM module into that graph
// and twelve suites stopped parsing. The persistence lives next door in
// store-session-epoch-storage.ts, which the app wires up at startup; this file
// only ever holds the number and the key it produces.

const EPOCH_KEY = 'mealio.storeSession.epoch';

/** Where the generation is persisted. Read by the storage module. */
export const EPOCH_STORAGE_KEY = EPOCH_KEY;

/**
 * The current generation, read synchronously.
 *
 * The script builders are synchronous -- they are called to produce a string to
 * inject, in the middle of a run -- so the epoch has to be readable without an
 * await. The storage module writes it through at startup and on sign-out.
 */
let cached = 0;

/** The generation to build cache keys with. Zero until it has been loaded. */
export function currentEpoch(): number {
  return cached;
}

/**
 * A cache key stamped with the current generation.
 *
 * Everything the rail stores in a store's localStorage goes through this, so a
 * bump orphans all of it at once rather than each cache needing to opt in.
 *
 * Generation zero emits the ORIGINAL key, so shipping this does not orphan
 * every existing install's caches on upgrade.
 */
export function epochKey(base: string): string {
  return cached === 0 ? base : base + '_g' + cached;
}

/** Set the in-memory generation. The storage module owns when this happens. */
export function setEpoch(n: number): void {
  cached = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Back to generation zero. Tests, and the storage module's reset. */
export function resetEpochValue(): void {
  cached = 0;
}
