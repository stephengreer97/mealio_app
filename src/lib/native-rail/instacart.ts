import {
  NativeCandidate, NativeRail, NativeSession, fetchWithTimeout, postJson, timed,
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
let lastSource = '';
async function shopAndZone(ua: string): Promise<{ shopId: string | null; zoneId: string | null }> {
  const t0 = Date.now();
  // The light one first, the storefront only if it comes back without them.
  // WHICH ONE ANSWERED IS REPORTED, for the reason the rail reports it: a store
  // fact discovered by guessing is one nobody can debug later.
  const sources = [`/store/${SLUG}/search_v3/zz`, `/store/${SLUG}/storefront`];
  let html = '';
  for (const path of sources) {
    const r = await fetchWithTimeout(`${ORIGIN}${path}`, { credentials: 'include', headers: { 'User-Agent': ua } }, 15000);
    html = await r.text();
    lastSource = path;
    if (html.includes('%22zoneId%22%3A%22') || html.includes('%5C%22zoneId%5C%22%3A%5C%22')) break;
  }
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
    const boot = warm ? 'shop/zone cached'
      : `shop/zone ${lastShopMs}ms, ${Math.round(lastHtmlBytes / 1024)}KB from ${lastSource}`;
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

// ── the run driver ───────────────────────────────────────────────────────────
//
// THE SAME RUN, WITHOUT THE RENDERER.
//
// This is the rail that looked page-bound and is not. Its three page
// dependencies each have a plain-HTTP answer:
//
//   op hashes  the app SHIPS them (INSTACART_SEED_OPS), and the refresh path
//              below finds bundle URLs in the storefront HTML instead of in
//              performance.getEntriesByType. Same scan, same markers.
//   shop id    fetched out of a storefront document and read off.
//   zone id    beside it, in the same document.
//
// WHAT REPLACES localStorage is a module-level map keyed through epochKey. That
// is not a downgrade dressed up: the caches exist so a run does not re-fetch a
// five-megabyte document, and a process-lifetime cache does that. Keying through
// epochKey is what makes "sign out of all grocery stores" reach them, which is
// the same mechanism and the same reason as the injected copy.

import { INSTACART_SEED_OPS } from '../webview-scripts/instacart-network';
import { INSTACART_TENANTS } from '../webview-scripts/instacart';
import type { NetworkAddItem, NetworkSession } from '../webview-scripts/network-rail';
import { epochKey } from '../store-session-epoch';
import { getStoreWebViewUA } from '../webview-user-agent';
import {
  Attempt, NativeRunDriver, PostToSheet, guarded, nativeAttempt, nativeGen,
  nativeRetry, parseJson,
} from './run';

/**
 * Resolve a tenant, or refuse.
 *
 * NO SILENT DEFAULT. There used to be a `|| { slug: 'aldi' }` at every call site
 * in the injected rail and it was not a harmless fallback, it was the bug: a
 * Publix run went hunting for an ALDI cart among Publix carts. For something
 * that WRITES TO A CART, a run that does not start is plainly better than a run
 * pointed at the wrong basket.
 */
function runTenant(storeId: string | null | undefined) {
  const t = storeId ? INSTACART_TENANTS[storeId] : null;
  if (!t) {
    throw new Error(
      `native-rail/instacart: no Instacart tenant for store id ${JSON.stringify(storeId)}. `
      + 'This means the store id was lost on the way in, not that the store is new.',
    );
  }
  return t;
}

/**
 * The caches, keyed through epochKey so a sign-out orphans them.
 *
 * Process-lifetime rather than on disk. The injected copy needs localStorage
 * because a WebView document does not outlive the run; this one is a module, and
 * a module outlives every run in the session.
 */
const runOpsCache = new Map<string, Record<string, string>>();
const runShopCache = new Map<string, { shopId: string | null; zoneId: string | null }>();

function runHeaders(origin: string): Record<string, string> {
  return {
    'User-Agent': getStoreWebViewUA(),
    'content-type': 'application/json',
    accept: '*/*',
    'x-client-identifier': 'mobile_web',
    Referer: `${origin}/`,
    Origin: origin,
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
}

function runOps(slug: string): Record<string, string> {
  return runOpsCache.get(epochKey(`ops:${slug}`)) ?? INSTACART_SEED_OPS;
}

/**
 * REFRESH THE HASHES, the day Instacart deploys.
 *
 * The injected rail lists bundle URLs from performance.getEntriesByType, which
 * only a document has. The same URLs are in the storefront HTML as script src,
 * so the scan is identical and only the list changes. Bounded by a deadline
 * because it is megabytes: a refresh that never ends is worse than stale hashes,
 * which at least fail fast and reach the review screen.
 */
async function runHarvestOps(
  origin: string, slug: string, budgetMs: number,
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  const wanted = Object.keys(INSTACART_SEED_OPS);
  const found: Record<string, string> = {};
  const page = await nativeAttempt(`${origin}/store/${slug}/storefront`,
    { headers: { 'User-Agent': getStoreWebViewUA() } }, 20_000);
  if (!page.ok || !page.data) return 0;
  const urls: string[] = [];
  for (const m of page.data.matchAll(/<script[^>]+src="([^"]+\.js[^"]*)"/g)) {
    urls.push(m[1].startsWith('http') ? m[1] : origin + m[1]);
  }
  for (const u of urls) {
    if (Date.now() > deadline) break;
    if (wanted.every((w) => found[w])) break;
    const r = await nativeAttempt(u, { headers: { 'User-Agent': getStoreWebViewUA() } }, 10_000);
    if (!r.ok || !r.data) continue;
    for (const name of wanted) {
      if (found[name]) continue;
      const at = r.data.indexOf(`"${name}":"`);
      if (at < 0) continue;
      const hash = r.data.substr(at + name.length + 4, 64);
      if (hash.length === 64) found[name] = hash;
    }
  }
  const got = Object.keys(found).length;
  // Only worth caching if the harvest actually found something; caching the
  // bare seed would hide a broken harvest.
  if (got > 0) {
    runOpsCache.set(epochKey(`ops:${slug}`), { ...INSTACART_SEED_OPS, ...found });
  }
  return got;
}

/** One persisted GraphQL call under the shared retry policy. */
function icGql(
  post: PostToSheet, origin: string, slug: string, name: string,
  variables: object, budgetMs: number, phase: string,
): Promise<Attempt<any>> {
  return nativeRetry<any>(async () => {
    const hash = runOps(slug)[name];
    if (!hash) return { ok: false, why: 'no_hash', status: null };
    const r = await nativeAttempt(`${origin}/graphql`, {
      method: 'POST',
      headers: runHeaders(origin),
      body: JSON.stringify({
        operationName: name, variables: variables || {},
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
      }),
    }, budgetMs);
    if (r.why === 'no_response') {
      return { ok: false, why: 'no_response', aborted: r.aborted, status: null, detail: r.detail };
    }
    if (r.status !== 200) {
      return { ok: false, why: 'http', status: r.status, detail: String(r.data || '').slice(0, 160) };
    }
    const j: any = parseJson(r.data);
    if (!j) return { ok: false, why: 'unparseable', status: r.status };
    if (j.errors && j.errors.length) {
      const first = j.errors[0] || {};
      const code = (first.extensions && first.extensions.code) || '';
      // The store no longer knows this hash -- Instacart deployed. Drop the
      // cache so the next call harvests again.
      if (code === 'PERSISTED_QUERY_NOT_FOUND') runOpsCache.delete(epochKey(`ops:${slug}`));
      // ERRORS AND DATA ARE NOT EXCLUSIVE. A resolver that fails puts an entry in
      // errors and null at that path, and everything else still arrives. Only a
      // response with no data at all is a failure.
      if (!j.data) {
        return { ok: false, why: 'gql_error', status: r.status, code,
                 detail: String(first.message || '').slice(0, 160) };
      }
      return { ok: true, status: r.status, data: j.data, partialErrors: j.errors.length };
    }
    return { ok: true, status: r.status, data: j.data };
  }, { phase, op: name, post });
}

/**
 * A call that re-harvests once if the store says it does not know the hash.
 *
 * The recovery the seed alone does not have. Without it a deploy on Instacart's
 * side turns every native run into "add it yourself" until the app ships new
 * constants, which is strictly worse than the injected path and therefore not
 * an acceptable trade for the renderer.
 */
async function icGqlFresh(
  post: PostToSheet, origin: string, slug: string, name: string,
  variables: object, budgetMs: number, phase: string,
): Promise<Attempt<any>> {
  const first = await icGql(post, origin, slug, name, variables, budgetMs, phase);
  if (first.ok || first.code !== 'PERSISTED_QUERY_NOT_FOUND') return first;
  const got = await runHarvestOps(origin, slug, 20_000);
  post({ type: 'IC_OPS_REFRESHED', source: 'network', harvested: got, op: name });
  if (!got) return first;
  return icGql(post, origin, slug, name, variables, budgetMs, phase);
}

/** shopId and zoneId, both out of the one storefront document. */
async function runShopAndZone(
  origin: string, slug: string,
): Promise<{ shopId: string | null; zoneId: string | null }> {
  const key = epochKey(`shop:${slug}`);
  const hit = runShopCache.get(key);
  if (hit) return hit;
  // The light one first, the storefront only if it comes back without them.
  // MEASURED 2026-09-11: search_v3/zz is 47KB in 1.02s where the storefront is
  // 242KB in 3.43s, and both carry the pair.
  let html = '';
  for (const path of [`/store/${slug}/search_v3/zz`, `/store/${slug}/storefront`]) {
    const r = await nativeAttempt(`${origin}${path}`,
      { headers: { 'User-Agent': getStoreWebViewUA() } }, 20_000);
    html = r.data || '';
    if (html.includes('%22zoneId%22%3A%22') || html.includes('%5C%22zoneId%5C%22%3A%5C%22')) break;
  }
  // Two independent markers each, because one of them will change before both do.
  const out = {
    shopId: digitsAfter(html, '%5C%22shopId%5C%22%3A%5C%22', 8)
      || digitsAfter(html, '%22shops%22%3A%5B%7B%22id%22%3A%22', 8)
      || digitsAfter(html, '%22shopId%22%3A%22', 8)
      || digitsAfter(html, '"shopId":"', 8),
    zoneId: digitsAfter(html, '%5C%22zoneId%5C%22%3A%5C%22', 8)
      || digitsAfter(html, '%22zoneId%22%3A%22', 8)
      || digitsAfter(html, '"zoneId":"', 8),
  };
  if (out.shopId || out.zoneId) runShopCache.set(key, out);
  return out;
}

/** The signed-in user's cart AT THIS RETAILER, or null. Never carts[0]. */
function runPickCart(list: any[], slug: string): any | null {
  for (const c of list) if (String(c?.retailer?.slug || '') === slug) return c;
  return null;
}

/** One cart line's ITEM id and name. See the note in the injected read: a line
 *  carries two ids and only basketProduct.itemId is the one search returns. */
function runLineOf(li: any): { itemId: string | null; name: string; qty: number } {
  const bp = li.basketProduct || null;
  let iid: string | null = null;
  try { iid = String((bp && (bp.itemId || bp.id)) || li.itemId || (li.item && li.item.id) || li.id); }
  catch { iid = null; }
  let nm: string | null = li.name || null;
  if (!nm && bp && bp.name) nm = bp.name;
  if (!nm) { try { nm = li.item.name || (li.item.viewSection && li.item.viewSection.titleString); } catch { nm = null; } }
  let qty = Number(li.quantity != null ? li.quantity : 1);
  if (!(qty > 0)) qty = 1;
  return { itemId: iid, name: String(nm || iid || 'item'), qty };
}

/** The search item -> a candidate, shaped as toCandidate shapes it. */
function runCandidate(it: any): Record<string, unknown> {
  const vs = it.viewSection || {};
  let img: string | null = null;
  try { img = (vs.itemImage && (vs.itemImage.url || vs.itemImage.templateUrl)) || null; } catch { img = null; }
  let price: string | null = null;
  try { price = vs.priceString || (it.price && it.price.viewSection && it.price.viewSection.priceString) || null; }
  catch { price = null; }
  let name = it.name || vs.titleString || null;
  if (name && it.size) name = `${name}, ${it.size}`;
  return {
    productName: String(name || ''),
    imageUrl: img,
    // The search does not report stock, so nothing here may claim it is out.
    // The write is what finds out, and it verifies against the cart.
    outOfStock: false,
    preferences: null,
    price,
    productId: it.id != null ? String(it.id) : null,
    skuId: null,
    isWeightItem: false,
    maxOrderQuantity: null,
  };
}

async function runReadCartLines(
  post: PostToSheet, origin: string, slug: string, shopId: string,
): Promise<{ cartId: string; held: Record<string, number>; rows: Array<Record<string, unknown>> } | null> {
  const carts = await icGqlFresh(post, origin, slug, 'ActiveCarts', {}, 12_000, 'cart_read');
  if (!carts.ok) return null;
  let list: any[] = [];
  try { list = (carts.data as any).userCarts.carts || []; } catch { list = []; }
  const mine = runPickCart(list, slug);
  if (!mine) return null;
  const cartId = String(mine.id);
  const items = await icGqlFresh(post, origin, slug, 'CartItems',
    { id: cartId, shopId, postalCode: POSTAL }, 15_000, 'cart_read');
  // A CART THAT COULD NOT BE READ IS NOT AN EMPTY CART. On a store whose write
  // is absolute, an empty held map SETS every line to what this run alone asked
  // for, which can take things out of the cart.
  if (!items.ok) return null;
  let lines: any[] = [];
  try { lines = (items.data as any).userCart.cartItemCollection.cartItems || []; } catch { lines = []; }
  const held: Record<string, number> = {};
  const rows: Array<Record<string, unknown>> = [];
  for (const li of lines) {
    const l = runLineOf(li || {});
    if (l.itemId) held[l.itemId] = (held[l.itemId] || 0) + l.qty;
    rows.push({ name: l.name, qty: l.qty, itemId: l.itemId, available: true });
  }
  return { cartId, held, rows };
}

/**
 * A driver BOUND TO ONE BANNER.
 *
 * A factory rather than a constant, and that is the whole of the multi-tenant
 * problem solved. The injected rail has to rediscover which banner it is on for
 * every script -- it reads location.hostname, because a NetworkSession carries
 * the SHOP id and not the tenant -- and getting that wrong is what sent a Publix
 * run hunting for an ALDI cart. There is no location here to read, and there
 * does not need to be: the store id is known at the moment the driver is looked
 * up, so it is closed over once instead of re-derived four times.
 */
export function instacartNativeRun(storeId: string): NativeRunDriver {
  const t = runTenant(storeId);
  return {
  id: t.storeId,

  session: () => {
    return async (post) => guarded(async () => {
      const carts = await icGqlFresh(post, t.origin, t.slug, 'ActiveCarts', {}, 12_000, 'cart_read');
      if (!carts.ok) {
        // 401 IS THE ANSWER, not a failure to answer. Treating it as "cannot
        // answer" sends a signed-out user to "add it yourself", which is the one
        // screen they have no use for.
        if (carts.status === 401) {
          // AND DROP THE CACHED SHOP. It was chosen by a session that is gone.
          runShopCache.delete(epochKey(`shop:${t.slug}`));
          post({ type: 'ALDI_SESSION', ok: true, loggedIn: false,
                 source: 'activeCarts_401', shopCacheCleared: true });
          return;
        }
        // Anything else is genuinely unanswerable. Saying "signed out" to a 5xx
        // or a wall would wall a signed-in user.
        post({ type: 'ALDI_SESSION', ok: false, why: carts.why, code: carts.code || null,
               detail: carts.detail || null, status: carts.status ?? null });
        return;
      }
      const who = await icGqlFresh(post, t.origin, t.slug, 'CurrentUser', {}, 8000, 'session');
      // A 401 from an ACCOUNT query means the account is not there. Unlike the
      // cart, this one cannot be true for a guest.
      const acctDenied = who.status === 401;
      let guest: boolean | null = null;
      try {
        const cu = (who.data as any)?.currentUser;
        if (cu && typeof cu === 'object') guest = typeof cu.guest === 'boolean' ? cu.guest : null;
      } catch { guest = null; }
      // === true ON PURPOSE. A missing or non-boolean guest must never wall
      // anyone: this only ever turns a "signed in" into a "signed out".
      const acctGuest = guest === true;

      const uc = (carts.data as any)?.userCarts || null;
      const list: any[] = (uc && uc.carts) || [];
      if (!uc) { post({ type: 'ALDI_SESSION', ok: true, loggedIn: false, source: 'activeCarts' }); return; }
      const mine = runPickCart(list, t.slug);
      const shop = await runShopAndZone(t.origin, t.slug);
      post({
        type: 'ALDI_SESSION',
        ok: true,
        // THE CART SAYS "there is a basket", never "there is a user" -- so it is
        // a NECESSARY condition and CurrentUser answering 401, or naming a
        // guest, overrides it outright. Stephen, 2026-09-07: a guest run adds
        // fine and the user cannot see any of it from their own account.
        loggedIn: !!mine && !acctDenied && !acctGuest,
        acctDenied,
        acctGuest,
        cartId: mine ? String(mine.id) : null,
        itemCount: mine ? mine.itemCount : null,
        retailerId: mine && mine.retailer ? String(mine.retailer.id) : null,
        sawSlugs: list.map((c) => (c.retailer || {}).slug || null),
        hadUserCarts: !!uc,
        cartCount: list.length,
        // The engine's NetworkSession wants these two names. storeId is the SHOP.
        storeId: shop.shopId,
        shoppingContext: 'delivery',
        shopFrom: shop.shopId ? 'storefront' : null,
        source: 'native',
      });
    }, (detail) => post({ type: 'ALDI_SESSION', ok: false, why: 'threw', detail }));
  },

  cartRead: () => {
    return async (post) => guarded(async () => {
      const shop = await runShopAndZone(t.origin, t.slug);
      if (!shop.shopId) {
        post({ type: 'CART_COUNT', count: null, source: 'network',
               reason: 'rail_read_failed', why: 'no_shop' });
        return;
      }
      const read = await runReadCartLines(post, t.origin, t.slug, shop.shopId);
      if (!read) {
        // No cart AT THIS RETAILER is a real zero; an unreadable one is not, and
        // runReadCartLines cannot tell us which. It reports the safe one.
        post({ type: 'CART_COUNT', count: null, source: 'network', reason: 'rail_read_failed' });
        return;
      }
      const count = read.rows.reduce((n, r) => n + ((r.qty as number) || 0), 0);
      post({ type: 'CART_COUNT', count, items: read.rows, source: 'network', cartId: read.cartId });
    }, (detail) => post({ type: 'CART_COUNT', count: null, source: 'network',
                          reason: 'rail_read_threw', detail }));
  },

  searchBatch: (terms, sess: NetworkSession) => {
    // NO SHOP, NO SEARCH. Every operation on this platform takes the shop the
    // user is actually shopping, and the retailer id is not it: ALDI the chain
    // is 12, the branch is 8583. The wrong one searches a catalogue the user
    // cannot buy from.
    if (!terms.length || !sess.storeId) return null;
    const shopId = String(sess.storeId);
    return async (post) => guarded(async () => {
      const myGen = nativeGen();
      const shop = await runShopAndZone(t.origin, t.slug);
      const zone = shop.zoneId;
      // zoneFrom is load-bearing rather than decoration: a wrong zone does not
      // fail, it answers 200 with every price field "Not Found" (MEAL-235).
      post({ type: 'IC_SEARCH_SHAPE', source: 'network', zone, zoneFrom: zone ? 'storefront' : 'none' });
      if (!zone) {
        for (const term of terms) {
          post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term, why: 'no_zone' });
        }
        post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: terms.length });
        return;
      }
      for (let i = 0; i < terms.length; i += 1) {
        // THE STOP IS READ BETWEEN TERMS, and on this rail that is most of the
        // saving: the loop is serial, so a stop at term two spares the other
        // sixteen requests rather than cancelling one.
        if (nativeGen() !== myGen) {
          post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: terms.length,
                 stopped: true, at: i });
          return;
        }
        const term = terms[i];
        const r = await icGqlFresh(post, t.origin, t.slug, 'Search',
          { query: term, shopId, zoneId: zone, postalCode: POSTAL }, 15_000, 'search');
        if (!r.ok) {
          post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term, why: r.why,
                 status: r.status ?? null, code: r.code || null, detail: r.detail || null });
          continue;
        }
        let items: any[] = [];
        try { items = (r.data as any).searchResults.primaryItemResultList.items || []; } catch { items = []; }
        const cands: Array<Record<string, unknown>> = [];
        for (const it of items.slice(0, 30)) {
          const c = runCandidate(it);
          if (c.productName && c.productId) cands.push(c);
        }
        post({ type: 'SEARCH_RESULT', source: 'network', term, candidates: cands, n: cands.length });
      }
      post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: terms.length });
    }, (detail) => post({ type: 'SEARCH_BATCH_DONE', source: 'network',
                          count: terms.length, threw: detail }));
  },

  addBatch: (items, opts) => {
    const writable = (items as NetworkAddItem[]).filter((i) => !!i.productId);
    if (!writable.length) return null;
    return async (post) => guarded(async () => {
      const report = (
        it: NetworkAddItem, ok: boolean, reason?: string, detail?: string, asked?: number,
      ) => {
        post({ type: 'NET_ADD_RESULT', idx: it.idx, name: it.name, productId: it.productId,
               skuId: null, asked: asked != null ? asked : it.quantity, success: !!ok,
               reason: reason || null, detail: detail || null });
      };

      const shop = await runShopAndZone(t.origin, t.slug);
      // The baseline. Handed in when the sheet already read it, read here when it
      // did not -- the write needs one either way, because a line is SET.
      let before: { held: Record<string, number>; rows: Array<Record<string, unknown>> } | null =
        opts.knownLines ? { held: opts.knownLines, rows: [] } : null;
      if (!before && shop.shopId) before = await runReadCartLines(post, t.origin, t.slug, shop.shopId);
      if (!before) {
        for (const it of writable) {
          report(it, false, 'no_cart', 'could not read the cart to baseline against');
        }
        post({ type: 'NET_ADD_DONE', count: writable.length, wrote: 0 });
        return;
      }

      const updates: Array<{ itemId: string; quantity: number }> = [];
      const planned: Array<{ it: NetworkAddItem; want: number; have: number; sent: number }> = [];
      for (const it of writable) {
        const have = Number(before.held[it.productId] || 0);
        const want = Math.max(1, Math.round(it.quantity || 1));
        // IS QUANTITY ABSOLUTE HERE? NOBODY HAS MEASURED IT, AND THIS REFUSES TO
        // GUESS. With have === 0 the two readings agree (held + wanted ===
        // wanted); with have > 0 they disagree, and getting it backwards is the
        // silent under-add MEAL-194 exists to prevent.
        if (have > 0 && opts.absoluteQty !== true) {
          report(it, false, 'qty_semantics_unproven',
            `the cart already holds ${have} of this and it is not yet measured whether this store SETS or ADDS the quantity`);
          continue;
        }
        updates.push({ itemId: it.productId, quantity: have + want });
        planned.push({ it, want, have, sent: have + want });
      }
      if (!updates.length) { post({ type: 'NET_ADD_DONE', count: writable.length, wrote: 0 }); return; }

      const res = await icGqlFresh(post, t.origin, t.slug, 'UpdateCartItemsMutation',
        { cartItemUpdates: updates }, 25_000, 'add');
      if (!res.ok) {
        for (const p of planned) {
          report(p.it, false, 'write_refused', `${res.why}${res.detail ? `: ${res.detail}` : ''}`);
        }
        post({ type: 'NET_ADD_DONE', count: writable.length, wrote: 0, why: res.why });
        return;
      }

      // THE CART DECIDES. Never the write's own report -- that rule has caught a
      // silent under-add, an unhydrated zero and an over-adding retry.
      const after = shop.shopId ? await runReadCartLines(post, t.origin, t.slug, shop.shopId) : null;
      let wrote = 0;
      for (const p of planned) {
        const now = after ? Number(after.held[p.it.productId] || 0) : null;
        if (now == null) { report(p.it, true, undefined, 'written, cart not re-read', p.want); wrote += 1; continue; }
        if (now >= p.sent) { report(p.it, true, undefined, undefined, p.want); wrote += 1; }
        else report(p.it, false, 'not_in_cart_after_write', `expected ${p.sent}, cart holds ${now}`, p.want);
      }
      post({ type: 'NET_ADD_DONE', count: writable.length, wrote,
             cartBefore: before.rows, cartAfter: after ? after.rows : [],
             cartLines: after ? after.rows.length : null });
    }, (detail) => post({ type: 'NET_ADD_DONE', count: writable.length, wrote: 0, threw: detail }));
  },
  };
}
