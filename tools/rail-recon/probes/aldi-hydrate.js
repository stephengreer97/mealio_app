// ItemDetailsRetailerProduct returned retailerProducts: [] for ids the search
// itself had just handed back. Something about (ids, zoneId) is wrong. Try the
// combinations rather than guess.
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
    return { ms: Date.now() - t0, status: r.status, body: t.slice(0, 500) };
  };
  const SEARCH = '19889f981af1f9c5c70543f3d7555bf0d435e026fc96329984fc3414e3b56d8e';
  const DETAIL = '5ac2d820f689a151c7dbaccefbbcb4b59d1c84db56a667a6b90d0137d5e72cca';
  const SHOP = '8583';

  const s = await gql('AsyncItemSearch', SEARCH,
    { query: 'sour cream', shopId: SHOP, postalCode: '00000', searchSource: 'search' });
  let ids = [];
  try { ids = JSON.parse(s.body.length < 500 ? s.body : '{}').data.itemSearch.itemResultList.itemIds; } catch (e) {}
  if (!ids.length) {
    const full = await fetch('/graphql', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-client-identifier': 'mobile_web' },
      body: JSON.stringify({ operationName: 'AsyncItemSearch', variables:
        { query: 'sour cream', shopId: SHOP, postalCode: '00000', searchSource: 'search' },
        extensions: { persistedQuery: { version: 1, sha256Hash: SEARCH } } }),
    });
    const j = await full.json();
    try { ids = j.data.itemSearch.itemResultList.itemIds; } catch (e) {}
  }
  const out = { idCount: ids.length, sampleId: ids[0] || null, tries: {} };
  if (!ids.length) return out;

  const zone = String(ids[0]).slice(String(ids[0]).indexOf('_') + 1, String(ids[0]).indexOf('-'));
  const bare = ids.slice(0, 3).map((i) => String(i).slice(String(i).indexOf('-') + 1));
  const full3 = ids.slice(0, 3);
  out.zoneFromId = zone;

  out.tries.fullIds_zoneFromId = await gql('ItemDetailsRetailerProduct', DETAIL, { ids: full3, zoneId: zone });
  out.tries.bareIds_zoneFromId = await gql('ItemDetailsRetailerProduct', DETAIL, { ids: bare, zoneId: zone });
  out.tries.fullIds_zoneShop   = await gql('ItemDetailsRetailerProduct', DETAIL, { ids: full3, zoneId: SHOP });
  out.tries.bareIds_zoneShop   = await gql('ItemDetailsRetailerProduct', DETAIL, { ids: bare, zoneId: SHOP });
  return out;
})()
