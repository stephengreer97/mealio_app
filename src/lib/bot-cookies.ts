import CookieManager from '@react-native-cookies/cookies';

/**
 * CLEAR THE BOT-PROTECTION TOKEN, AND NOTHING ELSE.
 *
 * Stephen, 2026-09-11, after H-E-B answered 403 for 35 minutes: "don't we have a
 * way of clearing imperva cookie? Let's do that now."
 *
 * We did not. The only tool was "Sign out of my stores", which calls
 * clearAll() -- that unsticks the wall by throwing away the login with it, which
 * is a cure the user pays for in a sign-in at every store.
 *
 * WHAT WENT WRONG AND WHY THIS IS THE RIGHT SHAPE OF FIX.
 *
 * Imperva protects www.heb.com/graphql at a higher tier than its HTML. MEASURED
 * from a laptop on the same network, 2026-09-11:
 *
 *   GET  /            no cookies                      200
 *   POST /graphql     no cookies                      403, Incapsula challenge
 *   POST /graphql     with incap_ses + visid_incap    403, still
 *
 * So the ordinary session cookies are not the gate. The gate is a token minted
 * by running Imperva's JavaScript challenge in a real browser, and it is scored
 * against the client that minted it. On Android our native fetch SHARES the
 * WebView's jar, which is the whole reason native works at all -- and it means a
 * native request replays a browser's token over a non-browser TLS stack. One
 * session presenting two clients is the exact signature Imperva exists to catch,
 * and a burned token is in the shared jar, so the WebView inherits the block.
 *
 * Expiring just those cookies lets the next page load mint a fresh one. The
 * store login is a different cookie and is deliberately left alone.
 *
 * ANDROID HAS NO DELETE. CookieManager.clearByName is iOS only, so a cookie is
 * removed the way a server removes one: written again with an expiry in the
 * past. Same mechanism, and it works on both platforms.
 */

/**
 * The token names, by vendor.
 *
 * Prefixes rather than exact names because three of the four carry a site id in
 * the name (incap_ses_1318_2302070). Matched case-insensitively on the prefix,
 * which is how these are documented and how they appear in a real jar.
 *
 * NOT A STORE LIST. Every name here belongs to a WAF vendor, not to a grocer,
 * which is why this file can hold it -- the same four names would need clearing
 * on any site behind the same vendor.
 */
const BOT_COOKIE_PREFIXES: readonly string[] = [
  // Imperva / Incapsula. reese84 is the advanced bot token, the one that is
  // scored against the client; the other three are the session and load
  // balancer pair that ride with it.
  'reese84',
  'incap_ses_',
  'visid_incap_',
  'nlbi_',
  // Imperva ADVANCED Bot Protection, which is the old Distil Networks product
  // and a SEPARATE tier from the reese84 stack above. Missing it is what made
  // the first sweep look like it had ruled the cookie out: H-E-B's jar was
  // cleared of all three Incapsula names, re-minted a fresh reese84 on the next
  // page load, and answered 403 exactly as before -- while _iidt sat there
  // untouched the whole time.
  '_iidt',
  '_vid_t',
  '___utmvc',
  // Akamai Bot Manager. Same story, different vendor: _abck is the token and
  // bm_sz is its session. Listed because the next store to wall us is as likely
  // to be behind this one, and finding that out at 403 time is the expensive way.
  '_abck',
  'bm_sz',
  'bm_sv',
  'ak_bmsc',
];

export function isBotCookieName(name: string): boolean {
  const n = String(name || '').toLowerCase();
  return BOT_COOKIE_PREFIXES.some((p) => n.startsWith(p));
}

export type BotCookieSweep = {
  origin: string;
  /** Names found and expired. Names only, never values: a token IS the session. */
  cleared: string[];
  /** Every cookie name the jar held, for telling "none there" from "none matched". */
  saw: string[];
  error?: string;
};

/**
 * Expire the bot-protection cookies on one origin.
 *
 * Returns what it touched rather than throwing, because the caller is usually
 * sweeping several origins and one unreadable jar must not end the sweep.
 */
export async function clearBotCookies(origin: string): Promise<BotCookieSweep> {
  const out: BotCookieSweep = { origin, cleared: [], saw: [] };
  let jar: Record<string, { name?: string; domain?: string; path?: string }> = {};
  try {
    jar = await CookieManager.get(origin, true);
  } catch (e) {
    out.error = String(e).slice(0, 120);
    return out;
  }
  const host = hostOf(origin);
  for (const key of Object.keys(jar)) {
    const name = jar[key]?.name || key;
    out.saw.push(name);
    if (!isBotCookieName(name)) continue;
    // THE DOMAIN IS THE PART THAT DECIDES WHETHER THIS WORKS. A cookie set on
    // .heb.com is a different cookie from one set on www.heb.com, and writing
    // the expiry against the wrong one leaves the original in place and adds a
    // second, already-dead entry. The jar tells us which it was; the host is the
    // fallback for a platform that does not report it.
    const domain = jar[key]?.domain || host;
    try {
      await CookieManager.set(origin, {
        name,
        value: '',
        domain,
        path: jar[key]?.path || '/',
        // 1970. Any past date removes it; this one is unmistakable in a log.
        expires: '1970-01-01T00:00:00.000Z',
      }, true);
      out.cleared.push(name);
    } catch {
      // Left in `saw` and out of `cleared`, which is the honest report: a name
      // we found and could not remove.
    }
  }
  try { await CookieManager.flush(); } catch { /* iOS has no flush */ }
  return out;
}

/** Sweep several origins. One bad jar does not end the sweep. */
export async function clearBotCookiesFor(origins: readonly string[]): Promise<BotCookieSweep[]> {
  const out: BotCookieSweep[] = [];
  for (const o of origins) out.push(await clearBotCookies(o));
  return out;
}

function hostOf(origin: string): string {
  return String(origin).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}
