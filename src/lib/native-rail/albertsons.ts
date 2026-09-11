import CookieManager from '@react-native-cookies/cookies';
import { NativeCandidate, NativeRail, fetchWithTimeout, postJson, timed } from './types';
import { albertsonsHostFor } from '../webview-scripts/albertsons';

/**
 * The Albertsons family, natively. Tom Thumb, because that is the banner
 * Stephen's session is actually on -- albertsons.com and tomthumb.com are
 * separate origins with separate cookie jars, and the first native probe of this
 * family read the right answer for the wrong banner as a failure.
 *
 * THE BANNER IS DERIVED FROM THE HOST in the rail (__albBanner splits
 * window.location.hostname), which native fetch has no equivalent of -- so it is
 * a constant here. That is not a limitation: the run already knows which store
 * it locked, and reading it off the page was only ever the WebView's way of
 * finding out something the app already had.
 *
 * WHAT THIS NEEDS THAT LOGIN DOES NOT
 *   SWY_SHOP_TOKEN, customerId, branchId, zipcode  all from /userinfo
 *   an APIM subscription key                       regexed out of the homepage
 *
 * The key is the interesting one: the rail reads it from window.SWY.CONFIGSERVICE
 * when the page runtime happens to have it, and otherwise fetches '/' and pulls
 * 32-hex values out of the HTML. The second path is the real one, and it needs
 * no page -- exactly like Instacart's shop and zone.
 */

/**
 * EVERY BANNER, NOT JUST THE ONE THAT WAS MEASURED.
 *
 * Fifteen brands run the same storefront platform behind the same gateway, so
 * one rail serves all of them -- the only per-banner facts are the host and the
 * `banner` query parameter, and both come from the map the WebView scripts
 * already use. Measured on Tom Thumb because that is the banner Stephen's
 * session is on.
 *
 * The banner is passed in rather than read from a page: the rail's __albBanner
 * splits window.location.hostname, which is the WebView's way of learning
 * something the app already knows.
 */
let ORIGIN = 'https://www.tomthumb.com';
let BANNER = 'tomthumb';

/** Point this rail at one of the fifteen banners. Resets anything cached. */
export function useAlbertsonsBanner(storeId: string): boolean {
  const host = albertsonsHostFor(storeId);
  if (!host) return false;
  const nextOrigin = `https://www.${host}`;
  if (nextOrigin === ORIGIN) return true;
  ORIGIN = nextOrigin;
  // The banner parameter is the host's own second-level label, exactly as
  // __albBanner derives it: www.tomthumb.com -> tomthumb.
  BANNER = host.split('.')[0];
  // A different banner is a different origin, a different cookie jar and a
  // different set of API keys. Carrying any of it across is how one account's
  // session gets read as another's.
  cachedUser = null;
  cachedKeys = null;
  cachedCartKey = null;
  return true;
}
const SEARCH_PATH = '/abs/pub/xapi/pgmsearch/v1/search/products';
const CART_PATH = '/abs/pub/erums/cartservice/api/v2/cart/customer/';
const TZ = 'America/Los_Angeles';

/**
 * THE HEADERS A PAGE GETS FOR FREE AND A NATIVE FETCH DOES NOT.
 *
 * The rail runs INSIDE the document, so Chromium attaches Referer, Origin and
 * the whole sec-fetch/sec-ch-ua family to every same-origin XHR without the
 * script asking. RN's fetch attaches none of them, and the first native attempt
 * answered 403 on search and 401 on every cart key -- which is what a gateway
 * does to a request that does not look like it came from its own page.
 *
 * Not a workaround for a block so much as sending what the browser was already
 * sending. Every value here is what a Chrome-on-Android WebView on this origin
 * would send; the UA is the one the rail spoofs, so the two agree.
 */
const browserHeaders = (ua: string) => ({
  'User-Agent': ua,
  Referer: `${ORIGIN}/`,
  Origin: ORIGIN,
  'Accept-Language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="151", "Not.A/Brand";v="24", "Google Chrome";v="151"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
});

type User = {
  token: string; customerId: string; branchId: string; zipcode: string;
};
let cachedUser: User | null = null;
let cachedKeys: string[] | null = null;
/**
 * The key that actually worked, remembered.
 *
 * The cart key sits at no field anyone can name, so it is found by walking
 * candidates -- and the first successful run walked SIXTEEN of them, at 9.7s.
 * Every one of those fifteen refusals is a request into a store that does not
 * need them twice. The rail keeps the winner in A.cartKey for the same reason.
 */
