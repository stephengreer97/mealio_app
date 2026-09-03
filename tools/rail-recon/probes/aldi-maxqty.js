// READ ONLY. Does an ALDI item carry a purchase limit we could respect?
(async () => {
  await IC.ensureOps({}, 12000);
  const tries = await IC.findShopId('aldi', 15000);
  let shop = null;
  for (const t of tries) if (t && t.v) { shop = String(t.v); break; }
  const r = await IC.gql('Search', { query: 'crushed tomatoes', shopId: shop, pageSource: 'search',
    elevatedItemIds: [], searchSource: 'search', orderBy: 'default', filters: [], action: null,
    clusterId: null, includeDebugInfo: false, retailerInventorySessionToken: null,
    postalCode: '00000', crossRetailerSearch: false }, 20000);
  if (!r.ok) return { why: r.why, detail: r.detail };
  let items = [];
  try { items = r.data.searchResults.primaryItemResultList.items || []; } catch (e) {}
  const first = items[0];
  if (!first) return { why: 'no items' };
  const names = [];
  const walk = (n, p, d) => {
    if (n == null || d > 4 || names.length > 60) return;
    if (Array.isArray(n)) { if (n[0]) walk(n[0], p + '[]', d + 1); return; }
    if (typeof n === 'object') { for (const k of Object.keys(n)) walk(n[k], p ? p + '.' + k : k, d + 1); return; }
    if (/max|limit|quantit|qty|increment|step/i.test(p)) names.push(p + ' = ' + String(n).slice(0, 20));
  };
  walk(first, '', 0);
  return { topKeys: Object.keys(first).slice(0, 24), limitish: names.slice(0, 20) };
})()
