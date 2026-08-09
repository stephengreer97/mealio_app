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

import { MOCK_STORE_ENABLED } from '../lib/webview-scripts/mockstore';

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
  'heb', 'walmart', 'aldi', 'amazon', 'wegmans',
  // Albertsons family — all use the same platform
  'albertsons', 'safeway', 'vons', 'jewel_osco', 'shaws', 'acme',
  'tom_thumb', 'randalls', 'pavilions', 'star_market', 'haggen',
  'carrs', 'kings', 'balduccis', 'united',
  'mockstore',   // dev/test only — deterministic store for Maestro e2e
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
 *
 * `mockstore` is special-cased for the same reason it is appended to
 * BUNDLED_STORES conditionally: it lives in WEBVIEW_STORE_IDS unconditionally
 * (selectorHealth derives its coverage from that set and must keep seeing it),
 * so without this line a remote row named `mockstore` would surface the dev
 * store in a production build.
 */
export function isSupportedStore(storeId: string): boolean {
  if (storeId === 'mockstore') return MOCK_STORE_ENABLED;
  return isKrogerBrand(storeId) || isWebViewStore(storeId);
}

/**
 * Offline fallback for the store catalog. The live list is getStores().
 *
 * Order is meaningful only in that it is stable: entries the remote catalog adds
 * are appended after these, and every picker sorts by name anyway.
 */
export const BUNDLED_STORES: Store[] = [
  { id: 'acme',           name: 'Acme Markets',        color: '#F04035' },
  { id: 'albertsons',     name: 'Albertsons',          color: '#009ee5' },
  { id: 'aldi',           name: 'ALDI',                color: '#02205F' },
  { id: 'amazon',         name: 'Amazon Fresh',        color: '#78BD21' },
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

// Dev/e2e only: surface the deterministic mock store in the store list so
// Maestro can save a meal at it and run the full add-to-cart flow. Excluded from
// production builds (the e2e flag is unset there).
if (MOCK_STORE_ENABLED) {
  BUNDLED_STORES.push({ id: 'mockstore', name: 'Mock Store', color: '#0a7d4b' });
}
