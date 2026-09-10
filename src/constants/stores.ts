// Which stores exist, and what THIS BUILD can do with them.
//
// Two kinds of fact live here and they must not be confused (MEAL-23):
//
//   • BUNDLED_STORES is DISPLAY data — id, name, colour. It is the offline
//     fallback for a catalog that is now fetched from mealio.co, so adding a
//     store is a database row rather than an App Store release. Read it through
//     getStores() in src/lib/store-catalog, never directly.
//
//   • KROGER_BRAND_IDS / WEBVIEW_STORE_IDS are CAPABILITY. They assert "this
//     binary contains code for this store" — the OAuth path for the first, the
//     WebView automation scripts for the second. They are deliberately NOT
//     remote and must never become remote: the scripts ship in the binary, and
//     no server response can make them exist. A remote value here would let a
//     database row promise automation the installed app cannot deliver
//     (getStoreScripts returns null, and per MEAL-31 the worker pools then get
//     undefined builders). Capability ships with the binary or it is a lie.
//
// Until MEAL-23 the two coincided exactly: every catalog entry sat in exactly
// one capability set and neither set had an orphan (15 + 21 = 36). That is no
// longer an invariant — the server can name a store this build has no code for.
// isSupportedStore() below is where that case is decided.

export interface Store {
  id: string;
  name: string;
  color: string;
}

// All stores in the Kroger corporate family (supported via Kroger API OAuth)
export const KROGER_BRAND_IDS = new Set([
  'kroger', 'king_soopers', 'ralphs', 'fred_meyer', 'frys', 'qfc',
  'harris_teeter', 'marianos', 'smiths', 'bakers', 'dillons', 'pay_less',
  'pick_n_save', 'metro_market', 'city_market',
]);

export function isKrogerBrand(storeId: string): boolean {
  return KROGER_BRAND_IDS.has(storeId);
}

// Stores supported via in-app WebView cart automation
export const WEBVIEW_STORE_IDS = new Set([
  'heb', 'walmart', 'aldi', 'wegmans',
  // Instacart Storefront banners sharing ALDI's rail. The scripts for these
  // genuinely ship in this binary, which is the only thing this set asserts.
  // Whether a banner ANSWERS the rail is a different question, held by
  // `proven` in webview-scripts/instacart.ts and by the server catalog: none of
  // these four is in BUNDLED_STORES or has a catalog row, so none is offered.
  'publix', 'sprouts', 'the_fresh_market', 'costco_sameday',
  // Added 2026-09-07. Each origin was checked for the platform's signature and
  // its slug read out of its own storefront links -- see INSTACART_TENANTS,
  // where the slugs and the chains that are NOT on this platform are recorded.
  'price_chopper', 'bristol_farms', 'save_mart', 'gelsons', 'dierbergs',
  // Albertsons family — all use the same platform
  'albertsons', 'safeway', 'vons', 'jewel_osco', 'shaws', 'acme',
  'tom_thumb', 'randalls', 'pavilions', 'star_market', 'haggen',
  'carrs', 'kings', 'balduccis', 'united',
]);

export function isWebViewStore(storeId: string): boolean {
  return WEBVIEW_STORE_IDS.has(storeId);
}

/**
 * True when this build actually has code to put a cart together at this store.
 *
 * The single gate the remote catalog is filtered through (see getStores()). A
 * store the server names but this binary cannot drive is treated exactly as it
 * is treated today — as not existing — so the behaviour of shipping the remote
 * catalog is, for every store that exists right now, byte-identical.
 *
 * Reversing that decision is deleting the filter in getStores(); it is not
 * spread across the call sites, on purpose, because it is on Stephen's list to
 * revisit.
 */
export function isSupportedStore(storeId: string): boolean {
  return isKrogerBrand(storeId) || isWebViewStore(storeId);
}

/**
 * Offline fallback for the store catalog. The live list is getStores().
 *
 * Order is meaningful only in that it is stable: entries the remote catalog adds
 * are appended after these, and every picker sorts by name anyway.
 */
/**
 * Family names a store should also answer to when someone searches the picker
 * (MEAL-229).
 *
 * "Kroger" has to surface Ralphs and Fry's, and "Albertsons" has to surface Tom
 * Thumb, because that is how people hold these: they know who owns their store
 * even when the sign over the door says something else.
 *
 * WHY THIS IS NOT READ FROM THE SERVER, where the same fact lives as
 * `stores.banner_group`. That column is deliberately not on the wire, and
 * `tests/api/stores.test.ts` has a leak sentinel to keep it there: on the seeded
 * rows `banner_group` partitions the catalog exactly like the app's capability
 * sets, so a client reads it as a RULE and applies it to rows the binary has
 * never seen -- which is the one question only the binary can answer. Serving it
 * "just for search" would put the field in front of the next reader with that
 * warning nowhere in sight. Overturning that is a decision worth taking
 * deliberately, not a side effect of adding a search box.
 *
 * So this is DISPLAY data in the binary, the same category as BUNDLED_STORES,
 * and it claims nothing about what this build can drive. The cost is honest and
 * small: a store added by catalog row alone has no family keyword until a
 * release, and until then it still matches on its own name.
 */
