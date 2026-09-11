import CookieManager from '@react-native-cookies/cookies';
import { NativeCandidate, NativeRail, postJson, timed } from './types';

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

const ORIGIN = 'https://www.tomthumb.com';
const BANNER = 'tomthumb';
const SEARCH_PATH = '/abs/pub/xapi/pgmsearch/v1/search/products';
const CART_PATH = '/abs/pub/erums/cartservice/api/v2/cart/customer/';
const TZ = 'America/Los_Angeles';

type User = {
  token: string; customerId: string; branchId: string; zipcode: string;
};
let cachedUser: User | null = null;
let cachedKeys: string[] | null = null;

/** Every 32-hex value on the homepage, the named ones first. */
async function fetchKeys(ua: string): Promise<string[]> {
  const r = await fetch(`${ORIGIN}/`, { credentials: 'include', headers: { 'User-Agent': ua } });
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
    const ask = (cookieHeader?: string) => fetch(url, {
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
    let lastStatus: number | null = null;
    for (let i = 0; i < Math.min(cachedKeys.length, 12); i++) {
      const r = await fetch(url, {
        method: 'POST', body: '{}', credentials: 'include',
        headers: {
          'User-Agent': ua,
          Authorization: `Bearer ${cachedUser.token}`,
          'ocp-apim-subscription-key': cachedKeys[i],
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'x-swy-client-id': 'web-portal',
          'Sort-Order': 'date',
        },
      });
      lastStatus = r.status;
      if (r.status === 401 || r.status === 403) continue;
      if (r.status !== 200) return { ok: false, status: r.status, detail: `http ${r.status} on key ${i + 1}` };
      const j = await r.json().catch(() => null);
      let lines: any[] = [];
      try { lines = j.cartItems || j.items || j.cart?.cartItems || []; } catch { /* below */ }
      const count = lines.reduce((n: number, l: any) => n + (Number(l.qty ?? l.quantity) || 0), 0);
      return {
        ok: true, status: r.status, count, lines: lines.length,
        detail: `${lines.length} lines, ${count} items (key ${i + 1} of ${cachedKeys.length})`,
      };
    }
    return { ok: false, status: lastStatus, detail: `every one of ${cachedKeys.length} key candidates was refused` };
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
    const r = await fetch(`${ORIGIN}${SEARCH_PATH}?${p.toString()}`, {
      credentials: 'include',
      headers: {
        'User-Agent': ua,
        'ocp-apim-subscription-key': key,
        Accept: 'application/json, text/plain, */*',
      },
    });
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
