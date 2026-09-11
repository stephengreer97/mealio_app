import { NativeCandidate, NativeRail, fetchWithTimeout, timed } from './types';

/**
 * Wegmans, natively, AND THE ONE STORE WHERE THE ANSWER IS MOSTLY NO.
 *
 * Its rail's own header lays out three parts with different certainties, and
 * moving to native fetch splits them cleanly along a line nobody chose:
 *
 *   search  FREE AND NATIVE. Algolia, with a search-only key that ships in the
 *           page's own request URLs. The rail measured "32,223 hits for sour
 *           cream in 26ms from a plain curl with no cookies". No session, so it
 *           works signed out and an expired token cannot break it. Nothing about
 *           it ever needed a WebView.
 *
 *   login   BLOCKED. MSAL keeps a plaintext account list in localStorage, and
 *           reading it costs no network at all -- which is exactly why native
 *           fetch cannot do it. It is not an HTTP question.
 *
 *   cart    BLOCKED, TWICE OVER. It needs a bearer, and MSAL keeps that
 *           ENCRYPTED in localStorage ({id, nonce, data} plus a
 *           msal.cache.encryption cookie), so reading it needs both that storage
 *           and WebCrypto's subtle.deriveKey -- React Native has neither. And
 *           the rail records that the commerce API "refuses the cookie session"
 *           outright, so there is no cookie-authenticated path to fall back to.
 *
 * add       Same bearer as cart. Same two blockers.
 *
 * So Wegmans is the store that keeps its WebView. This file implements the one
 * part that works rather than pretending the rest is close, because a probe that
 * reports four failures teaches less than one that reports which single thing
 * was never an HTTP problem in the first place.
 */

/**
 * TWO ASSUMPTIONS, NOW TESTED RATHER THAN INHERITED.
 *
 * Stephen, 2026-09-11: "are you 1000% sure about wegmans?" No, and the reason I
 * gave was partly wrong. The rail's note reads "the commerce API also refuses
 * the cookie session -- a no-cors request comes back opaque, so it is answered
 * and we are simply not allowed to read it." That is a CORS rule, and CORS is a
 * BROWSER rule. RN's fetch is not a browser and is not subject to it: the server
 * answered, and only the page was forbidden from looking. Native code can look.
 *
 * Reading further there is a stronger reason the cart is blocked, and it is not
 * CORS: COMMERCE_BASE is api.digitaldevelopment.wegmans.cloud, a different
 * registrable domain from shop.wegmans.com. Cookies set on the shop origin are
 * not sent there by ANY client. It is Bearer-authenticated.
 *
 * But "should not work" is not "was measured not to work", and the browser could
 * never observe this particular answer. So both assumptions get a probe:
 *
 *   1. Does shop.wegmans.com answer a cookie-authenticated "who am I"? The rail
 *      reads MSAL's localStorage because it is FREE and offline, not because
 *      anything else was tried and failed. Nobody has looked.
 *   2. Does the commerce API answer a cookie-only request? Cross-domain cookies
 *      say no. The browser could not see the answer either way.
 *
 * If either works, Wegmans stops needing a WebView.
 */
const COMMERCE_BASE = 'https://api.digitaldevelopment.wegmans.cloud';
const ALGOLIA_APP = 'QGPPR19V8V';
const ALGOLIA_KEY = '9a10b1401634e9a6e55161c3a60c200d';
const ORIGIN = 'https://shop.wegmans.com';

const BLOCKED_LOCALSTORAGE = {
  ok: false,
  status: null as number | null,
  detail: 'blocked: the token lives ENCRYPTED in the site\'s localStorage, which native fetch cannot read',
};

