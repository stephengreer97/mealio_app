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
