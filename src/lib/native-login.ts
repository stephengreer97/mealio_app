import CookieManager from '@react-native-cookies/cookies';
import { capabilityFor, webViewInevitable } from './store-capabilities';
import { getStoreWebViewUA } from './webview-user-agent';
import { nativeRailFor } from './native-rail';
import { NativeRail, NativeSession } from './native-rail/types';
import { getStoreScripts } from './webview-scripts';

/**
 * IS THIS USER SIGNED IN, ASKED AS CHEAPLY AS THE STORE ALLOWS.
 *
 * Stephen, 2026-09-11: "Don't spawn webviews if we don't have to." This is the
 * question that decides, and for three of the five stores it now costs one
 * request instead of an 8,499ms Chromium renderer.
 *
 * THREE ANSWERS, AND THE MIDDLE ONE IS THE POINT:
 *
 *   'in' / 'out'   settled, natively, in ~400ms
 *   'needs-webview' this store cannot be asked over HTTP, and the honest thing
 *                   is to say so rather than guess
 *
 * NOTHING HERE IS CACHED, and that is a deliberate reversal of how the prewarm
 * works today. A cached verdict is only worth having when asking is expensive,
 * and asking has stopped being expensive. The cache was also the source of a
 * whole family of bugs: the stale answer that showed Stephen a sign-in screen
 * while he was signed in, and the 6.2s storefront load spent re-learning what
 * the previous run had already proven. At 400ms you simply ask again at the
 * moment the answer matters, and every staleness window closes on its own.
 *
 * The one thing that IS remembered is a negative so cheap it needs no request.
 */

export type LoginVerdict = {
  state: 'in' | 'out' | 'needs-webview';
  /** How it was decided, for the log and for anyone debugging a wrong answer. */
  how: string;
  ms: number;
  /** Identifiers the run can reuse, when the check produced them. */
  session?: NativeSession;
};

/** The origin whose cookies this store's session lives in. */
function originFor(storeId: string, rail: NativeRail | null): string | null {
  if (rail) return rail.origin;
  const scripts = getStoreScripts(storeId);
  return scripts?.storeUrl ?? null;
}

/**
 * AN EMPTY JAR IS PROOF, AND A FULL ONE IS NOT.
 *
 * This is the only free answer in the whole model and it only points one way.
 * No cookies for an origin means the user has never had a session there, so
 * "signed out" is certain without spending a request. Cookies being PRESENT
 * says nothing at all -- they could be analytics, consent banners, or a session
 * that expired an hour ago -- which is exactly the trap the first native probe
 * fell into when it read 31 cookies and concluded nothing useful.
 */
async function jarIsEmpty(origin: string): Promise<boolean> {
  try {
    const jar = await CookieManager.get(origin, true);
    return Object.keys(jar).length === 0;
  } catch {
    // An unreadable jar is not an empty one. Fall through and ask properly.
    return false;
  }
}

/**
 * Ask the store. Cheap where the store allows it, honest where it does not.
 *
 * Never throws: a check that dies takes the run's decision with it, and the
 * caller can do something sensible with 'needs-webview' but nothing at all with
 * an exception.
 */
export async function checkLogin(storeId: string): Promise<LoginVerdict> {
  const t0 = Date.now();
  const done = (v: Omit<LoginVerdict, 'ms'>): LoginVerdict => ({ ...v, ms: Date.now() - t0 });

  const cap = capabilityFor(storeId);
  const rail = cap.nativeLogin ? nativeRailFor(storeId) : null;
  const origin = originFor(storeId, rail);

  // THE FREE NEGATIVE COMES FIRST, and it applies even to stores that need a
  // renderer. Wegmans with an empty jar is signed out, and knowing that without
  // building a Chromium process is the whole point -- it turns "open a WebView
  // to find out" into "open a WebView to sign in", which is a thing the user
  // asked for rather than a thing they waited through.
  if (origin && await jarIsEmpty(origin)) {
    return done({ state: 'out', how: 'no cookies for this origin: never signed in here' });
  }

  if (!cap.nativeLogin || !rail) {
    return done({
      state: 'needs-webview',
      how: webViewInevitable(storeId)
        ? 'this store needs a renderer for the run anyway, so the check rides along in it'
        : cap.why,
    });
  }

  try {
    const out = await rail.session(getStoreWebViewUA());
    if (!out.ok) {
      // A PROBE THAT CANNOT ANSWER IS NOT A SIGNED-OUT USER. Reporting 'out'
      // here would send a signed-in user to a login screen, which is the exact
      // complaint this whole model is meant to remove.
      return done({ state: 'needs-webview', how: `native check inconclusive: ${out.detail}` });
    }
    return done({
      state: out.session?.loggedIn ? 'in' : 'out',
      how: `native: ${out.detail}`,
      session: out.session,
    });
  } catch (e) {
    return done({ state: 'needs-webview', how: `native check threw: ${String(e).slice(0, 100)}` });
  }
}

/**
 * Is it worth asking at all right now?
 *
 * At app open and on a store tab tap the answer is only worth having when it is
 * cheap OR when it is free. For a store whose run needs a renderer regardless,
 * asking early buys nothing -- the WebView is coming either way and the check
 * can happen inside it -- so the launch path skips it and stays silent.
 */
export function worthCheckingEagerly(storeId: string): boolean {
  return capabilityFor(storeId).nativeLogin || !webViewInevitable(storeId);
}
