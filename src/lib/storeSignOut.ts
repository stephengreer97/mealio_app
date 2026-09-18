import CookieManager from '@react-native-cookies/cookies';
import { bumpEpoch } from './store-session-epoch-storage';

/**
 * Sign this DEVICE out of every grocery store.
 *
 * ONE FUNCTION, called from both places a store sign-out happens: the
 * "Sign out of my stores" button in Account, and signing out of Mealio itself
 * (Stephen's call: signing out of Mealio signs you out of your stores too, so a
 * shared phone does not hand the next person the last person's store logins).
 * A second copy is how the two drift apart, which is exactly what happened: the
 * button learned about the epoch and the prewarm, and logout never did.
 *
 * What it covers:
 *   - the WebView cookie jar, incl. HttpOnly store auth cookies. Both true and
 *     false, to cover iOS WKWebView and the shared NSHTTPCookieStorage; the arg
 *     is ignored on Android.
 *   - the rail caches in each store page's localStorage, which survive the jar
 *     being cleared, by bumping the generation their keys carry
 *     (store-session-epoch.ts).
 *
 * What the caller still owns:
 *   - `forgetPrewarm`: the prewarm's memory of what the cookies used to say.
 *     It lives in a React provider, so it cannot be reached from here. On a
 *     Mealio sign-out or account switch the provider forgets on its own
 *     (useSessionEnd); the button, where the account does not change, passes it.
 *   - Kroger, which is a server-side OAuth link on the MEALIO ACCOUNT rather
 *     than device state. The button disconnects it; a Mealio sign-out leaves
 *     it, since the link is unreachable without the account and disconnecting
 *     it would sign the user's other devices out of Kroger too.
 *
 * Throws if the cookie jar cannot be cleared. Callers that must not be blocked
 * by that (signing out of Mealio) catch it.
 */
export async function signOutOfStoresOnDevice(opts: { forgetPrewarm?: () => void } = {}): Promise<void> {
  try {
    await CookieManager.clearAll(true);
    await CookieManager.clearAll(false);
  } finally {
    // Neither of these may be skipped because the jar threw: the prewarm would
    // go on reporting a login that may be gone, and the rail caches would stay
    // pointed at the signed-in session's shop.
    opts.forgetPrewarm?.();
    await bumpEpoch();
  }
}
