(async () => {
  const r = await fetch('https://qgppr19v8v-dsn.algolia.net/1/indexes/*/queries', {
    method: 'POST',
    headers: { 'content-type': 'application/json',
      'x-algolia-application-id': 'QGPPR19V8V', 'x-algolia-api-key': '9a10b1401634e9a6e55161c3a60c200d' },
    body: JSON.stringify({ requests: [{ indexName: 'products', query: 'prepared horseradish',
      filters: 'storeNumber:140 AND excludeFromWeb:false AND isSoldAtStore:true AND fulfilmentType:pickup',
      hitsPerPage: 3 }] }),
  });
  const j = JSON.parse(await r.text());
  const hits = (j.results && j.results[0] && j.results[0].hits) || [];
  return hits.map((h) => ({ sku: h.skuId, name: String(h.productName || h.name || '').slice(0, 40) }));
})()
