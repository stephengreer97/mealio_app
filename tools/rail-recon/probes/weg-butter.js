// READ ONLY. What the index says about a product Stephen says is sold by unit.
(async () => {
  const q = async (query) => {
    const r = await fetch('https://qgppr19v8v-dsn.algolia.net/1/indexes/*/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json',
        'x-algolia-application-id': 'QGPPR19V8V', 'x-algolia-api-key': '9a10b1401634e9a6e55161c3a60c200d' },
      body: JSON.stringify({ requests: [{ indexName: 'products', query,
        filters: 'storeNumber:140 AND excludeFromWeb:false AND isSoldAtStore:true AND fulfilmentType:pickup',
        hitsPerPage: 4 }] }),
    });
    const j = JSON.parse(await r.text());
    return ((j.results && j.results[0] && j.results[0].hits) || []).map((h) => ({
      name: String(h.productName || '').slice(0, 44),
      sku: h.skuId,
      isSoldByWeight: h.isSoldByWeight,
      onlineSellByUnit: h.onlineSellByUnit,
      onlineApproxUnitWeight: h.onlineApproxUnitWeight,
      unitPrice: (h.price_pickup && h.price_pickup.unitPrice) || (h.price_delivery && h.price_delivery.unitPrice),
      amount: (h.price_pickup && h.price_pickup.amount) || (h.price_delivery && h.price_delivery.amount),
      sellBy: h.sellBy, uom: h.uom, weightUOM: h.weightUOM, averageWeight: h.averageWeight,
    }));
  };
  return {
    butter: await q('Butter Boy French Butter'),
    // A control: something genuinely sold by weight.
    deli: await q('sliced turkey breast per lb'),
  };
})()
