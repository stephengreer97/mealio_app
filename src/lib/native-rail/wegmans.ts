import { NativeCandidate, NativeRail, timed } from './types';

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

  session: () => timed(async () => ({
    ...BLOCKED_LOCALSTORAGE,
    detail: 'blocked: MSAL keeps the account list in the site\'s localStorage, not in any response',
  })),

  cartRead: () => timed(async () => ({ ...BLOCKED_LOCALSTORAGE })),

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
    const r = await fetch(url, {
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