export const WEGMANS_NATIVE: NativeRail = {
  id: 'wegmans',
  label: 'Wegmans',
  origin: ORIGIN,

  /**
   * Probe 1: is there a cookie-authenticated identity endpoint on the SHOP
   * origin? Candidates are the shapes this site family uses; each reports its
   * own status so a 404 (wrong guess) and a 401 (right guess, no session) stay
   * different findings.
   */
  session: (ua) => timed(async () => {
    const candidates = [
      '/api/v2/user',
      '/api/user',
      '/api/v2/account',
      '/api/session',
      '/api/v2/customer',
    ];
    const seen: string[] = [];
    for (const path of candidates) {
      try {
        const r = await fetchWithTimeout(`${ORIGIN}${path}`, {
          credentials: 'include',
          headers: { 'User-Agent': ua, accept: 'application/json, text/plain, */*' },
        }, 6000);
        seen.push(`${path}:${r.status}`);
        if (r.status === 200) {
          const t = await r.text();
          let j: any = null;
          try { j = JSON.parse(t); } catch { /* HTML means it is a page, not an API */ }
          if (j && typeof j === 'object') {
            const keys = Object.keys(j).slice(0, 6).join(',');
            return {
              ok: true, status: 200,
              detail: `${path} answered JSON with cookies: keys ${keys}`,
              session: { loggedIn: true },
            };
          }
        }
      } catch (e) {
        seen.push(`${path}:threw`);
      }
    }
    return {
      ...BLOCKED_LOCALSTORAGE,
      detail: `no cookie-authenticated identity endpoint found. Tried ${seen.join(' ')}`,
    };
  }),

  /**
   * Probe 2: does the commerce API answer a cookie-only request?
   *
   * No Bearer, deliberately -- the point is whether the session alone is enough.
   * The browser asked this once in no-cors mode and could not read the reply;
   * native fetch reads whatever comes back, including the status the page never
   * saw.
   */
  cartRead: (ua) => timed(async () => {
    const url = `${COMMERCE_BASE}/commerce/account/customer?api-version=2024-03-06-preview`;
    const r = await fetchWithTimeout(url, {
      credentials: 'include',
      headers: { 'User-Agent': ua, accept: 'application/json, text/plain, */*' },
    }, 8000);
    const body = (await r.text()).slice(0, 120);
    if (r.status === 200) {
      return { ok: true, status: 200, detail: `commerce answered a COOKIE-ONLY request: ${body}` };
    }
    return {
      ok: false, status: r.status,
      detail: `commerce refused cookies alone: ${r.status}. ${body}`,
    };
  }),

  /**
   * The one that works, and it needs no session at all.
   *
   * Deliberately does not take the store number from the session, because there
   * is no session here to take it from. Unfiltered, so this measures whether
   * Algolia answers a React Native client -- which is the open question -- rather
   * than failing for want of a store id the login step could not produce.
   */
  search: (ua, _s, term) => timed(async () => {
    const url = `https://${ALGOLIA_APP.toLowerCase()}-dsn.algolia.net/1/indexes/products/query`
      + `?x-algolia-api-key=${ALGOLIA_KEY}&x-algolia-application-id=${ALGOLIA_APP}`;
    const r = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'User-Agent': ua },
      body: JSON.stringify({ query: term, hitsPerPage: 12 }),
    });
    if (r.status !== 200) return { ok: false, status: r.status, detail: `http ${r.status}` };
    const j = await r.json().catch(() => null);
    const hits: any[] = j?.hits || [];
    const candidates: NativeCandidate[] = hits.map((h) => ({
      productId: String(h.sku ?? h.objectID ?? ''),
      productName: String(h.name ?? ''),
      price: h.price != null ? String(h.price) : null,
    })).filter((c) => c.productId && c.productName);
    return {
      ok: true, status: r.status, candidates,
      detail: `${j?.nbHits ?? candidates.length} hits, no session used, first: ${candidates[0]?.productName?.slice(0, 36) ?? 'none'}`,
    };
  }),

  add: () => timed(async () => ({
    ...BLOCKED_LOCALSTORAGE,
    detail: 'blocked: needs the same encrypted MSAL bearer, and the commerce API refuses the cookie session',
    added: false,
  })),
};
