import {
  NativeCandidate, NativeRail, NativeResult, NativeSession, postJson, timed,
} from './types';

/**
 * H-E-B, natively.
 *
 * The easiest of the four and the one already proven on the device: plain
 * GraphQL with the query TEXT in the body, so there are no persisted-query
 * hashes to harvest and nothing to read off a page. The headers are the same
 * three __hebGqlAttempt sends.
 *
 * Every document here is copied from heb-network-search.ts rather than
 * rewritten, so a comparison between the two measures the TRANSPORT and not two
 * people's idea of the same query.
 */

const ORIGIN = 'https://www.heb.com';
const GQL = `${ORIGIN}/graphql`;

const headers = (ua: string) => ({
  'User-Agent': ua,
  'apollographql-client-name': 'WebPlatform-Solar (Production)',
});

/** The rail's own selection, so the candidate shape cannot drift between them. */
const SEARCH_SELECTION = `
    __typename
    ... on SearchPage {
      layout {
        ... on VerticalStackLayout {
          visualComponents {
            ... on SearchGridV2 {
              items {
                __typename
                ... on Product {
                  id
                  displayName
                  fullDisplayName
                  inventory { inventoryState }
                  SKUs {
                    id
                    customerFriendlySize
                    contextPrices { context salePrice { formattedAmount } }
                  }
                }
              }
            }
          }
        }
      }
    }
    ... on SearchPageError { code message }`;

/** Walks the nested search page down to the product grid. */
function gridItems(page: any): any[] | null {
  try {
    const comps = page.layout.visualComponents || [];
    for (const c of comps) if (Array.isArray(c.items)) return c.items;
  } catch { /* an unreadable page is not an empty one */ }
  return null;
}

