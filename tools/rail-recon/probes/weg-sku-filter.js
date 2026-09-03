(async () => {
  const call = async (filters) => {
    const r = await fetch('https://qgppr19v8v-dsn.algolia.net/1/indexes/*/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json',
        'x-algolia-application-id': 'QGPPR19V8V', 'x-algolia-api-key': '9a10b1401634e9a6e55161c3a60c200d' },
      body: JSON.stringify({ requests: [{ indexName: 'products', query: '', filters, hitsPerPage: 1 }] }),
    });
    const j = JSON.parse(await r.text());
    const res = (j.results && j.results[0]) || {};
    return { n: res.nbHits, sku: res.hits && res.hits[0] && res.hits[0].skuId, err: j.message };
  };
  return {
    bare: await call('storeNumber:140 AND skuId:75994'),
    quoted: await call('storeNumber:140 AND skuId:"75994"'),
    objectID: await call('objectID:"140-75994"'),
    productId: await call('storeNumber:140 AND productId:"75994"'),
  };
})()
