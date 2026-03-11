export interface Store {
  id: string;
  name: string;
  color: string;
}

export const STORES: Store[] = [
  { id: 'acme',           name: 'Acme Markets',        color: '#C8102E' },
  { id: 'aldi',           name: 'ALDI',                color: '#00529F' },
  { id: 'albertsons',     name: 'Albertsons',          color: '#00529F' },
  { id: 'amazon',         name: 'Amazon Fresh',        color: '#FF9900' },
  { id: 'bakers',         name: "Baker's",             color: '#003087' },
  { id: 'balduccis',      name: "Balducci's",          color: '#2E7D32' },
  { id: 'carrs',          name: 'Carrs',               color: '#003087' },
  { id: 'central_market', name: 'Central Market',      color: '#005F3E' },
  { id: 'city_market',    name: 'City Market',         color: '#003087' },
  { id: 'costco',         name: 'Costco',              color: '#005DAA' },
  { id: 'dillons',        name: 'Dillons',             color: '#003087' },
  { id: 'fred_meyer',     name: 'Fred Meyer',          color: '#003087' },
  { id: 'frys',           name: "Fry's Food",          color: '#003087' },
  { id: 'haggen',         name: 'Haggen',              color: '#007A4D' },
  { id: 'heb',            name: 'H-E-B',               color: '#E31837' },
  { id: 'harris_teeter',  name: 'Harris Teeter',       color: '#00529F' },
  { id: 'jewel_osco',     name: 'Jewel-Osco',          color: '#C8102E' },
  { id: 'king_soopers',   name: 'King Soopers',        color: '#003087' },
  { id: 'kings',          name: 'Kings Food Markets',  color: '#C8102E' },
  { id: 'kroger',         name: 'Kroger',              color: '#003087' },
  { id: 'marianos',       name: "Mariano's",           color: '#003087' },
  { id: 'metro_market',   name: 'Metro Market',        color: '#003087' },
  { id: 'pay_less',       name: 'Pay-Less',            color: '#003087' },
  { id: 'pavilions',      name: 'Pavilions',           color: '#00529F' },
  { id: 'pick_n_save',    name: "Pick 'n Save",        color: '#003087' },
  { id: 'qfc',            name: 'QFC',                 color: '#003087' },
  { id: 'ralphs',         name: 'Ralphs',              color: '#C8102E' },
  { id: 'randalls',       name: 'Randalls',            color: '#00529F' },
  { id: 'safeway',        name: 'Safeway',             color: '#C8102E' },
  { id: 'shaws',          name: "Shaw's",              color: '#C8102E' },
  { id: 'smiths',         name: "Smith's Food & Drug", color: '#003087' },
  { id: 'star_market',    name: 'Star Market',         color: '#C8102E' },
  { id: 'tom_thumb',      name: 'Tom Thumb',           color: '#00529F' },
  { id: 'vons',           name: 'Vons',                color: '#00529F' },
  { id: 'walmart',        name: 'Walmart',             color: '#0071CE' },
  { id: 'wegmans',        name: 'Wegmans',             color: '#007A4D' },
];
