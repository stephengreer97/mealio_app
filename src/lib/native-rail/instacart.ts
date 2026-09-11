import {
  NativeCandidate, NativeRail, NativeSession, postJson, timed,
} from './types';

/**
 * ALDI, on the Instacart platform, natively.
 *
 * THE ONE THAT LOOKED IMPOSSIBLE AND IS NOT. Its rail carries
 * `sessionNeedsStorefront: true` with the note "robots.txt cannot answer this
 * one. The ops live in the storefront bundle", which reads as a hard page
 * dependency. Taking the bootstrap apart, it is not:
 *
 *   op hashes  -- the app SHIPS them (INSTACART_SEED_OPS). Harvesting from the
 *                 page is a REFRESH path for when Instacart rotates them, not a
 *                 requirement. This spike uses the seed.
 *   shop id    -- fetched out of /store/<slug>/storefront and regexed. Pure HTTP.
 *   zone id    -- beside the shop id in the same document. Pure HTTP.
 *
 * So the only genuinely page-bound part is the hash refresh, and even that is
 * replaceable: the page discovers bundle URLs from performance.getEntriesByType,
 * and the same URLs are in the storefront HTML as <script src>.
 *
 * WHAT THIS SPIKE DOES NOT DO: refresh the hashes. If Instacart has rotated
 * them since the seed was captured, every call here answers
 * PERSISTED_QUERY_NOT_FOUND -- which is itself a useful measurement, and says
 * the refresh path is required rather than optional.
 */

const ORIGIN = 'https://www.aldi.us';
const SLUG = 'aldi';
const GQL = `${ORIGIN}/graphql`;

/** Copied from INSTACART_SEED_OPS. Only the four this spike calls. */
const OPS = {
  CurrentUser: '7bdaa54dc2bc33ff8bb66af35da45efc94b2d1eb21ac53841cc214cdd6cc852a',
  ActiveCarts: '839c3658a57f86c543ba367a16d0eaa648f167a1eaf20f6d80aa14165f1ee10d',
  CartItems: '60fa63eb1afba0204993af2a7ea12e057f0ae2677e71753fc05d5a9c5b4adb6c',
  Search: '6d77b6fd5b62f6d88999f5a022af16fafcb00de911da6b942990f61a478ed8c1',
  UpdateCartItemsMutation: 'a88cb16f9d30ef225e487baf6eda6851786440e74ffe73d66908ac2ab8b227a7',
};

/** The rail's note: required by three operations and NOT validated. */
const POSTAL = '00000';

const headers = (ua: string) => ({
  'User-Agent': ua,
  'x-client-identifier': 'mobile_web',
});

async function gql(ua: string, name: keyof typeof OPS, variables: object) {
  return postJson(GQL, {
    operationName: name,
    variables,
    extensions: { persistedQuery: { version: 1, sha256Hash: OPS[name] } },
  }, headers(ua));
}

/**
 * Digits following a marker, up to `max` of them.
 *
 * `max` IS A CEILING, NOT A FLOOR, and the first cut of this read it as a
 * minimum length. Measured against the live storefront document the same day:
 * shopId is 8583 (four digits) and zoneId is 32 (two). Both were found and then
 * thrown away by a `length >= 8` guard, so the probe reported "the storefront
 * document did not carry one" about a document that carried both.
 */
function digitsAfter(s: string, marker: string, max: number): string | null {
  const at = s.indexOf(marker);
  if (at < 0) return null;
  const from = at + marker.length;
  let out = '';
  for (let i = from; i < from + max && i < s.length; i++) {
    const ch = s[i];
    if (ch < '0' || ch > '9') break;
    out += ch;
  }
  return out || null;
}

/**
 * shopId and zoneId, both out of the one storefront document.
 *
 * THIS IS NOT PART OF LOGIN DETECTION, and the first cut of this file made it
 * look like it was. Calling it from session() put a 1.8MB document fetch inside
 * the step labelled "login", which then reported 3914ms on a cold run and 411ms
 * on a warm one. The login question is CurrentUser and nothing else; shop and
 * zone are what SEARCH and CART READ need. Timed separately now so the number
 * against "login" is the login.
 */
let lastShopMs = 0;
let lastHtmlBytes = 0;
async function shopAndZone(ua: string): Promise<{ shopId: string | null; zoneId: string | null }> {
  const t0 = Date.now();
  const r = await fetch(`${ORIGIN}/store/${SLUG}/storefront`, {
    credentials: 'include', headers: { 'User-Agent': ua },
  });
  const html = await r.text();
  lastShopMs = Date.now() - t0;
  lastHtmlBytes = html.length;
  // Two independent markers each, because one will change before both do.
  const shopId = digitsAfter(html, '%5C%22shopId%5C%22%3A%5C%22', 8)
    || digitsAfter(html, '%22shops%22%3A%5B%7B%22id%22%3A%22', 8)
    || digitsAfter(html, '%22shopId%22%3A%22', 8)
    || digitsAfter(html, '"shopId":"', 8);
  const zoneId = digitsAfter(html, '%5C%22zoneId%5C%22%3A%5C%22', 8)
    || digitsAfter(html, '%22zoneId%22%3A%22', 8)
    || digitsAfter(html, '"zoneId":"', 8);
  return { shopId, zoneId };
}

/** Cached for the life of the probe run, as the rail caches in localStorage. */
let cachedShop: { shopId: string | null; zoneId: string | null } | null = null;