export const HEB_NATIVE: NativeRail = {
  id: 'heb',
  label: 'H-E-B',
  origin: ORIGIN,

  session: (ua) => timed(async () => {
    const who = await postJson(GQL, {
      operationName: 'myPreferredStore',
      variables: {},
      query: 'query myPreferredStore { me { id preferredStore { storeNumber } } }',
    }, headers(ua));
    if (who.status !== 200) return { ok: false, status: who.status, detail: 'http' };
    if (who.json?.errors?.length) {
      return { ok: false, status: who.status, detail: `graphql: ${String(who.json.errors[0]?.message).slice(0, 80)}` };
    }
    const me = who.json?.data?.me?.id;
    if (!me) return { ok: true, status: who.status, detail: 'me is null: signed out', session: { loggedIn: false } };

    // THE FULFILLMENT STORE, NOT THE PREFERRED ONE. The rail's note is explicit
    // that these are different numbers (243 vs 476 for one shop) and that search
    // wants the fulfillment store's id -- the other one searches a different
    // catalogue and returns results that look perfectly reasonable.
    const sess = await postJson(GQL, {
      operationName: 'SessionContext',
      variables: {},
      query: 'query SessionContext { cartV2 { __typename'
        + ' ... on Cart { id fulfillment { curbsideFulfillmentMode store { id name } } }'
        + ' ... on CartError { code title message } } }',
    }, headers(ua));
    let storeId: string | null = null;
    let cartId: string | null = null;
    let mode: string | null = null;
    try {
      const c = sess.json.data.cartV2;
      cartId = c.id ?? null;
      storeId = c.fulfillment?.store?.id != null ? String(c.fulfillment.store.id) : null;
      mode = c.fulfillment?.curbsideFulfillmentMode ?? null;
    } catch { /* reported by storeId being null */ }
    const shoppingContext = mode && String(mode).toUpperCase().includes('PICKUP')
      ? 'CURBSIDE_PICKUP' : 'CURBSIDE_DELIVERY';
    return {
      ok: true, status: who.status,
      detail: `signed in, store ${storeId ?? '?'}, ${shoppingContext}`,
      session: { loggedIn: true, storeId, shoppingContext, cartId },
    };
  }),

  cartRead: (ua) => timed(async () => {
    const r = await postJson(GQL, {
      operationName: 'CartLines',
      variables: {},
      query: 'query CartLines { cartV2 { __typename'
        + ' ... on Cart { id items { id quantity product { id fullDisplayName } } }'
        + ' ... on CartError { code title message } } }',
    }, headers(ua));
    if (r.status !== 200) return { ok: false, status: r.status, detail: 'http' };
    let items: any[] | null = null;
    try {
      const c = r.json.data.cartV2;
      if (c.__typename !== 'Cart') return { ok: false, status: r.status, detail: `cart error: ${c.code ?? '?'}` };
      items = c.items || [];
    } catch { return { ok: false, status: r.status, detail: 'unreadable cart shape' }; }
    const count = (items || []).reduce((n, l) => n + (Number(l.quantity) || 0), 0);
    return { ok: true, status: r.status, detail: `${items!.length} lines, ${count} items`, count, lines: items!.length };
  }),

  search: (ua, s, term) => timed(async () => {
    const r = await postJson(GQL, {
      operationName: 'productSearchPageV2',
      variables: {
        params: {
          query: term,
          storeId: Number(s.storeId),
          shoppingContext: s.shoppingContext,
          excludeSponsoredContent: true,
          includeOutOfStock: true,
          pageSize: 12,
        },
      },
      query: `query productSearchPageV2($params: SearchPageParamsV2!) {\n  productSearchPageV2(params: $params) {\n${SEARCH_SELECTION}\n  }\n}`,
    }, headers(ua));
    if (r.status !== 200) return { ok: false, status: r.status, detail: 'http' };
    if (r.json?.errors?.length) {
      return { ok: false, status: r.status, detail: `graphql: ${String(r.json.errors[0]?.message).slice(0, 90)}` };
    }
    const page = r.json?.data?.productSearchPageV2;
    if (page?.__typename === 'SearchPageError') {
      return { ok: false, status: r.status, detail: `search page error: ${page.code ?? page.message}` };
    }
    const items = gridItems(page);
    // A well-formed page with NO grid is the store saying it has nothing, which
    // the rail is careful to distinguish from a page it could not read.
    if (items == null) return { ok: true, status: r.status, detail: 'no grid: store has nothing', candidates: [] };
    const candidates: NativeCandidate[] = items
      .filter((it) => it.__typename === 'Product')
      .map((it) => ({
        productId: String(it.id),
        skuId: it.SKUs?.[0]?.id != null ? String(it.SKUs[0].id) : null,
        productName: String(it.fullDisplayName || it.displayName || ''),
        price: it.SKUs?.[0]?.contextPrices?.[0]?.salePrice?.formattedAmount ?? null,
        outOfStock: String(it.inventory?.inventoryState || '').toUpperCase().includes('OUT'),
      }))
      .filter((c) => c.productName && c.productId);
    return {
      ok: true, status: r.status,
      detail: `${candidates.length} candidates, first: ${candidates[0]?.productName?.slice(0, 40) ?? 'none'}`,
      candidates,
    };
  }),

  add: (ua, _s, c) => timed(async () => {
    const r = await postJson(GQL, {
      operationName: 'cartItemV2',
      variables: { productId: c.productId, skuId: c.skuId, quantity: 1, purchasePreferenceId: null },
      query: 'mutation cartItemV2($productId: String!, $skuId: String!, $quantity: Int,'
        + ' $purchasePreferenceId: String) {'
        + ' addItemToCartV2(productId: $productId, skuId: $skuId, quantity: $quantity,'
        + ' purchasePreferenceId: $purchasePreferenceId) {'
        + ' __typename'
        + ' ... on Cart { id }'
        + ' ... on AddOnsCart { id cart { id } }'
        + ' ... on AddItemToCartV2Error { message title code }'
        + ' ... on AddItemToCartV2TimeslotError { message title errorCode: code } } }',
    }, headers(ua));
    if (r.status !== 200) return { ok: false, status: r.status, detail: 'http', added: false };
    if (r.json?.errors?.length) {
      return { ok: false, status: r.status, detail: `graphql: ${String(r.json.errors[0]?.message).slice(0, 90)}`, added: false };
    }
    const res = r.json?.data?.addItemToCartV2;
    const t = res?.__typename;
    if (t === 'Cart' || t === 'AddOnsCart') {
      return { ok: true, status: r.status, detail: `added: ${c.productName.slice(0, 40)}`, added: true };
    }
    return {
      ok: false, status: r.status, added: false,
      detail: `refused (${t ?? 'unknown'}): ${String(res?.message || res?.code || '').slice(0, 80)}`,
    };
  }),
};

