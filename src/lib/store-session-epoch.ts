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

/**
 * JS that deletes any PREVIOUS generation of the given cache keys.
 *
 * Stamping the key orphans the old entry, which is enough for a stale shop id:
 * nothing can read it, and the browser evicts it eventually. It is NOT enough
 * for a credential. The Wegmans rail caches a bearer token and a refresh token
 * in the store page's localStorage, and a refresh token can mint fresh access
 * tokens for as long as it lives -- so leaving one on disk after the user asked
 * to be signed out is the wrong shape of "handled", however unreadable it is to
 * our own code.
 *
 * Deleting needs a page, and at sign-out there is no WebView open. So the
 * deletion happens at the first moment there IS one: the rail's own scripts run
 * this in their prelude, on the store's origin, where localStorage is reachable.
 * A user who signs out and never returns to that store leaves an orphan behind;
 * a user who returns has it removed before anything else runs.
 *
 * Emitted as a string rather than executed here because it has to run INSIDE
 * the WebView -- this module has no access to the page's localStorage.
 */
export function sweepOldGenerationsJs(bases: string[]): string {
  const keep = JSON.stringify(bases.map((b) => epochKey(b)));
  const all = JSON.stringify(bases);
  return `(function () {
  try {
    var keep = ${keep}, bases = ${all};
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      if (!k || keep.indexOf(k) !== -1) continue;
      for (var b = 0; b < bases.length; b++) {
        if (k === bases[b] || k.indexOf(bases[b] + '_g') === 0) { localStorage.removeItem(k); break; }
      }
    }
  } catch (e) {}
})();`;
}
