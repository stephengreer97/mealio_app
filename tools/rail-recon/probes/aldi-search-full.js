(async () => {
  const gql = async (name, hash, variables) => {
    const t0 = Date.now();
    const r = await fetch('/graphql', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
      body: JSON.stringify({ operationName: name, variables,
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }),
    });
    const t = await r.text();
    return { ms: Date.now() - t0, status: r.status, bytes: t.length, body: t };
  };
  const r = await gql('Search', '6d77b6fd5b62f6d88999f5a022af16fafcb00de911da6b942990f61a478ed8c1',
    { query: 'sour cream', shopId: '8583', zoneId: '23898', postalCode: '00000' });
  const out = { ms: r.ms, status: r.status, bytes: r.bytes };
  try {
    const j = JSON.parse(r.body);
    out.errorCount = (j.errors || []).length;
    out.firstError = j.errors ? String(j.errors[0].message) + ' at ' + (j.errors[0].path || []).join('.') : null;
    // What does it actually give back? Report the shape rather than assume.
    out.topKeys = Object.keys(j.data || {});
    var items = [];
    try { items = j.data.searchResults.primaryItemResultList.items || []; } catch (e) {}
    out.itemCount = items.length;
    out.sample = items.slice(0, 3).map(function (it) {
      var vs = it.viewSection || {};
      return { id: it.id, name: it.name || vs.titleString || null,
               price: (vs.priceString || (it.price && it.price.viewSection && it.price.viewSection.priceString)) || null,
               keys: Object.keys(it).slice(0, 14) };
    });
  } catch (e) { out.parseErr = String(e).slice(0, 90); out.raw = r.body.slice(0, 300); }
  return out;
})()