// ── the run driver ───────────────────────────────────────────────────────────
//
// THE SAME RUN, WITHOUT THE RENDERER. Stephen, 2026-09-11: "I want the same
// general logic, I just want it to be done without a webview and just 100% over
// network instead."
//
// Every document below is IMPORTED from heb-network-search.ts rather than
// retyped, so the two transports cannot ask different questions. What is ported
// is the shaping -- the candidate helpers and the write's per-item rules -- which
// lives in that file as JavaScript text and cannot be imported. Each ported
// block keeps the comment that explains why it is what it is, because those
// comments are the measurements.

import {
  HEB_ADD_MUTATION, HEB_CART_LINES_QUERY, HEB_SEARCH_QUERY, HEB_SESSION_QUERY,
  HEB_WHO_QUERY, hebAddBatchDoc, hebSearchBatchDoc,
} from '../webview-scripts/heb-network-search';
import type { NetworkAddItem, NetworkSession } from '../webview-scripts/network-rail';
import { getStoreWebViewUA } from '../webview-user-agent';
import {
  Attempt, NativeRunDriver, PostToSheet, guarded, nativeAttempt, nativeGen,
  nativeRetry, parseJson,
} from './run';

/** The three headers __hebGqlAttempt sends, plus the browser's own. */
function runHeaders(): Record<string, string> {
  return {
    'User-Agent': getStoreWebViewUA(),
    'content-type': 'application/json',
    accept: '*/*',
    'apollographql-client-name': 'WebPlatform-Solar (Production)',
    Referer: `${ORIGIN}/`,
    Origin: ORIGIN,
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
}

/** One GraphQL call under the shared retry policy. The native __hebGql. */
function hebGql(
  post: PostToSheet, op: string, query: string, variables: object,
  timeoutMs: number, phase: string,
): Promise<Attempt<any>> {
  return nativeRetry<any>(async () => {
    const r = await nativeAttempt(GQL, {
      method: 'POST',
      headers: runHeaders(),
      body: JSON.stringify({ operationName: op, variables: variables || {}, query }),
    }, timeoutMs);
    if (r.why === 'no_response') {
      return { ok: false, why: 'no_response', aborted: r.aborted, detail: r.detail, status: null };
    }
    // The wall answers 403 with an HTML incident page. Named on its own because
    // it is transient and self-healing (MEAL-16 measured 71-84s): it means try
    // again later, not "this store has no such product".
    if (r.status === 403) return { ok: false, why: 'blocked', status: 403 };
    if (!r.ok) return { ok: false, why: 'http', status: r.status };
    const json: any = parseJson(r.data);
    if (!json) return { ok: false, why: 'unparseable', status: r.status };
    if (json.errors && json.errors.length) {
      const e0 = json.errors[0];
      return { ok: false, why: 'graphql_error', status: r.status,
               detail: typeof e0?.message === 'string' ? e0.message.slice(0, 200) : null };
    }
    return { ok: true, status: r.status, data: json.data };
  }, { phase, op, post });
}

// ── the candidate, shaped exactly as CANDIDATE_HELPERS shapes it ─────────────

function runGridItems(page: any): any[] | null {
  let items: any[] | null = null;
  try {
    const vcs = page.layout.visualComponents;
    // Found by TYPE, not by having items in it. Requiring a non-empty list made
    // "the store has nothing matching this" indistinguishable from "the grid was
    // not where we expected", and the two have opposite answers.
    for (const v of vcs) if (v && v.__typename === 'SearchGridV2' && v.items) { items = v.items; break; }
    if (items == null) for (const v of vcs) if (v && v.items && v.items.length) { items = v.items; break; }
  } catch { /* an unreadable page is not an empty one */ }
  return items;
}

function runImageOf(p: any): string | null {
  const urls: any[] = p.productImageUrls || [];
  const bySize: Record<string, string> = {};
  for (const u of urls) if (u && u.size) bySize[u.size] = u.url;
  return bySize.MEDIUM || bySize.SMALL || bySize.LARGE || (urls[0] && urls[0].url) || null;
}

/** Same rule the embedded-JSON reader uses, so a price does not change with the path. */
function runPriceOf(p: any, sku: any): string | null {
  const cps: any[] = (sku && sku.contextPrices) || [];
  if (!cps.length) return null;
  const want = String(p.shoppingContext || '').split('_')[0];
  let pick = cps.find((c) => c && c.context === want)
    || cps.find((c) => c && c.context === 'ONLINE')
    || cps[0];
  const amt = pick && (pick.salePrice || pick.listPrice);
  const f = amt && amt.formattedAmount;
  return typeof f === 'string' && /[0-9]/.test(f) ? f : null;
}

/** The size is appended because the add path matches names EXACTLY. */
function runNameOf(p: any, sku: any): string | null {
  let base: string | null = null;
  if (typeof p.decodedDisplayName === 'string' && p.decodedDisplayName) base = p.decodedDisplayName;
  else if (typeof p.fullDisplayName === 'string' && p.fullDisplayName) base = p.fullDisplayName;
  else if (typeof p.displayName === 'string' && p.displayName) base = p.displayName;
  if (!base) return null;
  const size = sku && sku.customerFriendlySize;
  if (typeof size === 'string' && size && base.indexOf(size) === -1) base = `${base}, ${size}`;
  return base;
}

function runPrefsOf(p: any): Array<Record<string, string>> | null {
  const out: Array<Record<string, string>> = [];
  try {
    for (const e of p.purchasePreferenceList.purchasePreferences) {
      const t = e && e.text;
      if (!t) continue;
      const row: Record<string, string> = { text: String(t).trim(), value: String(t).trim() };
      if (e.preferenceId != null) row.preferenceId = String(e.preferenceId);
      out.push(row);
    }
  } catch { /* a product with no preferences is the normal case */ }
  return out.length ? out : null;
}

function runCandidates(items: any[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const p of items) {
    if (!p || p.__typename !== 'Product') continue;
    const sku = (p.SKUs && p.SKUs[0]) || null;
    const name = runNameOf(p, sku);
    if (!name) continue;
    const incr: number[] = (sku && sku.weightSelectionIncrements) || [];
    out.push({
      productName: name,
      imageUrl: runImageOf(p),
      outOfStock: !!(p.inventory && p.inventory.inventoryState !== 'IN_STOCK'),
      preferences: runPrefsOf(p),
      price: runPriceOf(p, sku),
      isWeightItem: !!p.pricedByWeight || incr.length > 0,
      weightOptions: incr.slice(),
      productId: p.id != null ? String(p.id) : null,
      skuId: sku && sku.id != null ? String(sku.id) : null,
      // The store's own per-item cap. The write sets an ABSOLUTE quantity, so
      // cart-held + asked can exceed it and the store refuses the whole write.
      maxOrderQuantity: typeof p.maximumOrderQuantity === 'number' && p.maximumOrderQuantity > 0
        ? p.maximumOrderQuantity : null,
    });
  }
  return out;
}

/** The search params, identical to paramsFor in the injected batch. */
function runParamsFor(term: string, storeId: number, shoppingContext: string) {
  return {
    query: term,
    storeId,
    shoppingContext,
    // Asked for, rather than filtered out afterwards.
    excludeSponsoredContent: true,
    // Out of stock still comes back, flagged, so the review screen can SAY so.
    includeOutOfStock: true,
    pageSize: 40,
  };
}

// ── the cart, shaped exactly as CART_READ_FN shapes it ───────────────────────

type CartLine = {
  quantity?: number; estimatedWeight?: number | null;
  product?: { id?: string; fullDisplayName?: string; maximumOrderQuantity?: number } | null;
  sku?: { id?: string; customerFriendlySize?: string } | null;
};

async function runReadCart(post: PostToSheet): Promise<CartLine[] | null> {
  const r = await hebGql(post, 'CartLines', HEB_CART_LINES_QUERY, {}, 8000, 'cart_read');
  if (!r.ok) return null;
  try {
    const c: any = (r.data as any).cartV2;
    if (!c || c.__typename !== 'Cart') return null;
    return (c.items || []) as CartLine[];
  } catch { return null; }
}

function runRowsOf(lines: CartLine[] | null): Array<Record<string, unknown>> | null {
  if (!lines) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const l of lines) {
    let nm = l && l.product && l.product.fullDisplayName;
    if (!nm) continue;
    nm = String(nm);
    // THE SIZE GOES ON, because the page reader puts it on. These rows are
    // diffed by NAME against rows that read "..., 10 ct" off the card.
    const size = l.sku && l.sku.customerFriendlySize;
    if (typeof size === 'string' && size && nm.indexOf(size) === -1) nm = `${nm}, ${size}`;
    const w = l.estimatedWeight != null ? Number(l.estimatedWeight) : null;
    const row: Record<string, unknown> = { name: nm, qty: Number(l.quantity) || 0 };
    if (l.product && l.product.id) row.itemId = String(l.product.id);
    // A weight line is reconciled by presence, not by count.
    if (w != null && !Number.isNaN(w)) { row.isWeight = true; row.weight = w; }
    out.push(row);
  }
  return out;
}