let cachedCartKey: string | null = null;

/** Every 32-hex value on the homepage, the named ones first. */
async function fetchKeys(ua: string): Promise<string[]> {
  const r = await fetchWithTimeout(`${ORIGIN}/`, { credentials: 'include', headers: { 'User-Agent': ua } }, 15000);
  if (r.status !== 200) return [];
  const html = await r.text();
  const out: string[] = [];
  const named = (field: string) => {
    const at = html.indexOf(`"${field}"`);
    if (at < 0) return;
    const m = html.slice(at, at + 160).match(/[0-9a-f]{32}/);
    if (m && !out.includes(m[0])) out.push(m[0]);
  };
  named('apimProgramSubscriptionKey');
  named('apimSubscriptionKey');
  // THE CART KEY IS NOT AT A FIELD WE CAN NAME -- that is why the rail PROBES
  // candidates rather than reading one. Every other 32-hex value follows.
  for (const m of html.matchAll(/[0-9a-f]{32}/g)) {
    if (out.length > 24) break;
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

export const ALBERTSONS_NATIVE: NativeRail = {
  id: 'tom_thumb',
  label: 'Tom Thumb (Albertsons)',
  origin: ORIGIN,

  session: (ua) => timed(async () => {
    /**
     * TWO ATTEMPTS, AND THE SECOND ONE IS THE EXPERIMENT.
     *
     * Stephen, 2026-09-11: "I was able to add to cart with Tom Thumb just now.
     * Looks like it was already logged in." The first native attempt reported
     * signed out -- 200, 16 keys, no SWY_SHOP_TOKEN -- so the probe was wrong,
     * not the account.
     *
     * "Signed out" and "the cookies never went" produce that identical
     * response, and the cookie COUNT cannot tell them apart: CookieManager
     * reading 31 cookies proves they are in the jar, not that OkHttp attached
     * them to this request. H-E-B and ALDI both worked on the implicit jar, but
     * both are POSTs to /graphql and this is a GET to a different path, so the
     * assumption deserved testing rather than carrying over.
     *
     * So: ask normally, and if that says no token, ask again with the jar
     * attached by hand. Which one answers is the finding.
     */
    const url = `${ORIGIN}/bin/safeway/unified/userinfo?rand=${Math.floor(1e6 * Math.random())}&banner=${BANNER}`;
    const ask = (cookieHeader?: string) => fetchWithTimeout(url, {
      credentials: 'include',
      headers: {
        'User-Agent': ua,
        accept: 'text/plain, application/json, */*',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });
    let how = 'implicit jar';
    let r = await ask();
    // The site itself treats these as signed out: it calls
    // processUserInfoFlow('{}') on a 403.
    if (r.status === 401 || r.status === 403) {
      return { ok: true, status: r.status, detail: 'the site reads this status as signed out', session: { loggedIn: false } };
    }
    if (r.status !== 200) return { ok: false, status: r.status, detail: `http ${r.status}` };
    let text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch { return { ok: false, status: r.status, detail: 'non-JSON body' }; }

    if (!j?.SWY_SHOP_TOKEN) {
      // The experiment. Values never leave the device and none is logged.
      let header = '';
      try {
        const jar = await CookieManager.get(ORIGIN, true);
        header = Object.entries(jar)
          .map(([, c]: [string, any]) => `${c.name}=${c.value}`)
          .join('; ');
      } catch { /* reported as the implicit answer standing */ }
      if (header) {
        r = await ask(header);
        text = await r.text();
        try { j = JSON.parse(text); } catch { j = null; }
        how = j?.SWY_SHOP_TOKEN ? 'EXPLICIT Cookie header (the implicit jar did NOT travel)' : 'implicit jar';
      }
    }
    // A 200 with no token IS the expired-session answer: the site responds to it
    // by tearing the user's session down.
    if (!j?.SWY_SHOP_TOKEN) {
      return {
        ok: true, status: r.status, session: { loggedIn: false },
        detail: `${Object.keys(j || {}).length} keys, no SWY_SHOP_TOKEN: signed out or expired`,
      };
    }
    cachedUser = {
      token: String(j.SWY_SHOP_TOKEN),
      customerId: String(j.customerId ?? j.custId ?? ''),
      branchId: String(j.branchId ?? j.shopStoreId ?? ''),
      zipcode: String(j.zipcode ?? j.shopZipcode ?? ''),
    };
    // WHICH IDENTIFIER CAME FROM WHERE, because the rail's note says they come
    // from different places: "The endpoint carries the customer; the cookie
    // carries the store. Neither knows both, which is why the page merges them."
    // A cart 401 with an EMPTY customerId is a malformed URL, not a bad key, and
    // those two look identical from the outside.
    const who = cachedUser.customerId
      ? `customerId ${cachedUser.customerId.length} chars`
      : 'customerId MISSING from userinfo';
    return {
      ok: true, status: r.status,
      detail: `signed in via ${how}, store ${cachedUser.branchId || '?'}, zip ${cachedUser.zipcode || '?'}, ${who}`,
      session: { loggedIn: true, storeId: cachedUser.branchId, shoppingContext: 'pickup' },
    };
  }),

  cartRead: (ua) => timed(async () => {
    if (!cachedUser) return { ok: false, status: null, detail: 'no session from the login step' };
    if (!cachedKeys) cachedKeys = await fetchKeys(ua);
    if (!cachedKeys.length) return { ok: false, status: null, detail: 'no APIM key found on the homepage' };
    const url = `${ORIGIN}${CART_PATH}${encodeURIComponent(cachedUser.customerId)}`
      + `?type=full&storeId=${encodeURIComponent(cachedUser.branchId)}`
      + `&zipCode=${encodeURIComponent(cachedUser.zipcode)}`
      + '&expressChk=true&cartCategoryList=1P,3P_MARKETPLACE,1P_Wine,1P_B2B';
    // THE KEY IS PROBED, not known. The rail walks candidates because the cart
    // key sits at no field anyone can name; a 401 or 403 burns a candidate
    // rather than the request.
    // A DEADLINE FOR THE WHOLE WALK, not just each request.
    //
    // Per-request timeouts stopped the hang and replaced it with a long wait:
    // 25 candidates at 6s each is 150 seconds of politely timing out. A wrong
    // key is refused in milliseconds, so anything slow is not the key -- the
    // per-key budget can be short, and the walk needs its own ceiling on top.
    const walkDeadline = Date.now() + 20_000;
    let lastStatus: number | null = null;
    const order = cachedCartKey
      ? [cachedCartKey, ...cachedKeys.filter((k) => k !== cachedCartKey)]
      : cachedKeys;
    for (let i = 0; i < order.length; i++) {
      if (Date.now() > walkDeadline) {
        return {
          ok: false, status: lastStatus,
          detail: `gave up after ${i} of ${order.length} key candidates, last status ${lastStatus}`,
        };
      }
      const r = await fetchWithTimeout(url, {
        method: 'POST', body: '{}', credentials: 'include',
        headers: {
          ...browserHeaders(ua),
          Authorization: `Bearer ${cachedUser.token}`,
          'ocp-apim-subscription-key': order[i],
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'x-swy-client-id': 'web-portal',
          'Sort-Order': 'date',
        },
      }, 4000);
      lastStatus = r.status;
      if (r.status === 401 || r.status === 403) continue;
      if (r.status !== 200) return { ok: false, status: r.status, detail: `http ${r.status} on key ${i + 1}` };
      cachedCartKey = order[i];
      const j = await r.json().catch(() => null);
      // THE BODY IS { multiCartSummary, carts, errors }, measured by asking it.
      // The first reader looked for cartItems at the top level, found nothing,
      // and reported an empty cart -- which is the failure this endpoint makes
      // easiest, because a wrong path and a genuinely empty cart are the same
      // zero. One banner can hold several carts (1P, marketplace, wine), so the
      // lines are the union of them rather than the first one's.
      let lines: any[] = [];
      try {
        const carts: any[] = Array.isArray(j?.carts) ? j.carts : [];
        for (const c of carts) {
          // cartItemsList, measured by dumping every key on the cart object.
          // Two earlier guesses (cartItems, items) both missed and both reported
          // an empty cart, which is why the shape is printed rather than
          // guessed at a third time.
          const inner = c?.cartItemsList || c?.cartItems || c?.items || [];
          if (Array.isArray(inner)) lines = lines.concat(inner);
        }
        if (!lines.length && Array.isArray(j?.cartItems)) lines = j.cartItems;
      } catch { /* reported by the shape line below */ }
      const count = lines.reduce((n: number, l: any) => n + (Number(l.qty ?? l.quantity) || 0), 0);
      // THE TOP-LEVEL KEYS, because "0 lines" has two very different causes and
      // they look identical: an empty cart, and a reader looking in the wrong
      // place. Naming what came back lets the second one be seen.
      // Still says what it saw when the answer is zero, one level deeper now:
      // an empty cart and a wrong path inside `carts` are the same zero again.
      const shape = lines.length === 0
        ? ` [carts: ${Array.isArray(j?.carts) ? j.carts.length : 'none'}`
          + `, ALL first-cart keys: ${Object.keys(j?.carts?.[0] || {}).join(',') || 'none'}]`
        : '';
      return {
        ok: true, status: r.status, count, lines: lines.length,
        detail: `${lines.length} lines, ${count} items (key ${i + 1} of ${order.length})${shape}`,
      };
    }
    return {
      ok: false, status: lastStatus,
      detail: `all ${cachedKeys.length} key candidates refused, last status ${lastStatus}`,
    };
  }),

  search: (ua, s, term) => timed(async () => {
    if (!cachedUser) return { ok: false, status: null, detail: 'no session from the login step' };
    if (!cachedKeys) cachedKeys = await fetchKeys(ua);
    const key = cachedKeys[0];
    if (!key) return { ok: false, status: null, detail: 'no APIM key found on the homepage' };
    // The site's own parameter list, in its order. Its defaults are not the
    // obvious ones: sort and featured are the EMPTY STRING, and the timezone is
    // a hardcoded America/Los_Angeles rather than the device's.
    const p = new URLSearchParams();
    p.set('request-id', `${Math.floor(900 * Math.random() + 100)}${Date.now()}${Math.floor(900 * Math.random() + 100)}`);
    p.set('url', ORIGIN.replace('https://', ''));
    p.set('pageurl', ORIGIN.replace('https://', ''));
    p.set('pagename', 'search');
    p.set('rows', '12');
    p.set('start', '0');
    p.set('search-type', 'keyword');
    p.set('storeid', String(s.storeId ?? cachedUser.branchId));
    p.set('featured', '');
    p.set('q', term);
    p.set('sort', '');
    p.set('timezone', TZ);
    p.set('dvid', 'web-4.1search');
    p.set('channel', 'pickup');
    p.set('pp', 'true');
    p.set('includeOffer', 'true');
    p.set('banner', BANNER);
    // 20s, because this endpoint sometimes tarpits: it answered in 1016ms on one
    // run and aborted at 12s on the next, from the same device minutes apart.
    const r = await fetchWithTimeout(`${ORIGIN}${SEARCH_PATH}?${p.toString()}`, {
      credentials: 'include',
      headers: {
        ...browserHeaders(ua),
        'ocp-apim-subscription-key': key,
        Accept: 'application/json, text/plain, */*',
      },
    }, 20000);
    if (r.status !== 200) return { ok: false, status: r.status, detail: `http ${r.status}` };
    const j = await r.json().catch(() => null);
    let items: any[] = [];
    try { items = j.primaryProducts?.response?.docs || j.response?.docs || []; } catch { /* below */ }
    if (!items.length) {
      const appCode = j?.primaryProducts?.response?.appCode ?? j?.appCode ?? null;
      return { ok: false, status: r.status, detail: `no docs${appCode ? `, appCode ${appCode}` : ''}` };
    }
    const candidates: NativeCandidate[] = items.map((d: any) => ({
      productId: String(d.pid ?? d.id ?? ''),
      productName: String(d.name ?? d.title ?? ''),
      price: d.price != null ? String(d.price) : null,
      outOfStock: d.inventoryAvailable === '0',
    })).filter((c) => c.productId && c.productName);
    return {
      ok: true, status: r.status, candidates,
      detail: `${candidates.length} candidates, first: ${candidates[0]?.productName?.slice(0, 40) ?? 'none'}`,
    };
  }),

  add: (ua, _s, c) => timed(async () => {
    if (!cachedUser) return { ok: false, status: null, detail: 'no session', added: false };
    if (!cachedKeys) cachedKeys = await fetchKeys(ua);
    const key = cachedKeys[0];
    if (!key) return { ok: false, status: null, detail: 'no APIM key', added: false };
    const url = `${ORIGIN}${CART_PATH}${encodeURIComponent(cachedUser.customerId)}`;
    const r = await postJson(url, [{ itemId: c.productId, qty: 1 }], {
      'User-Agent': ua,
      Authorization: `Bearer ${cachedUser.token}`,
      'ocp-apim-subscription-key': key,
      'x-swy-client-id': 'web-portal',
    });
    if (r.status < 200 || r.status >= 300) {
      return { ok: false, status: r.status, added: false, detail: `http ${r.status}: ${r.text.slice(0, 90)}` };
    }
    return { ok: true, status: r.status, added: true, detail: `wrote 1 of ${c.productName.slice(0, 36)}` };
  }),
};
