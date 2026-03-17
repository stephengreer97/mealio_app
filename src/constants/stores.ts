export interface Store {
  id: string;
  name: string;
  color: string;
}

// All stores in the Kroger corporate family (supported via Kroger API OAuth)
export const KROGER_BRAND_IDS = new Set([
  'kroger', 'king_soopers', 'ralphs', 'fred_meyer', 'frys', 'qfc',
  'harris_teeter', 'marianos', 'smiths', 'bakers', 'dillons', 'pay_less',
  'pick_n_save', 'metro_market', 'carrs', 'city_market',
]);

export function isKrogerBrand(storeId: string): boolean {
  return KROGER_BRAND_IDS.has(storeId);
}

export const STORES: Store[] = [
  { id: 'acme',           name: 'Acme Markets',        color: '#F04035' },
  { id: 'aldi',           name: 'ALDI',                color: '#02205F' },
  { id: 'albertsons',     name: 'Albertsons',          color: '#009ee5' },
  { id: 'amazon',         name: 'Amazon Fresh',        color: '#78BD21' },
  { id: 'bakers',         name: "Baker's",             color: '#EE3124' },
  { id: 'balduccis',      name: "Balducci's",          color: '#8D2B1E' },
  { id: 'carrs',          name: 'Carrs',               color: '#E5171D' },
  { id: 'central_market', name: 'Central Market',      color: '#005732' },
  { id: 'city_market',    name: 'City Market',         color: '#EE3124' },
  { id: 'costco',         name: 'Costco',              color: '#E31936' },
  { id: 'dillons',        name: 'Dillons',             color: '#CA2128' },
  { id: 'fred_meyer',     name: 'Fred Meyer',          color: '#D7282F' },
  { id: 'frys',           name: "Fry's Food",          color: '#E1251B' },
  { id: 'haggen',         name: 'Haggen',              color: '#025635' },
  { id: 'heb',            name: 'H-E-B',               color: '#dd0031' },
  { id: 'harris_teeter',  name: 'Harris Teeter',       color: '#A32036' },
  { id: 'jewel_osco',     name: 'Jewel-Osco',          color: '#E12C47' },
  { id: 'king_soopers',   name: 'King Soopers',        color: '#005DAA' },
  { id: 'kings',          name: 'Kings Food Markets',  color: '#417EC0' },
  { id: 'kroger',         name: 'Kroger',              color: '#0E51A1' },
  { id: 'marianos',       name: "Mariano's",           color: '#64433D' },
  { id: 'metro_market',   name: 'Metro Market',        color: '#63463E' },
  { id: 'pay_less',       name: 'Pay-Less',            color: '#D8232A' },
  { id: 'pavilions',      name: 'Pavilions',           color: '#2D2B29' },
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
  { id: 'walmart',        name: 'Walmart',             color: '#0053E2' },
  { id: 'wegmans',        name: 'Wegmans',             color: '#000000' },
];