/** Summed across every line for the product, WITH the line count. */
function runHeld(lines: CartLine[] | null, pid: string) {
  if (!lines) return null;
  let qty = 0; let n = 0; let weight = false;
  for (const l of lines) {
    const lp = l && l.product && l.product.id;
    if (lp == null || String(lp) !== String(pid)) continue;
    qty += l.quantity || 0; n += 1;
    if (l.estimatedWeight != null) weight = true;
  }
  return { qty, lines: n, weight };
}

/** The store's per-product cap, as the CART reports it. */
function runCapFromCart(lines: CartLine[] | null, pid: string): number | null {
  if (!lines) return null;
  for (const l of lines) {
    if (!l || !l.product || String(l.product.id) !== String(pid)) continue;
    const m = l.product.maximumOrderQuantity;
    if (typeof m === 'number' && m > 0) return m;
  }
  return null;
}

// ── the driver ───────────────────────────────────────────────────────────────

const BATCH_TERMS = 6;
const SEARCH_LANES = 3;

export const HEB_NATIVE_RUN: NativeRunDriver = {
  id: 'heb',

  session: () => async (post) => guarded(async () => {
    const who = await hebGql(post, 'myPreferredStore', HEB_WHO_QUERY, {}, 8000, 'session');
    if (!who.ok) {
      post({ type: 'HEB_SESSION', ok: false, why: who.why, status: who.status ?? null,
             detail: who.detail ?? null });
      return;
    }
    let me: string | null = null; let prefNumber: string | null = null;
    try { me = (who.data as any).me && (who.data as any).me.id; } catch { /* signed out */ }
    try { prefNumber = (who.data as any).me.preferredStore.storeNumber; } catch { /* optional */ }
    if (!me) { post({ type: 'HEB_SESSION', ok: true, loggedIn: false }); return; }

    const sess = await hebGql(post, 'SessionContext', HEB_SESSION_QUERY, {}, 8000, 'session');
    let storeId: unknown = null; let storeName: unknown = null; let mode: unknown = null;
    if (sess.ok) {
      try {
        const f = (sess.data as any).cartV2.fulfillment;
        storeId = f.store && f.store.id;
        storeName = f.store && f.store.name;
        mode = f.curbsideFulfillmentMode;
      } catch { /* a cart error arm carries no fulfilment */ }
    }
    post({
      type: 'HEB_SESSION',
      ok: true,
      loggedIn: true,
      storeId: storeId != null ? String(storeId) : null,
      storeName: storeName || null,
      // Pickup and delivery price and stock differently, so this is not cosmetic.
      shoppingContext: mode && String(mode).toUpperCase().indexOf('PICKUP') >= 0
        ? 'CURBSIDE_PICKUP' : 'CURBSIDE_DELIVERY',
      fulfillmentMode: mode || null,
      preferredStoreNumber: prefNumber != null ? String(prefNumber) : null,
      source: 'native',
    });
  }, (detail) => post({ type: 'HEB_SESSION', ok: false, why: 'threw', detail })),

  cartRead: () => async (post) => guarded(async () => {
    const lines = await runReadCart(post);
    if (!lines) {
      // Null is UNKNOWN, never zero. A failed read reporting 0 would tell the
      // reconcile the cart is empty and invite it to re-add everything.
      post({ type: 'CART_COUNT', count: null, reason: 'rail_read_failed', source: 'network' });
      return;
    }
    const rows = runRowsOf(lines) || [];
    const count = rows.reduce((n, r) => n + ((r.qty as number) || 0), 0);
    post({ type: 'CART_COUNT', count, items: rows, source: 'network' });
  }, (detail) => post({ type: 'CART_COUNT', count: null, reason: 'rail_read_threw',
                        source: 'network', detail })),

  searchBatch: (terms, sess: NetworkSession) => {
    // Coerced HERE, and a bad one refuses the batch. `Number('abc')` would have
    // searched store ZERO -- a real store somewhere, answering with a real
    // catalogue for a shop the user has never been to.
    const storeId = Number(sess.storeId);
    if (!Number.isInteger(storeId) || storeId <= 0) return null;
    if (!sess.shoppingContext) return null;
    if (!terms.length) return null;
    const chunks: string[][] = [];
    for (let i = 0; i < terms.length; i += BATCH_TERMS) chunks.push(terms.slice(i, i + BATCH_TERMS));

    return async (post) => guarded(async () => {
      const myGen = nativeGen();
      let stopped = false;

      /** One arm's answer -> this term's message. SHARED, deliberately. */
      const emit = (term: string, page: any) => {
        if (!page) {
          post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term, why: 'unexpected_shape' });
          return;
        }
        if (page.__typename === 'SearchPageError') {
          post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term, why: 'search_page_error',
                 detail: String(page.message || page.code || '').slice(0, 160) });
          return;
        }
        const items = runGridItems(page);
        if (items == null) {
          // A well-formed SearchPage with no product grid is the store saying it
          // has NOTHING. That is a real answer, not a transport failure.
          const seen: string[] = [];
          try {
            for (const v of page.layout.visualComponents) if (v && v.__typename) seen.push(v.__typename);
          } catch { /* the component list is diagnostic only */ }
          post({ type: 'SEARCH_RESULT', source: 'network', term, candidates: [],
                 noGrid: true, components: seen.join(',') });
          return;
        }
        post({ type: 'SEARCH_RESULT', source: 'network', term, candidates: runCandidates(items) });
      };

      const searchOne = async (term: string) => {
        const res = await hebGql(post, 'productSearchPageV2', HEB_SEARCH_QUERY,
          { params: runParamsFor(term, storeId, sess.shoppingContext) }, 9000, 'search');
        if (!res.ok) {
          post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term, why: res.why,
                 detail: res.detail || (res.status ? `status ${res.status}` : null) });
          return;
        }
        let page: any = null;
        try { page = (res.data as any).productSearchPageV2; } catch { /* emit reports it */ }
        emit(term, page);
      };

      const searchChunk = async (chunk: string[]) => {
        // A one-term chunk IS the single search.
        if (chunk.length === 1) { await searchOne(chunk[0]); return; }
        const vmap: Record<string, unknown> = {};
        chunk.forEach((t, i) => { vmap[`p${i}`] = runParamsFor(t, storeId, sess.shoppingContext); });
        const res = await hebGql(post, 'productSearchesV2', hebSearchBatchDoc(chunk.length), vmap,
          9000 + chunk.length * 1500, 'search');
        if (!res.ok) {
          // A document-level failure must not cost the terms in it.
          post({ type: 'SEARCH_BATCH_FELL_BACK', source: 'network', count: chunk.length,
                 why: res.why || null,
                 detail: res.detail || (res.status ? `status ${res.status}` : null) });
          for (const t of chunk) await searchOne(t);
          return;
        }
        chunk.forEach((t, k) => {
          let node: any = null;
          try { node = (res.data as any)[`a${k}`]; } catch { /* emit reports it */ }
          emit(t, node);
        });
      };

      // A fixed-size pool over the CHUNKS, not Promise.all: a burst of twelve
      // simultaneous requests is a shape nothing has measured.
      let next = 0;
      const runner = async () => {
        for (;;) {
          // Per chunk, which on this rail is the finest grain there is.
          if (nativeGen() !== myGen) { stopped = true; return; }
          const i = next; next += 1;
          if (i >= chunks.length) return;
          try { await searchChunk(chunks[i]); } catch (e) {
            // Per TERM, not per chunk: the caller falls back for just the terms
            // it never heard about.
            for (const t of chunks[i]) {
              post({ type: 'SEARCH_RESULT_FAILED', source: 'network', term: t,
                     why: 'threw', detail: String(e).slice(0, 120) });
            }
          }
        }
      };
      const lanes: Array<Promise<void>> = [];
      for (let l = 0; l < SEARCH_LANES && l < chunks.length; l += 1) lanes.push(runner());
      await Promise.all(lanes);
      post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: terms.length, stopped });
    }, (detail) => post({ type: 'SEARCH_BATCH_DONE', source: 'network', count: terms.length,
                          threw: detail }));
  },

  addBatch: (items, opts) => {
    // H-E-B addresses a cart line by sku, so an item without one is not writable
    // here; the filter is the store's constraint, not a shared rule.
    const usable = (items as NetworkAddItem[])
      .filter((i) => i && i.productId && i.skuId
        && Number.isInteger(i.quantity) && i.quantity > 0)
      .map((i) => ({ ...i, skuId: String(i.skuId) }));
    if (!usable.length) return null;

    return async (post) => guarded(async () => {
      const report = (it: typeof usable[number], ok: boolean, reason?: string, detail?: string) => {
        post({ type: 'NET_ADD_RESULT', idx: it.idx, name: it.name, productId: it.productId,
               skuId: it.skuId, asked: it.quantity, success: !!ok,
               reason: reason || null, detail: detail || null });
      };

      const before = await runReadCart(post);
      if (before == null) {
        // No baseline means no way to know what to SET. Guessing would drop
        // whatever the cart already held, silently.
        for (const it of usable) report(it, false, 'no_cart_baseline');
        post({ type: 'NET_ADD_DONE', count: usable.length, wrote: 0 });
        return;
      }
      void opts;

      let wrote = 0;
      const accepted: Array<{ it: typeof usable[number]; want: number }> = [];
      const planned: Array<{
        it: typeof usable[number]; want: number; base: number;
        vars: Record<string, unknown>;
      }> = [];

      for (const it of usable) {
        try {
          if (it.isWeightItem) { report(it, false, 'weight_item_declined'); continue; }
          const h = runHeld(before, it.productId);
          if (h && h.weight) { report(it, false, 'cart_line_is_weight'); continue; }
          if (h && h.lines > 1) { report(it, false, 'multiple_cart_lines'); continue; }
          // A single existing line is not necessarily OUR line: lines are keyed
          // by preference, and the cart read cannot say which one a line is.
          if (it.purchasePreferenceId && h && h.lines > 0) {
            report(it, false, 'preference_line_ambiguous',
              `cart already holds ${h.qty} of this product`);
            continue;
          }
          const base = h ? h.qty : 0;
          // ADD ON TOP OF WHAT IS THERE. Stephen chose this knowingly on
          // 2026-09-01: an item already in the cart is treated as the user's, so
          // re-running the same meals doubles them. Do not "fix" it into
          // max(base, asked) without asking him again.
          let want = base + it.quantity;
          let cap = typeof it.maxOrderQuantity === 'number' && it.maxOrderQuantity > 0
            ? it.maxOrderQuantity : null;
          // THE CART'S OWN ANSWER, when the search never gave us one: a run whose
          // products were already chosen never searched and carries no cap.
          if (cap == null) {
            const cartCap = runCapFromCart(before, it.productId);
            if (cartCap != null) cap = cartCap;
          }
          if (cap != null && want > cap) {
            // Clamping to a number the cart ALREADY holds would write no change
            // and report success, which is an under-add dressed as a win.
            if (base >= cap) {
              report(it, false, 'quantity_limit_reached', `cart already holds ${base} of ${cap}`);
              continue;
            }
            want = cap;
          }
          const vars: Record<string, unknown> = {
            productId: it.productId, skuId: it.skuId, quantity: want,
          };
          // Only sent when there is one. A null preference on a product that
          // offers them is a different statement from an absent one.
          if (it.purchasePreferenceId) vars.purchasePreferenceId = it.purchasePreferenceId;
          planned.push({ it, want, base, vars });
        } catch (e) {
          report(it, false, 'threw', String(e).slice(0, 120));
        }
      }

      /** Turn one mutation's answer into this item's verdict. */
      const applyOne = (
        p: typeof planned[number], data: any, why?: string | null, detail?: string | null,
      ) => {
        const { it } = p;
        if (why) { report(it, false, why, detail || undefined); return; }
        let arm: string | null = null; let msg: string | null = null; let code: string | null = null;
        try {
          const a = data.addItemToCartV2;
          arm = a && a.__typename;
          msg = a && a.message ? String(a.message).slice(0, 160) : null;
          code = a && (a.code || a.errorCode) ? String(a.code || a.errorCode) : null;
        } catch { /* an unreadable arm is reported as unexpected_shape below */ }
        // AddOnsCart wraps a cart -- the item went in. ACCEPTED, NOT LANDED:
        // verified against the read below.
        const ok = arm === 'Cart' || arm === 'AddOnsCart';
        if (ok) { wrote += 1; accepted.push({ it, want: p.want }); }
        // UNAVAILABLE IS OUT OF STOCK, and the difference is everything the user
        // can do about it. The code is a fast path, not a gate: H-E-B sends
        // 'UNKNOWN' with the words in the message, measured 2026-09-04.
        const unavailable = !ok && (
          (!!code && /OUT_OF_STOCK|UNAVAILABLE/i.test(code))
          || (!!msg && /out of stock|unavailable|not available/i.test(msg)));
        post({ type: 'NET_ADD_RESULT', idx: it.idx, name: it.name, productId: it.productId,
               skuId: it.skuId, asked: it.quantity, sent: p.want, base: p.base,
               preferenceId: it.purchasePreferenceId || null,
               success: ok,
               reason: ok ? null : unavailable ? 'out_of_stock' : arm ? 'error_arm' : 'unexpected_shape',
               detail: msg || null, code: code || null, arm: arm || null });
      };

      if (planned.length > 0) {
        const vmap: Record<string, unknown> = {};
        planned.forEach((p, i) => {
          vmap[`p${i}`] = p.vars.productId;
          vmap[`s${i}`] = p.vars.skuId;
          vmap[`q${i}`] = p.vars.quantity;
          // Left UNDEFINED when there is none: sending null would state a
          // preference of "none".
          if (p.vars.purchasePreferenceId) vmap[`r${i}`] = p.vars.purchasePreferenceId;
        });
        const bres = await hebGql(post, 'cartItemsV2', hebAddBatchDoc(planned.length), vmap,
          9000 + planned.length * 1500, 'add');
        if (!bres.ok) {
          post({ type: 'NET_ADD_BATCH_FELL_BACK', count: planned.length, why: bres.why || null });
          for (const p of planned) {
            const r1 = await hebGql(post, 'cartItemV2', HEB_ADD_MUTATION, p.vars, 9000, 'add');
            applyOne(p, r1.ok ? r1.data : null, r1.ok ? null : (r1.why || 'network'), r1.detail);
          }
        } else {
          planned.forEach((p, i) => {
            let node: any = null;
            try { node = (bres.data as any)[`a${i}`]; } catch { /* below */ }
            applyOne(p, node ? { addItemToCartV2: node } : null, node ? null : 'unexpected_shape');
          });
        }
      }

      let after = await runReadCart(post);

      // VERIFY EVERY ACCEPTED WRITE AGAINST THAT READ, AND RETRY WHAT IS MISSING.
      // The per-write answer is the mutation's return TYPE; it cannot say whether
      // the item is in the cart, and once it did not.
      if (after) {
        const missing = accepted.filter((a) => {
          const h2 = runHeld(after, a.it.productId);
          return !h2 || h2.qty < a.want;
        });
        if (missing.length > 0) {
          post({ type: 'NET_ADD_UNLANDED', source: 'network', count: missing.length,
                 names: missing.map((m) => m.it.name) });
          for (const m of missing) {
            try {
              const vars2: Record<string, unknown> = {
                productId: String(m.it.productId), skuId: String(m.it.skuId), quantity: m.want,
              };
              if (m.it.purchasePreferenceId) vars2.purchasePreferenceId = String(m.it.purchasePreferenceId);
              await hebGql(post, 'cartItemV2', HEB_ADD_MUTATION, vars2, 9000, 'add');
            } catch { /* the re-read below is what decides */ }
          }
          after = await runReadCart(post);
          for (const m of missing) {
            const h3 = runHeld(after, m.it.productId);
            const landed = !!(h3 && h3.qty >= m.want);
            if (!landed) wrote -= 1;
            post({ type: 'NET_ADD_RESULT', idx: m.it.idx, name: m.it.name,
                   productId: m.it.productId, skuId: m.it.skuId,
                   asked: m.it.quantity, sent: m.want, base: m.want - m.it.quantity,
                   preferenceId: m.it.purchasePreferenceId || null,
                   success: landed, reason: landed ? null : 'cart_not_incremented',
                   detail: landed ? 'landed on retry' : 'accepted but absent from the cart' });
          }
        }
      }
      post({ type: 'NET_ADD_DONE', count: usable.length, wrote,
             cartLines: after ? after.length : null,
             cartBefore: runRowsOf(before), cartAfter: runRowsOf(after) });
    }, (detail) => post({ type: 'NET_ADD_DONE', count: usable.length, wrote: 0, threw: detail }));
  },
};
