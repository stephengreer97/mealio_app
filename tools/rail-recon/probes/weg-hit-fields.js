// READ ONLY. What a single Algolia hit carries, so a write can be built from it.
(async () => {
  const r = await fetch('https://QGPPR19V8V-dsn.algolia.net/1/indexes/*/queries', {
    method: 'POST',
    headers: { 'content-type': 'application/json',
      'x-algolia-application-id': 'QGPPR19V8V',
      'x-algolia-api-key': '9a10b1401634e9a6e55161c3a60c200d' },
    body: JSON.stringify({ requests: [{ indexName: 'products', query: 'capers',
      filters: 'storeNumber:140 AND excludeFromWeb:false AND isSoldAtStore:true AND fulfilmentType:pickup',
      hitsPerPage: 1 }] }),
  });
  const j = JSON.parse(await r.text());
  const h = (j.results && j.results[0] && j.results[0].hits && j.results[0].hits[0]) || null;
  if (!h) return { why: 'no hit', peek: JSON.stringify(j).slice(0, 200) };
  const want = ['sku', 'name', 'category', 'categoryId', 'planogram', 'ebtEligible', 'isSoldAtStore',
    'isAvailable', 'bottleDeposit', 'upc', 'fulfilmentType', 'fulfillmentTypes', 'maxQuantity',
    'isSoldByWeight', 'onlineSellByUnit', 'onlineApproxUnitWeight', 'isAlcoholic', 'price_pickup',
    'price_delivery', 'storeNumber', 'objectID'];
  const out = { allKeys: Object.keys(h).slice(0, 60), picked: {} };
  for (const k of want) if (h[k] !== undefined) out.picked[k] = typeof h[k] === 'object' ? JSON.stringify(h[k]).slice(0, 160) : h[k];
  return out;
})()
