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

export const STORES: Store[] = [
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
  STORES.push({ id: 'mockstore', name: 'Mock Store', color: '#0a7d4b' });
}
