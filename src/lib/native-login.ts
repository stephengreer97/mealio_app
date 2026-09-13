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
 * THE CHECK, SWAPPABLE UNDER TEST.
 *
 * Same shape as __applyAutomationConfigForTests elsewhere in this repo, and for
 * the same reason: the real implementation makes a network request, and a suite
 * about the PREWARM'S behaviour should not be deciding what a store answers.
 *
 * Without this the two prewarm suites hang rather than fail. They call
 * checkStore and assert on what happened; the real checker reaches for fetch,
 * which under jest neither succeeds nor fails quickly, so the probe that should
 * follow it never mounts inside the test's act() window. Ten tests went red on
 * exactly that, and the fix is a seam rather than a timeout nobody can see.
 */
let checker: (storeId: string) => Promise<LoginVerdict> = realCheckLogin;

/** Swap the checker. Tests only; production never calls this. */
export function __setLoginCheckerForTests(fn: (storeId: string) => Promise<LoginVerdict>): void {
  checker = fn;
}

/** Put the real one back. */
export function __resetLoginCheckerForTests(): void {
  checker = realCheckLogin;
}

/** Ask the store, through whatever checker is installed. */
export function checkLogin(storeId: string): Promise<LoginVerdict> {
  return checker(storeId);
}

/**
 * Ask the store. Cheap where the store allows it, honest where it does not.
 *
 * Never throws: a check that dies takes the run's decision with it, and the
 * caller can do something sensible with 'needs-webview' but nothing at all with
 * an exception.
 */
async function realCheckLogin(storeId: string): Promise<LoginVerdict> {
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
 * YES, FOR EVERY STORE, and that is a decision rather than a simplification.
 *
 * This used to skip a store whose run needs a renderer regardless, on the
 * reasoning that the WebView is coming either way so the check can ride along
 * inside it. True, and it misses where the time goes: riding along puts the
 * check on the CRITICAL PATH, between the user tapping and the run starting.
 *
 * MEASURED on Stephen's device 2026-09-12:
 *
 *   Wegmans, no verdict yet   tap -> run starts   8.1s
 *   Tom Thumb, no verdict yet tap -> run starts   8.2s
 *   Wegmans, verdict already  tap -> DONE         4.3s, check skipped entirely
 *
 * The eight seconds are not the renderer. They are the store's own boot -- an
 * SSO redirect on the Albertsons family, an MSAL token refresh on Wegmans --
 * and it has to happen somewhere. Early, it happens while the user is picking
 * meals; late, they watch it.
 *
 * THE RENDERER IS NOT PURELY A NEW COST EITHER. Building the first Chromium
 * renderer in a process is what costs 8,499ms; the second is cheap. A probe
 * that pays it in the background is partly moving a cost the run would pay
 * anyway onto a moment where nobody is waiting.
 *
 * WHAT IT DOES COST is memory, one hidden renderer per store, and the honest
 * bound on that is: at most ONCE PER STORE PER SESSION. checkStore returns
 * early the moment a verdict exists, so this is not per tap.
 *
 * Stephen chose this trade on 2026-09-13, having been shown option A (leave it)
 * and option C (probe on meal selection instead of tab tap).
 */
export function worthCheckingEagerly(storeId: string): boolean {
  return !!storeId;
}