export const INSTACART_NATIVE: NativeRail = {
  id: 'aldi',
  label: 'ALDI (Instacart)',
  origin: ORIGIN,

  session: (ua) => timed(async () => {
    const who = await gql(ua, 'CurrentUser', {});
    // 401 IS THE ANSWER, not a failure to answer -- the rail learned this the
    // hard way: treating it as "cannot answer" sent a signed-out user to "add it
    // yourself", the one screen they have no use for.
    if (who.status === 401) {
      return { ok: true, status: 401, detail: 'Not Authenticated: signed out', session: { loggedIn: false } };
    }
    if (who.status !== 200) return { ok: false, status: who.status, detail: `http ${who.status}` };
    const code = who.json?.errors?.[0]?.extensions?.code;
    if (code === 'PERSISTED_QUERY_NOT_FOUND') {
      return {
        ok: false, status: who.status,
        detail: 'PERSISTED_QUERY_NOT_FOUND: the shipped seed hashes are stale, refresh path IS required',
      };
    }
    const cu = who.json?.data?.currentUser;
    if (cu === null || !cu) {
      return { ok: true, status: who.status, detail: 'currentUser null: signed out', session: { loggedIn: false } };
    }
    // The rail reports SHAPE, never the values: an account id, an email and a
    // name are none of a log file's business.
    const guest = cu.guest === true;
    if (guest) return { ok: true, status: who.status, detail: 'currentUser.guest: signed out', session: { loggedIn: false } };

    // THIS RETAILER'S CART, matched on retailer.slug. An Instacart account holds
    // carts across retailers, so carts[0] borrows somebody else's -- and
    // "signed in" and "has a cart here" are separate facts: a new banner has no
    // cart until you add to it, and deriving login from the cart deadlocks it.
    const carts = await gql(ua, 'ActiveCarts', {});
    let cartId: string | null = null;
    try {
      const list: any[] = carts.json.data.userCarts.carts || [];
      const mine = list.find((c) => String(c?.retailer?.slug || '') === SLUG);
      if (mine) cartId = String(mine.id);
    } catch { /* reported below as cart none */ }
    return {
      ok: true, status: who.status,
      detail: `signed in, cart ${cartId ? 'found' : 'none'} (CurrentUser + ActiveCarts only)`,
      session: { loggedIn: true, storeId: null, cartId, shoppingContext: 'delivery' },
    };
  }),

  cartRead: (ua, s) => timed(async () => {
    if (!s.cartId) return { ok: false, status: null, detail: 'no cart id from the session step' };
    const warm = !!cachedShop;
    if (!cachedShop) cachedShop = await shopAndZone(ua);
    const r = await gql(ua, 'CartItems', { id: s.cartId, shopId: cachedShop.shopId, postalCode: POSTAL });
    if (r.status !== 200) return { ok: false, status: r.status, detail: `http ${r.status}` };
    // The rail's path, copied rather than guessed at: the first cut reached for
    // data.cart.items and got nothing, because a cart line lives under
    // userCart.cartItemCollection.cartItems.
    let items: any[] = [];
    try { items = r.json.data.userCart.cartItemCollection.cartItems || []; } catch {
      return { ok: false, status: r.status, detail: 'unreadable cart shape' };
    }
    const count = items.reduce((n, l) => {
      const q = Number(l.quantity != null ? l.quantity : 1);
      return n + (q > 0 ? q : 1);
    }, 0);
    const boot = warm ? 'shop/zone cached' : `shop/zone fetch ${lastShopMs}ms for ${Math.round(lastHtmlBytes / 1024)}KB`;
    return { ok: true, status: r.status, detail: `${items.length} lines, ${count} items (${boot})`, count, lines: items.length };
  }),

  search: (ua, s, term) => timed(async () => {
    const warm = !!cachedShop;
    if (!cachedShop) cachedShop = await shopAndZone(ua);
    void warm;
    if (!cachedShop.zoneId) return { ok: false, status: null, detail: 'no zone id: the storefront document did not carry one' };
    const r = await gql(ua, 'Search', {
      query: term, shopId: cachedShop.shopId, zoneId: cachedShop.zoneId, postalCode: POSTAL,
    });
    if (r.status !== 200) return { ok: false, status: r.status, detail: `http ${r.status}` };
    let items: any[] = [];
    try { items = r.json.data.searchResults.primaryItemResultList.items || []; } catch {
      return { ok: false, status: r.status, detail: 'unreadable search shape' };
    }
    const candidates: NativeCandidate[] = items.slice(0, 20).map((it: any) => ({
      productId: String(it.id ?? it.legacyId ?? ''),
      productName: String(it.name ?? it.displayName ?? ''),
      price: it.viewSection?.priceString ?? null,
      outOfStock: false,
    })).filter((c) => c.productId && c.productName);
    return {
      ok: true, status: r.status,
      detail: `${candidates.length} candidates, first: ${candidates[0]?.productName?.slice(0, 40) ?? 'none'}`,
      candidates,
    };
  }),

  add: (ua, _s, c) => timed(async () => {
    // ONE unit. The rail refuses to guess whether quantity is absolute or
    // additive on this platform, and this spike is not the place to settle it --
    // so it writes the smallest thing that proves the endpoint answers.
    const r = await gql(ua, 'UpdateCartItemsMutation', {
      cartItemUpdates: [{ itemId: c.productId, quantity: 1 }],
    });
    if (r.status !== 200) return { ok: false, status: r.status, detail: `http ${r.status}`, added: false };
    if (r.json?.errors?.length) {
      return { ok: false, status: r.status, added: false, detail: `graphql: ${String(r.json.errors[0]?.message).slice(0, 90)}` };
    }
    return { ok: true, status: r.status, detail: `wrote 1 of ${c.productName.slice(0, 36)}`, added: true };
  }),
};