const KROGER_FAMILY = ['Kroger'];
const ALBERTSONS_FAMILY = ['Albertsons'];
export const STORE_SEARCH_ALIASES: Record<string, string[]> = {
  // Kroger banners
  bakers: KROGER_FAMILY,
  city_market: KROGER_FAMILY,
  dillons: KROGER_FAMILY,
  fred_meyer: KROGER_FAMILY,
  frys: KROGER_FAMILY,
  harris_teeter: KROGER_FAMILY,
  king_soopers: KROGER_FAMILY,
  marianos: KROGER_FAMILY,
  metro_market: KROGER_FAMILY,
  pay_less: KROGER_FAMILY,
  pick_n_save: KROGER_FAMILY,
  qfc: KROGER_FAMILY,
  ralphs: KROGER_FAMILY,
  smiths: KROGER_FAMILY,
  // Albertsons banners
  acme: ALBERTSONS_FAMILY,
  balduccis: ALBERTSONS_FAMILY,
  carrs: ALBERTSONS_FAMILY,
  haggen: ALBERTSONS_FAMILY,
  jewel_osco: ALBERTSONS_FAMILY,
  kings: ALBERTSONS_FAMILY,
  pavilions: ALBERTSONS_FAMILY,
  randalls: ALBERTSONS_FAMILY,
  safeway: ALBERTSONS_FAMILY,
  shaws: ALBERTSONS_FAMILY,
  star_market: ALBERTSONS_FAMILY,
  tom_thumb: ALBERTSONS_FAMILY,
  united: ALBERTSONS_FAMILY,
  vons: ALBERTSONS_FAMILY,
};

export const BUNDLED_STORES: Store[] = [
  { id: 'acme',           name: 'Acme Markets',        color: '#F04035' },
  { id: 'albertsons',     name: 'Albertsons',          color: '#009ee5' },
  { id: 'aldi',           name: 'ALDI',                color: '#02205F' },
  { id: 'bakers',         name: "Baker's",             color: '#EE3124' },
  { id: 'balduccis',      name: "Balducci's",          color: '#8D2B1E' },
  { id: 'carrs',          name: 'Carrs',               color: '#E5171D' },
  { id: 'city_market',    name: 'City Market',         color: '#EE3124' },
  { id: 'dillons',        name: 'Dillons',             color: '#CA2128' },
  { id: 'fred_meyer',     name: 'Fred Meyer',          color: '#D7282F' },
  { id: 'frys',           name: "Fry's Food",          color: '#E1251B' },
  { id: 'haggen',         name: 'Haggen',              color: '#025635' },
  { id: 'harris_teeter',  name: 'Harris Teeter',       color: '#A32036' },
  { id: 'heb',            name: 'H-E-B',               color: '#dd0031' },
  { id: 'jewel_osco',     name: 'Jewel-Osco',          color: '#E12C47' },
  { id: 'king_soopers',   name: 'King Soopers',        color: '#005DAA' },
  { id: 'kings',          name: 'Kings Food Markets',  color: '#417EC0' },
  { id: 'kroger',         name: 'Kroger',              color: '#0E51A1' },
  { id: 'marianos',       name: "Mariano's",           color: '#64433D' },
  { id: 'metro_market',   name: 'Metro Market',        color: '#63463E' },
  { id: 'pavilions',      name: 'Pavilions',           color: '#2D2B29' },
  { id: 'pay_less',       name: 'Pay-Less',            color: '#D8232A' },
  { id: 'pick_n_save',    name: "Pick 'n Save",        color: '#243444' },
  { id: 'qfc',            name: 'QFC',                 color: '#006BB6' },
  { id: 'ralphs',         name: 'Ralphs',              color: '#EA0029' },
  { id: 'randalls',       name: 'Randalls',            color: '#02365E' },
  { id: 'safeway',        name: 'Safeway',             color: '#E5161E' },
  { id: 'shaws',          name: "Shaw's",              color: '#F48424' },
  { id: 'smiths',         name: "Smith's Food & Drug", color: '#D51E48' },
  { id: 'star_market',    name: 'Star Market',         color: '#7AC142' },
  { id: 'tom_thumb',      name: 'Tom Thumb',           color: '#0435A6' },
  { id: 'vons',           name: 'Vons',                color: '#E41720' },
  { id: 'united',         name: 'United Supermarkets', color: '#003087' },
  { id: 'walmart',        name: 'Walmart',             color: '#0053E2' },
  { id: 'wegmans',        name: 'Wegmans',             color: '#000000' },
];
