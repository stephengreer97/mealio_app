import { ALBERTSONS_BANNERS } from './native-rail';

/**
 * WHAT EACH STORE CAN BE ASKED WITHOUT A CHROMIUM RENDERER.
 *
 * Stephen, 2026-09-11, on the goal: "faster overall automation. Same
 * reliability. Don't spawn webviews if we don't have to and keep prewarm
 * working as well."
 *
 * Everything in that decision reduces to TWO INDEPENDENT FACTS per store, and
 * they are independent on purpose: a store can answer the login question over
 * plain HTTP and still need a WebView to run, or the reverse.
 *
 *   login   can "is this user signed in" be answered with fetch alone?
 *   run     can search, cart read and add be done with fetch alone?
 *
 * THE LINE IS NOT BOT DETECTION. It is where the store keeps its credential.
 * A cookie-authenticated store goes native cleanly, because on Android RN's
 * fetch shares the WebView's cookie jar. A store that authenticates from a
 * credential IT wrote into ITS OWN localStorage cannot, ever, because native
 * code has no access to another origin's storage. That is Wegmans and Walmart,
 * and no amount of engineering moves them.
 *
 * MEASURED ON STEPHEN'S PIXEL, 2026-09-11. Every `proven` below means a request
 * that answered on the device, not a reading of the rail's source.
 */

export type StoreCapability = {
  /** Login answerable over plain HTTP, no renderer. */
  nativeLogin: boolean;
  /** Search, cart read and add answerable over plain HTTP. */
  nativeRun: boolean;
  /**
   * Has anyone actually measured this store, either way?
   *
   * UNMEASURED IS NOT THE SAME AS BLOCKED, and conflating them cost ten tests.
   * Both look like "needs a WebView", but they justify opposite behaviour: a
   * store MEASURED to need a renderer for its run can safely defer its login
   * check, because the renderer is coming anyway. A store nobody has measured
   * must keep doing exactly what it did before -- which is to probe. Treating
   * the two alike silently switched prewarm off for every banner not named in
   * this file.
   */
  measured: boolean;
  /**
   * Why, in one line, and specific enough to argue with. A capability nobody
   * can trace back to a measurement is one nobody can safely change.
   */
  why: string;
};

/**
 * The default for a store nobody has measured: assume it needs the WebView.
 *
 * FALSE IS THE SAFE DIRECTION, and it is the only safe direction. Claiming
 * native falsely means a run that silently fails; claiming WebView falsely
 * means a run that is merely slower. A new banner plumbed into the catalogue
 * gets the old path until someone proves otherwise.
 */
const UNMEASURED: StoreCapability = {
  nativeLogin: false,
  nativeRun: false,
  measured: false,
  why: 'not measured: keeps the WebView path it has always had',
};

const CAPABILITIES: Record<string, StoreCapability> = {
  heb: {
    measured: true,
    nativeLogin: true,
    nativeRun: true,
    why: 'proven 2026-09-11: login 398ms, cart read 308ms (32 lines/126 items, '
      + 'matching the rail), search 319ms, add 438ms with the write verified by re-reading the cart',
  },
  aldi: {
    measured: true,
    nativeLogin: true,
    nativeRun: true,
    why: 'proven 2026-09-11: login 638ms (CurrentUser + ActiveCarts), cart read, search and add all '
      + 'answered; sessionNeedsStorefront is NOT a renderer dependency -- the op hashes ship in the '
      + 'app and shop/zone come from /store/aldi/search_v3/zz in 784ms',
  },

  // THE ALBERTSONS FAMILY SHARES A RAIL AND A VERDICT. Measured on Tom Thumb,
  // which is the banner Stephen's session is on; the others are the same
  // codebase behind the same gateway, which is why they share the entry rather
  // than each claiming a measurement nobody took.
  //
  // nativeRun is FALSE, and deliberately so. Login and cart read are proven
  // (27 lines, 91 items), but search answered once in 1016ms and then timed out
  // on every run after, at 12s and at 20s. One good sample against several bad
  // ones is not a capability. Turning this on would trade reliability for speed,
  // which is the one trade the goal forbids.
  tom_thumb: {
    measured: true,
    nativeLogin: true,
    nativeRun: false,
    why: 'login proven 2026-09-11 (372ms, store 2574) and cart read proven (27 lines, 91 items); '
      + 'search UNRESOLVED -- answered once in 1016ms then timed out at 12s and 20s, so the run '
      + 'stays on the WebView until that settles',
  },

  wegmans: {
    measured: true,
    nativeLogin: false,
    nativeRun: false,
    why: 'MEASURED blocked 2026-09-11: the commerce API answers a cookie-only request with a plain '
      + '401 unauthorized, and it is on a different registrable domain from the shop origin so shop '
      + 'cookies never reach it. The bearer is encrypted in the site\'s own localStorage, which '
      + 'needs storage native code cannot read and WebCrypto React Native does not have',
  },

  walmart: {
    measured: true,
    nativeLogin: false,
    nativeRun: false,
    why: 'login is localStorage only (glassCartIdMap.isGuest) with no request to make, and Stephen '
      + 'has paused it in favour of walmart.io on his own bot-detection history',
  },
};

/**
 * THE ALBERTSONS FAMILY SHARES ONE RAIL AND THEREFORE ONE CAPABILITY.
 *
 * Fifteen banners run the same storefront platform behind the same gateway, and
 * the native rail already switches host and banner per store. Naming only
 * tom_thumb here -- the banner that was measured -- left the other fourteen as
 * UNMEASURED, which silently took their login prewarm away.
 */
const ALBERTSONS_SHARED: StoreCapability = { ...CAPABILITIES.tom_thumb };
for (const id of ALBERTSONS_BANNERS) CAPABILITIES[id] = ALBERTSONS_SHARED;

/** What this store can be asked natively. Unmeasured stores get the safe answer. */
export function capabilityFor(storeId: string | null | undefined): StoreCapability {
  if (!storeId) return UNMEASURED;
  return CAPABILITIES[storeId] ?? UNMEASURED;
}

/**
 * Does answering "is this user signed in" cost a renderer?
 *
 * The question the app open path asks, and the reason it can do almost nothing
 * at launch: for a store where this is false, the answer is a 400ms request, and
 * for a store where it is true the answer can WAIT until the user picks that
 * store. Spawning a renderer at launch to answer a question nobody has asked is
 * the cost this whole model exists to remove.
 */
export function loginNeedsWebView(storeId: string | null | undefined): boolean {
  return !capabilityFor(storeId).nativeLogin;
}

/** Does the RUN need a renderer, whatever the login answer turns out to be? */
export function runNeedsWebView(storeId: string | null | undefined): boolean {
  return !capabilityFor(storeId).nativeRun;
}

/**
 * Is a renderer inevitable for this store regardless of the login answer?
 *
 * When it is, pre-answering the login question buys nothing: the WebView is
 * being built either way, and the check can ride along inside it. That is what
 * keeps Wegmans from costing anything at launch.
 *
 * ONLY TRUE FOR A STORE SOMEBODY MEASURED. An unmeasured store also cannot be
 * asked natively, but that is ignorance rather than a finding, and it must not
 * be used to skip work the store has always done.
 */
export function webViewInevitable(storeId: string | null | undefined): boolean {
  const c = capabilityFor(storeId);
  return c.measured && !c.nativeLogin && !c.nativeRun;
}
